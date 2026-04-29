/**
 * Project-requirements step — Phase 5 port (per-project parallelism).
 *
 * Wraps cli's existing `runProjectRequirementsStage`. The Step has
 * `parallelism: 'per-project'` so the Pipeline walker (Phase 7+) can
 * fan out one invocation per project entry — matching today's
 * `parallel-runner.ts` scheduling.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { runProjectRequirementsStage } from '../stages/project-requirements.js';
import type { AgentRunner } from '../stages/types.js';

export interface ProjectRequirementsInput {
  project: { name: string; repos: string[] };
  feature: string;
  agentRunner: AgentRunner;
  runDir: string;
  projectYamlPath?: string;
  conventionsPath?: string;
  highLevelRequirements: string;
}

export interface ProjectRequirementsOutput {
  artifact: string;
  artifactName: string;
  tokenEstimate: number;
  projectName: string;
}

export const PROJECT_REQUIREMENTS_STEP_ID = 'project-requirements' as const;

export function createProjectRequirementsStep(): Step<
  ProjectRequirementsInput,
  ProjectRequirementsOutput
> {
  return {
    id: PROJECT_REQUIREMENTS_STEP_ID,
    name: 'Per-project requirements derived from high-level reqs',
    parallelism: 'per-project',
    run: async (ctx: StepContext<ProjectRequirementsInput>): Promise<ProjectRequirementsOutput> => {
      const { project, feature, agentRunner, runDir, projectYamlPath, conventionsPath, highLevelRequirements } = ctx.input;
      const result = await runProjectRequirementsStage(
        {
          project: project.name,
          feature,
          agentRunner,
          runDir,
          projectYamlPath,
          conventionsPath,
          workspaceDir: ctx.workspaceDir,
          repoPaths: ctx.repoPaths,
        },
        highLevelRequirements,
        project,
      );
      ctx.emit(`${project.name}-REQUIREMENTS.md`, {
        artifact: result.artifact,
        artifactName: result.artifactName,
        tokenEstimate: result.tokenEstimate,
        projectName: project.name,
      });
      return {
        artifact: result.artifact,
        artifactName: result.artifactName,
        tokenEstimate: result.tokenEstimate,
        projectName: project.name,
      };
    },
  };
}
