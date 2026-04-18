/**
 * CLI-local re-export of the MemoryStore.
 *
 * The canonical implementation lives in packages/dashboard/server/memory-store.ts.
 * This file re-exports it so the CLI orchestrator can import without a deep
 * cross-package relative path. If the dashboard module is not available at
 * runtime (e.g. standalone CLI build), it falls back to a minimal in-process
 * implementation that reads/writes the same ~/.anvil/memories/ layout.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ─────────────────────────────────────────────────────────

const ENTRY_DELIMITER = '\n§\n';
const MEMORY_CHAR_LIMIT = 4000;
const USER_CHAR_LIMIT = 2000;

export type MemoryTarget = 'memory' | 'user';

export interface MemoryActionResult {
  success: boolean;
  target: MemoryTarget;
  message?: string;
  error?: string;
  entries: string[];
  usage: string;
  entryCount: number;
}

// ── MemoryStore ───────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export class MemoryStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'memories');
    ensureDir(this.baseDir);
  }

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private filePath(project: string, target: MemoryTarget): string {
    return join(this.projectDir(project), target === 'user' ? 'USER.md' : 'MEMORY.md');
  }

  private charLimit(target: MemoryTarget): number {
    return target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
  }

  private readEntries(project: string, target: MemoryTarget): string[] {
    const path = this.filePath(project, target);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return [];
      return [...new Set(raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean))];
    } catch {
      return [];
    }
  }

  private writeEntries(project: string, target: MemoryTarget, entries: string[]): void {
    ensureDir(this.projectDir(project));
    const path = this.filePath(project, target);
    const content = entries.join(ENTRY_DELIMITER);
    const tmp = path + '.tmp';
    writeFileSync(tmp, content, 'utf-8');
    renameSync(tmp, path);
  }

  private charCount(entries: string[]): number {
    if (entries.length === 0) return 0;
    return entries.join(ENTRY_DELIMITER).length;
  }

  private usageString(entries: string[], target: MemoryTarget): string {
    const current = this.charCount(entries);
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
    return `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`;
  }

  /** Get all entries for a project and target */
  getEntries(project: string, target: MemoryTarget): string[] {
    return this.readEntries(project, target);
  }

  /** Get entries formatted for project prompt injection */
  formatForPrompt(project: string, target: MemoryTarget): string {
    const entries = this.readEntries(project, target);
    if (entries.length === 0) return '';

    const content = entries.join(ENTRY_DELIMITER);
    const usage = this.usageString(entries, target);
    const header = target === 'user'
      ? `USER PROFILE [${usage}]`
      : `SYSTEM MEMORY [${usage}]`;
    const sep = '═'.repeat(46);

    return `${sep}\n${header}\n${sep}\n${content}`;
  }

  /** Add a new entry */
  add(project: string, target: MemoryTarget, content: string): MemoryActionResult {
    content = content.trim();
    if (!content) {
      return { success: false, target, error: 'Content cannot be empty.', entries: [], usage: '', entryCount: 0 };
    }

    const entries = this.readEntries(project, target);
    const limit = this.charLimit(target);

    if (entries.includes(content)) {
      return {
        success: true, target,
        message: 'Entry already exists (no duplicate added).',
        entries, usage: this.usageString(entries, target), entryCount: entries.length,
      };
    }

    const newEntries = [...entries, content];
    if (this.charCount(newEntries) > limit) {
      return {
        success: false, target,
        error: `Memory at ${this.charCount(entries).toLocaleString()}/${limit.toLocaleString()} chars. Adding would exceed the limit.`,
        entries, usage: this.usageString(entries, target), entryCount: entries.length,
      };
    }

    entries.push(content);
    this.writeEntries(project, target, entries);
    return {
      success: true, target, message: 'Entry added.',
      entries, usage: this.usageString(entries, target), entryCount: entries.length,
    };
  }
}
