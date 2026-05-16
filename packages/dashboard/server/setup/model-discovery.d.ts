/**
 * Available-models discovery shim (Phase 3 round-8 extraction from
 * `dashboard-server.ts`).
 *
 * Wraps `provider-registry.discoverProviders()`, feeds the discovery
 * result into agent-core's tier resolver, and reshapes the result
 * into the slimmer `AvailableModelsResult` shape the Settings UI +
 * `sendInit` consume.
 */
export interface AvailableModelsResult {
    providers: Array<{
        name: string;
        displayName: string;
        type: string;
        available: boolean;
        models: string[];
        tier: string;
        envVar?: string;
        binary?: string;
        setupHint?: string;
        capabilities: string[];
    }>;
    defaultModel: string;
    defaultProvider: string;
}
export declare function discoverAvailableModels(): Promise<AvailableModelsResult>;
//# sourceMappingURL=model-discovery.d.ts.map