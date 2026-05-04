/**
 * `runWithAgent` — single-shot helper for callers that don't need the
 * full `AgentManager` registry (cli `commands/diff`, `commands/learn`,
 * `commands/migrate`, `commands/test-gen`).
 *
 * Internally constructs an `AgentManager`, spawns one agent against the
 * given `SpawnConfig`, awaits completion, and returns the assembled
 * result + cost. Saves callers from re-implementing the
 * spawn-and-stream-parse pattern with bare `child_process.spawn`.
 *
 * No checkpoint cache — for cache-aware single-shot execution wrap the
 * call site with `runWithCheckpoint` (see `@anvil/agent-core/checkpoint`).
 */

import { AgentManager } from './session-registry.js';
import type { AgentAdapterFactory } from './adapter.js';
import type { AgentState, CostInfo, SpawnConfig } from './types.js';

export interface RunWithAgentOptions {
  /** Override the default adapter factory (test seam). */
  adapterFactory?: AgentAdapterFactory;
  /** AbortSignal — triggers `kill()` on the spawned agent. */
  signal?: AbortSignal;
}

export interface RunWithAgentResult {
  /** Final assembled output text. */
  output: string;
  /** Cost + token usage. */
  cost: CostInfo;
  /** Final agent state snapshot (status will be 'done', 'error', or 'killed'). */
  state: AgentState;
}

/**
 * Run a single agent to completion. Resolves with the final output + cost,
 * or rejects when the agent fails or is killed. Cancellation via
 * `opts.signal.abort()` triggers `kill()` and rejects with `AbortError`.
 */
export async function runWithAgent(
  spec: SpawnConfig,
  opts: RunWithAgentOptions = {},
): Promise<RunWithAgentResult> {
  const manager = new AgentManager(
    opts.adapterFactory ? { adapterFactory: opts.adapterFactory } : {},
  );

  return new Promise<RunWithAgentResult>((resolve, reject) => {
    let agentId: string | undefined;
    let finished = false;

    const finish = (cb: () => void) => {
      if (finished) return;
      finished = true;
      cb();
    };

    manager.on('agent-done', ({ agent }) => {
      if (agent.id !== agentId) return;
      finish(() => {
        resolve({ output: agent.output, cost: agent.cost, state: agent });
      });
    });

    manager.on('agent-error', ({ agentId: errId, error }) => {
      if (errId !== agentId) return;
      finish(() => {
        reject(new Error(error || 'Agent failed'));
      });
    });

    if (opts.signal) {
      const onAbort = () => {
        if (agentId) {
          try { manager.kill(agentId); } catch { /* ignore */ }
        }
        finish(() => {
          const err = new Error('Aborted') as Error & { name: string };
          err.name = 'AbortError';
          reject(err);
        });
      };
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const state = manager.spawn(spec);
      agentId = state.id;
      // If the spawn synthesized 'done' (checkpoint cache hit), resolve
      // synchronously with the pre-populated state.
      if (state.status === 'done') {
        finish(() => {
          resolve({ output: state.output, cost: state.cost, state });
        });
      }
    } catch (err) {
      finish(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}
