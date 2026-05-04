/**
 * High-Level Requirements step — Phase 6 per-stage adapter.
 * Lifts orchestrator.ts:Stage-1 logic.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { APPROVAL_GATE_CHANNEL } from '@anvil/core-pipeline';
import { buildPersonaProjectPrompt } from '../persona-prompt.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import { estimateAgentCallCost } from '../cost-estimator.js';
import type { CliPipelineState } from '../cli-state.js';

export const HIGH_LEVEL_REQUIREMENTS_STEP_ID = 'requirements' as const;
export const HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID = 'HIGH-LEVEL-REQUIREMENTS.md' as const;

export function createHighLevelRequirementsStep(): Step<unknown, unknown> {
  return {
    id: HIGH_LEVEL_REQUIREMENTS_STEP_ID,
    name: 'Generate high-level requirements with success criteria',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;
      updatePipelineStage(1, 'running');

      const projectPrompt = await buildPersonaProjectPrompt(
        1, state.project, state.feature, state.featureSlug,
        state.projectYamlPath, state.workspaceDir, state.repoNames, state.memoryStore,
      );

      const failureCtx = (state.resumeFromStage === 1 && state.failureContext)
        ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${state.failureContext}\nFix the issues and proceed.`
        : '';

      const out = await state.agentRunner.run({
        persona: 'analyst',
        projectPrompt,
        userPrompt: `Feature: "${state.feature}"\n\nClarification:\n${state.clarificationArtifact.slice(0, 8000)}\n\nProduce high-level requirements for this feature across the entire project. Identify which repositories need changes and why. Include success criteria.${failureCtx}`,
        workingDir: state.workspaceDir,
        stage: 'requirements',
      });

      state.highLevelReqsArtifact = out.output;

      const { inputTokens, outputTokens, costUsd } = estimateAgentCallCost(out.tokenEstimate, state.model);
      ctx.emit(HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID, {
        artifact: out.output,
        artifactName: HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID,
        tokenEstimate: out.tokenEstimate,
        costUsd,
      });
      state.stageCosts.set(1, { inputTokens, outputTokens, estimatedCost: costUsd });
      updateStageCost(1, costUsd);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(1, 'completed');

      if (state.approvalRequired) {
        const decision = await ctx.bus.request<unknown, 'approved' | 'rejected'>(
          APPROVAL_GATE_CHANNEL,
          { stepId: HIGH_LEVEL_REQUIREMENTS_STEP_ID, stageIndex: 1 },
        );
        if (decision === 'rejected') throw new Error('Stage 1 rejected by user');
      }

      return out.output;
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
