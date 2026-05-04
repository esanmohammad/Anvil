/**
 * PR-as-episode primitive (Phase 12 — plan §12).
 *
 * Builds a `Memory<PrEpisode>` with `kind = 'episodic'`, writes it
 * directly to durable storage (auto-ratified — PR episodes are
 * structured low-noise), and exposes a BM25-keyed retrieval helper
 * that filters to merged + CI-pass PRs (success patterns).
 *
 * Note: the episode `content` is a `PrEpisode` *object*, not a string.
 * `HybridMemoryStore.add` JSON-stringifies the payload for FTS so BM25
 * queries match against the JSON tokens (intent / plan / file paths).
 */

import { ulid } from 'ulid';
import { bm25Search } from '../retrieve/bm25.js';
import type { HybridMemoryStore } from '../storage/hybrid-store.js';
import type {
  Memory,
  MemoryNamespace,
  PrEpisode,
} from '../types.js';

export interface BuildPrEpisodeOptions {
  namespace: MemoryNamespace;
  /** ISO-8601; defaults to now. */
  now?: string;
  /** Provenance source run id (CI run, pipeline run). */
  runId?: string;
  /** TTL on the episode (default 365 days; PR history is long-lived). */
  ttlDays?: number;
}

export function buildPrEpisodeMemory(
  episode: PrEpisode,
  opts: BuildPrEpisodeOptions,
): Memory<PrEpisode> {
  const now = opts.now ?? new Date().toISOString();
  const ttlDays = opts.ttlDays ?? 365;
  const expiresAt =
    ttlDays >= 0
      ? new Date(Date.parse(now) + ttlDays * 86_400_000).toISOString()
      : '9999-12-31T00:00:00.000Z';

  return {
    id: ulid(),
    namespace: opts.namespace,
    kind: 'episodic',
    subtype: undefined,
    content: episode,
    tags: [
      'pr-episode',
      `ci:${episode.ciStatus}`,
      ...(episode.mergeStatus ? [`merge:${episode.mergeStatus}`] : []),
      ...(episode.reviewOutcome ? [`review:${episode.reviewOutcome}`] : []),
    ],
    confidence: 80,
    ttlDays,
    expiresAt,
    bitemporal: { validAt: now },
    decay: { lastAccessed: now, strength: 90, rehearseCount: 0 },
    provenance: {
      createdBy: 'pr-episode',
      createdAt: now,
      sourceRunId: opts.runId,
      ratifiedAt: now,
    },
  };
}

/**
 * Persist a PR episode to durable memory. Auto-ratified per plan §12.2.2 —
 * the episode is structured, so we skip the Phase 10 proposal queue.
 */
export function recordPrEpisode(
  store: HybridMemoryStore,
  episode: PrEpisode,
  opts: BuildPrEpisodeOptions,
): Memory<PrEpisode> {
  const memory = buildPrEpisodeMemory(episode, opts);
  // SqliteHotIndex serializes content via JSON.stringify regardless of T;
  // the cast is the safe bridge between the typed builder + the
  // string-default Memory<T> the storage layer assumes.
  store.add(memory as unknown as Memory);
  return memory;
}

export interface RetrievePrEpisodesOptions {
  namespace: MemoryNamespace;
  /** BM25 result cap before filtering. Default 30. */
  bm25Limit?: number;
  /** Final cap after filtering. */
  limit?: number;
  /**
   * If true, only return PRs that merged with green CI (success
   * patterns). Default true — that's the plan's primary use case.
   */
  successOnly?: boolean;
}

/**
 * Retrieve past PR episodes whose intent/plan/files match the query.
 * Reuses Phase 8 BM25 and post-filters by ciStatus + mergeStatus.
 */
export function retrievePrEpisodes(
  store: HybridMemoryStore,
  query: string,
  opts: RetrievePrEpisodesOptions,
): Memory<PrEpisode>[] {
  const successOnly = opts.successOnly ?? true;
  const bm25Limit = opts.bm25Limit ?? 30;

  const candidates = bm25Search(store, query, {
    namespace: opts.namespace,
    limit: bm25Limit,
  });

  const filtered = candidates
    .filter((m) => m.kind === 'episodic')
    .filter((m) => isPrEpisode(m))
    .filter((m) => {
      if (!successOnly) return true;
      const ep = m.content as unknown as PrEpisode;
      return ep.ciStatus === 'pass' && ep.mergeStatus === 'merged';
    })
    .map((m) => m as unknown as Memory<PrEpisode>);

  return opts.limit ? filtered.slice(0, opts.limit) : filtered;
}

function isPrEpisode(m: Memory): boolean {
  return (
    m.kind === 'episodic' &&
    typeof m.content === 'object' &&
    m.content !== null &&
    'prUrl' in (m.content as Record<string, unknown>) &&
    'ciStatus' in (m.content as Record<string, unknown>)
  );
}
