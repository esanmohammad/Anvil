/**
 * cli pipeline `Step` registry — Phase 4 + 5 entry point.
 *
 * Builds the default ordered list of `Step<I, O>`s the new pipeline
 * walker runs through. Phase 4 introduced the contract via `clarify`;
 * Phase 5 added the remaining 7 stages.
 *
 * The orchestrator's legacy if-tree continues to ship the actual hot
 * path until Phase 8 deletes it. The compatibility shim
 * (`isNewPipelineEnabled`) gates the new code path on
 * `ANVIL_USE_NEW_PIPELINE=1` until then.
 */

import { InMemoryStepRegistry, type StepRegistry } from '@anvil/core-pipeline';
import {
  createClarifyStep,
  CLARIFY_STEP_ID,
  CLARIFICATION_ARTIFACT_ID,
} from './clarify.step.js';
import type { ClarifyInput, ClarifyOutput } from './clarify.step.js';
import {
  createHighLevelRequirementsStep,
  HIGH_LEVEL_REQUIREMENTS_STEP_ID,
  HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID,
} from './high-level-requirements.step.js';
import type {
  HighLevelRequirementsInput,
  HighLevelRequirementsOutput,
} from './high-level-requirements.step.js';
import {
  createProjectRequirementsStep,
  PROJECT_REQUIREMENTS_STEP_ID,
} from './project-requirements.step.js';
import type {
  ProjectRequirementsInput,
  ProjectRequirementsOutput,
} from './project-requirements.step.js';
import {
  createProjectSpecsStep,
  PROJECT_SPECS_STEP_ID,
} from './project-specs.step.js';
import type { ProjectSpecsInput, ProjectSpecsOutput } from './project-specs.step.js';
import {
  createProjectTasksStep,
  PROJECT_TASKS_STEP_ID,
} from './project-tasks.step.js';
import type { ProjectTasksInput, ProjectTasksOutput } from './project-tasks.step.js';
import { createBuildStep, BUILD_STEP_ID } from './build.step.js';
import type { BuildInput, BuildOutput } from './build.step.js';
import {
  createValidateStep,
  VALIDATE_STEP_ID,
  VALIDATION_ARTIFACT_ID,
} from './validate.step.js';
import type { ValidateInput, ValidateOutput } from './validate.step.js';
import { createShipStep, SHIP_STEP_ID } from './ship.step.js';
import type { ShipInput, ShipOutput } from './ship.step.js';

// ── Re-exports ─────────────────────────────────────────────────────────────

export {
  // clarify
  createClarifyStep,
  CLARIFY_STEP_ID,
  CLARIFICATION_ARTIFACT_ID,
  // requirements
  createHighLevelRequirementsStep,
  HIGH_LEVEL_REQUIREMENTS_STEP_ID,
  HIGH_LEVEL_REQUIREMENTS_ARTIFACT_ID,
  // project-requirements
  createProjectRequirementsStep,
  PROJECT_REQUIREMENTS_STEP_ID,
  // specs
  createProjectSpecsStep,
  PROJECT_SPECS_STEP_ID,
  // tasks
  createProjectTasksStep,
  PROJECT_TASKS_STEP_ID,
  // build
  createBuildStep,
  BUILD_STEP_ID,
  // validate
  createValidateStep,
  VALIDATE_STEP_ID,
  VALIDATION_ARTIFACT_ID,
  // ship
  createShipStep,
  SHIP_STEP_ID,
};
export type {
  ClarifyInput,
  ClarifyOutput,
  HighLevelRequirementsInput,
  HighLevelRequirementsOutput,
  ProjectRequirementsInput,
  ProjectRequirementsOutput,
  ProjectSpecsInput,
  ProjectSpecsOutput,
  ProjectTasksInput,
  ProjectTasksOutput,
  BuildInput,
  BuildOutput,
  ValidateInput,
  ValidateOutput,
  ShipInput,
  ShipOutput,
};

/**
 * Construct the default cli pipeline registry. Registers all 8 stages
 * in canonical order: clarify → requirements → project-requirements →
 * specs → tasks → build → validate → ship.
 *
 * The per-project stages (`project-requirements`, `specs`, `tasks`)
 * declare `parallelism: 'per-project'`; the Pipeline walker honors
 * this hint by fanning the step out across projects (Phase 7+).
 */
export function buildDefaultPipelineRegistry(): StepRegistry {
  const registry = new InMemoryStepRegistry();
  registry.register(createClarifyStep() as never);
  registry.register(createHighLevelRequirementsStep() as never);
  registry.register(createProjectRequirementsStep() as never);
  registry.register(createProjectSpecsStep() as never);
  registry.register(createProjectTasksStep() as never);
  registry.register(createBuildStep() as never);
  registry.register(createValidateStep() as never);
  registry.register(createShipStep() as never);
  return registry;
}

/**
 * Strangler-fig feature flag.
 *
 * Returns true when `ANVIL_USE_NEW_PIPELINE` is set to a truthy value
 * (1, true, yes, on — case-insensitive). Defaults to false until the
 * orchestrator's if-tree is fully replaced (Phase 8).
 */
export function isNewPipelineEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ANVIL_USE_NEW_PIPELINE;
  if (raw === undefined) return false;
  const v = raw.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}
