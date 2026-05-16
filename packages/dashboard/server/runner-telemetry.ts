/**
 * `runner-telemetry` — auth gate + token/cache/per-repo telemetry
 * helpers. Extracted from `pipeline-runner.ts` so the runner stays
 * focused on orchestration. Each function takes a `RunnerTelemetryDeps`
 * opts bag; no FS state of its own.
 */
import {
  writePerRepoTelemetry as writePerRepoTelemetryShared,
  formatTelemetrySummary,
} from '@esankhan3/anvil-core-pipeline';
import { checkClaudeAuth, refreshClaudeAuth } from './claude-auth.js';
import type {
  PipelineRunState,
  StageTokenStats,
} from './pipeline-runner-types.js';

export interface RunnerTelemetryDeps {
  state: PipelineRunState;
  broadcast: () => void;
  checkpoint: () => void;
  emit: (event: 'auth-required' | 'project-event', payload: unknown) => void;
  /** Resolve the model ID for a stage (used to short-circuit auth on non-Claude models). */
  resolveModel: (stageName: string) => string;
}

/**
 * Auth-aware gate. Pauses the pipeline, opens a browser re-login flow,
 * polls for success, then resumes. No-op for non-Claude models.
 *
 * On timeout: marks the run failed and throws so the outer loop can
 * checkpoint + bubble the error to the user.
 */
export async function ensureAuth(deps: RunnerTelemetryDeps, stageName: string): Promise<void> {
  const model = deps.resolveModel(stageName);
  if (!model.startsWith('claude-') && model !== 'claude') return;

  if (checkClaudeAuth()) return;

  console.warn(`[pipeline] Auth expired before "${stageName}" — pausing for re-login...`);

  deps.checkpoint();

  deps.state.status = 'waiting';
  deps.state.waitingForInput = true;
  deps.broadcast();

  deps.emit('auth-required', {
    stageName,
    message: `Authentication expired before "${stageName}" stage. Opening browser for re-login — pipeline will resume automatically.`,
  });

  deps.emit('project-event', {
    source: 'auth',
    message: `Authentication expired — opening browser for re-login. Pipeline will resume automatically once logged in.`,
    level: 'warn',
  });

  const ok = await refreshClaudeAuth(600_000);

  if (!ok) {
    deps.state.status = 'failed';
    deps.state.waitingForInput = false;
    deps.broadcast();
    deps.checkpoint();
    throw new Error(
      `Authentication expired and automatic re-login timed out after 10 minutes. ` +
      `Run "claude auth login" manually, then resume the pipeline from the "${stageName}" stage.`,
    );
  }

  console.log(`[pipeline] Re-authentication successful — resuming "${stageName}"`);
  deps.state.status = 'running';
  deps.state.waitingForInput = false;
  deps.broadcast();

  deps.emit('project-event', {
    source: 'auth',
    message: `Re-authentication successful — resuming pipeline.`,
  });
}

/**
 * Persist per-repo agent stats next to the run record so silent-empty
 * artifacts leave a forensic trail. JSONL — appended once per repo per
 * stage. Failures are non-fatal.
 */
export function writePerRepoTelemetry(
  deps: RunnerTelemetryDeps,
  stageName: string,
  repoName: string,
  stats: {
    outputBytes: number;
    outputTokens: number;
    inputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    costUsd: number;
  },
): void {
  writePerRepoTelemetryShared(
    {
      runId: deps.state.runId,
      onRecord: (record) => {
        deps.emit('project-event', {
          source: 'pipeline',
          message: formatTelemetrySummary(record),
        });
      },
    },
    { stage: stageName, repo: repoName, ...stats },
  );
}

/**
 * Output-truncation telemetry hook. Called when an agent's stop_reason
 * indicates the max-tokens ceiling was reached.
 */
export function handleOutputTruncation(
  deps: RunnerTelemetryDeps,
  agentName: string,
  outputTokens: number,
): void {
  const message = `[pipeline] Output truncated for ${agentName} at ${outputTokens} tokens (max_tokens reached). Consider raising STAGE_OUTPUT_LIMITS.`;
  if (process.env.ANVIL_LOG_OUTPUT_TRUNCATIONS === '1') {
    console.warn(message);
  }
  try {
    deps.emit('project-event', {
      source: 'pipeline',
      message,
    });
  } catch {
    /* defensive — emit must never break the run */
  }
}

/**
 * Roll a single stage's token totals into the run-level aggregate. The
 * cache-hit ratio is computed against the BILLABLE side (input tokens
 * sent fresh + cache reads); output and cache writes are excluded.
 */
export function aggregateRunTokens(deps: RunnerTelemetryDeps, t: StageTokenStats): void {
  const prev = deps.state.tokens ?? {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cacheHitRatio: 0,
  };
  const inputTokens = prev.inputTokens + t.inputTokens;
  const outputTokens = prev.outputTokens + t.outputTokens;
  const cacheReadTokens = prev.cacheReadTokens + t.cacheReadTokens;
  const cacheWriteTokens = prev.cacheWriteTokens + t.cacheWriteTokens;
  const denom = inputTokens + cacheReadTokens;
  deps.state.tokens = {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheHitRatio: denom > 0 ? cacheReadTokens / denom : 0,
  };
}

/**
 * Log the cache-hit ratio for one stage. Denominator is billable input
 * (input + cache reads). Cache writes pay full price the first call and
 * amortise for `cacheTtlSeconds` after.
 */
export function logCacheTelemetry(
  deps: RunnerTelemetryDeps,
  stageName: string,
  t: StageTokenStats,
): void {
  const denom = t.inputTokens + t.cacheReadTokens;
  const ratio = denom > 0 ? t.cacheReadTokens / denom : 0;
  const pct = (ratio * 100).toFixed(1);
  console.log(
    `[cache] stage=${stageName} hit=${t.cacheReadTokens}/${denom} (${pct}%)`
    + ` write=${t.cacheWriteTokens} input=${t.inputTokens} output=${t.outputTokens}`,
  );
  try {
    deps.emit('project-event', {
      source: 'cache',
      message: `Stage "${stageName}" cache hit ${pct}% (${t.cacheReadTokens.toLocaleString()} of ${denom.toLocaleString()} input-side tokens served from cache)`,
    });
  } catch { /* defensive */ }
}
