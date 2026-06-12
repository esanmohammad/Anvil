/**
 * `ProviderRegistryAdapterResolver` — the `LlmRouter`'s `AdapterResolver`,
 * backed by the process-wide `ProviderRegistry`.
 *
 * Resolves a model id → provider (`registry.resolveFromModelId`) → the
 * registered `ModelAdapter`, then wraps it via `legacyAdapterToLanguageModel`
 * so the router sees a uniform `LanguageModel`. Provider-prefixed ids
 * (`opencode/minimax-m2.5`, `adk:gemini-2.5-flash`) resolve to the right
 * adapter; the adapter strips its own prefix before the upstream call, so the
 * full id is passed through unchanged.
 */

import { ProviderRegistry } from '../registry.js';
import { legacyAdapterToLanguageModel } from '../agent/session/legacy-adapter-language-model.js';
import { LlmRouter, type AdapterResolver } from './router.js';
import { loadModelRegistry } from './model-registry.js';
import { DEFAULT_RETRY_POLICY } from './retry.js';
import { DEFAULT_CIRCUIT_BREAKER } from './circuit-breaker.js';
import type { LanguageModel } from '../types.js';
import type { RouterConfig, RetryPolicy, ErrorClass } from './types.js';

export class ProviderRegistryAdapterResolver implements AdapterResolver {
  constructor(private readonly registry: ProviderRegistry = ProviderRegistry.getInstance()) {}

  resolve(modelId: string): LanguageModel {
    const provider = this.registry.resolveFromModelId(modelId);
    const adapter = this.registry.get(provider);
    if (!adapter) {
      throw new Error(`router resolver: no adapter registered for model '${modelId}' (provider '${provider}')`);
    }
    return legacyAdapterToLanguageModel(adapter);
  }
}

/** Convenience factory — defaults to the singleton registry. */
export function providerRegistryAdapterResolver(registry?: ProviderRegistry): AdapterResolver {
  return new ProviderRegistryAdapterResolver(registry);
}

/**
 * Build the agentic router's config from `~/.anvil/models.yaml`'s `walker:`
 * block — the user's single config file. Only `retryPolicy` + `circuitBreaker`
 * matter for `runAgent` (the chain is injected via `resolveModel`, not tag
 * routes), and both default to the well-tuned compiled defaults unless the
 * walker block overrides them. This replaces the old `llm-router.yaml` source,
 * which is no longer read for the agentic path. A malformed models.yaml falls
 * back to defaults rather than breaking every run.
 */
function buildAgentRouterConfig(): RouterConfig {
  let walker: ReturnType<typeof loadModelRegistry>['walker'] | undefined;
  try {
    walker = loadModelRegistry().walker;
  } catch {
    walker = undefined;
  }
  const retryPolicy: Record<ErrorClass, RetryPolicy> = { ...DEFAULT_RETRY_POLICY };
  if (walker?.retry) {
    for (const [cls, override] of Object.entries(walker.retry)) {
      const key = cls as ErrorClass;
      retryPolicy[key] = { ...retryPolicy[key], ...override };
    }
  }
  const circuitBreaker = { ...DEFAULT_CIRCUIT_BREAKER, ...(walker?.circuit_breaker ?? {}) };
  return { routes: [], retryPolicy, circuitBreaker };
}

/**
 * Process-wide shared `LlmRouter` for the AGENTIC path (`runAgent`). The
 * circuit-breaker state is intentionally process-scoped — a provider that's
 * down is down for every run/stage, and recovers via the breaker's half-open
 * probe. cli + dashboard both call this so reliability is unified across
 * consumers and tuned from one place (`models.yaml` → `walker:`).
 */
let sharedAgentRouter: LlmRouter | null = null;
export function getAgentReliabilityRouter(): LlmRouter {
  if (!sharedAgentRouter) {
    sharedAgentRouter = new LlmRouter({
      config: buildAgentRouterConfig(),
      resolver: providerRegistryAdapterResolver(),
    });
  }
  return sharedAgentRouter;
}

/** Test seam — drop the shared router so breaker state doesn't leak across cases. */
export function _resetAgentReliabilityRouter(): void {
  sharedAgentRouter = null;
}
