/**
 * cli pipeline `Step` registry — Phase 6 entry point.
 *
 * Builds the canonical 8-step registry the orchestrator hands to
 * `Pipeline.run()`. Each step reads cross-stage state from `ctx.shared`
 * (typed as `CliPipelineState`) and contains its full per-stage logic
 * (persona prompt building, agent invocation, approval-gate request,
 * artifact emission).
 */

import { InMemoryStepRegistry, type StepRegistry } from '@anvil/core-pipeline';
import { createClarifyStep, CLARIFY_STEP_ID, CLARIFICATION_ARTIFACT_ID } from './clarify.step.js';
import {
  createHighLevelRequirementsStep,
  HIGH_LEVEL_REQUIREMENTS_STEP_ID,
  HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID,
} from './high-level-requirements.step.js';
import {
  createRepoRequirementsStep,
  REPO_REQUIREMENTS_STEP_ID,
} from './repo-requirements.step.js';
import { createProjectSpecsStep, PROJECT_SPECS_STEP_ID } from './project-specs.step.js';
import { createProjectTasksStep, PROJECT_TASKS_STEP_ID } from './project-tasks.step.js';
import { createBuildStep, BUILD_STEP_ID } from './build.step.js';
import { createValidateStep, VALIDATE_STEP_ID, VALIDATION_ARTIFACT_ID } from './validate.step.js';
import { createShipStep, SHIP_STEP_ID } from './ship.step.js';
import {
  registerCustomStages,
  type CustomStageConfigV2,
  type CustomStageRegistration,
  type CustomStageStepInput,
  type CustomStageStepOutput,
} from './custom-stage-shim.js';

export {
  createClarifyStep,
  CLARIFY_STEP_ID,
  CLARIFICATION_ARTIFACT_ID,
  createHighLevelRequirementsStep,
  HIGH_LEVEL_REQUIREMENTS_STEP_ID,
  HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID,
  createRepoRequirementsStep,
  REPO_REQUIREMENTS_STEP_ID,
  createProjectSpecsStep,
  PROJECT_SPECS_STEP_ID,
  createProjectTasksStep,
  PROJECT_TASKS_STEP_ID,
  createBuildStep,
  BUILD_STEP_ID,
  createValidateStep,
  VALIDATE_STEP_ID,
  VALIDATION_ARTIFACT_ID,
  createShipStep,
  SHIP_STEP_ID,
  registerCustomStages,
};
export type {
  CustomStageConfigV2,
  CustomStageRegistration,
  CustomStageStepInput,
  CustomStageStepOutput,
};

/** Construct the default cli pipeline registry — 8 stages in order. */
export function buildDefaultPipelineRegistry(): StepRegistry {
  const registry = new InMemoryStepRegistry();
  registry.register(createClarifyStep());
  registry.register(createHighLevelRequirementsStep());
  registry.register(createRepoRequirementsStep());
  registry.register(createProjectSpecsStep());
  registry.register(createProjectTasksStep());
  registry.register(createBuildStep());
  registry.register(createValidateStep());
  registry.register(createShipStep());
  return registry;
}
