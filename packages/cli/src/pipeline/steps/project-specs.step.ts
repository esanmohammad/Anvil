/**
 * Project Specs step — Phase 6 per-stage adapter.
 * Lifts orchestrator.ts:Stage-3 logic with manual per-project fanout.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { APPROVAL_GATE_CHANNEL } from '@anvil/core-pipeline';
import { runProjectSpecsStage } from '../stages/index.js';
import type { StageContext } from '../stages/types.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import { estimateAgentCallCost } from '../cost-estimator.js';
import type { CliPipelineState } from '../cli-state.js';

export const PROJECT_SPECS_STEP_ID = 'specs' as const;

export function createProjectSpecsStep(): Step<unknown, unknown> {
  return {
    id: PROJECT_SPECS_STEP_ID,
    name: 'Per-project specs (parallel)',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;
      updatePipelineStage(3, 'running');

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
          const sysReqs = state.projectReqsMap.get(sys.name) ?? '';
          return runProjectSpecsStage(stageCtx, sysReqs, {
            name: sys.name, repos: sys.repos,
          });
        }),
      );

      let totalTokens = 0;
      let anySuccess = false;
      for (let i = 0; i < state.affectedProjects.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          state.projectSpecsMap.set(state.affectedProjects[i].name, r.value.artifact);
          totalTokens += r.value.tokenEstimate;
          anySuccess = true;
        }
      }
      if (!anySuccess) throw new Error('All project specs stages failed');

      const { inputTokens, outputTokens, costUsd } = estimateAgentCallCost(totalTokens, state.model);
      state.stageCosts.set(3, { inputTokens, outputTokens, estimatedCost: costUsd });
      updateStageCost(3, costUsd);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(3, 'completed');

      if (state.approvalRequired) {
        const decision = await ctx.bus.request<unknown, 'approved' | 'rejected'>(
          APPROVAL_GATE_CHANNEL,
          { stepId: PROJECT_SPECS_STEP_ID, stageIndex: 3 },
        );
        if (decision === 'rejected') throw new Error('Stage 3 rejected by user');
      }

      return Object.fromEntries(state.projectSpecsMap);
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
