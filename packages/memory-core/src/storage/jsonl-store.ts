/**
 * `JsonlAppendLog` — append-only canonical store for v2 `Memory<T>` records.
 *
 * Per ADR §M1, JSONL stays as the auditable, git-mergeable source of truth.
 * The SQLite hot index is rebuilt from this file at any time. One JSON
 * object per line (newline-delimited).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { Memory } from '../types.js';

export class JsonlAppendLog {
  constructor(public readonly filePath: string) {
    mkdirSync(dirname(filePath), { recursive: true });
  }

  /** Atomic append of one record (one line). */
  append(m: Memory): void {
    appendFileSync(this.filePath, JSON.stringify(m) + '\n', 'utf-8');
  }

  /** Read every record. Skips blank lines + lines that fail to parse (logged to stderr). */
  readAll(): Memory[] {
    if (!existsSync(this.filePath)) return [];
    const raw = readFileSync(this.filePath, 'utf-8');
    const lines = raw.split('\n');
    const out: Memory[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as Memory);
      } catch (err) {
        process.stderr.write(
          `[anvil-memory] WARN: skipping malformed line ${i + 1} in ${this.filePath}: ${(err as Error).message}\n`,
        );
      }
    }
    return out;
  }

  /** Overwrite the file with a list of records. Use sparingly — breaks append-only invariant. */
  rewrite(records: Memory[]): void {
    const lines = records.map((m) => JSON.stringify(m)).join('\n');
    writeFileSync(this.filePath, lines.length > 0 ? lines + '\n' : '', 'utf-8');
  }

  exists(): boolean {
    return existsSync(this.filePath);
  }
}
