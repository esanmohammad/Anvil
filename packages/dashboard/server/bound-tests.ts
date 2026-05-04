/**
 * bound-tests — bind-forever enforcement for Anvil's bug-to-test replay feature.
 *
 * When a production incident is successfully replayed and a regression test is
 * generated from it, that test becomes "bound" to the incident: it must not be
 * rewritten, modified, or deleted by subsequent automated rounds of test
 * regeneration (mutation-targeted regen, stale-test pruning, test-author
 * rewrites, etc.). If a future mutant happens to land inside a bound file, the
 * system must add a *sibling* test rather than touch the bound one.
 *
 * Overriding a binding is possible but requires an explicit human reason and
 * is recorded in an append-only audit log. The bound-tests list itself is
 * atomically rewritten on every bind/override; the audit log is append-only
 * (one JSON object per line) and never rewritten.
 *
 * Storage layout (per project):
 *   ~/.anvil/incidents/<project>/
 *   ├── bound-tests.json      # BoundTest[] — atomically rewritten
 *   └── audit.log             # newline-delimited AuditEntry JSON (append-only)
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Public types ─────────────────────────────────────────────────────────

export interface BoundTest {
  filePath: string;                 // repo-relative path of the test file
  incidentId: string;
  replayId: string;
  addedAt: string;
}

export interface AuditEntry {
  action: 'bind' | 'override';
  boundTest: BoundTest;
  at: string;
  user: string;                     // from ANVIL_USER_NAME env or 'anonymous'
  reason?: string;                  // required for override
}

// ── Internal helpers ─────────────────────────────────────────────────────

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function resolveAnvilHome(anvilHome?: string): string {
  return (
    anvilHome ??
    process.env.ANVIL_HOME ??
    process.env.FF_HOME ??
    join(homedir(), '.anvil')
  );
}

function currentUser(): string {
  const name = process.env.ANVIL_USER_NAME;
  if (typeof name === 'string' && name.trim().length > 0) return name;
  return 'anonymous';
}

// ── BoundTestsStore ──────────────────────────────────────────────────────

export class BoundTestsStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = resolveAnvilHome(anvilHome);
    this.baseDir = join(home, 'incidents');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ────────────────────────────────────────────────────────

  private projectDir(project: string): string {
    return join(this.baseDir, project);
  }

  private boundTestsPath(project: string): string {
    return join(this.projectDir(project), 'bound-tests.json');
  }

  private auditLogPath(project: string): string {
    return join(this.projectDir(project), 'audit.log');
  }

  // ── Bound-tests list ────────────────────────────────────────────────────

  listBound(project: string): BoundTest[] {
    const path = this.boundTestsPath(project);
    if (!existsSync(path)) return [];
    try {
      const raw = readFileSync(path, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((x): x is BoundTest =>
        !!x &&
        typeof x === 'object' &&
        typeof (x as BoundTest).filePath === 'string' &&
        typeof (x as BoundTest).incidentId === 'string' &&
        typeof (x as BoundTest).replayId === 'string' &&
        typeof (x as BoundTest).addedAt === 'string',
      );
    } catch {
      return [];
    }
  }

  isBound(project: string, filePath: string): boolean {
    return this.listBound(project).some((b) => b.filePath === filePath);
  }

  appendBound(project: string, bound: BoundTest): void {
    ensureDir(this.projectDir(project));
    const existing = this.listBound(project);

    // Replace any prior entry for the same filePath so the set stays unique.
    const filtered = existing.filter((b) => b.filePath !== bound.filePath);
    filtered.push(bound);

    atomicWriteFileSync(
      this.boundTestsPath(project),
      JSON.stringify(filtered, null, 2),
    );

    this.appendAudit(project, {
      action: 'bind',
      boundTest: bound,
      user: currentUser(),
    });
  }

  /**
   * Override — remove a bound test. A reason is required (callers should
   * surface it to the user before calling). Returns the removed entry or null
   * when the file wasn't bound to begin with.
   */
  removeBound(project: string, filePath: string, reason: string): BoundTest | null {
    if (typeof reason !== 'string' || reason.trim().length === 0) {
      throw new Error('removeBound requires a non-empty reason for the override');
    }
    const existing = this.listBound(project);
    const idx = existing.findIndex((b) => b.filePath === filePath);
    if (idx === -1) return null;

    const removed = existing[idx];
    const next = existing.slice(0, idx).concat(existing.slice(idx + 1));

    ensureDir(this.projectDir(project));
    atomicWriteFileSync(
      this.boundTestsPath(project),
      JSON.stringify(next, null, 2),
    );

    this.appendAudit(project, {
      action: 'override',
      boundTest: removed,
      user: currentUser(),
      reason,
    });

    return removed;
  }

  // ── Audit log ───────────────────────────────────────────────────────────

  listAudit(project: string): AuditEntry[] {
    const path = this.auditLogPath(project);
    if (!existsSync(path)) return [];
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch {
      return [];
    }
    const out: AuditEntry[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        const parsed = JSON.parse(trimmed) as AuditEntry;
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed.action === 'bind' || parsed.action === 'override') &&
          typeof parsed.at === 'string' &&
          typeof parsed.user === 'string' &&
          parsed.boundTest &&
          typeof parsed.boundTest.filePath === 'string'
        ) {
          out.push(parsed);
        }
      } catch {
        // Skip malformed lines — audit log is append-only and must tolerate
        // partial/corrupted tails without losing earlier valid entries.
      }
    }
    return out;
  }

  appendAudit(project: string, entry: Omit<AuditEntry, 'at'>): void {
    if (entry.action === 'override' && (typeof entry.reason !== 'string' || entry.reason.trim().length === 0)) {
      throw new Error("appendAudit: 'override' action requires a non-empty reason");
    }
    ensureDir(this.projectDir(project));
    const full: AuditEntry = {
      ...entry,
      at: new Date().toISOString(),
    };
    appendFileSync(this.auditLogPath(project), JSON.stringify(full) + '\n', 'utf-8');
  }
}

