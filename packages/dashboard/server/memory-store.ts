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
  statSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ── Constants ─────────────────────────────────────────────────────────

const ENTRY_DELIMITER = '\n§\n';
const MEMORY_CHAR_LIMIT = 4000;   // ~2 pages of focused notes
const USER_CHAR_LIMIT = 2000;     // user profile stays concise

// Each entry is prefixed with: <!-- added:<ISO-8601> -->
const TIMESTAMP_HEADER_RE = /^<!--\s*added:([^ ]+?)\s*-->\s*\n?/;

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

  private readRawEntries(project: string, target: MemoryTarget): string[] {
    const path = this.filePath(project, target);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) return [];
      const entries = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
      const deduped = [...new Set(entries)];

      // Migrate legacy entries (no timestamp header) by baking file mtime in,
      // so later reads/writes don't drift their apparent timestamp forward.
      const needsMigration = deduped.some((e) => !TIMESTAMP_HEADER_RE.test(e));
      if (needsMigration) {
        const fallback = this.fileMTimeISO(project, target);
        const migrated = deduped.map((e) =>
          TIMESTAMP_HEADER_RE.test(e) ? e : this.formatEntry(e, fallback),
        );
        try {
          ensureDir(this.projectDir(project));
          const tmp = path + '.tmp';
          writeFileSync(tmp, migrated.join(ENTRY_DELIMITER), 'utf-8');
          renameSync(tmp, path);
          return migrated;
        } catch {
          return deduped; // read still works even if migration write fails
        }
      }
      return deduped;
    } catch {
      return [];
    }
  }

  private readEntries(project: string, target: MemoryTarget): string[] {
    return this.readRawEntries(project, target).map((e) => this.stripHeader(e));
  }

  /** Split one raw entry into its `addedAt` header (if any) and its content. */
  private parseEntry(raw: string, fallbackAddedAt: string): MemoryEntry {
    const m = raw.match(TIMESTAMP_HEADER_RE);
    if (m) {
      return { addedAt: m[1], content: raw.slice(m[0].length).trim() };
    }
    return { addedAt: fallbackAddedAt, content: raw.trim() };
  }

  private stripHeader(raw: string): string {
    return raw.replace(TIMESTAMP_HEADER_RE, '').trim();
  }

  private formatEntry(content: string, addedAt: string): string {
    return `<!-- added:${addedAt} -->\n${content.trim()}`;
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

  private fileMTimeISO(project: string, target: MemoryTarget): string {
    const path = this.filePath(project, target);
    try { return statSync(path).mtime.toISOString(); } catch { return new Date(0).toISOString(); }
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

  /** Get all entries for a project and target (content only, headers stripped). */
  getEntries(project: string, target: MemoryTarget): string[] {
    return this.readEntries(project, target);
  }

  /** Get all entries with their metadata (addedAt, content). Newest first. */
  getEntriesWithMeta(project: string, target: MemoryTarget): MemoryEntry[] {
    const raw = this.readRawEntries(project, target);
    const fallback = this.fileMTimeISO(project, target);
    const parsed = raw.map((r) => this.parseEntry(r, fallback));
    // Sort newest first (lexicographic ISO compare works)
    parsed.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    return parsed;
  }

  /** Get entries formatted for project prompt injection */
  formatForPrompt(project: string, target: MemoryTarget): string {
    const entries = this.readEntries(project, target);
    if (entries.length === 0) return '';

    const content = entries.join(ENTRY_DELIMITER);
    const usage = this.usageString(this.readRawEntries(project, target), target);
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

    const rawEntries = this.readRawEntries(project, target);
    const limit = this.charLimit(target);

    // Reject exact duplicates (compare stripped content)
    const existingContent = rawEntries.map((e) => this.stripHeader(e));
    if (existingContent.includes(content)) {
      return this.successResult(project, target, existingContent, 'Entry already exists (no duplicate added).');
    }

    const newRaw = this.formatEntry(content, new Date().toISOString());
    const newEntries = [...rawEntries, newRaw];
    const newTotal = this.charCount(newEntries);
    if (newTotal > limit) {
      return {
        success: false,
        target,
        error: `Memory at ${this.charCount(rawEntries).toLocaleString()}/${limit.toLocaleString()} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
        entries: existingContent,
        usage: this.usageString(rawEntries, target),
        entryCount: rawEntries.length,
      };
    }

    this.writeEntries(project, target, newEntries);
    const stripped = newEntries.map((e) => this.stripHeader(e));
    return this.successResult(project, target, stripped, 'Entry added.');
  }

  /** Replace entry matching old_text substring with new content */
  replace(project: string, target: MemoryTarget, oldText: string, newContent: string): MemoryActionResult {
    oldText = oldText.trim();
    newContent = newContent.trim();
    if (!oldText) return this.errorResult(target, 'old_text cannot be empty.');
    if (!newContent) return this.errorResult(target, 'new_content cannot be empty. Use remove to delete.');

    const rawEntries = this.readRawEntries(project, target);
    const matches = rawEntries
      .map((raw, i) => ({ idx: i, content: this.stripHeader(raw) }))
      .filter(({ content }) => content.includes(oldText));

    const strippedView = rawEntries.map((r) => this.stripHeader(r));
    if (matches.length === 0) {
      return this.errorResult(target, `No entry matched "${oldText}".`, strippedView);
    }
    if (matches.length > 1) {
      const unique = new Set(matches.map((m) => m.content));
      if (unique.size > 1) {
        return this.errorResult(target, `Multiple entries matched "${oldText}". Be more specific.`, strippedView);
      }
    }

    const idx = matches[0].idx;
    const limit = this.charLimit(target);

    // Replacement bumps the timestamp (treated as a fresh edit).
    const testEntries = [...rawEntries];
    testEntries[idx] = this.formatEntry(newContent, new Date().toISOString());
    if (this.charCount(testEntries) > limit) {
      return this.errorResult(target, `Replacement would exceed ${limit.toLocaleString()} char limit. Shorten the content.`, strippedView);
    }

    this.writeEntries(project, target, testEntries);
    const stripped = testEntries.map((e) => this.stripHeader(e));
    return this.successResult(project, target, stripped, 'Entry replaced.');
  }

  /** Remove entry matching old_text substring */
  remove(project: string, target: MemoryTarget, oldText: string): MemoryActionResult {
    oldText = oldText.trim();
    if (!oldText) return this.errorResult(target, 'old_text cannot be empty.');

    const rawEntries = this.readRawEntries(project, target);
    const matches = rawEntries
      .map((raw, i) => ({ idx: i, content: this.stripHeader(raw) }))
      .filter(({ content }) => content.includes(oldText));

    const strippedView = rawEntries.map((r) => this.stripHeader(r));
    if (matches.length === 0) {
      return this.errorResult(target, `No entry matched "${oldText}".`, strippedView);
    }

    rawEntries.splice(matches[0].idx, 1);
    this.writeEntries(project, target, rawEntries);
    const stripped = rawEntries.map((e) => this.stripHeader(e));
    return this.successResult(project, target, stripped, 'Entry removed.');
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
