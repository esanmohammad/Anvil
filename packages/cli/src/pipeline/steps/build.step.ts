/**
 * Build step — Phase 6 per-stage adapter.
 * Lifts orchestrator.ts:Stage-5 logic.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { APPROVAL_GATE_CHANNEL } from '@anvil/core-pipeline';
import { runBuildStage, type BuildStageConfig } from '../stages/build/index.js';
import { buildPersonaProjectPrompt } from '../persona-prompt.js';
import { createPipelineFeatureBranches } from '../feature-branches.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import type { CliPipelineState } from '../cli-state.js';

export const BUILD_STEP_ID = 'build' as const;

export function createBuildStep(): Step<unknown, unknown> {
  return {
    id: BUILD_STEP_ID,
    name: 'Create feature branches, build per repo, push branches',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;

      // Create feature branches in all repos before build
      createPipelineFeatureBranches(
        state.featureSlug,
        state.repoPaths,
        state.workspaceDir,
        state.repoNames,
      );

      updatePipelineStage(5, 'running');

      const projectPrompt = await buildPersonaProjectPrompt(
        5, state.project, state.feature, state.featureSlug,
        state.projectYamlPath, state.workspaceDir, state.repoNames, state.memoryStore,
      );

      const failureCtx = (state.resumeFromStage === 5 && state.failureContext)
        ? `\n\nIMPORTANT — This is a RETRY. The previous run failed:\n${state.failureContext}\nFix the issues and proceed.`
        : '';

      // Assemble per-project task plans
      const buildRepoPaths: Record<string, string> = {};
      const taskPlans: BuildStageConfig['taskPlans'] = [];

      for (const sys of state.affectedProjects) {
        const sysData = await state.projectLoader.findProject(sys.name);
        for (const repo of sysData.repos) {
          if (repo.path) buildRepoPaths[repo.name] = repo.path;
          const tasksArtifact = state.projectTasksMap.get(sys.name) ?? '';
          taskPlans.push({
            project: sys.name,
            repo: repo.name,
            tasks: [{ id: 'task-1', description: tasksArtifact + failureCtx, files: [] }],
          });
        }
      }

      await runBuildStage({
        runId: state.runId,
        featureSlug: state.featureSlug,
        agentRunner: state.agentRunner,
        repoPaths: buildRepoPaths,
        taskPlans,
        projectPrompt: projectPrompt + '\n\nIMPORTANT: Do NOT make git commits. Only write code. Commits happen in the ship stage.',
      });

      // Cost tracking — build stage doesn't return per-task tokens currently
      state.stageCosts.set(5, { inputTokens: 0, outputTokens: 0, estimatedCost: 0 });
      updateStageCost(5, 0);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(5, 'completed');

      if (state.approvalRequired) {
        const decision = await ctx.bus.request<unknown, 'approved' | 'rejected'>(
          APPROVAL_GATE_CHANNEL,
          { stepId: BUILD_STEP_ID, stageIndex: 5 },
        );
        if (decision === 'rejected') throw new Error('Stage 5 rejected by user');
      }

      return null;
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