// ── Convenience helpers ──────────────────────────────────────────────────

/** One-shot register — used by replay-pipeline to append a bound test. */
export function registerBoundTest(
  project: string,
  bound: BoundTest,
  anvilHome?: string,
): void {
  new BoundTestsStore(anvilHome).appendBound(project, bound);
}

/** Filter helper — returns input list minus any file path that is bound. */
export function excludeBoundFiles<T extends { filePath: string }>(
  project: string,
  items: T[],
  anvilHome?: string,
): T[] {
  const store = new BoundTestsStore(anvilHome);
  const bound = new Set(store.listBound(project).map((b) => b.filePath));
  if (bound.size === 0) return items.slice();
  return items.filter((i) => !bound.has(i.filePath));
}

/** Convenience — true if any item in the list is a bound file. */
export function hasBoundFile<T extends { filePath: string }>(
  project: string,
  items: T[],
  anvilHome?: string,
): boolean {
  const store = new BoundTestsStore(anvilHome);
  const bound = new Set(store.listBound(project).map((b) => b.filePath));
  if (bound.size === 0) return false;
  return items.some((i) => bound.has(i.filePath));
}

/**
 * Block-string for injecting into test-author / regen prompts. Names files
 * that must not be rewritten. Returns an empty string when no tests are bound.
 */
export function formatBoundTestsForPrompt(project: string, anvilHome?: string): string {
  const store = new BoundTestsStore(anvilHome);
  const bound = store.listBound(project);
  if (bound.length === 0) return '';

  const lines: string[] = [
    '# Bound regression tests (DO NOT MODIFY OR DELETE)',
    'The following test files are incident-bound and must not be rewritten or removed:',
  ];
  for (const b of bound) {
    lines.push(`- ${b.filePath} (incident: ${b.incidentId}, replay: ${b.replayId})`);
  }
  lines.push(
    'If an uncovered mutant lives in one of these files, add a sibling test rather than modifying the existing one.',
  );
  return lines.join('\n');
}
