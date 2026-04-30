/**
 * Clarify step — Phase 6 per-stage adapter.
 *
 * Lifts the legacy orchestrator's stage-0 logic verbatim:
 *   - Build clarifier persona prompt
 *   - Phase A: agent generates numbered questions
 *   - Phase B: ask each question via stdin readline (cli) — interactive Q&A
 *     [If `state.skipClarify`: produce a "skipped" stub instead.
 *      If `state.answersFile`: read answers from file instead of stdin.]
 *   - Phase C: agent synthesizes CLARIFICATION.md from Q&A
 *   - Approval gate request after the stage completes (if state.approvalRequired)
 *   - Emit `CLARIFICATION.md` artifact for the feature-store hook
 */

import { readFileSync } from 'node:fs';
import type { Step, StepContext } from '@anvil/core-pipeline';
import { APPROVAL_GATE_CHANNEL } from '@anvil/core-pipeline';
import { buildPersonaProjectPrompt, parseQuestions } from '../persona-prompt.js';
import { info } from '../../logger.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import { estimateAgentCallCost } from '../cost-estimator.js';
import type { CliPipelineState } from '../cli-state.js';

export const CLARIFY_STEP_ID = 'clarify' as const;
export const CLARIFICATION_ARTIFACT_ID = 'CLARIFICATION.md' as const;

export function createClarifyStep(): Step<unknown, unknown> {
  return {
    id: CLARIFY_STEP_ID,
    name: 'Clarify feature request via interactive Q&A',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;
      updatePipelineStage(0, 'running');

      let artifact: string;
      let totalTokens = 0;

      if (state.skipClarify) {
        artifact = '# Clarification\n\nClarification skipped.\n';
        info('Clarify stage skipped (skipClarify=true)');
      } else if (state.answersFile) {
        const raw = readFileSync(state.answersFile, 'utf8');
        artifact = `# Clarification\n\n${raw}\n`;
      } else {
        const projectPrompt = await buildPersonaProjectPrompt(
          0, state.project, state.feature, state.featureSlug,
          state.projectYamlPath, state.workspaceDir, state.repoNames, state.memoryStore,
        );

        // Phase A: agent generates numbered questions
        const questionsResult = await state.agentRunner.run({
          persona: 'clarifier',
          projectPrompt,
          userPrompt: `Feature request: "${state.feature}"\n\nExplore the codebase to understand the current architecture, then output 3-5 clarifying questions about this feature request. Number each question. Be specific — reference actual files, APIs, or patterns you found in the code.`,
          workingDir: state.workspaceDir,
          stage: 'clarify',
        });
        totalTokens += questionsResult.tokenEstimate;

        const questions = parseQuestions(questionsResult.output);

        if (questions.length === 0) {
          artifact = questionsResult.output;
        } else {
          // Phase B: gather answers via bus.request — cli stdin responder
          // attaches in orchestrator.ts; dashboard could attach a WS responder.
          const answers = await ctx.bus.request<{ questions: string[] }, string[]>(
            'clarify:answers',
            { questions },
          );

          const qaText = questions.map((q, i) =>
            `**Q${i + 1}**: ${q}\n**A${i + 1}**: ${answers[i] ?? ''}`,
          ).join('\n\n');

          // Phase C: synthesize final CLARIFICATION.md
          const synthesizeResult = await state.agentRunner.run({
            persona: 'clarifier',
            projectPrompt,
            userPrompt: `Feature: "${state.feature}"\n\nHere are the clarifying questions and the user's answers:\n\n${qaText}\n\nNow synthesize a CLARIFICATION.md document that combines the questions, answers, and your codebase understanding into clear context for the next stages. Output ONLY the markdown content.`,
            workingDir: state.workspaceDir,
            stage: 'clarify',
          });
          totalTokens += synthesizeResult.tokenEstimate;
          artifact = synthesizeResult.output || questionsResult.output;
        }
      }

      state.clarificationArtifact = artifact;

      // Cost tracking — emit costUsd via artifact event so attachCostTrackerHook accumulates
      const { inputTokens, outputTokens, costUsd } = estimateAgentCallCost(totalTokens, state.model);
      ctx.emit(CLARIFICATION_ARTIFACT_ID, {
        artifact,
        artifactName: CLARIFICATION_ARTIFACT_ID,
        tokenEstimate: totalTokens,
        costUsd,
      });
      state.stageCosts.set(0, { inputTokens, outputTokens, estimatedCost: costUsd });
      updateStageCost(0, costUsd);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(0, 'completed');

      // Approval gate (if required)
      if (state.approvalRequired) {
        const decision = await ctx.bus.request<unknown, 'approved' | 'rejected'>(
          APPROVAL_GATE_CHANNEL,
          { stepId: CLARIFY_STEP_ID, stageIndex: 0 },
        );
        if (decision === 'rejected') throw new Error('Stage 0 rejected by user');
      }

      return artifact;
    },
  };
}

function aggregateCost(state: CliPipelineState): { inputTokens: number; outputTokens: number; estimatedCost: number } {
  let estimatedCost = 0, inputTokens = 0, outputTokens = 0;
  for (const c of state.stageCosts.values()) {
    estimatedCost += c.estimatedCost;
    inputTokens += c.inputTokens;
    outputTokens += c.outputTokens;
  }
  return { estimatedCost, inputTokens, outputTokens };
}
