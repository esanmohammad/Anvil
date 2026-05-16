/**
 * File watcher — coalesces fs events into debounced reindex batches.
 *
 * Implementation note: we use Node's built-in `fs.watch` with the `recursive:
 * true` option (macOS + Windows) and fall back to per-directory watchers on
 * Linux. Chokidar is intentionally not a dep (zero-runtime-dep MCP server
 * was a stated product constraint). Robustness can be upgraded by swapping
 * this module out — every caller only sees `start()` / `stop()` / `onBatch()`.
 */

import { watch, type FSWatcher, statSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { EventEmitter } from 'node:events';

export interface WatcherOpts {
  /** Directory to watch (recursive). */
  workspaceDir: string;
  /** Glob-like substrings to ignore (no node_modules, .git, ...). */
  ignorePatterns: string[];
  /** Wait this many ms after the last event before emitting a batch. */
  debounceMs: number;
}

export interface WatcherBatch {
  /** Set of absolute paths that changed within the debounce window. */
  changed: Set<string>;
  /** Snapshot of paths that were removed (best-effort — fs.watch doesn't
   *  reliably distinguish create vs delete cross-platform). */
  removed: Set<string>;
}

export type WatcherListener = (batch: WatcherBatch) => void;

const HAS_RECURSIVE = process.platform === 'darwin' || process.platform === 'win32';

export class Watcher extends EventEmitter {
  private readonly workspaceDir: string;
  private readonly ignore: string[];
  private readonly debounceMs: number;
  private watchers: FSWatcher[] = [];
  private pending = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private started = false;

  constructor(opts: WatcherOpts) {
    super();
    this.workspaceDir = opts.workspaceDir;
    this.ignore = opts.ignorePatterns;
    this.debounceMs = Math.max(50, opts.debounceMs);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (HAS_RECURSIVE) {
      const w = watch(this.workspaceDir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        this.queue(filename.toString());
      });
      w.on('error', (err) => this.emit('error', err));
      this.watchers.push(w);
    } else {
      // Linux: walk and watch each directory non-recursively.
      this.walkAndWatch(this.workspaceDir);
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    this.pending.clear();
  }

  onBatch(listener: WatcherListener): this {
    return this.on('batch', listener);
  }

  private walkAndWatch(dir: string): void {
    if (this.shouldIgnore(dir)) return;
    try {
      const w = watch(dir, (_event, filename) => {
        if (!filename) return;
        const full = join(dir, filename.toString());
        this.queue(relative(this.workspaceDir, full));
        try {
          if (statSync(full).isDirectory()) this.walkAndWatch(full);
        } catch { /* may have been deleted */ }
      });
      w.on('error', (err) => this.emit('error', err));
      this.watchers.push(w);

      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) this.walkAndWatch(full);
        } catch { /* ignore */ }
      }
    } catch { /* ignore inaccessible dirs */ }
  }

  private queue(rel: string): void {
    if (this.shouldIgnore(rel)) return;
    this.pending.add(join(this.workspaceDir, rel));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.debounceMs);
  }

  private flush(): void {
    const batch: WatcherBatch = { changed: new Set(this.pending), removed: new Set() };
    this.pending.clear();
    this.timer = null;
    // Best-effort split into changed/removed using statSync (synchronous,
    // cheap, and avoids tracking explicit fs.watch event types which are
    // unreliable cross-platform).
    for (const p of batch.changed) {
      try { statSync(p); } catch { batch.removed.add(p); }
    }
    for (const r of batch.removed) batch.changed.delete(r);
    this.emit('batch', batch);
  }

  private shouldIgnore(path: string): boolean {
    for (const pat of this.ignore) {
      if (path.includes(`/${pat}/`) || path.endsWith(`/${pat}`) || path.startsWith(`${pat}/`) || path === pat) {
        return true;
      }
    }
    return false;
  }
}
