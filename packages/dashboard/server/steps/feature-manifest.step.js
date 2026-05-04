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
import { extractAcceptanceCriteria, extractAffectedRepos, extractApiEndpoints, extractChangeBrief, extractFilesPlanned, extractOpenQuestions, extractTablesTouched, extractTestBehaviors, } from '../feature-manifest-extractors.js';
const STAGE_EXTRACTORS = {
    requirements: [extractAcceptanceCriteria, extractAffectedRepos],
    specs: [extractApiEndpoints, extractTablesTouched, extractTestBehaviors],
    tasks: [extractFilesPlanned],
    build: [extractChangeBrief],
    validate: [extractOpenQuestions],
};
/**
 * Stage names with at least one configured extractor. A registry that
 * registers a manifest Step for an unknown stage is harmless (it would
 * pass-through), but exposing the keys lets callers no-op early.
 */
export const FEATURE_MANIFEST_STAGES = Object.keys(STAGE_EXTRACTORS);
/**
 * Build a manifest extraction Step for one stage. Phase 4f registers one of
 * these per stage (after the corresponding persona Step) inside
 * `buildDashboardStepRegistry`.
 */
export function createFeatureManifestStep(opts) {
    const id = opts.id ?? `feature-manifest:${opts.stageName}`;
    const extractors = STAGE_EXTRACTORS[opts.stageName] ?? [];
    const onError = opts.onExtractorError ?? defaultOnExtractorError;
    return {
        id,
        name: `Feature manifest extract (${opts.stageName})`,
        parallelism: 'serial',
        async run(ctx) {
            const artifact = ctx.input;
            if (!artifact || extractors.length === 0) {
                return artifact ?? '';
            }
            let mutated = false;
            let manifest = null;
            for (const extractor of extractors) {
                try {
                    const result = extractor(artifact);
                    if (!result)
                        continue;
                    manifest = opts.manifestStore.patchField(opts.project, opts.featureSlug, result.field, result.status, result.value, opts.stageName);
                    mutated = true;
                }
                catch (error) {
                    onError(opts.stageName, extractor, error);
                }
            }
            if (mutated) {
                opts.invalidateManifestBlock?.();
                if (manifest) {
                    ctx.emit('FEATURE-MANIFEST.json', manifest);
                }
            }
            return artifact;
        },
    };
}
function defaultOnExtractorError(stage, _extractor, error) {
    // Matches pipeline-runner.ts:756 message format so log greps stay valid.
    // eslint-disable-next-line no-console
    console.warn(`[pipeline] manifest extractor ${stage} failed:`, error);
}
//# sourceMappingURL=feature-manifest.step.js.map