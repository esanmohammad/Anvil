/**
 * Sleeptime memory consolidation pump (Phase 3 round-6 extraction
 * from `dashboard-server.ts`).
 *
 * Per tick, two passes per project:
 *   1. Consolidation — walks pending proposals (from `reflectOnRun`)
 *      and ratifies via memory-core's `defaultDecide`. fix-pattern
 *      ratifications also trigger convention-core's `checkAndPromote`
 *      (3-strike rule promotion).
 *   2. Drift sweep — `verifyCodeBindings` re-hashes every code-bound
 *      memory; structurally-changed files trigger `downweight`,
 *      missing files also downweight (NOT invalidate — see risk
 *      mitigation in MEMORY-CORE-COMPLETENESS-PLAN.md §7: a
 *      `mv src/foo src/bar` would mass-invalidate otherwise).
 *
 * `ANVIL_SLEEPTIME_INTERVAL_MS=0` disables both passes; default 30 min.
 * `ANVIL_DRIFT_SWEEP_DISABLED=1` disables drift sweep only.
 */
import type { AgentManager } from '@esankhan3/anvil-agent-core';
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
    /**
     * Optional — when present, near-duplicate ratification routes through an
     * LLM judge (Tier 2.3). Absent dep degrades to legacy hash-only behavior.
     */
    agentManager?: AgentManager;
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