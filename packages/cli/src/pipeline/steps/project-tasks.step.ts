/**
 * Project-tasks step — Phase 5 port (per-project parallelism).
 *
 * Wraps cli's existing `runProjectTasksStage`. Reads the project's
 * SPEC.md body and emits a `<project>-TASKS.md` artifact.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { runProjectTasksStage } from '../stages/project-tasks.js';
import type { AgentRunner } from '../stages/types.js';

export interface ProjectTasksInput {
  project: { name: string; repos: string[] };
  feature: string;
  agentRunner: AgentRunner;
  runDir: string;
  projectYamlPath?: string;
  conventionsPath?: string;
  projectSpec: string;
}

export interface ProjectTasksOutput {
  artifact: string;
  artifactName: string;
  tokenEstimate: number;
  projectName: string;
}

export const PROJECT_TASKS_STEP_ID = 'tasks' as const;

export function createProjectTasksStep(): Step<ProjectTasksInput, ProjectTasksOutput> {
  return {
    id: PROJECT_TASKS_STEP_ID,
    name: 'Per-project ordered implementation tasks',
    parallelism: 'per-project',
    run: async (ctx: StepContext<ProjectTasksInput>): Promise<ProjectTasksOutput> => {
      const { project, feature, agentRunner, runDir, projectYamlPath, conventionsPath, projectSpec } = ctx.input;
      const result = await runProjectTasksStage(
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
        projectSpec,
        project,
      );
      ctx.emit(`${project.name}-TASKS.md`, {
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
