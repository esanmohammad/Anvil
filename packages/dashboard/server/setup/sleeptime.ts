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
  parseFixPatternContent: (content: unknown) => { error: string; fix: string };
}

export interface SleeptimeHandle {
  /** Null when sleeptime is disabled (interval ≤ 0). */
  stop: (() => void) | null;
}

/**
 * Start the sleeptime consolidation timer. Returns `{ stop }` where
 * `stop` is null if sleeptime was disabled by env (interval 0).
 */
export function startSleeptimeConsolidator(deps: SleeptimeDeps): SleeptimeHandle {
  const sleeptimeIntervalMs = (() => {
    const raw = process.env.ANVIL_SLEEPTIME_INTERVAL_MS;
    if (raw === undefined) return 30 * 60_000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 30 * 60_000;
  })();

  if (sleeptimeIntervalMs <= 0) {
    return { stop: null };
  }

  const runSleeptime = async (): Promise<void> => {
    try {
      const { consolidate, defaultDecide, ProposalQueue } = await import('@esankhan3/anvil-memory-core');
      const { checkAndPromote } = await import('@esankhan3/anvil-convention-core');
      const projects = await deps.projectLoader.listProjects().catch(() => []);
      const store = deps.memoryStore.unwrap();
      const queue = new ProposalQueue(store.sqlite);
      let total = 0;
      for (const sys of projects) {
        const decideFn = async (
          s: typeof store,
          proposal: Parameters<typeof defaultDecide>[1],
        ) => {
          const decision = defaultDecide(s, proposal);
          try {
            const cand = proposal.candidate;
            if (
              cand.kind === 'semantic' &&
              cand.subtype === 'fix-pattern' &&
              (decision.kind === 'add' || decision.kind === 'merge-into')
            ) {
              const { error, fix } = deps.parseFixPatternContent(cand.content);
              if (error && fix) {
                const promoted = checkAndPromote(deps.conventionPaths, error, fix, sys.name);
                if (promoted.promoted && promoted.rule) {
                  console.log(
                    `[sleeptime] promoted convention rule for "${sys.name}": ${promoted.rule.id}`,
                  );
                }
              }
            }
          } catch (err) {
            console.warn('[sleeptime] promotion hook failed:', err);
          }
          return decision;
        };
        const result = await consolidate(
          store,
          queue,
          { scope: 'project', projectId: sys.name },
          { decideFn },
        );
        total += result.ratified + result.merged;
      }
      if (total > 0) {
        console.log(`[sleeptime] consolidated ${total} proposal(s) across ${projects.length} project(s)`);
      }
    } catch (err) {
      console.warn('[sleeptime] consolidate failed:', err);
    }
  };

  const timer = setInterval(runSleeptime, sleeptimeIntervalMs);
  timer.unref?.();
  console.log(`[dashboard] sleeptime consolidation every ${Math.round(sleeptimeIntervalMs / 60_000)}m`);

  return {
    stop: () => { try { clearInterval(timer); } catch { /* ignore */ } },
  };
}
