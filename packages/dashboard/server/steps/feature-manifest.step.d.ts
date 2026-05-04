/**
 * `feature-manifest.step` — wraps `FeatureManifestStore` + the seven
 * `feature-manifest-extractors` into a `Step<string, string>` that runs after
 * each pipeline stage's persona artifact lands.
 *
 * Phase 4b of the dashboard consolidation. Lifts
 * `pipeline-runner.ts:extractAndUpdateManifest()` so Phases 4c–4f can
 * compose it into the registry without touching the legacy runner yet.
 *
 * Step semantics:
 *   - input:  the stage artifact string (output of the prior persona step)
 *   - output: the *same* artifact string, untouched — the manifest patch is
 *             a side effect, so downstream stages still see the artifact as
 *             their input. This makes the step trivially insertable between
 *             two persona steps.
 *   - emits:  `FEATURE-MANIFEST.json` artifact via `ctx.emit` so subscribers
 *             on the bus's `artifact:emitted` hook (audit, dashboard, …)
 *             see the manifest land, mirroring the prior behavior where
 *             pipeline-runner.ts logged + broadcast manifest changes.
 *
 * Per-extractor errors are caught and logged (matching the legacy
 * `console.warn` from extractAndUpdateManifest) so a single failing
 * extractor never blocks the rest. Returns the artifact unchanged on
 * failure.
 *
 * Stage → extractor mapping mirrors pipeline-runner.ts exactly:
 *
 *   requirements → extractAcceptanceCriteria, extractAffectedRepos
 *   specs        → extractApiEndpoints, extractTablesTouched, extractTestBehaviors
 *   tasks        → extractFilesPlanned
 *   build        → extractChangeBrief
 *   validate     → extractOpenQuestions
 */
import type { Step } from '@anvil/core-pipeline';
import type { FeatureManifestStore } from '../feature-manifest.js';
import { type ManifestExtractor } from '../feature-manifest-extractors.js';
/**
 * Stage names with at least one configured extractor. A registry that
 * registers a manifest Step for an unknown stage is harmless (it would
 * pass-through), but exposing the keys lets callers no-op early.
 */
export declare const FEATURE_MANIFEST_STAGES: readonly string[];
export interface FeatureManifestStepOptions {
    /** Step id; conventionally `feature-manifest:${stageName}`. */
    id?: string;
    /** Stage that produced the input artifact (drives extractor dispatch). */
    stageName: string;
    /** Project slug (matches FeatureStore keying). */
    project: string;
    /** Feature slug (matches FeatureManifestStore keying). */
    featureSlug: string;
    /** Manifest store the step writes through. */
    manifestStore: FeatureManifestStore;
    /**
     * Optional — invoked after a successful extractor patch so callers (today
     * `PipelineRunner`) can drop their cached prompt block. Mirrors
     * `pipeline-runner.ts:invalidateManifestBlock()`.
     */
    invalidateManifestBlock?: () => void;
    /**
     * Optional — escape hatch for tests + observability. Logs a warning for
     * each failed extractor instead of swallowing silently. Defaults to
     * `console.warn` (matching legacy behavior).
     */
    onExtractorError?: (stage: string, extractor: ManifestExtractor, error: unknown) => void;
}
/**
 * Build a manifest extraction Step for one stage. Phase 4f registers one of
 * these per stage (after the corresponding persona Step) inside
 * `buildDashboardStepRegistry`.
 */
export declare function createFeatureManifestStep(opts: FeatureManifestStepOptions): Step<string, string>;
//# sourceMappingURL=feature-manifest.step.d.ts.map