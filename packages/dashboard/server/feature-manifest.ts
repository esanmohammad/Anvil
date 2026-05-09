/**
 * Feature Manifest — Phase 2 of TOKEN-OPTIMIZATION-PLAN.
 *
 * A FeatureManifest is a structured JSON file accumulated across pipeline
 * stages so that downstream agents stop re-deriving fields an upstream stage
 * already produced. Each field carries a status (`unset` | `partial` | `final`)
 * and a writer attribution; the manifest renders into the *stable* prefix of
 * the prompt envelope so it benefits from prompt caching.
 *
 * Storage:  <feature-store>/<project>/<slug>/manifest.json
 *
 * Manifest mutation is additive: `patchField` updates one field, bumps
 * `updatedAt`, and rewrites the JSON atomically.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureStore } from './feature-store.js';

// Phase F11 — types + the FEATURE_MANIFEST_VERSION constant + the
// pure `emptyManifest` factory live in @esankhan3/anvil-core-pipeline.
// The `FeatureManifestStore` CLASS (FS-backed `~/.anvil/features/...
// /manifest.json` storage) and `renderManifestForPrompt` (depends on
// nothing FS but only the dashboard wires it into prompts) stay here.
import {
  FEATURE_MANIFEST_VERSION,
  emptyManifest,
  type FieldStatus,
  type ManifestField,
  type ApiEndpoint,
  type TableMutation,
  type PlannedFile,
  type TestBehavior,
  type FeatureManifest,
  type ManifestFieldKey,
  type ManifestFieldValue,
} from '@esankhan3/anvil-core-pipeline';

export {
  FEATURE_MANIFEST_VERSION,
  emptyManifest,
};
export type {
  FieldStatus,
  ManifestField,
  ApiEndpoint,
  TableMutation,
  PlannedFile,
  TestBehavior,
  FeatureManifest,
  ManifestFieldKey,
  ManifestFieldValue,
};

const MANIFEST_FILENAME = 'manifest.json';

// ── Store ────────────────────────────────────────────────────────────────

// Phase G — `implements FeatureManifestStoreLike` pins the shape
// step modules consume from core-pipeline.
import type { FeatureManifestStoreLike } from '@esankhan3/anvil-core-pipeline';

export class FeatureManifestStore implements FeatureManifestStoreLike {
  constructor(private featureStore: FeatureStore) {}

  private manifestPath(project: string, slug: string): string {
    return join(this.featureStore.getFeatureDir(project, slug), MANIFEST_FILENAME);
  }

  read(project: string, slug: string): FeatureManifest | null {
    const path = this.manifestPath(project, slug);
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as FeatureManifest;
      if (parsed && typeof parsed.version === 'number') return parsed;
      return null;
    } catch {
      return null;
    }
  }

  write(m: FeatureManifest): void {
    const path = this.manifestPath(m.project, m.featureSlug);
    const tmp = path + '.tmp';
    m.updatedAt = new Date().toISOString();
    writeFileSync(tmp, JSON.stringify(m, null, 2), 'utf-8');
    renameSync(tmp, path);
  }

  /**
   * Ensure a manifest exists for the feature. If one is on disk, return it;
   * otherwise create + persist an empty manifest. Caller-supplied feature is
   * used only when creating fresh — never overwrites an existing record.
   */
  ensure(project: string, slug: string, feature: string): FeatureManifest {
    const existing = this.read(project, slug);
    if (existing) return existing;
    const fresh = emptyManifest(project, slug, feature);
    this.write(fresh);
    return fresh;
  }

  /**
   * Update one ManifestField in place. Persists atomically. Returns the new
   * manifest. If no manifest exists, creates one with an empty `feature`
   * field (caller can call `ensure` first to seed the description).
   */
  patchField<K extends ManifestFieldKey>(
    project: string,
    slug: string,
    field: K,
    status: FieldStatus,
    value: ManifestFieldValue<K>,
    writtenBy: string,
  ): FeatureManifest {
    const m = this.read(project, slug) ?? emptyManifest(project, slug, '');
    const now = new Date().toISOString();
    const updated: ManifestField<ManifestFieldValue<K>> = {
      status,
      value,
      writtenBy,
      writtenAt: now,
    };
    // The cast is safe because K constrains the field to a ManifestField<value>.
    (m as unknown as Record<K, ManifestField<ManifestFieldValue<K>>>)[field] = updated;
    this.write(m);
    return m;
  }
}

// ── Render ───────────────────────────────────────────────────────────────

/**
 * Render the manifest as a compact text block for inclusion in the *stable*
 * prefix of the prompt envelope. Empty manifest returns the empty string so
 * callers can feed the result directly into the envelope.
 */
export function renderManifestForPrompt(m: FeatureManifest | null): string {
  if (!m) return '';
  const hasAny = (
    [
      m.acceptanceCriteria, m.affectedRepos, m.apiEndpoints, m.tablesTouched,
      m.filesPlanned, m.testBehaviors, m.changeBrief, m.openQuestions,
    ] as ManifestField<unknown>[]
  ).some((f) => f.status !== 'unset' && f.value !== null);
  if (!hasAny) return '';

  const lines: string[] = [];
  lines.push(`Feature manifest (v${m.version}) — read this BEFORE deriving any field below.`);
  lines.push(`Rule: if a field is marked 'final', use it verbatim. Do not re-derive.`);
  lines.push('');

  const renderField = (label: string, fld: ManifestField<unknown>): void => {
    if (fld.status === 'unset' || fld.value === null) {
      lines.push(`- ${label}: <unset>`);
      return;
    }
    const writer = fld.writtenBy ? `, by ${fld.writtenBy}` : '';
    if (Array.isArray(fld.value)) {
      const entries = fld.value as unknown[];
      lines.push(`- ${label} [${fld.status}${writer}]: ${entries.length} entries`);
      for (const entry of entries) {
        lines.push(`    • ${stringifyEntry(entry)}`);
      }
    } else {
      lines.push(`- ${label} [${fld.status}${writer}]: ${stringifyEntry(fld.value)}`);
    }
  };

  renderField('Acceptance criteria', m.acceptanceCriteria);
  renderField('Affected repos', m.affectedRepos);
  renderField('API endpoints', m.apiEndpoints);
  renderField('Tables touched', m.tablesTouched);
  renderField('Files planned', m.filesPlanned);
  renderField('Test behaviors', m.testBehaviors);
  renderField('Change brief', m.changeBrief);
  renderField('Open questions', m.openQuestions);

  return lines.join('\n');
}

function stringifyEntry(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
