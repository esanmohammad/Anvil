/**
 * Memory WS routes (Wave 3 + Wave 4 + Tier 4 surface).
 *
 * Read-only inspector + the PR-episode plan replay suggestion endpoint.
 * No new write surface — memory writes still go through `recordPrEpisode`
 * (auto-ratified) or the proposal queue (sleeptime ratifies).
 *
 * Routes:
 *   - get-memory-overview        → counts by kind/subtype + recent hits
 *   - search-memory              → hybridSearch results
 *   - get-plan-suggestions       → past PR episodes similar to a feature
 *                                  intent (Wave 3.2 — UI banner consumer
 *                                  will surface these before plan stage)
 *   - get-memory-hit-stats       → hitStatsByKind for the inspector
 *   - get-memory-injections      → injection log for a specific run
 */

import * as Z from './schemas.js';
import { route, type Handler } from './route.js';
import type { MemoryStore } from '../memory-store.js';

function getStore(extras: { memoryStore?: MemoryStore }) {
  return extras.memoryStore?.unwrap() ?? null;
}

export function memoryRoutes(): Record<string, Handler> {
  return {
    'get-memory-overview': route({
      input: Z.GetMemoryOverview,
      errorWireType: 'memory-error',
      handle: async (input, deps) => {
        const store = getStore(deps.extras as { memoryStore?: MemoryStore });
        if (!store) return { error: 'memory store unavailable' };
        const ns = { scope: 'project' as const, projectId: input.project };
        // Pull a reasonable window of memories per kind for the overview.
        const all = store.query(ns, { limit: 1000 });
        const counts: Record<string, number> = {};
        for (const m of all) {
          const key = `${m.kind}${m.subtype ? ':' + m.subtype : ''}`;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        const hitStats = store.injections.hitStatsByKind();
        const topHits = store.injections.topHitMemories({ limit: 10 });
        return { project: input.project, counts, hitStats, topHits };
      },
      wireType: 'memory-overview',
    }),

    'search-memory': route({
      input: Z.SearchMemory,
      errorWireType: 'memory-error',
      handle: async (input, deps) => {
        const store = getStore(deps.extras as { memoryStore?: MemoryStore });
        if (!store) return { error: 'memory store unavailable' };
        const { hybridSearch } = await import('@esankhan3/anvil-memory-core');
        const ns = { scope: 'project' as const, projectId: input.project };
        const results = await hybridSearch(store, input.query, {
          namespace: ns,
          limit: input.limit ?? 20,
        });
        return { project: input.project, query: input.query, results };
      },
      wireType: 'memory-search-results',
    }),

    'get-plan-suggestions': route({
      input: Z.GetPlanSuggestions,
      errorWireType: 'memory-error',
      handle: async (input, deps) => {
        const store = getStore(deps.extras as { memoryStore?: MemoryStore });
        if (!store) return { error: 'memory store unavailable' };
        const { retrievePrEpisodes } = await import('@esankhan3/anvil-memory-core');
        const ns = { scope: 'project' as const, projectId: input.project };
        // Restrict to merged + CI-pass (default of retrievePrEpisodes).
        // Caller renders these as "Reuse plan from PR #N?" suggestions.
        const episodes = retrievePrEpisodes(store, input.intent, {
          namespace: ns,
          limit: 5,
          successOnly: true,
        });
        return {
          project: input.project,
          intent: input.intent,
          suggestions: episodes.map((m) => ({
            memoryId: m.id,
            episode: m.content,
            createdAt: m.provenance.createdAt,
          })),
        };
      },
      wireType: 'plan-suggestions',
    }),

    'get-memory-injections': route({
      input: Z.GetMemoryInjections,
      errorWireType: 'memory-error',
      handle: (input, deps) => {
        const store = getStore(deps.extras as { memoryStore?: MemoryStore });
        if (!store) return { error: 'memory store unavailable' };
        return { runId: input.runId, records: store.injections.forRun(input.runId) };
      },
      wireType: 'memory-injections',
    }),
  };
}
