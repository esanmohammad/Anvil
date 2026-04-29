/**
 * `LlmRouter` — single source of truth for routing, retries, fallbacks,
 * rate-limits, spend tracking, and circuit breaking.
 *
 * Phase 2: per-error retry engine wired against a single caller-supplied
 * adapter. No fallback chain yet — that lands in Phase 5.
 */

import type {
  ErrorClass,
  InvokeOpts,
  RetryPolicy,
  RouteAttempt,
  RouteOutcome,
  RouterConfig,
} from './types.js';
import type { LanguageModel, LanguageModelInvokeOptions, InvokeResult } from '../types.js';
import { RouterError, classifyError } from './errors.js';
import { DEFAULT_RETRY_POLICY, runWithRetry } from './retry.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';

export interface AdapterResolver {
  /** Resolve a model id to an executor. */
  resolve(modelId: string): LanguageModel;
}

export interface LlmRouterDeps {
  config: RouterConfig;
  /**
   * Resolves a model id → executor. Phase 5 wires this to ProviderRegistry.
   * Tests inject fakes directly.
   */
  resolver?: AdapterResolver;
  /**
   * Pre-flight rate limiter. If omitted, the router constructs an internal
   * TokenBucketRateLimiter from `config.rateLimit`.
   */
  rateLimiter?: TokenBucketRateLimiter;
  /** Time source for deterministic tests. */
  now?: () => number;
  /** Sleep — injectable for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Random source for jitter. */
  random?: () => number;
  /** Adapter-specific error classifiers (per-provider override). */
  errorClassifiers?: Record<string, (err: unknown) => ErrorClass | undefined>;
}

export class LlmRouter {
  protected readonly config: RouterConfig;
  protected readonly resolver?: AdapterResolver;
  protected readonly rateLimiter: TokenBucketRateLimiter;
  protected readonly now: () => number;
  protected readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  protected readonly random?: () => number;
  protected readonly errorClassifiers: Record<string, (err: unknown) => ErrorClass | undefined>;

  constructor(deps: LlmRouterDeps) {
    this.config = deps.config;
    this.resolver = deps.resolver;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep;
    this.random = deps.random;
    this.errorClassifiers = deps.errorClassifiers ?? {};
    this.rateLimiter =
      deps.rateLimiter ??
      new TokenBucketRateLimiter({
        config: deps.config.rateLimit,
        now: deps.now,
        sleep: deps.sleep
          ? (ms: number) => deps.sleep!(ms)
          : undefined,
        onRateLimit: deps.config.onRateLimit,
      });
  }

  /** Inspect the active config (immutable snapshot). */
  getConfig(): Readonly<RouterConfig> {
    return this.config;
  }

  /**
   * Resolve the route for a tag (or pinned model) and execute the call
   * under the configured retry policy. Phase 2 is single-adapter scope —
   * the primary model is invoked, and on terminal failure the call fails.
   */
  async invoke(opts: InvokeOpts): Promise<RouteOutcome> {
    const startedAt = this.now();
    const modelId = this.resolveModelId(opts);
    if (!this.resolver) {
      throw new Error('LlmRouter.invoke requires an AdapterResolver (deps.resolver)');
    }
    const adapter = this.resolver.resolve(modelId);

    const llmOpts = this.buildInvokeOpts(opts, modelId);
    const estimatedTokens = this.estimateTokens(llmOpts);

    const policyFor = (cls: ErrorClass): RetryPolicy =>
      this.config.retryPolicy[cls] ?? DEFAULT_RETRY_POLICY[cls];

    const classify = (err: unknown): ErrorClass | undefined => {
      const provider = adapter.provider;
      const override = this.errorClassifiers[provider];
      const overrideResult = override?.(err);
      if (overrideResult) return overrideResult;
      return classifyError(err);
    };

    const retryRun = await runWithRetry<InvokeResult>(
      async () => {
        await this.rateLimiter.acquire(adapter.provider, estimatedTokens);
        return adapter.invoke(llmOpts);
      },
      {
        policyFor,
        classify,
        sleep: this.sleep,
        now: this.now,
        random: this.random,
        signal: opts.signal,
      },
    );

    const attempts: RouteAttempt[] = retryRun.attempts.map((a) => ({
      model: modelId,
      provider: adapter.provider,
      attemptIndex: a.index,
      fallbackIndex: 0,
      errorClass: a.errorClass,
      durationMs: a.durationMs,
      costUsd: undefined,
    }));

    const totalDurationMs = Math.max(0, this.now() - startedAt);

    if (retryRun.result) {
      const last = attempts[attempts.length - 1];
      if (last) last.costUsd = retryRun.result.costUsd;
      return {
        result: retryRun.result,
        attempts,
        totalDurationMs,
        totalCostUsd: retryRun.result.costUsd,
      };
    }

    const err = retryRun.error ?? new Error('LlmRouter: unknown failure');
    throw new RouterError(`route '${opts.tag}' failed: ${err.message}`, {
      attempts,
      cause: err,
    });
  }

  protected resolveModelId(opts: InvokeOpts): string {
    if (opts.model) return opts.model;
    const route = this.config.routes.find((r) => r.tag === opts.tag);
    if (!route) {
      throw new Error(`LlmRouter: no route for tag '${opts.tag}' (and no opts.model pin)`);
    }
    return route.primary;
  }

  /**
   * Rough token estimate for pre-flight rate-limit checks. Uses the
   * standard ~4-chars-per-token heuristic over message content. We bias
   * slightly high (with maxTokens) so the bucket reserves enough room
   * for the response too.
   */
  protected estimateTokens(opts: LanguageModelInvokeOptions): number {
    const promptChars = opts.messages.reduce((acc, m) => acc + m.content.length, 0);
    const promptTokens = Math.ceil(promptChars / 4);
    const responseTokens = opts.maxTokens ?? 1024;
    return promptTokens + responseTokens;
  }

  protected buildInvokeOpts(opts: InvokeOpts, modelId: string): LanguageModelInvokeOptions {
    const messages =
      typeof opts.prompt === 'string'
        ? [{ role: 'user' as const, content: opts.prompt }]
        : opts.prompt.map((m) => ({ role: m.role, content: m.content }));
    return {
      model: modelId,
      messages,
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      cacheBreakpoint: opts.cacheBreakpoint,
      providerOptions: opts.providerOptions,
      signal: opts.signal,
    };
  }
}
