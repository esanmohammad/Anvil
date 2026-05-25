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

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { MemoryStore } from '../memory-store.js';
import type { ProjectLoader } from '../project-loader.js';

function getWorkspaceRootForProject(projectName: string): string {
  const root =
    process.env.ANVIL_WORKSPACE_ROOT ??
    process.env.FF_WORKSPACE_ROOT ??
    join(homedir(), 'workspace');
  return join(root, projectName);
}

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

  const driftDisabled = process.env.ANVIL_DRIFT_SWEEP_DISABLED === '1';
  const llmDedupeDisabled = process.env.ANVIL_LLM_DEDUPE_DISABLED === '1';
  const embedBackfillDisabled = process.env.ANVIL_MEMORY_EMBED_BACKFILL_DISABLED === '1';
  // Bound per-tick backfill so a project with thousands of un-embedded
  // memories doesn't monopolize the tick. 100 ≈ 30s with local Ollama.
  const embedBackfillBatch = (() => {
    const raw = process.env.ANVIL_MEMORY_EMBED_BATCH;
    if (raw === undefined) return 100;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 100;
  })();

  const runSleeptime = async (): Promise<void> => {
    try {
      const { consolidate, defaultDecide, llmDedupeDecide, ProposalQueue, verifyCodeBindings, embedMemoriesBatch } =
        await import('@esankhan3/anvil-memory-core');
      const { checkAndPromote } = await import('@esankhan3/anvil-convention-core');
      const projects = await deps.projectLoader.listProjects().catch(() => []);
      const store = deps.memoryStore.unwrap();
      const queue = new ProposalQueue(store.sqlite);
      let total = 0;
      let driftDriftedTotal = 0;
      let driftMissingTotal = 0;
      for (const sys of projects) {
        // LLM-aware decideFn when an AgentManager is wired AND not
        // env-disabled. Otherwise legacy hash-only `defaultDecide`.
        const baseDecide = (deps.agentManager && !llmDedupeDisabled)
          ? await buildLlmDecide(deps.agentManager, sys.name)
          : (s: typeof store, p: Parameters<typeof defaultDecide>[1]) =>
              Promise.resolve(defaultDecide(s, p));

        const decideFn = async (
          s: typeof store,
          proposal: Parameters<typeof defaultDecide>[1],
        ) => {
          const decision = await baseDecide(s, proposal);
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

        // Drift sweep — re-hash code-bound memories per project.
        if (!driftDisabled) {
          try {
            const driftResult = verifyCodeBindings(
              store,
              { scope: 'project', projectId: sys.name },
              {
                workspaceRoot: getWorkspaceRootForProject(sys.name),
                staleAfterDays: 7,
                // Conservative default: downweight on both drift AND
                // missing. A mass-rename (`mv src/foo src/bar`) would
                // otherwise nuke half a project's memories. Operators
                // can flip to `'invalidate'` via env once they're
                // comfortable.
                driftPolicy: 'downweight',
                missingPolicy: 'downweight',
              },
            );
            driftDriftedTotal += driftResult.drifted;
            driftMissingTotal += driftResult.missing;
            if (driftResult.drifted + driftResult.missing > 0) {
              console.log(
                `[sleeptime] drift sweep "${sys.name}": ${driftResult.drifted} drifted, ${driftResult.missing} missing, ${driftResult.fresh} fresh`,
              );
            }
          } catch (err) {
            console.warn('[sleeptime] drift sweep failed:', err);
          }
        }
      }
      if (total > 0) {
        console.log(`[sleeptime] consolidated ${total} proposal(s) across ${projects.length} project(s)`);
      }

      // Embed backfill — process the newest unembedded memories per
      // tick, capped at `embedBackfillBatch`. No-op when the embedder
      // isn't installed, lancedb isn't available, or env-disabled.
      if (!embedBackfillDisabled && embedBackfillBatch > 0) {
        try {
          const r = await embedMemoriesBatch(store, { limit: embedBackfillBatch });
          if (r.embedded > 0) {
            console.log(
              `[sleeptime] embed backfill: ${r.embedded} embedded, ${r.skipped} skipped`,
            );
          }
        } catch (err) {
          console.warn('[sleeptime] embed backfill failed:', err);
        }
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

/**
 * Build the LLM-aware `baseDecide` for one project's consolidation pass.
 * Curries `agentManager` + `workspaceRoot` into a `DedupeJudge`, then
 * binds it to `llmDedupeDecide` so memory-core can call it like any
 * other `decideFn` (returns `Promise<RatificationDecision>`).
 */
async function buildLlmDecide(
  agentManager: AgentManager,
  projectName: string,
) {
  const { llmDedupeDecide } = await import('@esankhan3/anvil-memory-core');
  const { createDedupeJudge } = await import('../dedupe-judge.js');
  const judge = createDedupeJudge({
    agentManager,
    project: projectName,
    cwd: getWorkspaceRootForProject(projectName),
  });
  return (
    s: Parameters<typeof llmDedupeDecide>[0],
    p: Parameters<typeof llmDedupeDecide>[1],
  ) => llmDedupeDecide(s, p, judge);
}
