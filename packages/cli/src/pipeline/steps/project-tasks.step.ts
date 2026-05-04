/**
 * Project Tasks step — Phase 6 per-stage adapter.
 * Lifts orchestrator.ts:Stage-4 logic with manual per-project fanout.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { APPROVAL_GATE_CHANNEL } from '@anvil/core-pipeline';
import { runProjectTasksStage } from '../stages/index.js';
import type { StageContext } from '../stages/types.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import { estimateAgentCallCost } from '../cost-estimator.js';
import type { CliPipelineState } from '../cli-state.js';

export const PROJECT_TASKS_STEP_ID = 'tasks' as const;

export function createProjectTasksStep(): Step<unknown, unknown> {
  return {
    id: PROJECT_TASKS_STEP_ID,
    name: 'Per-project tasks (parallel)',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;
      updatePipelineStage(4, 'running');

      const stageCtx: StageContext = {
        runDir: state.runDir,
        project: state.project,
        feature: state.feature,
        agentRunner: state.agentRunner,
        workspaceDir: state.workspaceDir,
        repoPaths: state.repoPaths,
        projectYamlPath: state.projectYamlPath,
      };

      const results = await Promise.allSettled(
        state.affectedProjects.map((sys) => {
          const sysSpec = state.projectSpecsMap.get(sys.name) ?? '';
          return runProjectTasksStage(stageCtx, sysSpec, {
            name: sys.name, repos: sys.repos,
          });
        }),
      );

      let totalTokens = 0;
      let anySuccess = false;
      for (let i = 0; i < state.affectedProjects.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          state.projectTasksMap.set(state.affectedProjects[i].name, r.value.artifact);
          totalTokens += r.value.tokenEstimate;
          anySuccess = true;
        }
      }
      if (!anySuccess) throw new Error('All project tasks stages failed');

      const { inputTokens, outputTokens, costUsd } = estimateAgentCallCost(totalTokens, state.model);
      state.stageCosts.set(4, { inputTokens, outputTokens, estimatedCost: costUsd });
      updateStageCost(4, costUsd);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(4, 'completed');

      if (state.approvalRequired) {
        const decision = await ctx.bus.request<unknown, 'approved' | 'rejected'>(
          APPROVAL_GATE_CHANNEL,
          { stepId: PROJECT_TASKS_STEP_ID, stageIndex: 4 },
        );
        if (decision === 'rejected') throw new Error('Stage 4 rejected by user');
      }

      return Object.fromEntries(state.projectTasksMap);
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
