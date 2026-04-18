/**
 * Memory Store — Hermes-inspired persistent curated memory.
 *
 * Per-project bounded memory with two stores:
 *   - MEMORY.md: project learnings (architecture patterns, conventions, gotchas,
 *     API quirks, tool behavior, environment facts)
 *   - USER.md: user preferences for this project (communication style, priorities,
 *     workflow habits, domain knowledge)
 *
 * Entry delimiter: § (section sign). Entries can be multiline.
 * Character limits keep memory focused and prevent bloat.
 *
 * Inspired by: github.com/NousResearch/hermes-agent/blob/main/tools/memory_tool.py
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
const MEMORY_CHAR_LIMIT = 4000;   // ~2 pages of focused notes
const USER_CHAR_LIMIT = 2000;     // user profile stays concise

export type MemoryTarget = 'memory' | 'user';

export interface MemoryEntry {
  content: string;
  addedAt: string;     // ISO timestamp
}

export interface MemoryActionResult {
  success: boolean;
  target: MemoryTarget;
  message?: string;
  error?: string;
  entries: string[];
  usage: string;       // e.g. "62% — 2,480/4,000 chars"
  entryCount: number;
}

// ── MemoryStore ───────────────────────────────────────────────────────

export class MemoryStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'memories');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private filePath(project: string, target: MemoryTarget): string {
    return join(this.projectDir(project), target === 'user' ? 'USER.md' : 'MEMORY.md');
  }

  private charLimit(target: MemoryTarget): number {
    return target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
  }

  // ── Read/Write ────────────────────────────────────────────────────

  private readEntries(project: string, target: MemoryTarget): string[] {
    const path = this.filePath(project, target);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return [];
      const entries = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
      // Deduplicate (keep first occurrence)
      return [...new Set(entries)];
    } catch {
      return [];
    }
  }

  private writeEntries(project: string, target: MemoryTarget, entries: string[]): void {
    ensureDir(this.projectDir(project));
    const path = this.filePath(project, target);
    const content = entries.join(ENTRY_DELIMITER);
    // Atomic write
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

  // ── Public API ────────────────────────────────────────────────────

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
      return this.errorResult(target, 'Content cannot be empty.');
    }

    const entries = this.readEntries(project, target);
    const limit = this.charLimit(target);

    // Reject exact duplicates
    if (entries.includes(content)) {
      return this.successResult(project, target, entries, 'Entry already exists (no duplicate added).');
    }

    // Check capacity
    const newEntries = [...entries, content];
    const newTotal = this.charCount(newEntries);
    if (newTotal > limit) {
      return {
        success: false,
        target,
        error: `Memory at ${this.charCount(entries).toLocaleString()}/${limit.toLocaleString()} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
        entries,
        usage: this.usageString(entries, target),
        entryCount: entries.length,
      };
    }

    entries.push(content);
    this.writeEntries(project, target, entries);
    return this.successResult(project, target, entries, 'Entry added.');
  }

  /** Replace entry matching old_text substring with new content */
  replace(project: string, target: MemoryTarget, oldText: string, newContent: string): MemoryActionResult {
    oldText = oldText.trim();
    newContent = newContent.trim();
    if (!oldText) return this.errorResult(target, 'old_text cannot be empty.');
    if (!newContent) return this.errorResult(target, 'new_content cannot be empty. Use remove to delete.');

    const entries = this.readEntries(project, target);
    const matches = entries.map((e, i) => ({ idx: i, entry: e })).filter(({ entry }) => entry.includes(oldText));

    if (matches.length === 0) {
      return this.errorResult(target, `No entry matched "${oldText}".`, entries);
    }
    if (matches.length > 1) {
      const unique = new Set(matches.map((m) => m.entry));
      if (unique.size > 1) {
        return this.errorResult(target, `Multiple entries matched "${oldText}". Be more specific.`, entries);
      }
    }

    const idx = matches[0].idx;
    const limit = this.charLimit(target);

    // Check capacity after replacement
    const testEntries = [...entries];
    testEntries[idx] = newContent;
    if (this.charCount(testEntries) > limit) {
      return this.errorResult(target, `Replacement would exceed ${limit.toLocaleString()} char limit. Shorten the content.`, entries);
    }

    entries[idx] = newContent;
    this.writeEntries(project, target, entries);
    return this.successResult(project, target, entries, 'Entry replaced.');
  }

  /** Remove entry matching old_text substring */
  remove(project: string, target: MemoryTarget, oldText: string): MemoryActionResult {
    oldText = oldText.trim();
    if (!oldText) return this.errorResult(target, 'old_text cannot be empty.');

    const entries = this.readEntries(project, target);
    const matches = entries.map((e, i) => ({ idx: i, entry: e })).filter(({ entry }) => entry.includes(oldText));

    if (matches.length === 0) {
      return this.errorResult(target, `No entry matched "${oldText}".`, entries);
    }

    entries.splice(matches[0].idx, 1);
    this.writeEntries(project, target, entries);
    return this.successResult(project, target, entries, 'Entry removed.');
  }

  /** List all projects that have memory */
  listProjects(): string[] {
    if (!existsSync(this.baseDir)) return [];
    try {
      const { readdirSync } = require('node:fs');
      return readdirSync(this.baseDir, { withFileTypes: true })
        .filter((d: any) => d.isDirectory())
        .map((d: any) => d.name);
    } catch {
      return [];
    }
  }

  // ── Result builders ───────────────────────────────────────────────

  private successResult(project: string, target: MemoryTarget, entries: string[], message: string): MemoryActionResult {
    return {
      success: true,
      target,
      message,
      entries,
      usage: this.usageString(entries, target),
      entryCount: entries.length,
    };
  }

  private errorResult(target: MemoryTarget, error: string, entries: string[] = []): MemoryActionResult {
    return {
      success: false,
      target,
      error,
      entries,
      usage: '',
      entryCount: entries.length,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}
