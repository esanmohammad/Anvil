// JSONL reader/writer — Section A.2

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Read a JSONL file, parsing each line. Skips malformed lines.
 * Returns empty array for missing/empty files.
 */
export function readJSONL<T>(filePath: string): T[] {
  if (!existsSync(filePath)) {
    return [];
  }

  const content = readFileSync(filePath, 'utf-8');
  if (!content.trim()) {
    return [];
  }

  const results: T[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // Skip malformed lines
    }
  }
  return results;
}

/**
 * Append a single item as a JSONL line. Auto-creates parent dirs.
 */
export function appendJSONL<T>(filePath: string, item: T): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(item) + '\n';
  const existing = existsSync(filePath) ? readFileSync(filePath, 'utf-8') : '';
  // Ensure we don't double-newline
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  writeFileSync(filePath, existing + (needsNewline ? '\n' : '') + line, 'utf-8');
}

/**
 * Overwrite the entire JSONL file with the given items. Auto-creates parent dirs.
 */
export function writeJSONL<T>(filePath: string, items: T[]): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const content = items.map((item) => JSON.stringify(item)).join('\n') + (items.length > 0 ? '\n' : '');
  writeFileSync(filePath, content, 'utf-8');
}
