/**
 * Content-addressed blob storage for checkpoint outputs.
 *
 * Agent outputs (plan JSON, diffs, review findings, test code, etc.) are
 * written here by sha256 of their bytes. A CheckpointRecord references the
 * blob via `outputRef` (the sha hex). Two checkpoints that produce the same
 * output share a single blob on disk (dedup).
 *
 * Writes are atomic: we write to `<path>.tmp` then `renameSync` into place,
 * which is a single filesystem operation on POSIX and NTFS. `gc` enumerates
 * every blob under `_blobs/` and deletes those not present in the supplied
 * reference set.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import { blobPath, blobRoot } from './key.js';

export interface BlobWriteResult {
  sha: string;
  path: string;
  bytes: number;
}

export interface BlobGcResult {
  deleted: number;
  bytes: number;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

export class BlobStore {
  private readonly anvilHome: string;

  constructor(anvilHome: string) {
    this.anvilHome = anvilHome;
  }

  /**
   * Write content to the blob store. Returns the sha and path even when the
   * blob already existed (dedup — same bytes → same sha, skip the write).
   */
  write(content: string | Buffer): BlobWriteResult {
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;
    const sha = sha256Hex(buf);
    const path = blobPath(this.anvilHome, sha);

    if (existsSync(path)) {
      return { sha, path, bytes: buf.byteLength };
    }

    ensureDir(dirname(path));

    // Atomic write: tmp + rename. Tmp name includes pid + random to avoid
    // collisions between concurrent writers of the same sha.
    const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      writeFileSync(tmp, buf);
      renameSync(tmp, path);
    } catch (err) {
      // Clean up tmp file if rename failed.
      try { unlinkSync(tmp); } catch { /* ignore */ }
      throw err;
    }

    return { sha, path, bytes: buf.byteLength };
  }

  /** Return blob bytes, or null if missing / unreadable. */
  read(sha: string): Buffer | null {
    const path = blobPath(this.anvilHome, sha);
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  }

  /** Cheap existence check without reading the bytes. */
  exists(sha: string): boolean {
    return existsSync(blobPath(this.anvilHome, sha));
  }

  /**
   * Garbage-collect blobs not in `referencedShas`. Walks every fan-out
   * directory and unlinks orphans. Reports bytes freed.
   */
  gc(referencedShas: Set<string>): BlobGcResult {
    const root = blobRoot(this.anvilHome);
    if (!existsSync(root)) return { deleted: 0, bytes: 0 };

    let deleted = 0;
    let bytes = 0;

    let prefixes: string[];
    try {
      prefixes = readdirSync(root);
    } catch {
      return { deleted: 0, bytes: 0 };
    }

    for (const prefix of prefixes) {
      const prefixDir = join(root, prefix);
      let entries: string[];
      try {
        entries = readdirSync(prefixDir);
      } catch {
        continue;
      }
      for (const sha of entries) {
        if (referencedShas.has(sha)) continue;
        const file = join(prefixDir, sha);
        try {
          const st = statSync(file);
          if (!st.isFile()) continue;
          unlinkSync(file);
          deleted += 1;
          bytes += st.size;
        } catch {
          // Best-effort gc — skip files that vanish mid-walk.
        }
      }
    }

    return { deleted, bytes };
  }
}
