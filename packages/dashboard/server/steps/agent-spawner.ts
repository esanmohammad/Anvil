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

import type { AgentManager, SpawnConfig } from '@anvil/agent-core';

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
      return {
        artifact: current.output,
        cost: current.cost.totalUsd,
        inputTokens: current.cost.inputTokens,
        outputTokens: current.cost.outputTokens,
        cacheReadTokens: current.cost.cacheReadTokens,
        cacheWriteTokens: current.cost.cacheWriteTokens,
      };
    }
    if (current.status === 'error' || current.status === 'killed') {
      throw new Error(current.error ?? 'Agent failed');
    }
    await sleep(pollMs);
  }
}
