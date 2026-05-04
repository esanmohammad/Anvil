/**
 * Memory Store — Phase 5 of the dashboard consolidation (D6).
 *
 * Replaces the legacy Hermes-style markdown backend with a thin façade
 * over `@anvil/memory-core`'s `HybridMemoryStore` (JSONL canonical +
 * SQLite hot index). The 5 operations the dashboard consumes
 * (`add`, `replace`, `remove`, `getEntriesWithMeta`, `formatForPrompt`)
 * keep their existing return shapes verbatim per D10 — only the storage
 * backend changes.
 *
 * Mapping (D6):
 *   - target='memory' → kind='semantic' subtype='manual', namespace
 *     `{ scope: 'project', projectId }`
 *   - target='user' → kind='profile', namespace
 *     `{ scope: 'user', projectId }`
 *
 * Migration: the first read/write per project triggers a one-time
 * scan of `~/.anvil/memories/<project>/{MEMORY.md,USER.md}`. Each
 * delimiter-separated entry becomes a Memory record (preserving the
 * `<!-- added:<iso> -->` timestamp header where present), then the
 * markdown files move under `~/.anvil/memories/_archive_<ts>/<project>/`.
 *
 * Dashboard-specific UX rules (char limits, substring matching for
 * replace/remove, dedup, insertion-order in formatForPrompt) live in
 * this façade — memory-core stays generic.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import { HybridMemoryStore } from '@anvil/memory-core';
import type { Memory, MemoryNamespace } from '@anvil/memory-core';

// ── Constants ─────────────────────────────────────────────────────────

const ENTRY_DELIMITER = '\n§\n';
const MEMORY_CHAR_LIMIT = 4000;   // ~2 pages of focused notes
const USER_CHAR_LIMIT = 2000;     // user profile stays concise

// Each legacy entry is prefixed with: <!-- added:<ISO-8601> -->
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

// ── Helpers ───────────────────────────────────────────────────────────

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Local id generator — Date.now() (ms) + 8 random bytes hex. Sorts
 * lexicographically by time (ULID-ish) without pulling `ulid` into
 * the dashboard's dependency graph.
 */
function newId(): string {
  return `${Date.now().toString(36)}${randomBytes(8).toString('hex')}`;
}

function namespaceFor(project: string, target: MemoryTarget): MemoryNamespace {
  return target === 'user'
    ? { scope: 'user', projectId: project }
    : { scope: 'project', projectId: project };
}

// ── MemoryStore ───────────────────────────────────────────────────────

