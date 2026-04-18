/**
 * Agent Process Manager — types and configuration defaults.
 */

// ---------------------------------------------------------------------------
// Process configuration
// ---------------------------------------------------------------------------

export interface AgentProcessConfig {
  /** Path to the Claude CLI binary. */
  binaryPath: string;
  /** Extra CLI arguments. */
  args: string[];
  /** Project prompt injected via --project-prompt. */
  projectPrompt: string;
  /** Working directory for the spawned process. */
  workingDir: string;
  /** Timeout in milliseconds (0 = no timeout). */
  timeout: number;
  /** Maximum number of automatic restarts on crash. */
  maxRestarts: number;
  /** Pipeline stage name (e.g. "clarify", "build"). */
  stage: string;
}

// ---------------------------------------------------------------------------
// Process state
// ---------------------------------------------------------------------------

export type AgentProcessState =
  | 'idle'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'restarting';

// ---------------------------------------------------------------------------
// Agent events — discriminated union
// ---------------------------------------------------------------------------

export type AgentEvent =
  | { type: 'output'; data: string }
  | { type: 'error'; data: string }
  | { type: 'activity'; data: string }
  | { type: 'result'; data: string }
  | { type: 'exit'; code: number; signal?: string }
  | { type: 'timeout'; elapsed: number }
  | { type: 'restart'; attempt: number };

// ---------------------------------------------------------------------------
// Agent result
// ---------------------------------------------------------------------------

export interface AgentResult {
  status: AgentProcessState;
  output: string;
  duration: number;
  tokenEstimate: number;
  exitCode: number | null;
  validation?: ValidationResult;
}

export interface ValidationResult {
  valid: boolean;
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Per-stage timeout defaults (milliseconds)
// ---------------------------------------------------------------------------

export const STAGE_TIMEOUT_DEFAULTS: Record<string, number> = {
  clarify: 5 * 60_000,
  requirements: 10 * 60_000,
  'project-requirements': 10 * 60_000,
  specs: 15 * 60_000,
  tasks: 15 * 60_000,
  build: 30 * 60_000,
  validate: 20 * 60_000,
  ship: 15 * 60_000,
};

/** Return the default timeout for a given stage (falls back to 15 min). */
export function getDefaultTimeout(stage: string): number {
  return STAGE_TIMEOUT_DEFAULTS[stage] ?? 15 * 60_000;
}

/** Create a default AgentProcessConfig, merging any provided overrides. */
export function createDefaultConfig(
  overrides?: Partial<AgentProcessConfig>,
): AgentProcessConfig {
  const stage = overrides?.stage ?? 'build';
  return {
    binaryPath: overrides?.binaryPath ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude',
    args: overrides?.args ?? [],
    projectPrompt: overrides?.projectPrompt ?? '',
    workingDir: overrides?.workingDir ?? process.cwd(),
    timeout: overrides?.timeout ?? getDefaultTimeout(stage),
    maxRestarts: overrides?.maxRestarts ?? 2,
    stage,
  };
}
