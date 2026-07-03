/**
 * Local-filesystem BlobStorePort adapter (ADR §4, default backend).
 *
 * A 1:1 mapping of today's `node:fs` artifact I/O: keys are project-relative
 * POSIX paths joined onto a base directory (`getKnowledgeBasePath(project)`).
 * This is the zero-behavior-change default — every method does exactly what
 * the scattered `readFileSync`/`writeFileSync`/`existsSync` calls do today.
 */

import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  copyFileSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  createReadStream,
  readdirSync,
  statSync,
} from 'node:fs';
import { join, dirname, posix, sep } from 'node:path';
import type { BlobStorePort } from './ports.js';

const FLUSH_BYTES = 8 * 1024 * 1024; // batch NDJSON writes ~8MB at a time (matches chunks-io.ts)

export class FsBlobStore implements BlobStorePort {
  constructor(private readonly basePath: string) {}

  /** Resolve a project-relative POSIX key to an absolute on-disk path. */
  private resolve(key: string): string {
    return join(this.basePath, ...key.split('/'));
  }

  private ensureParent(abs: string): void {
    mkdirSync(dirname(abs), { recursive: true });
  }

  async exists(key: string): Promise<boolean> {
    return existsSync(this.resolve(key));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const abs = this.resolve(key);
    if (!existsSync(abs)) return null;
    return JSON.parse(readFileSync(abs, 'utf-8')) as T;
  }

  async putJson(key: string, value: unknown): Promise<void> {
    const abs = this.resolve(key);
    this.ensureParent(abs);
    writeFileSync(abs, JSON.stringify(value, null, 2), 'utf-8');
  }

  async getText(key: string): Promise<string | null> {
    const abs = this.resolve(key);
    if (!existsSync(abs)) return null;
    return readFileSync(abs, 'utf-8');
  }

  async putText(key: string, text: string): Promise<void> {
    const abs = this.resolve(key);
    this.ensureParent(abs);
    writeFileSync(abs, text, 'utf-8');
  }

  async getBytes(key: string, opts?: { toFile?: string }): Promise<Buffer | string | null> {
    const abs = this.resolve(key);
    if (!existsSync(abs)) return null;
    if (opts?.toFile) {
      // The file is already local; copy only if the caller wants it elsewhere.
      if (opts.toFile !== abs) {
        mkdirSync(dirname(opts.toFile), { recursive: true });
        copyFileSync(abs, opts.toFile);
      }
      return opts.toFile;
    }
    return readFileSync(abs);
  }

  async putBytes(key: string, data: Buffer | string): Promise<void> {
    const abs = this.resolve(key);
    this.ensureParent(abs);
    if (typeof data === 'string') {
      // Contract: a string is a local source-file path to copy in.
      copyFileSync(data, abs);
    } else {
      writeFileSync(abs, data);
    }
  }

  async delete(key: string): Promise<void> {
    rmSync(this.resolve(key), { force: true });
  }

  async deletePrefix(prefix: string): Promise<void> {
    rmSync(this.resolve(prefix), { recursive: true, force: true });
  }

  async list(prefix: string): Promise<string[]> {
    const root = this.resolve(prefix);
    if (!existsSync(root)) return [];
    const out: string[] = [];
    const walk = (abs: string): void => {
      for (const entry of readdirSync(abs)) {
        const child = join(abs, entry);
        if (statSync(child).isDirectory()) walk(child);
        // Key = path relative to basePath, normalized to POSIX separators.
        else out.push(child.slice(this.basePath.length + 1).split(sep).join(posix.sep));
      }
    };
    // `prefix` may name a directory (enumerate under it) or a file.
    if (statSync(root).isDirectory()) walk(root);
    else out.push(prefix);
    return out;
  }

  async putNdjson(key: string, source: AsyncIterable<unknown> | Iterable<unknown>): Promise<void> {
    const abs = this.resolve(key);
    this.ensureParent(abs);
    const fd = openSync(abs, 'w');
    let buf = '';
    try {
      for await (const item of source) {
        buf += JSON.stringify(item) + '\n';
        if (buf.length >= FLUSH_BYTES) {
          writeSync(fd, buf);
          buf = '';
        }
      }
      if (buf.length > 0) writeSync(fd, buf);
    } finally {
      closeSync(fd);
    }
  }

  async *iterateNdjson<T>(key: string): AsyncGenerator<T> {
    const abs = this.resolve(key);
    if (!existsSync(abs)) return;
    // Legacy single-array files (written before NDJSON) start with '['; parse
    // them whole and yield element-by-element. New writes are always NDJSON.
    if (peekFirstNonWs(abs) === '[') {
      const arr = JSON.parse(readFileSync(abs, 'utf-8')) as T[];
      for (const c of arr) yield c;
      return;
    }
    let buffered = '';
    const stream = createReadStream(abs, { encoding: 'utf-8' });
    for await (const piece of stream) {
      buffered += piece as string;
      let nl = buffered.indexOf('\n');
      while (nl >= 0) {
        const line = buffered.slice(0, nl);
        buffered = buffered.slice(nl + 1);
        if (line.trim().length > 0) yield JSON.parse(line) as T;
        nl = buffered.indexOf('\n');
      }
    }
    if (buffered.trim().length > 0) yield JSON.parse(buffered) as T;
  }
}

/** First non-whitespace character of a file (cheap NDJSON-vs-array sniff). */
function peekFirstNonWs(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const b = Buffer.alloc(64);
    const n = readSync(fd, b, 0, 64, 0);
    return b.toString('utf-8', 0, n).trimStart().charAt(0);
  } finally {
    closeSync(fd);
  }
}
