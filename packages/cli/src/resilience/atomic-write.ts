/**
 * atomicWrite — write to temp file then rename to avoid partial writes.
 */

import { writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * Write data atomically: writes to a temp file in the same directory,
 * then renames to the target path. This prevents partial/corrupt writes.
 */
export function atomicWrite(filePath: string, data: string): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmpPath, data, 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}

/**
 * Write JSON data atomically with pretty-printing.
 */
export function atomicWriteJSON(filePath: string, data: unknown): void {
  atomicWrite(filePath, JSON.stringify(data, null, 2) + '\n');
}
