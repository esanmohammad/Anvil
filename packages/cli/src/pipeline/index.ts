// Barrel export for the pipeline module

export type {
  ParallelismMode,
  StageDefinition,
  PipelineConfig,
  PipelineEventType,
  PipelineEvent,
  PipelineState,
  AffectedProject,
} from './types.js';
export {
  PIPELINE_STAGES,
  getStageDefinition,
  getStageByName,
  createDefaultPipelineConfig,
} from './types.js';

export { PipelineStateMachine } from './state-machine.js';

export type { ParallelResult, ParallelStatus, ParallelRunResult } from './parallel-runner.js';
export { runParallelPerProject } from './parallel-runner.js';

export { CostTracker } from './cost-tracker.js';

export { PipelineDisplay } from './display.js';

export { detectAffectedProjects } from './affected-projects.js';

export type {
  OrchestratorConfig,
  OrchestratorResult,
  PipelineDependencies,
  StageRunners,
} from './orchestrator.js';
export { runPipeline } from './orchestrator.js';

export type {
  DashboardState,
  DashboardPipeline,
  DashboardStageState,
} from './state-file.js';
export {
  readDashboardState,
  writeDashboardState,
  flushDashboardState,
  updatePipelineStage,
  updatePipelineCost,
  updateStageCost,
  clearActivePipeline,
  setPendingApproval,
  clearPendingApproval,
  pushUserMessage,
  drainUserMessages,
  STATE_FILE_PATH,
} from './state-file.js';

export type { OutputLogEntry } from './output-log.js';
export { appendOutput } from './output-log.js';
