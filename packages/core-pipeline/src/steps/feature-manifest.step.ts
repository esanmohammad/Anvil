/**
 * `feature-manifest.step` — wraps `FeatureManifestStoreLike` + the seven
 * `feature-manifest-extractors` into a `Step<string, string>` that runs
 * after each pipeline stage's persona artifact lands.
 *
 * Phase H4 — promoted from
 * `packages/dashboard/server/steps/feature-manifest.step.ts` into
 * `core-pipeline/src/steps`. Takes a `FeatureManifestStoreLike` so the
 * dashboard's FS-backed `FeatureManifestStore` and any future substrate
 * both satisfy it.
 *
 * Step semantics:
 *   - input:  the stage artifact string
 *   - output: the *same* artifact string, untouched (the manifest patch
 *             is a side effect)
 *   - emits:  `FEATURE-MANIFEST.json` artifact via `ctx.emit`
 *
 * Stage → extractor mapping mirrors the legacy runner:
 *   requirements → extractAcceptanceCriteria, extractAffectedRepos
 *   specs        → extractApiEndpoints, extractTablesTouched, extractTestBehaviors
 *   tasks        → extractFilesPlanned
 *   build        → extractChangeBrief
 *   validate     → extractOpenQuestions
 */

import type { Step, StepContext } from '../types.js';
import type { FeatureManifestStoreLike } from '../storage-like.js';
import type { FeatureManifest } from '../utils/feature-manifest-types.js';
import {
  extractAcceptanceCriteria,
  extractAffectedRepos,
  extractApiEndpoints,
  extractChangeBrief,
  extractFilesPlanned,
  extractOpenQuestions,
  extractTablesTouched,
  extractTestBehaviors,
  type ManifestExtractor,
} from '../utils/feature-manifest-extractors.js';

const STAGE_EXTRACTORS: Record<string, readonly ManifestExtractor[]> = {
  requirements: [extractAcceptanceCriteria, extractAffectedRepos],
  specs: [extractApiEndpoints, extractTablesTouched, extractTestBehaviors],
  tasks: [extractFilesPlanned],
  build: [extractChangeBrief],
  validate: [extractOpenQuestions],
};

export const FEATURE_MANIFEST_STAGES: readonly string[] = Object.keys(STAGE_EXTRACTORS);

export interface FeatureManifestStepOptions {
  id?: string;
  stageName: string;
  project: string;
  featureSlug: string;
  /** Structural store handle. Dashboard's `FeatureManifestStore` satisfies this. */
  manifestStore: FeatureManifestStoreLike;
  invalidateManifestBlock?: () => void;
  onExtractorError?: (stage: string, extractor: ManifestExtractor, error: unknown) => void;
}

export function createFeatureManifestStep(
  opts: FeatureManifestStepOptions,
): Step<string, string> {
  const id = opts.id ?? `feature-manifest:${opts.stageName}`;
  const extractors = STAGE_EXTRACTORS[opts.stageName] ?? [];
  const onError = opts.onExtractorError ?? defaultOnExtractorError;

  return {
    id,
    name: `Feature manifest extract (${opts.stageName})`,
    parallelism: 'serial',
    async run(ctx: StepContext<string>): Promise<string> {
      const artifact = ctx.input;
      if (!artifact || extractors.length === 0) {
        return artifact ?? '';
      }

      let mutated = false;
      let manifest: FeatureManifest | null = null;
      for (const extractor of extractors) {
        try {
          const result = extractor(artifact);
          if (!result) continue;
          manifest = opts.manifestStore.patchField(
            opts.project,
            opts.featureSlug,
            result.field,
            result.status,
            result.value as never,
            opts.stageName,
          );
          mutated = true;
        } catch (error) {
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

function defaultOnExtractorError(
  stage: string,
  _extractor: ManifestExtractor,
  error: unknown,
): void {
  // eslint-disable-next-line no-console
  console.warn(`[pipeline] manifest extractor ${stage} failed:`, error);
}
