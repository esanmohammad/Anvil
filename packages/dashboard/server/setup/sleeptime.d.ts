/**
 * Sleeptime memory consolidation pump (Phase 3 round-6 extraction
 * from `dashboard-server.ts`).
 *
 * Walks pending proposals (from `reflectOnRun`) every N ms and
 * ratifies them via memory-core's `defaultDecide` (hash-dedupe →
 * MERGE-INTO else ADD). Cancellable via the returned `stop()` fn.
 * `ANVIL_SLEEPTIME_INTERVAL_MS=0` disables; default is 30 minutes.
 *
 * Wrapped decideFn: when a `semantic:fix-pattern` proposal ratifies
 * (add or merge-into), parse the failure into error/fix and call
 * convention-core's `checkAndPromote`. Three occurrences of the same
 * normalized error promote to a rule in
 * `<conventionsDir>/<project>/rules.json`, closing the
 * lesson → convention loop.
 */
import type { MemoryStore } from '../memory-store.js';
import type { ProjectLoader } from '../project-loader.js';
export interface ConventionPaths {
    conventionsDir: string;
    rulesDir: string;
}
export interface SleeptimeDeps {
    memoryStore: MemoryStore;
    projectLoader: ProjectLoader;
    conventionPaths: ConventionPaths;
    /** Parse a `semantic:fix-pattern` proposal's content into error/fix. */
    parseFixPatternContent: (content: unknown) => {
        error: string;
        fix: string;
    };
}
export interface SleeptimeHandle {
    /** Null when sleeptime is disabled (interval ≤ 0). */
    stop: (() => void) | null;
}
/**
 * Start the sleeptime consolidation timer. Returns `{ stop }` where
 * `stop` is null if sleeptime was disabled by env (interval 0).
 */
export declare function startSleeptimeConsolidator(deps: SleeptimeDeps): SleeptimeHandle;
//# sourceMappingURL=sleeptime.d.ts.map