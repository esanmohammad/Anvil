/**
 * Instrumentation wrapper — wraps a ModelAdapter so its `run()` method
 * emits an OpenTelemetry span following the GenAI semantic conventions.
 *
 * Phase 2 deviation from plan §2.2: the plan envisioned wrapping
 * `LanguageModel.invoke` / `invokeStream`, but the seven existing adapters
 * implement only the legacy `ModelAdapter.run(config, output)` interface
 * today (see AGENT-CORE-ADR.md §9 Phase 5 deviation). This wrapper targets
 * `run` instead — same integration seam (registry.get), same GenAI
 * attributes emitted, lower fidelity (one span per stage run, not per
 * turn). When adapters gain native `invoke()` impls, this file gains a
 * sibling wrapper for that surface.
 *
 * Tool-call and reasoning child spans are deferred to Phase 3, where
 * per-adapter NDJSON parsing surfaces them.
 */

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderName,
  ProviderCapabilities,
} from '../types.js';
import { getTracer } from './tracer.js';
import { loadTelemetryConfig } from './config.js';
import { GenAi } from './attributes.js';
import { recordGenAiCall } from './metrics.js';
import { calculateCostBreakdown } from '../cost.js';

/**
 * Wrap a single-shot LLM call (e.g. runClaude / runGemini in single-shot.ts)
 * with a `gen_ai.invoke` span. The callback receives the active span only
 * for diagnostic logging; it is auto-`end()`-ed via try/finally.
 */
