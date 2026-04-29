/**
 * Adapter factory — resolves a model id to an `@anvil/agent-core`
 * `ModelAdapter` and wraps it in an `AgentCoreBridge` so the dashboard's
 * `BaseAdapter` consumers (AgentManager, AgentProcess, prompt-envelope,
 * token-util) keep their existing event-emit interface.
 *
 * Provider resolution preserves dashboard-specific behavior that
 * agent-core's registry doesn't carry:
 *   - `gemini-*` prefers the Gemini CLI when the binary is on PATH; if not,
 *     falls back to the HTTP API adapter (`gemini`).
 *   - Model ids containing `/` route to OpenRouter.
 *   - Otherwise we delegate to `ProviderRegistry.resolveFromModelId` which
 *     covers Claude / OpenAI / Gemini-API.
 *
 * Phase 1 of the dashboard consolidation. See DASHBOARD-CONSOLIDATION-PLAN.md.
 */

import { execSync } from 'node:child_process';
import { ProviderRegistry, type ModelAdapter, type ProviderName } from '@anvil/agent-core';
import { BaseAdapter, type AdapterConfig } from './base-adapter.js';
import { AgentCoreBridge } from './agent-core-bridge.js';

// ── Provider resolution ──────────────────────────────────────────────────

/**
 * Resolve which agent-core provider should handle a given model id.
 *
 * Mirrors the legacy dashboard heuristic so call sites that pre-compute the
 * provider string (e.g., for logging) keep behaving the same.
 */
export function resolveProvider(modelId: string): ProviderName {
  return resolveProviderByHeuristic(modelId);
}

export function resolveProviderByHeuristic(modelId: string): ProviderName {
  const id = modelId.toLowerCase();

  // Gemini: prefer CLI when available, fall back to HTTP API.
  if (id.startsWith('gemini-')) {
    if (geminiCliAvailable()) return 'gemini-cli';
    return 'gemini';
  }

  // OpenAI patterns
  if (
    id.startsWith('gpt-') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('o4') ||
    id.startsWith('chatgpt-')
  ) {
    return 'openai';
  }

  // OpenRouter uses `org/model` format
  if (id.includes('/')) {
    return 'openrouter';
  }

  // Claude (default)
  return 'claude';
}

// Cache the CLI probe so repeated factory calls don't fork a shell each time.
let geminiCliCached: boolean | null = null;
function geminiCliAvailable(): boolean {
  if (geminiCliCached !== null) return geminiCliCached;
  try {
    execSync('which gemini', { stdio: 'pipe', timeout: 2000 });
    geminiCliCached = true;
  } catch {
    geminiCliCached = false;
  }
  return geminiCliCached;
}

// ── Factory ──────────────────────────────────────────────────────────────

/**
 * Create the appropriate adapter for a given config.
 * Returned adapter is always an `AgentCoreBridge` — the dashboard sees the
 * familiar `BaseAdapter` event surface; agent-core handles the actual call.
 */
export function createAdapter(config: AdapterConfig): BaseAdapter {
  const registry = ProviderRegistry.getInstance();
  const provider = resolveProvider(config.model);
  const adapter = resolveAdapterOrFallback(registry, provider);
  return new AgentCoreBridge(config, adapter.adapter, adapter.provider);
}

function resolveAdapterOrFallback(
  registry: ProviderRegistry,
  provider: ProviderName,
): { adapter: ModelAdapter; provider: ProviderName } {
  const direct = registry.get(provider);
  if (direct) return { adapter: direct, provider };

  // Claude is always registered by registerDefaults; treat as the safe fallback.
  const claude = registry.get('claude');
  if (claude) return { adapter: claude, provider: 'claude' };

  throw new Error(
    `No agent-core adapter available for provider "${provider}" and no "claude" fallback registered.`,
  );
}
