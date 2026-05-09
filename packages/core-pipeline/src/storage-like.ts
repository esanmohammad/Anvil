/**
 * Phase G — structural interfaces for the FS-backed storage layers
 * the dashboard owns.
 *
 * The full classes (`FeatureStore`, `FeatureManifestStore`,
 * `KnowledgeBaseManager`, `ProjectLoader`) stay in
 * `packages/dashboard/server/` because their lifecycle is tied to
 * dashboard-specific paths (`~/.anvil/features/`, `~/.anvil/plans/`,
 * worktrees, factory.yaml). What lifts here is the *shape* each
 * collaborator exposes to a step module.
 *
 * Step modules (`packages/core-pipeline/src/steps/`, landing in Phase H)
 * accept these `*Like` interfaces as injected deps so they stay
 * substrate-agnostic. The dashboard wires its concrete stores in;
 * cli (when its consolidation lands) wires its own substrate.
 *
 * Pure types — zero runtime side effects.
 */

import type {
  FeatureManifest,
  ManifestFieldKey,
  ManifestFieldValue,
  FieldStatus,
} from './utils/feature-manifest-types.js';

// ── FeatureStoreLike — `~/.anvil/features/<project>/<slug>/` ─────────

/**
 * Structural shape of the dashboard's `FeatureStore` class — the FS
 * surface a step module needs for cross-stage artifact persistence.
 *
 * The dashboard's full `FeatureStore` exposes more methods (run history,
 * status snapshots, audit metadata); step modules touch only the three
 * here.
 */
export interface FeatureStoreLike {
  /** Resolve the on-disk dir for a feature, creating dirs as needed. */
  getFeatureDir(project: string, slug: string): string;
  /** Atomically write an artifact (markdown / JSON) under the feature dir. */
  writeArtifact(project: string, slug: string, relativePath: string, content: string): void;
  /** Read a previously-written artifact. Returns null when absent. */
  readArtifact(project: string, slug: string, relativePath: string): string | null;
}

// ── FeatureManifestStoreLike — manifest.json in feature dir ──────────

/**
 * Structural shape of the dashboard's `FeatureManifestStore` class.
 * Step modules call `ensure` once at the top of their stage and
 * `patchField` whenever they extract structured data from an artifact.
 */
export interface FeatureManifestStoreLike {
  /** Read an existing manifest; null when none. */
  read(project: string, slug: string): FeatureManifest | null;
  /**
   * Ensure a manifest exists. Returns the existing one if present,
   * otherwise creates + persists an empty one for the feature.
   */
  ensure(project: string, slug: string, feature: string): FeatureManifest;
  /** Update one field with status + writer attribution; persists atomically. */
  patchField<K extends ManifestFieldKey>(
    project: string,
    slug: string,
    field: K,
    status: FieldStatus,
    value: ManifestFieldValue<K>,
    writtenBy: string,
  ): FeatureManifest;
}

// ── KbManagerLike — knowledge-core wrapper ───────────────────────────

/**
 * Structural shape of the dashboard's `KnowledgeBaseManager`. Step
 * modules read three things from the KB layer: the compact keyword
 * index for prompt injection, the synthesized graph reports, and a
 * pre-warm of the hybrid-context cache before stages that need it.
 *
 * The full `KnowledgeBaseManager` does much more (project status,
 * graph build, project_index.json maintenance, refresh progress)
 * that's lifecycle-only and stays in dashboard.
 */
export interface KbManagerLike {
  /** Compact keyword index for prompt injection. Empty string when none. */
  getIndexForPrompt(project: string): string;
  /** Concatenated SYSTEM_REPORT.md + per-repo synthesized reports. */
  getAllGraphReports(project: string): string;
  /**
   * Pre-warm the hybrid-context cache for a feature query. Awaited at
   * pipeline start so per-stage prompt assembly is sync.
   */
  prefetchHybridContext(project: string, query: string, maxTokens?: number): Promise<void>;
}

// ── ProjectLoaderLike — factory.yaml loader ──────────────────────────

/**
 * Structural shape of the dashboard's `ProjectLoader`. Step modules
 * read three things: the resolved project info bundle, the per-project
 * factory.yaml config, and the per-stage model id (with project-level
 * override resolution). Returns are kept opaque (`unknown | null`) so
 * the full `ProjectInfo` / `FactoryConfig` types stay dashboard-owned;
 * step modules consume the returned bundle by passing it back to
 * dashboard-side code, not by reading specific fields off it.
 */
export interface ProjectLoaderLike {
  /**
   * Resolve a project record (factory.yaml + on-disk state). Returns
   * null when the project is unknown.
   */
  getProject(project: string): Promise<unknown | null>;
  /** Synchronous factory.yaml lookup. Null when unknown. */
  getConfig(project: string): unknown | null;
  /** Per-stage model id, with the project's override applied. */
  getModelForStage(project: string, stage: string): string;
}
