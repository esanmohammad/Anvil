/**
 * `agent-spawner` — Phase 4f.1 of the dashboard consolidation.
 *
 * Wraps the spawn → poll → resolve / handle-truncation pattern that
 * `pipeline-runner.ts:waitForAgent()` implements today. Lifting it here
 * lets the per-stage Steps that land in 4f.2+ share a single spawn path
 * without each Step re-implementing the polling + cancellation machinery.
 *
 * Behavior parity with pipeline-runner.ts:waitForAgent():
 *   - Polls every 500ms via `setTimeout` (same cadence as the legacy)
 *   - Reject on cancellation OR `agent.status === 'error' | 'killed'`
 *   - Resolve on `agent.status === 'done'`, returning artifact + cost
 *   - Fires `onTruncation` when stop_reason is `max_tokens`
 *
 * Test seam: `now`, `sleep`, and `pollIntervalMs` are injectable so
 * tests can drive the polling loop deterministically.
 */

import type { AgentManager, SpawnConfig } from '@esankhan3/anvil-agent-core';

export interface SpawnAndWaitOptions {
  /** AgentManager instance owned by the caller (PipelineRunner today). */
  agentManager: AgentManager;
  /** Spawn config forwarded verbatim to AgentManager.spawn(). */
  spec: SpawnConfig;
  /** Returns true when the run has been cancelled — checked at every poll. */
  isCancelled: () => boolean;
  /** Called once with the freshly-spawned agent id. */
  onSpawn?: (agentId: string) => void;
  /**
   * Called when the agent's stop_reason is 'max_tokens' (output ceiling
   * reached). Mirrors `pipeline-runner.ts:handleOutputTruncation()`.
   */
  onTruncation?: (agentName: string, outputTokens: number) => void;
  /** Override poll cadence; defaults to 500ms (legacy). Test seam. */
  pollIntervalMs?: number;
  /** Override the sleep primitive — test seam. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SpawnAndWaitResult {
  agentId: string;
  artifact: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const DEFAULT_POLL_MS = 500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn an agent and resolve when it completes. Returns the agent's id,
 * its emitted artifact, and total USD cost. Rejects on cancellation or
 * agent-side error/kill.
 *
 * Caller is responsible for any state mutation (e.g. assigning agentId
 * onto a stage record + broadcasting). This helper stays purely about
 * spawn lifecycle.
 */
export async function spawnAndWait(
  opts: SpawnAndWaitOptions,
): Promise<SpawnAndWaitResult> {
  const agent = opts.agentManager.spawn(opts.spec);
  opts.onSpawn?.(agent.id);
  const completed = await waitForAgent({
    agentId: agent.id,
    agentManager: opts.agentManager,
    isCancelled: opts.isCancelled,
    onTruncation: opts.onTruncation,
    pollIntervalMs: opts.pollIntervalMs,
    sleep: opts.sleep,
  });
  return {
    agentId: agent.id,
    artifact: completed.artifact,
    cost: completed.cost,
    inputTokens: completed.inputTokens,
    outputTokens: completed.outputTokens,
    cacheReadTokens: completed.cacheReadTokens,
    cacheWriteTokens: completed.cacheWriteTokens,
  };
}

/**
 * Reconstruct an UpstreamError-shaped exception from the stringified
 * error stored in `AgentState.error`. The bridge stringifies the
 * adapter's thrown error before we ever see it (see
 * `language-model-bridge.ts:259`), losing the structured shape. We
 * parse the canonical UpstreamError format `<provider> <status>: <body>`
 * and rehydrate a duck-typed UpstreamError so the router's agentic chain
 * walk (`LlmRouter.runAgent`) sees a structured status and burns/falls
 * back instead of failing the stage on first attempt.
 *
 * Note: `LlmRouter`'s `classifyError` also matches the error *message*
 * (e.g. "fetch failed"), so a transient failure is caught even when this
 * rehydration can't recover a structured status; the rehydration just
 * gives a cleaner status for classification + logs.
 */
function rehydrateAgentError(raw: string | null): Error {
  const msg = raw ?? 'Agent failed';
  const m = msg.match(/^([\w-]+)\s+(\d{3}):/);
  if (!m) return new Error(msg);
  const provider = m[1];
  const status = Number(m[2]);
  const retryable = status === 429 || status === 502 || status === 503 || status === 504;
  const err = new Error(msg) as Error & {
    name: string;
    status: number;
    retryable: boolean;
    provider: string;
  };
  err.name = 'UpstreamError';
  err.status = status;
  err.retryable = retryable;
  err.provider = provider;
  return err;
}

export interface WaitForAgentOptions {
  agentId: string;
  agentManager: AgentManager;
  isCancelled: () => boolean;
  onTruncation?: (agentName: string, outputTokens: number) => void;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Poll an already-spawned agent until it completes. Used by
 * `pipeline-runner.ts` legacy paths that spawn their agents directly
 * (per-repo fanout, per-task build) and just need the wait machinery.
 */
export interface WaitForAgentResult {
  artifact: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export async function waitForAgent(
  opts: WaitForAgentOptions,
): Promise<WaitForAgentResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

  while (true) {
    if (opts.isCancelled()) {
      throw new Error('Pipeline cancelled');
    }
    const current = opts.agentManager.getAgent(opts.agentId);
    if (!current) {
      throw new Error('Agent disappeared');
    }
    if (current.status === 'done') {
      if (current.cost.stopReason === 'max_tokens') {
        opts.onTruncation?.(current.name, current.cost.outputTokens);
      }
      // Prefer finalAnswer (canonical artifact from the adapter's
      // terminal `result` event) over output (streaming transcript).
      // Fall back to output for cache-hit replays from before the field
      // existed and any path that doesn't fire a structured result.
      return {
        artifact: current.finalAnswer || current.output,
        cost: current.cost.totalUsd,
        inputTokens: current.cost.inputTokens,
        outputTokens: current.cost.outputTokens,
        cacheReadTokens: current.cost.cacheReadTokens,
        cacheWriteTokens: current.cost.cacheWriteTokens,
      };
    }
    if (current.status === 'error' || current.status === 'killed') {
      throw rehydrateAgentError(current.error);
    }
    await sleep(pollMs);
  }
}
