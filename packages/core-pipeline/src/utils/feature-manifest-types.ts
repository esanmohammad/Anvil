/**
 * Feature Manifest type vocabulary — Phase 2 of TOKEN-OPTIMIZATION-PLAN.
 *
 * A FeatureManifest is a structured JSON file accumulated across pipeline
 * stages so that downstream agents stop re-deriving fields an upstream
 * stage already produced. Each field carries a status
 * (`unset` | `partial` | `final`) and a writer attribution; the manifest
 * renders into the *stable* prefix of the prompt envelope so it benefits
 * from prompt caching.
 *
 * Phase F11 — types-only promotion from
 * `packages/dashboard/server/feature-manifest.ts` into
 * `core-pipeline/utils`. The `FeatureManifestStore` CLASS (FS-backed
 * `~/.anvil/features/<project>/<slug>/manifest.json` storage) STAYS in
 * dashboard per the layering rule. Types lift so cli + dashboard +
 * pipeline-stage code share one canonical manifest vocabulary.
 *
 * Pure data + a pure factory; zero runtime side effects. Storage path
 * (the manifest.json filename) is NOT exported here — that's the
 * dashboard's concern.
 */

export const FEATURE_MANIFEST_VERSION = 1;

export type FieldStatus = 'unset' | 'partial' | 'final';

export interface ManifestField<T> {
  status: FieldStatus;
  value: T | null;
  /** Stage that last wrote this field. */
  writtenBy?: string;
  /** ISO timestamp of last write. */
  writtenAt?: string;
}

export interface ApiEndpoint {
  repo: string;
  method: string;
  path: string;
  purpose: string;
}

export interface TableMutation {
  repo: string;
  table: string;
  mutationKind: 'add' | 'alter' | 'drop' | 'read-only';
}

export interface PlannedFile {
  repo: string;
  path: string;
  kind: 'create' | 'modify' | 'delete';
}

export interface TestBehavior {
  description: string;
  gherkin?: string;
}

export interface FeatureManifest {
  version: number;
  feature: string;
  featureSlug: string;
  project: string;
  createdAt: string;
  updatedAt: string;

  // Populated through the pipeline:
  acceptanceCriteria: ManifestField<string[]>;
  affectedRepos: ManifestField<string[]>;
  apiEndpoints: ManifestField<ApiEndpoint[]>;
  tablesTouched: ManifestField<TableMutation[]>;
  filesPlanned: ManifestField<PlannedFile[]>;
  testBehaviors: ManifestField<TestBehavior[]>;
  changeBrief: ManifestField<string>;
  openQuestions: ManifestField<string[]>;
}

/** Keys of FeatureManifest that hold a ManifestField (i.e. patchable). */
export type ManifestFieldKey =
  | 'acceptanceCriteria'
  | 'affectedRepos'
  | 'apiEndpoints'
  | 'tablesTouched'
  | 'filesPlanned'
  | 'testBehaviors'
  | 'changeBrief'
  | 'openQuestions';

/** Extract the inner value type T for a ManifestField<T> living at key K. */
export type ManifestFieldValue<K extends ManifestFieldKey> =
  FeatureManifest[K] extends ManifestField<infer T> ? T : never;

// ── Factory ─────────────────────────────────────────────────────────────

function unsetField<T>(): ManifestField<T> {
  return { status: 'unset', value: null };
}

/** Pure: build an empty manifest skeleton with all fields `unset`. */
export function emptyManifest(project: string, slug: string, feature: string): FeatureManifest {
  const now = new Date().toISOString();
  return {
    version: FEATURE_MANIFEST_VERSION,
    feature,
    featureSlug: slug,
    project,
    createdAt: now,
    updatedAt: now,
    acceptanceCriteria: unsetField<string[]>(),
    affectedRepos: unsetField<string[]>(),
    apiEndpoints: unsetField<ApiEndpoint[]>(),
    tablesTouched: unsetField<TableMutation[]>(),
    filesPlanned: unsetField<PlannedFile[]>(),
    testBehaviors: unsetField<TestBehavior[]>(),
    changeBrief: unsetField<string>(),
    openQuestions: unsetField<string[]>(),
  };
}
