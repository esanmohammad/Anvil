/**
 * Build step — Phase 5 port.
 *
 * Wraps cli's existing `runBuildStage`. The build stage today: creates
 * feature branches in all repos, runs the engineer agent per task,
 * commits, then pushes the branches.
 *
 * Phase 7 will hoist the per-repo build → per-task fix loop into
 * `subSteps`. Phase 5 keeps the entire build as a single Step for now.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { runBuildStage } from '../stages/build/index.js';
import type { BuildStageResult } from '../stages/build/index.js';
import type { AgentRunner } from '../stages/types.js';

export interface BuildInput {
  runId: string;
  featureSlug: string;
  agentRunner: AgentRunner;
  repoPaths: Record<string, string>;
  taskPlans: Array<{
    project: string;
    repo: string;
    tasks: Array<{ id: string; description: string; files: string[] }>;
  }>;
  projectPrompt: string;
}

export type BuildOutput = BuildStageResult;

export const BUILD_STEP_ID = 'build' as const;

export function createBuildStep(): Step<BuildInput, BuildOutput> {
  return {
    id: BUILD_STEP_ID,
    name: 'Create feature branches, build per repo, push branches',
    parallelism: 'serial',
    run: async (ctx: StepContext<BuildInput>): Promise<BuildOutput> => {
      const result = await runBuildStage({
        runId: ctx.input.runId,
        featureSlug: ctx.input.featureSlug,
        agentRunner: ctx.input.agentRunner,
        repoPaths: ctx.input.repoPaths,
        taskPlans: ctx.input.taskPlans,
        projectPrompt: ctx.input.projectPrompt,
      });
      ctx.emit('BUILD.json', result);
      return result;
    },
  };
}
