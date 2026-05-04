/**
 * Router telemetry — OTel parent + child spans for `LlmRouter.invoke`.
 *
 * Span hierarchy (per ADR R10):
 *   anvil.router.invoke         — one per invoke() call
 *     anvil.router.attempt      — one per RouteAttempt (success or failure)
 *       gen_ai.invoke           — emitted by instrumentModelAdapter (legacy
 *                                  adapters) or LanguageModel callers
 *
 * Attributes:
 *   anvil.router.route_id, anvil.router.tag, anvil.router.run_id,
 *   anvil.router.attempt, anvil.router.error_class,
 *   anvil.router.fallback_index, anvil.router.budget_remaining_usd,
 *   anvil.router.circuit_breaker_state, anvil.router.total_cost_usd,
 *   anvil.router.attempt_count
 *
 * Wrapper-style — call `withRouterSpans(router, opts)` to capture spans
 * around a single invoke. The wrapper is a no-op when `recordContent` is
 * false; it never throws on tracer absence.
 */

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import type { Span } from '@opentelemetry/api';
import { getTracer } from '../telemetry/tracer.js';
import type { LlmRouter } from './router.js';
import type { InvokeOpts, RouteOutcome, RouteAttempt } from './types.js';
import { RouterError } from './errors.js';

export const ROUTER_INVOKE_SPAN = 'anvil.router.invoke';
export const ROUTER_ATTEMPT_SPAN = 'anvil.router.attempt';

export const RouterAttr = {
  ROUTE_ID: 'anvil.router.route_id',
  TAG: 'anvil.router.tag',
  RUN_ID: 'anvil.router.run_id',
  PROJECT: 'anvil.router.project',
  USER: 'anvil.router.user',
  ATTEMPT: 'anvil.router.attempt',
  ATTEMPT_COUNT: 'anvil.router.attempt_count',
  ERROR_CLASS: 'anvil.router.error_class',
  FALLBACK_INDEX: 'anvil.router.fallback_index',
  BUDGET_REMAINING_USD: 'anvil.router.budget_remaining_usd',
  CIRCUIT_BREAKER_STATE: 'anvil.router.circuit_breaker_state',
  TOTAL_COST_USD: 'anvil.router.total_cost_usd',
  PROVIDER: 'anvil.router.provider',
  MODEL: 'anvil.router.model',
  COST_USD: 'anvil.router.cost_usd',
} as const;

/**
 * Wrap a single `LlmRouter.invoke()` call with a parent span and one
 * child span per RouteAttempt. The wrapper post-walks `outcome.attempts`
 * to emit children — this keeps the router code itself untouched.
 */
export async function invokeWithSpans(
  router: LlmRouter,
  opts: InvokeOpts,
): Promise<RouteOutcome> {
  const tracer = getTracer();
  return tracer.startActiveSpan(
    ROUTER_INVOKE_SPAN,
    { kind: SpanKind.INTERNAL },
    async (parent: Span) => {
      parent.setAttribute(RouterAttr.TAG, opts.tag);
      if (opts.runId) parent.setAttribute(RouterAttr.RUN_ID, opts.runId);
      if (opts.project) parent.setAttribute(RouterAttr.PROJECT, opts.project);
      if (opts.user) parent.setAttribute(RouterAttr.USER, opts.user);
      try {
        const outcome = await router.invoke(opts);
        emitAttemptChildren(tracer, outcome.attempts);
        parent.setAttributes({
          [RouterAttr.ATTEMPT_COUNT]: outcome.attempts.length,
          [RouterAttr.TOTAL_COST_USD]: outcome.totalCostUsd,
        });
        if (outcome.budgetRemainingUsd !== undefined) {
          parent.setAttribute(RouterAttr.BUDGET_REMAINING_USD, outcome.budgetRemainingUsd);
        }
        parent.setStatus({ code: SpanStatusCode.OK });
        return outcome;
      } catch (err) {
        if (err instanceof RouterError) {
          emitAttemptChildren(tracer, err.attempts);
          parent.setAttribute(RouterAttr.ATTEMPT_COUNT, err.attempts.length);
        }
        parent.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        if (err instanceof Error) parent.recordException(err);
        throw err;
      } finally {
        parent.end();
      }
    },
  );
}

function emitAttemptChildren(
  tracer: ReturnType<typeof getTracer>,
  attempts: ReadonlyArray<RouteAttempt>,
): void {
  for (const a of attempts) {
    tracer.startActiveSpan(
      ROUTER_ATTEMPT_SPAN,
      { kind: SpanKind.INTERNAL },
      (child: Span) => {
        child.setAttributes({
          [RouterAttr.PROVIDER]: a.provider,
          [RouterAttr.MODEL]: a.model,
          [RouterAttr.ATTEMPT]: a.attemptIndex,
          [RouterAttr.FALLBACK_INDEX]: a.fallbackIndex,
        });
        if (a.errorClass) child.setAttribute(RouterAttr.ERROR_CLASS, a.errorClass);
        if (a.costUsd !== undefined) child.setAttribute(RouterAttr.COST_USD, a.costUsd);
        if (a.errorClass) {
          child.setStatus({ code: SpanStatusCode.ERROR, message: a.errorClass });
        } else {
          child.setStatus({ code: SpanStatusCode.OK });
        }
        child.end();
      },
    );
  }
}
