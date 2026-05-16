/**
 * Available-models discovery shim (Phase 3 round-8 extraction from
 * `dashboard-server.ts`).
 *
 * Wraps `provider-registry.discoverProviders()`, feeds the discovery
 * result into agent-core's tier resolver, and reshapes the result
 * into the slimmer `AvailableModelsResult` shape the Settings UI +
 * `sendInit` consume.
 */
import { discoverProviders } from '../provider-registry.js';
import { setDiscoveryResult } from '@esankhan3/anvil-agent-core';
export async function discoverAvailableModels() {
    const discovery = await discoverProviders();
    // Feed the tier resolver so it can map weight classes to actual model IDs
    setDiscoveryResult(discovery);
    return {
        providers: discovery.providers.map((p) => ({
            name: p.name,
            displayName: p.displayName,
            type: p.type,
            available: p.available,
            models: p.models.map((m) => m.id),
            tier: p.capabilities.includes('agentic')
                ? 'agentic'
                : p.capabilities.includes('chat')
                    ? 'chat'
                    : 'embedding',
            envVar: p.envVar,
            binary: p.binary,
            setupHint: p.setupHint,
            capabilities: p.capabilities,
        })),
        defaultModel: discovery.defaultModel,
        defaultProvider: discovery.defaultProvider,
    };
}
//# sourceMappingURL=model-discovery.js.map