/**
 * Per-repo chunk files: each repo's chunks live in `<repo>/chunks.ndjson`
 * (NDJSON, one CodeChunk per line), written only when that repo is
 * re-chunked — so an index cycle reads and writes the chunks of the repos
 * that changed, not the whole corpus. Indexes written by older versions keep
 * every repo in one project-wide `chunks.json`; buildKB splits it once
 * (`splitLegacyChunks`) and readers fall back to it until then.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';
import type { BlobStorePort } from './storage/ports.js';
import { createChunkWriter, iterateChunksFile } from './chunks-io.js';

/** Blob key of a repo's chunk file. */
export const repoChunksKey = (repoName: string): string => `${repoName}/chunks.ndjson`;

/** The project-wide chunk file older versions wrote. */
export const LEGACY_CHUNKS_KEY = 'chunks.json';

export interface RepoChunkTotals { chunks: number; tokens: number }

/** Repos of the project's current index, from the stats rollup buildKB writes. */
export async function indexedRepoNames(blobs: BlobStorePort): Promise<string[]> {
  const stats = await blobs
    .getJson<{ repos?: Array<{ name: string }> }>('index_stats.json')
    .catch(() => null);
  return (stats?.repos ?? []).map((r) => r.name);
}

/** The chunks of `repoNames`, repo by repo. Repos without their own file yet
 *  (an index not upgraded) are read from the legacy project-wide file. */
export async function* iterateRepoChunks(blobs: BlobStorePort, repoNames: string[]): AsyncGenerator<CodeChunk> {
  const missing = new Set<string>();
  for (const name of repoNames) {
    if (await blobs.exists(repoChunksKey(name))) yield* blobs.iterateNdjson<CodeChunk>(repoChunksKey(name));
    else missing.add(name);
  }
  if (missing.size > 0 && (await blobs.exists(LEGACY_CHUNKS_KEY))) {
    for await (const c of blobs.iterateNdjson<CodeChunk>(LEGACY_CHUNKS_KEY)) {
      if (missing.has(c.repoName)) yield c;
    }
  }
}

/**
 * One-time upgrade: copy each of `repoNames`' chunks out of the legacy
 * project-wide file into its own file, via local scratch under `scratchDir`.
 * A single pass over the legacy file; it lists a repo's chunks mostly
 * contiguously, so one scratch file is open at a time (reopened to append
 * when a repo shows up again). Returns each repo's totals.
 */
export async function splitLegacyChunks(
  blobs: BlobStorePort,
  scratchDir: string,
  repoNames: Set<string>,
): Promise<Map<string, RepoChunkTotals>> {
  const totals = new Map<string, RepoChunkTotals>();
  if (repoNames.size === 0 || !(await blobs.exists(LEGACY_CHUNKS_KEY))) return totals;
  const dir = join(scratchDir, '.chunk-split');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const scratch = (name: string) => join(dir, `${encodeURIComponent(name)}.ndjson`);
  let openName: string | null = null;
  let writer: ReturnType<typeof createChunkWriter> | null = null;
  try {
    for await (const c of blobs.iterateNdjson<CodeChunk>(LEGACY_CHUNKS_KEY)) {
      if (!repoNames.has(c.repoName)) continue;
      if (!writer || openName !== c.repoName) {
        writer?.close();
        writer = createChunkWriter(scratch(c.repoName), { append: totals.has(c.repoName) });
        openName = c.repoName;
      }
      writer.write(c);
      const t = totals.get(c.repoName) ?? { chunks: 0, tokens: 0 };
      t.chunks++;
      t.tokens += c.tokens;
      totals.set(c.repoName, t);
    }
    writer?.close();
    writer = null;
    for (const name of totals.keys()) await blobs.putNdjson(repoChunksKey(name), iterateChunksFile(scratch(name)));
  } finally {
    writer?.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return totals;
}

/** Blob key of the list of repos whose chunk files changed (or that were
 *  removed) since the embed step last applied them. */
export const EMBED_PENDING_KEY = 'embed_pending.json';

/** Repos the embed step must diff, embed and sweep. `all`: an index from
 *  before the list existed — one full pass over every repo. */
export interface EmbedPending { all: boolean; repos: string[]; removed: string[] }

export async function readEmbedPending(blobs: BlobStorePort): Promise<EmbedPending> {
  const p = await blobs.getJson<Partial<EmbedPending>>(EMBED_PENDING_KEY).catch(() => null);
  if (!p) return { all: true, repos: [], removed: [] };
  return { all: !!p.all, repos: p.repos ?? [], removed: p.removed ?? [] };
}
