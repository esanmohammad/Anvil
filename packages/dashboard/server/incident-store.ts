/**
 * IncidentStore — persistence for captured production incidents.
 *
 * Incidents are ingested from external sources (incident.io, Sentry, Datadog,
 * Jira, Linear, manual) and deduplicated by (source, externalId) so that the
 * same Sentry event or Jira ticket can be surfaced repeatedly without creating
 * duplicate records.
 *
 * Storage layout:
 *   ~/.anvil/incidents/<project>/
 *   ├── <incidentId>.json          # one file per incident
 *   ├── index.json                 # IncidentPointer[] — newest-first
 *   └── replays/                   # owned by ReplayStore
 *       └── <replayId>.json
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

import type {
  IncidentPointer,
  IncidentRecord,
  IncidentSource,
} from './incident-types.js';

// ── Helpers ──────────────────────────────────────────────────────────────

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

function readJsonSync<T>(filePath: string): T | null {
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function newIncidentId(): string {
  return `incident-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}

function toPointer(record: IncidentRecord): IncidentPointer {
  return {
    id: record.id,
    source: record.source,
    externalId: record.externalId,
    title: record.title,
    severity: record.severity,
    occurredAt: record.occurredAt,
  };
}

// ── IncidentStore ────────────────────────────────────────────────────────

class IncidentStore {
  private baseDir: string;

  constructor(anvilHome?: string) {
    const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    this.baseDir = join(home, 'incidents');
    ensureDir(this.baseDir);
  }

  // ── Path helpers ──────────────────────────────────────────────────────

  getIncidentDir(project: string): string {
    return join(this.baseDir, project);
  }

  private incidentPath(project: string, incidentId: string): string {
    return join(this.getIncidentDir(project), `${incidentId}.json`);
  }

  private indexPath(project: string): string {
    return join(this.getIncidentDir(project), 'index.json');
  }

  // ── Index ─────────────────────────────────────────────────────────────

  private readIndex(project: string): IncidentPointer[] {
    return readJsonSync<IncidentPointer[]>(this.indexPath(project)) ?? [];
  }

  private writeIndex(project: string, pointers: IncidentPointer[]): void {
    ensureDir(this.getIncidentDir(project));
    pointers.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
    atomicWriteFileSync(this.indexPath(project), JSON.stringify(pointers, null, 2));
  }

  private upsertIndex(project: string, record: IncidentRecord): void {
    const pointers = this.readIndex(project);
    const idx = pointers.findIndex((p) => p.id === record.id);
    const pointer = toPointer(record);
    if (idx === -1) pointers.push(pointer);
    else pointers[idx] = pointer;
    this.writeIndex(project, pointers);
  }

  // ── CRUD ──────────────────────────────────────────────────────────────

  /** Write the full record and update the index. Does not dedup — use `ingest`. */
  save(record: IncidentRecord): IncidentRecord {
    ensureDir(this.getIncidentDir(record.project));
    atomicWriteFileSync(
      this.incidentPath(record.project, record.id),
      JSON.stringify(record, null, 2),
    );
    this.upsertIndex(record.project, record);
    return record;
  }

  /**
   * Primary entry point: dedups on (source, externalId). If an incident with
   * the same source + externalId already exists for the project, returns it
   * unchanged. Otherwise generates a fresh id + capturedAt and persists.
   */
  ingest(
    project: string,
    source: IncidentSource,
    externalId: string,
    record: Omit<IncidentRecord, 'id' | 'project' | 'capturedAt'>,
  ): IncidentRecord {
    const existing = this.findByExternal(project, source, externalId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const full: IncidentRecord = {
      ...record,
      id: newIncidentId(),
      project,
      source,
      externalId,
      capturedAt: now,
    };
    return this.save(full);
  }

  read(project: string, incidentId: string): IncidentRecord | null {
    return readJsonSync<IncidentRecord>(this.incidentPath(project, incidentId));
  }

  findByExternal(
    project: string,
    source: IncidentSource,
    externalId: string,
  ): IncidentRecord | null {
    const pointers = this.readIndex(project);
    const match = pointers.find((p) => p.source === source && p.externalId === externalId);
    if (!match) return null;
    return this.read(project, match.id);
  }

  list(project: string): IncidentPointer[] {
    const pointers = this.readIndex(project);
    // Defensive re-sort: the on-disk index is sorted, but guard against manual edits.
    return [...pointers].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  }

  delete(project: string, incidentId: string): boolean {
    const pointers = this.readIndex(project);
    const next = pointers.filter((p) => p.id !== incidentId);
    if (next.length === pointers.length) return false;
    this.writeIndex(project, next);
    // Leave the JSON file on disk as a tombstone-free best-effort; callers can
    // remove manually if desired. Index removal is enough to hide it from list.
    return true;
  }
}

export { IncidentStore };