export class MemoryStore {
  private baseDir: string;
  private legacyDir: string;
  private migratedProjects = new Set<string>();
  private store: HybridMemoryStore;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = home;
    this.legacyDir = join(home, 'memories');
    const v2Dir = join(home, 'memories', 'v2');
    ensureDir(v2Dir);
    this.store = HybridMemoryStore.open({
      jsonlPath: join(v2Dir, 'memories.jsonl'),
      sqlitePath: join(v2Dir, 'index.sqlite'),
    });
  }

  /**
   * Expose the underlying HybridMemoryStore for memory-core primitives that
   * need direct access (recordPrEpisode, reflectOnRun, ProposalQueue,
   * MemoryInspector, BM25 retrieval). The façade's add/replace/remove
   * surface remains the canonical write path for dashboard UI mutations.
   */
  unwrap(): HybridMemoryStore {
    return this.store;
  }

  // ── One-time markdown migration per project ──────────────────────

  private migrateOnce(project: string): void {
    if (this.migratedProjects.has(project)) return;
    this.migratedProjects.add(project);

    const projectLegacyDir = join(this.legacyDir, project);
    if (!existsSync(projectLegacyDir)) return;

    const memoryPath = join(projectLegacyDir, 'MEMORY.md');
    const userPath = join(projectLegacyDir, 'USER.md');
    let migratedAny = false;

    for (const [path, target] of [[memoryPath, 'memory'], [userPath, 'user']] as const) {
      if (!existsSync(path)) continue;
      const fallbackTs = (() => {
        try { return statSync(path).mtime.toISOString(); } catch { return new Date().toISOString(); }
      })();
      const raw = readFileSync(path, 'utf-8').trim();
      if (!raw) continue;
      const entries = raw.split(ENTRY_DELIMITER).map((e) => e.trim()).filter(Boolean);
      for (const entry of entries) {
        const m = entry.match(TIMESTAMP_HEADER_RE);
        const addedAt = m ? m[1] : fallbackTs;
        const content = m ? entry.slice(m[0].length).trim() : entry;
        if (!content) continue;
        try {
          this.store.add(this.makeMemoryRecord(project, target, content, addedAt));
        } catch {
          /* skip — scrubber rejection or invalid record */
        }
      }
      migratedAny = true;
    }

    if (migratedAny) {
      // Archive the markdown so re-launches don't re-migrate.
      const archiveBase = join(this.legacyDir, `_archive_${Date.now()}`);
      const archiveProject = join(archiveBase, project);
      try {
        ensureDir(archiveBase);
        renameSync(projectLegacyDir, archiveProject);
      } catch {
        /* best-effort archive */
      }
    }
  }

  private makeMemoryRecord(
    project: string,
    target: MemoryTarget,
    content: string,
    addedAt: string,
    id: string = newId(),
  ): Memory {
    return {
      id,
      namespace: namespaceFor(project, target),
      kind: target === 'user' ? 'profile' : 'semantic',
      subtype: target === 'memory' ? 'manual' : undefined,
      content,
      tags: [`dashboard:${target}`],
      confidence: 100,
      ttlDays: -1,
      expiresAt: '9999-12-31T23:59:59.999Z',
      bitemporal: { validAt: addedAt },
      decay: { lastAccessed: addedAt, strength: 100, rehearseCount: 0 },
      provenance: { createdBy: 'user', createdAt: addedAt },
    };
  }

  // ── Read helpers ─────────────────────────────────────────────────

  private queryActive(project: string, target: MemoryTarget): Memory[] {
    return this.store.query(namespaceFor(project, target), { limit: 1000 });
  }

  private charCountOf(memories: Memory[]): number {
    if (memories.length === 0) return 0;
    return memories.map((m) => String(m.content)).join(ENTRY_DELIMITER).length;
  }

  private charLimit(target: MemoryTarget): number {
    return target === 'user' ? USER_CHAR_LIMIT : MEMORY_CHAR_LIMIT;
  }

  private usageString(memories: Memory[], target: MemoryTarget): string {
    const current = this.charCountOf(memories);
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
    return `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`;
  }

  /**
   * Order matches the legacy MEMORY.md layout (insertion order, oldest
   * first) so prompt bytes stay byte-identical across runs that don't
   * touch memory.
   */
  private ordered(memories: Memory[]): Memory[] {
    return memories.slice().sort((a, b) => {
      const aTs = a.provenance.createdAt;
      const bTs = b.provenance.createdAt;
      const cmp = aTs.localeCompare(bTs);
      return cmp !== 0 ? cmp : a.id.localeCompare(b.id);
    });
  }

  // ── Public API ────────────────────────────────────────────────────

  /** Get all entries (content only). */
  getEntries(project: string, target: MemoryTarget): string[] {
    this.migrateOnce(project);
    return this.ordered(this.queryActive(project, target)).map((m) => String(m.content));
  }

  /** Get all entries with metadata, newest first. */
  getEntriesWithMeta(project: string, target: MemoryTarget): MemoryEntry[] {
    this.migrateOnce(project);
    const memories = this.queryActive(project, target);
    const parsed: MemoryEntry[] = memories.map((m) => ({
      addedAt: m.provenance.createdAt,
      content: String(m.content),
    }));
    parsed.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
    return parsed;
  }

  /**
   * @deprecated Newest-first slice formatter, kept only for the legacy WS
   * context-preview handlers. Pipeline prompts now use BM25 retrieval via
   * `PipelineRunner.getStableMemoryBlock`.
   */
  formatForPrompt(project: string, target: MemoryTarget): string {
    this.migrateOnce(project);
    const memories = this.ordered(this.queryActive(project, target));
    if (memories.length === 0) return '';
    const content = memories.map((m) => String(m.content)).join(ENTRY_DELIMITER);
    const usage = this.usageString(memories, target);
    const header = target === 'user'
      ? `USER PROFILE [${usage}]`
      : `SYSTEM MEMORY [${usage}]`;
    const sep = '═'.repeat(46);
    return `${sep}\n${header}\n${sep}\n${content}`;
  }

  /** Add a new entry. */
  add(project: string, target: MemoryTarget, content: string): MemoryActionResult {
    this.migrateOnce(project);
    content = content.trim();
    if (!content) return this.errorResult(target, 'Content cannot be empty.');

    const existing = this.queryActive(project, target);
    const existingContent = this.ordered(existing).map((m) => String(m.content));

    if (existingContent.includes(content)) {
      return this.successResult(project, target, existingContent, 'Entry already exists (no duplicate added).');
    }

    const limit = this.charLimit(target);
    const projected = this.charCountOf([...existing, this.makeMemoryRecord(project, target, content, new Date().toISOString())]);
    if (projected > limit) {
      return {
        success: false,
        target,
        error: `Memory at ${this.charCountOf(existing).toLocaleString()}/${limit.toLocaleString()} chars. Adding this entry (${content.length} chars) would exceed the limit. Replace or remove existing entries first.`,
        entries: existingContent,
        usage: this.usageString(existing, target),
        entryCount: existing.length,
      };
    }

    try {
      this.store.add(this.makeMemoryRecord(project, target, content, new Date().toISOString()));
    } catch (err) {
      return this.errorResult(target, err instanceof Error ? err.message : String(err), existingContent);
    }
    const after = this.queryActive(project, target);
    const stripped = this.ordered(after).map((m) => String(m.content));
    return this.successResult(project, target, stripped, 'Entry added.');
  }

  /** Replace entry matching old_text substring with new content. */
  replace(project: string, target: MemoryTarget, oldText: string, newContent: string): MemoryActionResult {
    this.migrateOnce(project);
    oldText = oldText.trim();
    newContent = newContent.trim();
    if (!oldText) return this.errorResult(target, 'old_text cannot be empty.');
    if (!newContent) return this.errorResult(target, 'new_content cannot be empty. Use remove to delete.');

    const existing = this.queryActive(project, target);
    const ordered = this.ordered(existing);
    const matches = ordered.filter((m) => String(m.content).includes(oldText));
    const stripped = ordered.map((m) => String(m.content));

    if (matches.length === 0) {
      return this.errorResult(target, `No entry matched "${oldText}".`, stripped);
    }
    if (matches.length > 1) {
      const unique = new Set(matches.map((m) => String(m.content)));
      if (unique.size > 1) {
        return this.errorResult(target, `Multiple entries matched "${oldText}". Be more specific.`, stripped);
      }
    }

    const target0 = matches[0];
    const limit = this.charLimit(target);
    const remaining = existing.filter((m) => m.id !== target0.id);
    const replacement = this.makeMemoryRecord(project, target, newContent, new Date().toISOString());
    if (this.charCountOf([...remaining, replacement]) > limit) {
      return this.errorResult(target, `Replacement would exceed ${limit.toLocaleString()} char limit. Shorten the content.`, stripped);
    }

    // Soft-delete + add fresh — preserves the audit trail.
    this.store.invalidate(target0.id, new Date().toISOString(), 'replaced via dashboard MemoryStore.replace');
    this.store.add(replacement);

    const after = this.queryActive(project, target);
    const next = this.ordered(after).map((m) => String(m.content));
    return this.successResult(project, target, next, 'Entry replaced.');
  }

  /** Remove entry matching old_text substring. */
  remove(project: string, target: MemoryTarget, oldText: string): MemoryActionResult {
    this.migrateOnce(project);
    oldText = oldText.trim();
    if (!oldText) return this.errorResult(target, 'old_text cannot be empty.');

    const existing = this.queryActive(project, target);
    const ordered = this.ordered(existing);
    const matches = ordered.filter((m) => String(m.content).includes(oldText));
    const stripped = ordered.map((m) => String(m.content));

    if (matches.length === 0) {
      return this.errorResult(target, `No entry matched "${oldText}".`, stripped);
    }

    this.store.invalidate(matches[0].id, new Date().toISOString(), 'removed via dashboard MemoryStore.remove');
    const after = this.queryActive(project, target);
    const next = this.ordered(after).map((m) => String(m.content));
    return this.successResult(project, target, next, 'Entry removed.');
  }

  /** List projects that have memory in either bucket. */
  listProjects(): string[] {
    // Cross-namespace admin query — find every distinct projectId on a
    // project-scoped or user-scoped memory.
    const all = this.store.queryAll({ limit: 10_000 });
    const projects = new Set<string>();
    for (const m of all) {
      const ns = m.namespace;
      if ((ns.scope === 'project' || ns.scope === 'user') && ns.projectId) {
        projects.add(ns.projectId);
      }
    }
    return Array.from(projects).sort();
  }

  // ── Result builders ──────────────────────────────────────────────

  private successResult(project: string, target: MemoryTarget, entries: string[], message: string): MemoryActionResult {
    void project;
    const memories = this.ordered(this.queryActive('__usage_only__', target));
    void memories;
    // Compute usage from `entries` directly so the result reflects the
    // post-write state without re-querying SQLite (the query is needed
    // for the legacy multi-line accumulation only, not the count).
    const current = entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length;
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.round((current / limit) * 100)) : 0;
    return {
      success: true,
      target,
      message,
      entries,
      usage: `${pct}% — ${current.toLocaleString()}/${limit.toLocaleString()} chars`,
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
