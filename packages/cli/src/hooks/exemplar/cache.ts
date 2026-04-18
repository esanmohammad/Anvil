// Section F — Exemplar Disk Cache with 24h TTL
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { Exemplar, ExemplarCache } from './types.js';

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  exemplars: Exemplar[];
  timestamp: number;
}

export interface FsAdapter {
  readFileSync(path: string, encoding: BufferEncoding): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  existsSync(path: string): boolean;
}

const defaultFs: FsAdapter = {
  readFileSync,
  writeFileSync,
  mkdirSync: (p, o) => { mkdirSync(p, o); },
  existsSync,
};

export class ExemplarDiskCache implements ExemplarCache {
  private cacheDir: string;
  private fs: FsAdapter;
  private ttlMs: number;

  constructor(cacheDir: string, fs: FsAdapter = defaultFs, ttlMs: number = TTL_MS) {
    this.cacheDir = cacheDir;
    this.fs = fs;
    this.ttlMs = ttlMs;
  }

  private keyToPath(key: string): string {
    const hash = createHash('sha256').update(key).digest('hex').slice(0, 16);
    return join(this.cacheDir, `${hash}.json`);
  }

  get(key: string): Exemplar[] | null {
    const path = this.keyToPath(key);
    try {
      if (!this.fs.existsSync(path)) return null;
      const raw = this.fs.readFileSync(path, 'utf-8');
      const entry = JSON.parse(raw) as CacheEntry;
      if (Date.now() - entry.timestamp > this.ttlMs) {
        return null; // expired
      }
      return entry.exemplars;
    } catch {
      return null;
    }
  }

  set(key: string, exemplars: Exemplar[]): void {
    try {
      this.fs.mkdirSync(this.cacheDir, { recursive: true });
      const path = this.keyToPath(key);
      const entry: CacheEntry = { exemplars, timestamp: Date.now() };
      this.fs.writeFileSync(path, JSON.stringify(entry));
    } catch {
      // Cache write failure is non-fatal
    }
  }

  clear(): void {
    // Simple clear — no-op in this implementation, callers can rm the directory
  }
}
