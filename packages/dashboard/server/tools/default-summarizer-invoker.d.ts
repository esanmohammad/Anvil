/**
 * Default summarizer invoker — uses `runWithAgent` from agent-core to
 * spawn a single-shot agent for the focused summarization call. Routes
 * through the standard adapter factory + provider registry, so any
 * model registered in `~/.anvil/models.yaml` works.
 *
 * The invoker is the seam between the prompt-engineering layer
 * (summarizer.ts) and the model-execution layer (agent-core). Tests
 * substitute their own deterministic stub.
 */
import type { SummarizerInvoker } from './summarizer.js';
export declare function createDefaultSummarizerInvoker(): SummarizerInvoker;
//# sourceMappingURL=default-summarizer-invoker.d.ts.map