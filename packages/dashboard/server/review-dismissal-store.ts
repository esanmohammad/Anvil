/**
 * review-dismissal-store — R8 dismissal tracker for auto-filtering findings.
 *
 * Additive to `review-learner.ts` — this module focuses specifically on
 * capturing per-(persona, claimType, file-pattern) dismissal counts and
 * exposing a `shouldFilter` predicate that callers can use to drop or
 * demote future findings that match a dismissal key the user has already
 * rejected N times.
 *
 * Storage: <anvilHome>/review-dismissals/<project>/dismissals.json
 * Writes are atomic (tmp + rename); corrupt files are treated as empty.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export interface DismissalKey {
  personaId: string;
  claimType: string;
  filePattern: string;
}

export interface DismissalRecord {
  key: DismissalKey;
  count: number;
  lastDismissedAt: string;
  reasons: string[];
}

interface DismissalIndex {
  version: 1;
  project: string;
  updatedAt: string;
  records: Record<string, DismissalRecord>;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_THRESHOLD = 3;
const MAX_REASONS = 5;

// ── Helpers ──────────────────────────────────────────────────────────────

function dismissalsDir(anvilHome: string, project: string): string {
  return join(anvilHome, 'review-dismissals', project);
}

function dismissalsPath(anvilHome: string, project: string): string {
  return join(dismissalsDir(anvilHome, project), 'dismissals.json');
}

function atomicWriteJson(path: string, data: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

function readIndex(path: string, project: string): DismissalIndex {
  if (!existsSync(path)) return emptyIndex(project);
  try {
    const raw = readFileSync(path, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return emptyIndex(project);
    const obj = parsed as Partial<DismissalIndex>;
    if (obj.version !== 1 || !obj.records || typeof obj.records !== 'object') {
      return emptyIndex(project);
    }
    return {
      version: 1,
      project: obj.project ?? project,
      updatedAt: obj.updatedAt ?? new Date().toISOString(),
      records: obj.records as Record<string, DismissalRecord>,
    };
  } catch {
    return emptyIndex(project);
  }
}

function emptyIndex(project: string): DismissalIndex {
  return {
    version: 1,
    project,
    updatedAt: new Date().toISOString(),
    records: {},
  };
}

function hashKey(key: DismissalKey): string {
  return `${key.personaId}\u0001${key.claimType}\u0001${key.filePattern}`;
}

/**
 * Derive a glob-like filePattern from a concrete filePath.
 * Strategy: take first two directory segments + `**` + `*<ext>`.
 *
 *   packages/dashboard/src/foo/bar.tsx → packages/dashboard/**\/*.tsx
 *   src/util.ts                        → src/**\/*.ts
 *   README.md                          → **\/*.md
 *   (empty)                            → **\/*
 */
export function derivePatternFromFile(filePath: string | null | undefined): string {
  if (!filePath) return '**/*';
  const trimmed = String(filePath).trim();
  if (!trimmed) return '**/*';

  const normalized = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
  const lastSlash = normalized.lastIndexOf('/');
  const filename = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);

  const dotIdx = filename.lastIndexOf('.');
  const ext = dotIdx > 0 ? filename.slice(dotIdx) : '';
  const suffix = ext ? `*${ext}` : '*';

  if (lastSlash === -1) return `**/${suffix}`;

  const dirParts = normalized.slice(0, lastSlash).split('/').filter(Boolean);
  const head = dirParts.slice(0, 2).join('/');
  return head ? `${head}/**/${suffix}` : `**/${suffix}`;
}

// ── Store ────────────────────────────────────────────────────────────────

export class ReviewDismissalStore {
  private readonly anvilHome: string;

  constructor(anvilHome: string) {
    this.anvilHome = anvilHome;
  }

  /**
   * Record a dismissal for the given key. Creates the record on first hit,
   * increments count otherwise. Reasons ring-buffer at MAX_REASONS entries.
   */
  record(project: string, key: DismissalKey, reason?: string): DismissalRecord {
    const path = dismissalsPath(this.anvilHome, project);
    const index = readIndex(path, project);
    const hash = hashKey(key);
    const now = new Date().toISOString();

    const existing = index.records[hash];
    const record: DismissalRecord = existing
      ? {
          key: existing.key,
          count: existing.count + 1,
          lastDismissedAt: now,
          reasons: existing.reasons.slice(),
        }
      : {
          key: { ...key },
          count: 1,
          lastDismissedAt: now,
          reasons: [],
        };

    if (reason && reason.trim()) {
      record.reasons.push(reason.trim());
      if (record.reasons.length > MAX_REASONS) {
        record.reasons = record.reasons.slice(record.reasons.length - MAX_REASONS);
      }
    }

    index.records[hash] = record;
    index.updatedAt = now;
    atomicWriteJson(path, index);
    return record;
  }

  /** Get a single record, or null if none exists. */
  get(project: string, key: DismissalKey): DismissalRecord | null {
    const path = dismissalsPath(this.anvilHome, project);
    const index = readIndex(path, project);
    const record = index.records[hashKey(key)];
    return record ?? null;
  }

  /** List all records, newest-first by lastDismissedAt. */
  list(project: string): DismissalRecord[] {
    const path = dismissalsPath(this.anvilHome, project);
    const index = readIndex(path, project);
    const out = Object.values(index.records);
    out.sort((a, b) => (a.lastDismissedAt < b.lastDismissedAt ? 1 : -1));
    return out;
  }

  /**
   * Returns true when the key has been dismissed at least `threshold` times.
   * Default threshold is 3.
   */
  shouldFilter(
    project: string,
    key: DismissalKey,
    threshold: number = DEFAULT_THRESHOLD,
  ): boolean {
    const effective = typeof threshold === 'number' && threshold > 0 ? threshold : DEFAULT_THRESHOLD;
    const record = this.get(project, key);
    if (!record) return false;
    return record.count >= effective;
  }

  /**
   * Clear a single record (used when the user presses "Re-enable" on a
   * key). Returns true if a record was removed.
   */
  reset(project: string, key: DismissalKey): boolean {
    const path = dismissalsPath(this.anvilHome, project);
    const index = readIndex(path, project);
    const hash = hashKey(key);
    if (!(hash in index.records)) return false;
    delete index.records[hash];
    index.updatedAt = new Date().toISOString();
    atomicWriteJson(path, index);
    return true;
  }
}
