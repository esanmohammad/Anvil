/**
 * Init-payload sender (Phase 3 round-7 extraction from
 * `dashboard-server.ts`).
 *
 * `createInitSender(deps)` returns the `sendInit(ws)` closure called
 * for every newly-connected socket.io client. The function packs:
 *   - project summaries (from `projectLoader.listProjects`)
 *   - run history (`loadRunsSync`)
 *   - dashboard state (`readStateFile`)
 *   - feature records
 *   - tracked PRs (`trackedPRsForBroadcast`)
 *   - active runs snapshot
 *   - discovered models
 *
 * It also pre-warms the broadcaster's dedup string so the next state
 * watcher tick won't re-emit a `state` event identical to the one
 * embedded in this frame, then replays the accumulated `outputBuffer`
 * so the connecting client catches up on agent activity that fired
 * before it subscribed.
 *
 * The factory takes a `getOutputBuffer()` getter (rather than the
 * array directly) because dashboard-server rebinds `outputBuffer`
 * on every pipeline / quick-action start.
 */
import type { ProjectLoader } from '../project-loader.js';
import type { FeatureStore } from '../feature-store.js';
import type { Broadcaster, ActiveRun, ActivityEntry } from '../broadcasts.js';
import type { WsClient } from './ws-client.js';
import type { DashboardState } from '../dashboard-server.js';
import type { TrackedPR } from '../pipeline/pr-tracking.js';
/**
 * Discovery shape — mirrors `AvailableModelsResult` in dashboard-server.ts
 * but redeclared here to keep the module independent of the larger file.
 */
export interface AvailableModelsLike {
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
export interface InitSenderDeps {
    projectLoader: ProjectLoader;
    featureStore: FeatureStore;
    broadcaster: Broadcaster;
    activeRuns: Map<string, ActiveRun>;
    discoverAvailableModels: () => Promise<AvailableModelsLike>;
    loadRunsSync: () => unknown[];
    readStateFile: () => DashboardState;
    trackedPRsForBroadcast: () => Array<TrackedPR & {
        review: unknown;
    }>;
    /** Returns the current outputBuffer reference (may be re-bound by pipeline / quick-action starts). */
    getOutputBuffer: () => ActivityEntry[];
}
export type SendInitFn = (ws: WsClient) => Promise<void>;
export declare function createInitSender(deps: InitSenderDeps): SendInitFn;
//# sourceMappingURL=init-payload.d.ts.map