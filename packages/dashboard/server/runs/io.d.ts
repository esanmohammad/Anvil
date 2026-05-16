/**
 * Run / state-file I/O helpers (Phase 3 round-8 extraction from
 * `dashboard-server.ts`).
 *
 * Pure file-readers — no closure deps. The dashboard-server passes
 * the canonical `RUNS_INDEX` + `STATE_FILE` paths into the
 * factory-style wrappers so tests can target a temp ANVIL_HOME.
 */
import type { RunSummary, DashboardState } from '../dashboard-server.js';
/** Parse `RUNS_INDEX` (JSONL) into `RunSummary[]`, newest first. */
export declare function loadRunsSync(runsIndex: string): RunSummary[];
/** Read `state.json`; return a fresh empty state on any read/parse error. */
export declare function readStateFile(stateFile: string): DashboardState;
//# sourceMappingURL=io.d.ts.map