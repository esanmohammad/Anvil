/**
 * High-level requirements step — Phase 5 port.
 *
 * Wraps cli's existing `runHighLevelRequirementsStage`. Reads the
 * `CLARIFICATION.md` body from the input (passed by the orchestrator or
 * the prior `clarify` Step's output) and emits `HIGH-LEVEL-REQUIREMENTS.md`.
 */

import type { Step, StepContext } from '@anvil/core-pipeline';
import { runHighLevelRequirementsStage } from '../stages/high-level-requirements.js';
import type { AgentRunner } from '../stages/types.js';

export interface HighLevelRequirementsInput {
  project: string;
  feature: string;
  agentRunner: AgentRunner;
  runDir: string;
  projectYamlPath?: string;
  conventionsPath?: string;
  clarification: string;
}

export interface HighLevelRequirementsOutput {
  artifact: string;
  tokenEstimate: number;
}

export const HIGH_LEVEL_REQUIREMENTS_STEP_ID = 'requirements' as const;
export const HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID = 'HIGH-LEVEL-REQUIREMENTS.md' as const;

export function createHighLevelRequirementsStep(): Step<
  HighLevelRequirementsInput,
  HighLevelRequirementsOutput
> {
  return {
    id: HIGH_LEVEL_REQUIREMENTS_STEP_ID,
    name: 'Generate high-level requirements with success criteria',
    parallelism: 'serial',
    run: async (
      ctx: StepContext<HighLevelRequirementsInput>,
    ): Promise<HighLevelRequirementsOutput> => {
      const { project, feature, agentRunner, runDir, projectYamlPath, conventionsPath, clarification } = ctx.input;
      const result = await runHighLevelRequirementsStage(
        {
          project,
          feature,
          agentRunner,
          runDir,
          projectYamlPath,
          conventionsPath,
          workspaceDir: ctx.workspaceDir,
          repoPaths: ctx.repoPaths,
        },
        clarification,
      );
      ctx.emit(HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID, {
        artifact: result.artifact,
        artifactName: result.artifactName,
        tokenEstimate: result.tokenEstimate,
      });
      return { artifact: result.artifact, tokenEstimate: result.tokenEstimate };
    },
  };
}
