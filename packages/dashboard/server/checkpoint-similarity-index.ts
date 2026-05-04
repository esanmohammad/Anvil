/**
 * Phase 7 — JSON-backed similarity index for the checkpoint cache.
 *
 * Each entry pairs a prompt embedding (from `prompt-similarity.ts`) with
 * the slot key fields (`runFamily`, `stage`, `taskId`, `model`,
 * `promptVersion`) and the content-addressed `outputRef` of the cached
 * checkpoint blob. `nearest()` filters to entries inside the same slot and
 * returns the highest-cosine match if it clears `threshold`.
 *
 * ── Why scope similarity to the slot ────────────────────────────────────
 *
 * Without the slot filter, a "clarify" prompt could match a "ship" prompt
 * with the same surface form, or a Sonnet output could be served to a Haiku
 * caller. The slot filter mirrors the exact-hash key (everything except the
 * prompt content), so similarity only relaxes the *one* dimension we
 * actually want to relax.
 *
 * ── Persistence ─────────────────────────────────────────────────────────
 *
 * Single JSON file at:
 *   <anvilHome>/checkpoints/<project>/_similarity-index.json
 *
 * Atomically written via tmp + renameSync (matching `checkpoint-store.ts`).
 * Loaded lazily on the first `add` / `nearest`. Corrupt JSON is replaced
 * with an empty index (logged to stderr) — same posture as the rest of the
 * checkpoint subsystem.
 *
 * The format embeds an `embeddingVersion` so a future change to the
 * embedding shape (DIM, NGRAM, hash) drops stale entries cleanly instead of
 * mixing incompatible vectors.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { cosine, EMBEDDING_VERSION } from './prompt-similarity.js';

export interface SimilarityEntry {
  /** Slot key fields (mirror exact-hash inputs). */
  runFamily: string;
  stage: string;
  taskId: string;
  model: string;
  promptVersion: string;
  /** Embedded prompt (l2-normalized). */
  vec: number[];
  /** Content-addressed blob sha for the cached output. */
  outputRef: string;
  /** Source CheckpointRecord hash — used to dedupe on re-record. */
  hash: string;
  /** Optional cost snapshot, mirrored from the checkpoint record. */
  cost?: { usd: number; tokensIn: number; tokensOut: number };
  /** ISO-8601 write timestamp. */
  recordedAt: string;
}

export interface NearestFilter {
  runFamily: string;
  stage: string;
  taskId: string;
  model: string;
  promptVersion: string;
}

interface IndexFile {
  version: 1;
  embeddingVersion: number;
  entries: SimilarityEntry[];
}

function similarityIndexPath(anvilHome: string, project: string): string {
  return join(anvilHome, 'checkpoints', project, '_similarity-index.json');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function atomicWriteFileSync(filePath: string, data: string): void {
  ensureDir(dirname(filePath));
  const tmp = `${filePath}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, filePath);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

export interface CheckpointSimilarityIndexOpts {
  anvilHome: string;
  project: string;
}

export class CheckpointSimilarityIndex {
  private readonly anvilHome: string;
  private readonly project: string;
  private readonly path: string;
  private entries: SimilarityEntry[] | null = null;

  constructor(opts: CheckpointSimilarityIndexOpts) {
    this.anvilHome = opts.anvilHome;
    this.project = opts.project;
    this.path = similarityIndexPath(this.anvilHome, this.project);
  }

  /**
   * Read entries from disk on first access. Drops the file when the
   * embedding version drifted — better to rebuild than to mix vector
   * spaces.
   */
  private load(): SimilarityEntry[] {
    if (this.entries !== null) return this.entries;
    if (!existsSync(this.path)) {
      this.entries = [];
      return this.entries;
    }
    try {
      const raw = readFileSync(this.path, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<IndexFile>;
      if (parsed.version !== 1 || parsed.embeddingVersion !== EMBEDDING_VERSION) {
        this.entries = [];
        return this.entries;
      }
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : [];
      return this.entries;
    } catch (err) {
      process.stderr.write(
        `[checkpoint-similarity-index] dropping corrupt index ${this.path}: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
      this.entries = [];
      return this.entries;
    }
  }

  private flush(): void {
    if (this.entries === null) return;
    const file: IndexFile = {
      version: 1,
      embeddingVersion: EMBEDDING_VERSION,
      entries: this.entries,
    };
    atomicWriteFileSync(this.path, JSON.stringify(file));
  }

  /**
   * Upsert by exact `hash`. Replacing on hash collision keeps the latest
   * `outputRef` / `cost` / `recordedAt` while leaving distinct prompts
   * intact.
   */
  add(entry: SimilarityEntry): void {
    const list = this.load();
    const idx = list.findIndex((e) => e.hash === entry.hash);
    if (idx >= 0) list[idx] = entry;
    else list.push(entry);
    this.flush();
  }

  /**
   * Return the highest-cosine entry inside the same slot, if it clears
   * `threshold`. Linear scan: fine up to ~10⁴ entries (one project's full
   * iteration history).
   */
  nearest(
    filter: NearestFilter,
    vec: number[],
    threshold: number,
  ): { entry: SimilarityEntry; score: number } | null {
    const list = this.load();
    let best: { entry: SimilarityEntry; score: number } | null = null;
    for (const entry of list) {
      if (
        entry.runFamily !== filter.runFamily ||
        entry.stage !== filter.stage ||
        entry.taskId !== filter.taskId ||
        entry.model !== filter.model ||
        entry.promptVersion !== filter.promptVersion
      ) continue;
      const score = cosine(vec, entry.vec);
      if (score < threshold) continue;
      if (!best || score > best.score) best = { entry, score };
    }
    return best;
  }

  /** Visible for tests. */
  size(): number {
    return this.load().length;
  }

  /** Visible for tests. Drops the on-disk index too. */
  clear(): void {
    this.entries = [];
    this.flush();
  }
}
