/**
 * Review-domain WS routes (Recipe 7 / Phase 1).
 *
 * Migrated (service methods already exist):
 *   - resolve-review-finding   (fire-and-forget; emit-only)
 *   - apply-review-patch       (echo `review-patch-applied`, error
 *                              wire-type `review-patch-error`; preserves
 *                              the legacy `{ findingId, message }` shape)
 *   - publish-review           (echo `review-published`; setImmediate
 *                              barrier so dismissed findings settle first)
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - run-pr-review, run-incremental-review, apply-review-fix —
 *     all spawn pipelines / call `applyReviewFix` closure inside
 *     `startDashboardServer`.
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function reviewRoutes(): Record<string, Handler> {
  return {
    // ── Reads ───────────────────────────────────────────────────────────
    'get-review': route({
      input: Z.GetReview,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const store = deps.extras.reviewStore;
        if (!store) return;
        return { review: store.readCurrent(input.project, input.reviewId) };
      },
      wireType: 'review',
    }),

    'list-reviews': route({
      input: Z.ListReviews,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const store = deps.extras.reviewStore;
        if (!store) return;
        const limit = input.limit ?? 200;
        return { reviews: store.listReviews(input.project, limit) };
      },
      wireType: 'reviews',
    }),

    'get-reviewer-calibration': route({
      input: Z.GetReviewerCalibration,
      errorWireType: 'reviewer-calibration-error',
      handle: (input, deps) => {
        const store = deps.extras.reviewCalibrationStore;
        if (!store) return;
        return { bundle: store.computeSnapshot(input.project) };
      },
      wireType: 'reviewer-calibration',
    }),

    'list-review-dismissals': route({
      input: Z.ListReviewDismissals,
      errorWireType: 'review-dismissals-error',
      handle: (input, deps) => {
        const store = deps.extras.reviewDismissalStore;
        if (!store) return;
        return { project: input.project, records: store.list(input.project) };
      },
      wireType: 'review-dismissals',
    }),

    // ── Mutations ───────────────────────────────────────────────────────
    'resolve-review-finding': route({
      input: Z.ResolveReviewFinding,
      onParseFail: 'silent',
      handle: (input, deps) => deps.services.reviews.resolveFinding(input),
      errorMessage: () => 'Finding not found',
    }),

    'publish-review': route({
      input: Z.PublishReview,
      onParseFail: 'silent',
      // Legacy parity: caught exceptions use `review-error`, but
      // `not-found` uses plain `error`. Two different wire-types in
      // one handler — `errorWireType: 'review-error'` covers the
      // thrown path; not-found is dispatched manually below.
      errorWireType: 'review-error',
      handle: async (input, deps) => {
        // Barrier — let any in-flight `resolve-review-finding` handlers
        // run + persist before publish reads the review. Without this, a
        // publish dispatched immediately after a dismiss can post a
        // just-dismissed finding.
        await new Promise((r) => setImmediate(r));
        const outcome = await deps.services.reviews.publish(input);
        if ('error' in outcome) {
          deps.ws.send(JSON.stringify({
            type: 'error',
            payload: { message: `Review ${input.reviewId} not found` },
          }));
          return;
        }
        const { result } = outcome;
        deps.ws.send(JSON.stringify({
          type: 'review-published',
          payload: {
            reviewId: input.reviewId,
            commentsPosted: result.commentsPosted,
            summaryUrl: result.summaryUrl,
            errors: result.errors,
          },
        }));
      },
    }),

    'reset-review-dismissal': route({
      input: Z.ResetReviewDismissal,
      onParseFail: 'silent',
      // The store doesn't expose a delete yet — the case body just
      // acks. Keep the wire shape identical.
      handle: () => ({ ok: true }),
      wireType: 'review-dismissal-reset',
    }),

    'synthesize-review-verdict': route({
      input: Z.SynthesizeReviewVerdict,
      errorWireType: 'review-verdict-error',
      handle: async (input) => {
        const { synthesizeVerdict } = await import('../review-synthesizer.js');
        const verdict = synthesizeVerdict(input.findings as Parameters<typeof synthesizeVerdict>[0]);
        return { verdict };
      },
      wireType: 'review-verdict',
    }),

    'apply-review-patch': route({
      input: Z.ApplyReviewPatch,
      errorWireType: 'review-patch-error',
      // Legacy parity: parse failure echoes `{ findingId, message }`.
      // The raw `findingId` is bubbled even when parsing fails so the UI
      // can highlight the right finding. May be undefined.
      errorEcho: (input) => {
        const fid = (input as { findingId?: unknown }).findingId;
        return { findingId: typeof fid === 'string' ? fid : undefined };
      },
      handle: async (input, deps) => {
        const outcome = await deps.services.reviews.applyPatch(input);
        if ('error' in outcome) return { error: 'no-repo-clone' };
        deps.ws.send(JSON.stringify({
          type: 'review-patch-applied',
          payload: { findingId: input.findingId, result: outcome.result },
        }));
      },
      errorMessage: () => 'no repo clone found',
    }),
  };
}
