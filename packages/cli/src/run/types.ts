// Run Record & History — type definitions

export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface CostEntry {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface StageResult {
  stage: number;
  name: string;
  status: StageStatus;
  startedAt?: string;
  completedAt?: string;
  cost?: CostEntry;
  artifactPath?: string;
  agentOutput?: string;
  repos?: string[];
  quality?: number;
}

export interface RunRecord {
  id: string;
  project: string;
  feature: string;
  featureSlug: string;
  status: RunStatus;
  stages: StageResult[];
  totalCost?: CostEntry;
  artifacts: string[];
  contextSnapshot?: any;
  createdAt: string;
  updatedAt: string;
  branchName?: string;
  prUrls?: string[];
  sandboxUrl?: string;
}

export const STAGE_NAMES: readonly string[] = [
  'clarify',
  'requirements',
  'project-requirements',
  'specs',
  'tasks',
  'build',
  'validate',
  'ship',
] as const;

export function createEmptyRunRecord(
  id: string,
  project: string,
  feature: string,
  featureSlug: string,
): RunRecord {
  const now = new Date().toISOString();
  const stages: StageResult[] = STAGE_NAMES.map((name, index) => ({
    stage: index,
    name,
    status: 'pending' as StageStatus,
  }));

  return {
    id,
    project,
    feature,
    featureSlug,
    status: 'pending',
    stages,
    artifacts: [],
    createdAt: now,
    updatedAt: now,
  };
}
