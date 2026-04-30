/**
 * Project Requirements step — Phase 6 per-stage adapter.
 * Lifts orchestrator.ts:Stage-2 logic with manual per-project fanout.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { APPROVAL_GATE_CHANNEL } from '@anvil/core-pipeline';
import { runProjectRequirementsStage } from '../stages/index.js';
import type { StageContext } from '../stages/types.js';
import { detectAffectedProjects } from '../affected-projects.js';
import { updatePipelineStage, updateStageCost, updatePipelineCost } from '../state-file.js';
import { estimateAgentCallCost } from '../cost-estimator.js';
import type { CliPipelineState } from '../cli-state.js';

export const PROJECT_REQUIREMENTS_STEP_ID = 'project-requirements' as const;

export function createProjectRequirementsStep(): Step<unknown, unknown> {
  return {
    id: PROJECT_REQUIREMENTS_STEP_ID,
    name: 'Per-project requirements (parallel)',
    parallelism: 'serial',
    run: async (ctx: StepContext<unknown>) => {
      const state = ctx.shared as unknown as CliPipelineState;
      updatePipelineStage(2, 'running');

      const allProjects = await state.projectLoader.loadAll();
      const projectNames = allProjects.map((s) => s.project);
      const projectRegistry = new Map(
        allProjects.map((s) => [s.project, { repos: s.repos.map((r) => r.name) }]),
      );
      let affected = detectAffectedProjects(state.highLevelReqsArtifact, projectNames, projectRegistry);
      if (affected.length === 0) {
        const primarySys = await state.projectLoader.findProject(state.project);
        affected = [{
          name: primarySys.project,
          repos: primarySys.repos.map((r) => r.name),
          reason: 'Primary project specified in config',
        }];
      }
      state.affectedProjects = affected;

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
        affected.map((sys) => runProjectRequirementsStage(stageCtx, state.highLevelReqsArtifact, {
          name: sys.name, repos: sys.repos,
        })),
      );

      let totalTokens = 0;
      let anySuccess = false;
      for (let i = 0; i < affected.length; i++) {
        const r = results[i];
        if (r.status === 'fulfilled') {
          state.projectReqsMap.set(affected[i].name, r.value.artifact);
          totalTokens += r.value.tokenEstimate;
          anySuccess = true;
        }
      }
      if (!anySuccess) throw new Error('All project requirements stages failed');

      const { inputTokens, outputTokens, costUsd } = estimateAgentCallCost(totalTokens, state.model);
      state.stageCosts.set(2, { inputTokens, outputTokens, estimatedCost: costUsd });
      updateStageCost(2, costUsd);
      updatePipelineCost(aggregateCost(state));
      updatePipelineStage(2, 'completed');

      if (state.approvalRequired) {
        const decision = await ctx.bus.request<unknown, 'approved' | 'rejected'>(
          APPROVAL_GATE_CHANNEL,
          { stepId: PROJECT_REQUIREMENTS_STEP_ID, stageIndex: 2 },
        );
        if (decision === 'rejected') throw new Error('Stage 2 rejected by user');
      }

      return Object.fromEntries(state.projectReqsMap);
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
