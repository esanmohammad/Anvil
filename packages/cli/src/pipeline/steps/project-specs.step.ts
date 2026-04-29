/**
 * Project-specs step — Phase 5 port (per-project parallelism).
 *
 * Wraps cli's existing `runProjectSpecsStage`. Reads the project's
 * REQUIREMENTS.md body and emits a `<project>-SPEC.md` artifact.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { runProjectSpecsStage } from '../stages/project-specs.js';
import type { AgentRunner } from '../stages/types.js';

export interface ProjectSpecsInput {
  project: { name: string; repos: string[] };
  feature: string;
  agentRunner: AgentRunner;
  runDir: string;
  projectYamlPath?: string;
  conventionsPath?: string;
  projectRequirements: string;
}

export interface ProjectSpecsOutput {
  artifact: string;
  artifactName: string;
  tokenEstimate: number;
  projectName: string;
}

export const PROJECT_SPECS_STEP_ID = 'specs' as const;

export function createProjectSpecsStep(): Step<ProjectSpecsInput, ProjectSpecsOutput> {
  return {
    id: PROJECT_SPECS_STEP_ID,
    name: 'Per-project technical specs derived from project requirements',
    parallelism: 'per-project',
    run: async (ctx: StepContext<ProjectSpecsInput>): Promise<ProjectSpecsOutput> => {
      const { project, feature, agentRunner, runDir, projectYamlPath, conventionsPath, projectRequirements } = ctx.input;
      const result = await runProjectSpecsStage(
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
        projectRequirements,
        project,
      );
      ctx.emit(`${project.name}-SPEC.md`, {
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
