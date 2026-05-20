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
import { type Handler } from './route.js';
export declare function durableRoutes(): Record<string, Handler>;
//# sourceMappingURL=durable.d.ts.map