/**
 * Durable execution WS routes (Phases D5 + F1).
 *
 *   - `get-durable-timeline` — returns the run record + every persisted
 *     event so the UI can render a step-by-step + effect-by-effect log
 *     from `~/.anvil/durable.db`. Used by the Run Timeline UI under
 *     `RunDetail → Durable Timeline` disclosure.
 *
 *   - `provide-stage-answer` — routes per-question Q&A answers to the
 *     active pipeline runner. Frontend payload:
 *     `{ stageIndex, repoName?, questionIndex, text }`. The runner
 *     resolves the answer + enqueues a durable signal so crash-recovery
 *     replays past the Q&A pause without re-prompting.
 */

import { z } from 'zod';
import { route, type Handler } from './route.js';
import { getDurableStore } from '../durable-store-singleton.js';

const GetDurableTimeline = z.object({ runId: z.string().min(1) });
const ProvideStageAnswer = z.object({
  stageIndex: z.number().int().min(0),
  repoName: z.string().optional(),
  questionIndex: z.number().int().min(0),
  text: z.string(),
});

export function durableRoutes(): Record<string, Handler> {
  return {
    'get-durable-timeline': route({
      input: GetDurableTimeline,
      onParseFail: 'silent',
      handle: async (input) => {
        const store = getDurableStore();
        if (!store) {
          return { runId: input.runId, run: null, events: [] };
        }
        try {
          const run = await store.getRun(input.runId);
          const events = run ? await store.readEvents(input.runId) : [];
          return { runId: input.runId, run, events };
        } catch (err) {
          throw err instanceof Error ? err : new Error(String(err));
        }
      },
      wireType: 'durable-timeline',
    }),

    'provide-stage-answer': route({
      input: ProvideStageAnswer,
      onParseFail: 'silent',
      errorWireType: 'pipeline-error',
      handle: (input, deps) => {
        const runner = deps.extras.getActivePipelineRunner?.();
        if (!runner) {
          throw new Error('no active pipeline run');
        }
        if (typeof runner.provideStageAnswer !== 'function') {
          throw new Error('active pipeline runner does not support Q&A signals');
        }
        runner.provideStageAnswer(
          input.stageIndex,
          input.repoName ?? null,
          input.questionIndex,
          input.text,
        );
        // No reply on success — the runner emits state updates via the
        // pipelineBus → services bridge.
        return;
      },
      wireType: 'stage-answer-provided',
    }),
  };
}