export async function withInvokeSpan<TResult>(
  args: {
    provider: ProviderName | string;
    model: string;
    prompt?: string;
    systemPrompt?: string;
  },
  exec: () => Promise<TResult>,
  applyResult: (result: TResult) => Record<string, number | string | boolean | undefined>,
): Promise<TResult> {
  const tracer = getTracer();
  const telemetry = loadTelemetryConfig();

  return tracer.startActiveSpan(
    SPAN_NAME,
    { kind: SpanKind.CLIENT },
    async (span) => {
      span.setAttributes({
        [GenAi.SYSTEM]: args.provider,
        [GenAi.REQUEST_MODEL]: args.model,
        [GenAi.MESSAGES_COUNT]: args.systemPrompt ? 2 : 1,
      });
      if (telemetry.recordContent && args.prompt) {
        span.setAttribute(GenAi.PROMPT, args.prompt.slice(0, PROMPT_TRUNCATE_BYTES));
      }
      try {
        const result = await exec();
        const attrs = applyResult(result);
        for (const [k, v] of Object.entries(attrs)) {
          if (v !== undefined) span.setAttribute(k, v as string | number | boolean);
        }
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err as Error);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

const SPAN_NAME = 'gen_ai.invoke';
const PROMPT_TRUNCATE_BYTES = 8192;

/**
 * Return an instrumented view of the adapter. The new object delegates all
 * methods to the wrapped instance; only `run` gets a span around it. When
 * telemetry is disabled, OTel's no-op tracer makes the wrapper effectively
 * free (no allocations beyond a closure).
 */
export function instrumentModelAdapter(adapter: ModelAdapter): ModelAdapter {
  return new InstrumentedModelAdapter(adapter);
}

class InstrumentedModelAdapter implements ModelAdapter {
  constructor(private readonly inner: ModelAdapter) {}

  get provider(): ProviderName {
    return this.inner.provider;
  }
  get capabilities(): ProviderCapabilities {
    return this.inner.capabilities;
  }
  supportsModel(modelId: string): boolean {
    return this.inner.supportsModel(modelId);
  }
  getModelPricing(modelId: string): [number, number] | null {
    return this.inner.getModelPricing(modelId);
  }
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    return this.inner.checkAvailability();
  }
  kill(): void {
    this.inner.kill?.();
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    const tracer = getTracer();
    const telemetry = loadTelemetryConfig();

    return tracer.startActiveSpan(
      SPAN_NAME,
      { kind: SpanKind.CLIENT },
      async (span) => {
        span.setAttributes({
          [GenAi.SYSTEM]: this.inner.provider,
          [GenAi.REQUEST_MODEL]: config.model,
          [GenAi.MESSAGES_COUNT]: 1,
          [GenAi.TOOLS_COUNT]: config.allowedTools?.length ?? 0,
          'anvil.stage': config.stage,
          'anvil.persona': config.persona,
          'anvil.session.resume': config.resume === true,
        });
        if (telemetry.recordContent) {
          span.setAttribute(
            GenAi.PROMPT,
            config.userPrompt.slice(0, PROMPT_TRUNCATE_BYTES),
          );
        }

        try {
          const result = await this.inner.run(config, output);
          // Compute the per-component breakdown from the central cost table.
          // When the table doesn't know the model, breakdown.totalUsd is 0 —
          // fall back to the adapter's costUsd so we never undercount in
          // exported telemetry. (Decision O6: agent-core is the single source
          // of truth, but only when it actually has data.)
          const bd = calculateCostBreakdown(result.model, {
            inputTokens: result.inputTokens,
            outputTokens: result.outputTokens,
            cacheReadTokens: result.cacheReadTokens,
            cacheWriteTokens: result.cacheWriteTokens,
          });
          const totalUsd = bd.totalUsd > 0 ? bd.totalUsd : result.costUsd;
          span.setAttributes({
            [GenAi.USAGE_INPUT_TOKENS]: result.inputTokens,
            [GenAi.USAGE_OUTPUT_TOKENS]: result.outputTokens,
            [GenAi.USAGE_COST_USD]: totalUsd,
            [GenAi.USAGE_COST_INPUT_USD]: bd.inputUsd,
            [GenAi.USAGE_COST_OUTPUT_USD]: bd.outputUsd,
            [GenAi.USAGE_COST_CACHE_READ_USD]: bd.cacheReadUsd,
            [GenAi.USAGE_COST_CACHE_WRITE_USD]: bd.cacheWriteUsd,
            [GenAi.RESPONSE_MODEL]: result.model,
            'anvil.duration_ms': result.durationMs,
          });
          if (result.sessionId) {
            span.setAttribute(GenAi.RESPONSE_ID, result.sessionId);
          }
          // Phase 3 — cache + reasoning + tool-call enrichment from
          // per-adapter response parsing. Adapters that don't surface these
          // simply leave the fields undefined; we don't fabricate zeros for
          // providers where the data isn't reported.
          if (typeof result.cacheReadTokens === 'number') {
            span.setAttribute(GenAi.USAGE_CACHE_READ_TOKENS, result.cacheReadTokens);
            const denom = result.inputTokens + result.cacheReadTokens;
            if (denom > 0) {
              span.setAttribute(GenAi.USAGE_CACHE_HIT_RATIO, result.cacheReadTokens / denom);
            }
          }
          if (typeof result.cacheWriteTokens === 'number') {
            span.setAttribute(GenAi.USAGE_CACHE_WRITE_TOKENS, result.cacheWriteTokens);
          }
          if (typeof result.reasoningTokens === 'number' && result.reasoningTokens > 0) {
            span.setAttribute(GenAi.REASONING_TOKENS, result.reasoningTokens);
          }
          if (typeof result.toolCallCount === 'number') {
            span.setAttribute('gen_ai.response.tool_call_count', result.toolCallCount);
          }
          if (telemetry.recordContent) {
            span.setAttribute(
              GenAi.COMPLETION,
              result.output.slice(0, PROMPT_TRUNCATE_BYTES),
            );
          }
          // Mirror the span attrs into OTel metrics so Grafana can build
          // counter/histogram dashboards. Failures here must not bubble —
          // a metrics emit issue should never break the agent run.
          try {
            recordGenAiCall({
              system: this.inner.provider,
              requestModel: config.model,
              responseModel: result.model,
              stage: config.stage,
              persona: config.persona,
              inputTokens: result.inputTokens,
              outputTokens: result.outputTokens,
              cacheReadTokens: result.cacheReadTokens ?? 0,
              cacheWriteTokens: result.cacheWriteTokens ?? 0,
              reasoningTokens: result.reasoningTokens,
              costInputUsd: bd.inputUsd,
              costOutputUsd: bd.outputUsd,
              costCacheReadUsd: bd.cacheReadUsd,
              costCacheWriteUsd: bd.cacheWriteUsd,
              costTotalUsd: totalUsd,
              durationMs: result.durationMs ?? 0,
            });
          } catch { /* never let metrics break a run */ }
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err) {
          span.recordException(err as Error);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }
}
