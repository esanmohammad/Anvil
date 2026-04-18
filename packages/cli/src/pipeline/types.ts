// Pipeline types and stage definitions

export type ParallelismMode = 'serial' | 'parallel-per-project';

export interface StageDefinition {
  index: number;
  name: string;
  persona: string;
  parallelism: ParallelismMode;
  timeout: number;
  validationRequired: boolean;
}

export const PIPELINE_STAGES: StageDefinition[] = [
  { index: 0, name: 'clarify', persona: 'clarifier', parallelism: 'serial', timeout: 300000, validationRequired: true },
  { index: 1, name: 'requirements', persona: 'analyst', parallelism: 'serial', timeout: 600000, validationRequired: true },
  { index: 2, name: 'project-requirements', persona: 'analyst', parallelism: 'parallel-per-project', timeout: 600000, validationRequired: true },
  { index: 3, name: 'specs', persona: 'architect', parallelism: 'parallel-per-project', timeout: 900000, validationRequired: true },
  { index: 4, name: 'tasks', persona: 'lead', parallelism: 'parallel-per-project', timeout: 900000, validationRequired: true },
  { index: 5, name: 'build', persona: 'engineer', parallelism: 'serial', timeout: 1800000, validationRequired: false },
  { index: 6, name: 'validate', persona: 'tester', parallelism: 'serial', timeout: 1200000, validationRequired: true },
  { index: 7, name: 'ship', persona: 'engineer', parallelism: 'serial', timeout: 900000, validationRequired: false },
];

export interface PipelineConfig {
  project: string;
  feature: string;
  featureSlug: string;
  skipClarify: boolean;
  skipShip: boolean;
  answersFile?: string;
  maxRetries: number;
  concurrency: number;
  approvalGates?: string[];           // stage names to pause after
  modelTier?: 'fast' | 'balanced' | 'thorough';
}

export type PipelineEventType =
  | 'stage-start'
  | 'stage-complete'
  | 'stage-fail'
  | 'pipeline-complete'
  | 'pipeline-fail';

export interface PipelineEvent {
  type: PipelineEventType;
  stage?: number;
  stageName?: string;
  project?: string;
  error?: string;
  timestamp: string;
}

export interface PipelineState {
  currentStage: number;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  events: PipelineEvent[];
  startedAt?: string;
  completedAt?: string;
}

export interface AffectedProject {
  name: string;
  repos: string[];
  reason: string;
}

export function getStageDefinition(index: number): StageDefinition | undefined {
  return PIPELINE_STAGES.find((s) => s.index === index);
}

export function getStageByName(name: string): StageDefinition | undefined {
  return PIPELINE_STAGES.find((s) => s.name === name);
}

export function createDefaultPipelineConfig(
  project: string,
  feature: string,
  featureSlug: string,
): PipelineConfig {
  return {
    project,
    feature,
    featureSlug,
    skipClarify: false,
    skipShip: false,
    maxRetries: 2,
    concurrency: 4,
  };
}
