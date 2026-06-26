/**
 * Chunks file I/O — NDJSON (one JSON object per line).
 *
 * At org scale (hundreds of repos → millions of chunks) the old
 * `JSON.stringify(allChunks)` / `JSON.parse(readFileSync(...))` round-trip
 * crashes with "Invalid string length": a single JS string cannot exceed
 * V8's `String::kMaxLength` (~512MB). NDJSON sidesteps the ceiling on BOTH
 * ends — each line is serialized/parsed independently, and reads stream
 * line-by-line so the whole file is never one string.
 *
 * The file keeps the historical `chunks.json` name. Files written before
 * this change were a single JSON array; `iterateChunksFile` detects that
 * legacy shape (leading `[`) and falls back to a whole-file parse.
 */

import { openSync, readSync, closeSync, writeSync, readFileSync, createReadStream } from 'node:fs';
import type { CodeChunk } from './types.js';

const FLUSH_BYTES = 8 * 1024 * 1024; // batch writes ~8MB at a time

/** Write chunks as NDJSON, flushing in batches so no single string is huge. */
export function writeChunksFile(path: string, chunks: CodeChunk[]): void {
  const fd = openSync(path, 'w');
  try {
    let buf = '';
    for (const c of chunks) {
      buf += JSON.stringify(c) + '\n';
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

/**
 * Streaming NDJSON writer — append chunks one at a time without ever holding
 * the whole set in memory (the inverse of writeChunksFile). Used to stream
 * deduped chunks from per-repo shards into chunks.json at org scale.
 */
export function createChunkWriter(path: string): { write(c: CodeChunk): void; close(): void } {
  const fd = openSync(path, 'w');
  let buf = '';
  return {
    write(c: CodeChunk): void {
      buf += JSON.stringify(c) + '\n';
      if (buf.length >= FLUSH_BYTES) { writeSync(fd, buf); buf = ''; }
    },
    close(): void {
      if (buf.length > 0) writeSync(fd, buf);
      closeSync(fd);
    },
  };
}

/** First non-whitespace character of a file (cheap format sniff). */
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

/**
 * Stream chunks one at a time. NDJSON is read line-by-line; a legacy
 * single-array file is parsed whole and yielded element-by-element.
 */
export async function* iterateChunksFile(path: string): AsyncGenerator<CodeChunk> {
  if (peekFirstNonWs(path) === '[') {
    const arr = JSON.parse(readFileSync(path, 'utf-8')) as CodeChunk[];
    for (const c of arr) yield c;
    return;
  }
  let buffered = '';
  const stream = createReadStream(path, { encoding: 'utf-8' });
  for await (const piece of stream) {
    buffered += piece as string;
    let nl = buffered.indexOf('\n');
    while (nl >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      if (line.trim().length > 0) yield JSON.parse(line) as CodeChunk;
      nl = buffered.indexOf('\n');
    }
  }
  if (buffered.trim().length > 0) yield JSON.parse(buffered) as CodeChunk;
}

/** Load every chunk into memory (NDJSON or legacy array). */
export async function readChunksFile(path: string): Promise<CodeChunk[]> {
  const out: CodeChunk[] = [];
  for await (const c of iterateChunksFile(path)) out.push(c);
  return out;
}

/**
 * Stream the file and return up to `limit` chunks matching `match`, stopping
 * early. Lets callers fetch a single entity without loading millions of
 * chunks into memory.
 */
export async function findChunksInFile(
  path: string,
  match: (c: CodeChunk) => boolean,
  limit: number,
): Promise<CodeChunk[]> {
  const out: CodeChunk[] = [];
  for await (const c of iterateChunksFile(path)) {
    if (match(c)) {
      out.push(c);
      if (out.length >= limit) break;
    }
  }
  return out;
}
