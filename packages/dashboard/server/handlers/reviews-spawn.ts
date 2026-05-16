/**
 * Review-spawn routes (Phase 2.6 migration).
 *
 * Migrated:
 *   - run-review-pr
 *   - run-review-incremental
 *   - apply-review-fix
 *
 * Thin wrappers over `pipelineActions.startReviewRun` / `applyReviewFix`.
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function reviewsSpawnRoutes(): Record<string, Handler> {
  return {
    'run-review-pr': route({
      input: Z.RunReviewPr,
      errorWireType: 'review-error',
      handle: async (input, deps) => {
        const actions = deps.extras.pipelineActions;
        if (!actions) return;
        const { project, prUrl, options } = input;
        const personas = options?.personas ?? ['architect', 'security', 'style', 'tester'];
        try {
          await actions.startReviewRun(project, prUrl, 'manual', personas, options?.model);
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'review-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'run-review-incremental': route({
      input: Z.RunReviewIncremental,
      onParseFail: 'silent',
      errorWireType: 'review-error',
      handle: async (input, deps) => {
        const actions = deps.extras.pipelineActions;
        const reviewStore = deps.extras.reviewStore as unknown as {
          readCurrent(project: string, reviewId: string): {
            pr: { url: string };
            personas: string[];
          } | null;
        } | undefined;
        if (!actions || !reviewStore) return;
        const { project, reviewId, options } = input;
        const prior = reviewStore.readCurrent(project, reviewId);
        if (!prior) {
          deps.ws.send(JSON.stringify({
            type: 'error',
            payload: { message: `Review ${reviewId} not found` },
          }));
          return;
        }
        try {
          await actions.startReviewRun(project, prior.pr.url, 'push', prior.personas, options?.model, prior);
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'review-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'apply-review-fix': route({
      input: Z.ApplyReviewFix,
      onParseFail: 'silent',
      errorWireType: 'review-error',
      handle: async (input, deps) => {
        const actions = deps.extras.pipelineActions;
        const reviewStore = deps.extras.reviewStore as unknown as {
          readCurrent(project: string, reviewId: string): unknown;
        } | undefined;
        if (!actions || !reviewStore) return;
        const { project, reviewId, findingId } = input;
        try {
          const commitSha = await actions.applyReviewFix(project, reviewId, findingId);
          const updated = reviewStore.readCurrent(project, reviewId);
          deps.ws.send(JSON.stringify({
            type: 'review-fix-applied',
            payload: { reviewId, findingId, commitSha, review: updated },
          }));
          if (updated) {
            deps.services.reviews.emit('review.finding-resolved', {
              reviewId,
              findingId,
              resolution: 'addressed',
              review: updated,
            } as never);
          }
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'review-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),
  };
}
