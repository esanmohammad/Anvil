/**
 * Reflection invoker — adapts memory-core's `ReflectionInvoker` contract
 * (`(systemPrompt, userPrompt) => Promise<string>`) onto the dashboard's
 * `AgentManager` so end-of-run reflection routes through stage-policy
 * tier walking (local → cheap → premium) instead of a hardcoded model.
 *
 * Why not `runLLM` from agent-core/single-shot? That helper is
 * Claude/Gemini-only (CLI subprocess). Reflection should be cheap by
 * design — `prefer: [local, cheap]` in stage-policy.yaml — so we route
 * through `AgentManager` which can drive any registered adapter,
 * including ollama / opencode.
 */

import type { AgentManager } from '@anvil/agent-core';
import type { ReflectionInvoker } from '@anvil/memory-core';
import { resolveModelForStage } from '@anvil/core-pipeline';
import { allowedToolsForStage } from '@anvil/core-pipeline';
import { pickAliveModelFromChainSync } from './provider-liveness.js';
import { resolveProviderForModel } from './provider-registry.js';
import type { ProviderName } from '@anvil/agent-core';

const REFLECTION_STAGE = 'reflection';

export interface CreateReflectionInvokerOptions {
  agentManager: AgentManager;
  project: string;
  runId?: string;
  cwd: string;
  /** Per-call timeout. Reflection is short — 60s is generous. */
  timeoutMs?: number;
}

/**
 * Build a `ReflectionInvoker` that spawns a one-shot agent on the
 * cheapest available model in the reflection chain.
 */
export function createReflectionInvoker(opts: CreateReflectionInvokerOptions): ReflectionInvoker {
  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    const chain = resolveModelForStage(REFLECTION_STAGE);
    const picked = pickAliveModelFromChainSync(chain, (modelId) => {
      const provider = resolveProviderForModel(modelId);
      return (provider ?? 'claude') as ProviderName;
    });

    const agent = opts.agentManager.spawn({
      name: `reflection-${opts.runId ?? 'adhoc'}`,
      persona: 'reflector',
      project: opts.project,
      stage: REFLECTION_STAGE,
      prompt: userPrompt,
      projectPrompt: systemPrompt,
      model: picked.model,
      cwd: opts.cwd,
      permissionMode: 'bypassPermissions',
      allowedTools: allowedToolsForStage(REFLECTION_STAGE), // [] — distillation only
      runId: opts.runId,
      timeoutMs: opts.timeoutMs ?? 60_000,
    });

    return waitForReflectionOutput(opts.agentManager, agent.id);
  };
}

/**
 * Poll an agent's status until it terminates; return raw output text.
 * On error, returns the partial output (memory-core's parseReflectionJson
 * is lenient about garbage and returns ReflectionFailure when the JSON
 * block is missing — better to surface what the model produced than
 * to throw and lose the whole run's reflection).
 */
function waitForReflectionOutput(agentManager: AgentManager, agentId: string): Promise<string> {
  return new Promise((resolve) => {
    const poll = () => {
      const current = agentManager.getAgent(agentId);
      if (!current) {
        resolve('');
        return;
      }
      if (current.status === 'done') {
        resolve(current.output ?? '');
      } else if (current.status === 'error' || current.status === 'killed') {
        resolve(current.output ?? '');
      } else {
        setTimeout(poll, 250);
      }
    };
    poll();
  });
}
