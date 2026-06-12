/**
 * `LlmRouter` — single source of truth for routing, retries, fallbacks,
 * rate-limits, spend tracking, and circuit breaking.
 *
 * Phase 5: walks the full fallback chain. Per-error gates control which
 * fallback steps are eligible. content_policy / auth / invalid_request
 * never trigger cross-provider fallback (security default).
 */

import type {
  ErrorClass,
  InvokeOpts,
  RetryPolicy,
  RouteAttempt,
  RouteConfig,
  RouteOutcome,
  RouterConfig,
} from './types.js';
import type { LanguageModel, LanguageModelInvokeOptions, InvokeResult, StreamEvent } from '../types.js';
import { RouterError, classifyError, isFallbackEligibleErrorClass, parseRetryAfterMs } from './errors.js';
import { DEFAULT_RETRY_POLICY, runWithRetry, computeDelay } from './retry.js';
import { TokenBucketRateLimiter } from './rate-limiter.js';
import { SpendLedger } from './spend-ledger.js';
import { CircuitBreaker } from './circuit-breaker.js';

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
  /**
   * Spend ledger. If omitted, no rows are recorded (useful for tests or
   * embedded scenarios). Pass `new SpendLedger()` to use the default
   * `~/.anvil/router/spend.sqlite` file.
   */
  ledger?: SpendLedger;
  /**
   * Per-provider circuit breaker. If omitted, the router constructs one
   * from `config.circuitBreaker` (or defaults).
   */
  circuitBreaker?: CircuitBreaker;
  /** Generate ledger row ids — injectable for deterministic tests. */
  newId?: () => string;
  /** Time source for deterministic tests. */
  now?: () => number;
  /** Sleep — injectable for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Random source for jitter. */
  random?: () => number;
  /** Adapter-specific error classifiers (per-provider override). */
  errorClassifiers?: Record<string, (err: unknown) => ErrorClass | undefined>;
}

/**
 * Options for the agentic chain walk (`runAgent`). Unlike `invoke`/`invokeStream`
 * (tag-routed, single-shot adapter calls), the agentic path executes an
 * injected `attempt(model, prefill)` — a full agent spawn the caller owns
 * (e.g. the dashboard's `spawnAndWait` over `AgentManager`). The router
 * supplies the reliability: per-error-class backoff retry, circuit breaking,
 * unified classification, and cross-model burn + durable prefill resume.
 */
export interface AgentChainOptions<P = unknown> {
  /** Stage label for telemetry / burn events. */
  stage: string;
  /** Resolve the next model id given the burned set (caller's liveness-aware walker). */
  resolveModel: (excluded: ReadonlySet<string>) => string;
  /** Derive a provider key from a model id for the circuit breaker. Defaults to the resolver. */
  providerOf?: (model: string) => string;
  /** After a burn, produce the prefill the next attempt continues from (durable cross-vendor resume). */
  resolvePrefill?: (info: { burnedModel: string; attemptIndex: number; nextModel?: string }) => Promise<P | undefined>;
  /**
   * Fired when a model is burned. `errorClass` is the unified classification
   * (rate_limit / timeout / server_5xx / model_unavailable / …) and `delayMs`
   * is the backoff about to elapse before the next attempt (0 on the final
   * attempt). Lets the UI render the real timeline:
   * "minimax rate_limited → backoff 2.1s → next model".
   */
  onBurn?: (info: {
    stageName: string;
    model: string;
    status: number | string;
    message: string;
    errorClass: ErrorClass;
    delayMs: number;
  }) => void;
  /** Max distinct chain entries to walk. Default 5. */
  maxAttempts?: number;
  signal?: AbortSignal;
}

export interface AgentChainResult<T> {
  result: T;
  model: string;
  attempts: RouteAttempt[];
}

export class LlmRouter {
  protected readonly config: RouterConfig;
  protected readonly resolver?: AdapterResolver;
  protected readonly rateLimiter: TokenBucketRateLimiter;
  protected readonly circuitBreaker: CircuitBreaker;
  protected readonly ledger?: SpendLedger;
  protected readonly newId: () => string;
  protected readonly now: () => number;
  protected readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  protected readonly random?: () => number;
  protected readonly errorClassifiers: Record<string, (err: unknown) => ErrorClass | undefined>;

  constructor(deps: LlmRouterDeps) {
    this.config = deps.config;
    this.resolver = deps.resolver;
    this.ledger = deps.ledger;
    this.newId = deps.newId ?? defaultNewId;
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
    this.circuitBreaker =
      deps.circuitBreaker ??
      new CircuitBreaker({
        config: deps.config.circuitBreaker,
        now: deps.now,
      });
  }

  /** Inspect the active config (immutable snapshot). */
  getConfig(): Readonly<RouterConfig> {
    return this.config;
  }

  /**
   * Resolve the route for a tag (or pinned model) and walk the chain
   * primary → fallback[0] → fallback[1] until either success or the
   * chain is exhausted.
   *
   * Per ADR R5:
   *   - auth / content_policy / invalid_request never trigger fallback
   *   - rate_limit / server_5xx / timeout default to the full chain;
   *     RouteFallback.on can restrict per-step
   *   - All attempts are ledgered (including failed ones with cost)
   */
  async invoke(opts: InvokeOpts): Promise<RouteOutcome> {
    const startedAt = this.now();
    if (!this.resolver) {
      throw new Error('LlmRouter.invoke requires an AdapterResolver (deps.resolver)');
    }

    // Pre-flight budget enforcement (Phase 4)
    this.enforceBudgetPreflight(opts);

    const chain = this.buildChain(opts);
    const allAttempts: RouteAttempt[] = [];
    let totalCostUsd = 0;
    let lastError: Error | undefined;
    let lastErrorClass: ErrorClass | undefined;
    let priorAttempted = false; // true once any step has actually run
    const maxCost = this.config.maxFallbackCostUsd ?? 1.0;

    for (let step = 0; step < chain.length; step += 1) {
      const link = chain[step];
      const adapter = this.resolver.resolve(link.model);

      // Skip non-primary steps whose `on` gate doesn't match the previous
      // error. If no step has yet attempted (e.g., circuit breaker skipped
      // every prior step) we let the fallback run regardless of its gate —
      // there's no prior error to filter against.
      if (step > 0 && priorAttempted && !this.shouldTryFallback(link, lastErrorClass)) {
        continue;
      }

      // Circuit-breaker — if open, skip this provider entirely (no adapter
      // call, no rate-limit consumption, no ledger row).
      if (!this.circuitBreaker.canAttempt(adapter.provider)) {
        continue;
      }
      this.circuitBreaker.reserveAttempt(adapter.provider);
      priorAttempted = true;

      const llmOpts = this.buildInvokeOpts(opts, link.model);
      const estimatedTokens = this.estimateTokens(llmOpts);

      const policyFor = (cls: ErrorClass): RetryPolicy =>
        this.config.retryPolicy[cls] ?? DEFAULT_RETRY_POLICY[cls];

      const classify = (err: unknown): ErrorClass | undefined => {
        const override = this.errorClassifiers[adapter.provider];
        return override?.(err) ?? classifyError(err);
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

      const stepAttempts: RouteAttempt[] = retryRun.attempts.map((a) => ({
        model: link.model,
        provider: adapter.provider,
        attemptIndex: a.index,
        fallbackIndex: step,
        errorClass: a.errorClass,
        durationMs: a.durationMs,
        costUsd: undefined,
      }));
      allAttempts.push(...stepAttempts);

      if (retryRun.result) {
        const last = stepAttempts[stepAttempts.length - 1];
        if (last) last.costUsd = retryRun.result.costUsd;
        totalCostUsd += retryRun.result.costUsd;
        this.recordSpend(opts, adapter.provider, link.model, stepAttempts, retryRun.result, undefined);
        this.circuitBreaker.recordSuccess(adapter.provider);
        const outcome: RouteOutcome = {
          result: retryRun.result,
          attempts: allAttempts,
          totalDurationMs: Math.max(0, this.now() - startedAt),
          totalCostUsd,
        };
        this.populateBudgetRemaining(outcome, opts);
        return outcome;
      }

      lastError = retryRun.error ?? new Error('LlmRouter: unknown failure');
      lastErrorClass = stepAttempts[stepAttempts.length - 1]?.errorClass ?? 'unknown';

      // Record this step's spend regardless (even though no cost was billed).
      this.recordSpend(opts, adapter.provider, link.model, stepAttempts, undefined, lastError);

      // Update circuit breaker: only retryable provider faults count
      // toward tripping the breaker — auth/content_policy/invalid_request
      // are caller / data issues, not provider health, so they don't open
      // the circuit.
      if (!isTerminal(lastErrorClass)) {
        this.circuitBreaker.recordFailure(adapter.provider);
      } else {
        // Terminal classes leave breaker state untouched and short-circuit.
        break;
      }

      // Per-call cost ceiling — abort the chain if we've already exceeded it.
      if (totalCostUsd > maxCost) {
        break;
      }
    }

    const finalErr = lastError ?? new Error('LlmRouter: chain produced no error and no result');
    throw new RouterError(`route '${opts.tag}' failed: ${finalErr.message}`, {
      attempts: allAttempts,
      cause: finalErr,
    });
  }

  /**
   * Streaming sibling of `invoke()`. Walks the same fallback chain with the
   * same reliability kernel — circuit-breaker gate, per-error-class backoff
   * retry, spend ledger — but yields `StreamEvent`s as the provider produces
   * them and RETURNS the final `RouteOutcome`.
   *
   * Stream retry/fallback semantics: the retryable window is "establish the
   * stream + pull its first event". A failure there — the canonical
   * connect-time `fetch failed` that used to burn a whole chain in ~1.5s — is
   * retried with backoff on the same model (letting a poisoned socket recycle)
   * and, once that model's policy is exhausted, burns it and falls back to the
   * next chain entry. Once the first event has been yielded downstream we are
   * committed to that model's stream: a mid-stream failure surfaces (the
   * agentic session layer adds durable mid-stream continuation in Phase 3).
   */
  async *invokeStream(opts: InvokeOpts): AsyncGenerator<StreamEvent, RouteOutcome> {
    const startedAt = this.now();
    if (!this.resolver) {
      throw new Error('LlmRouter.invokeStream requires an AdapterResolver (deps.resolver)');
    }
    this.enforceBudgetPreflight(opts);

    const chain = this.buildChain(opts);
    const allAttempts: RouteAttempt[] = [];
    let totalCostUsd = 0;
    let lastError: Error | undefined;
    let lastErrorClass: ErrorClass | undefined;
    let priorAttempted = false;
    const maxCost = this.config.maxFallbackCostUsd ?? 1.0;

    for (let step = 0; step < chain.length; step += 1) {
      const link = chain[step];
      const adapter = this.resolver.resolve(link.model);

      if (step > 0 && priorAttempted && !this.shouldTryFallback(link, lastErrorClass)) {
        continue;
      }
      if (!this.circuitBreaker.canAttempt(adapter.provider)) {
        continue;
      }
      this.circuitBreaker.reserveAttempt(adapter.provider);
      priorAttempted = true;

      const llmOpts = this.buildInvokeOpts(opts, link.model);
      const estimatedTokens = this.estimateTokens(llmOpts);
      const policyFor = (cls: ErrorClass): RetryPolicy =>
        this.config.retryPolicy[cls] ?? DEFAULT_RETRY_POLICY[cls];
      const classify = (err: unknown): ErrorClass | undefined => {
        const override = this.errorClassifiers[adapter.provider];
        return override?.(err) ?? classifyError(err);
      };

      // Retryable window — open the stream and pull the first event. A
      // connect-time failure throws here and `runWithRetry` backs off + retries
      // the same model before we burn it.
      type Established = {
        iterator: AsyncIterator<StreamEvent, InvokeResult>;
        first: IteratorResult<StreamEvent, InvokeResult>;
      };
      const retryRun = await runWithRetry<Established>(
        async () => {
          await this.rateLimiter.acquire(adapter.provider, estimatedTokens);
          const iterator = adapter.invokeStream(llmOpts)[Symbol.asyncIterator]() as
            AsyncIterator<StreamEvent, InvokeResult>;
          const first = await iterator.next();
          return { iterator, first };
        },
        { policyFor, classify, sleep: this.sleep, now: this.now, random: this.random, signal: opts.signal },
      );

      const stepAttempts: RouteAttempt[] = retryRun.attempts.map((a) => ({
        model: link.model,
        provider: adapter.provider,
        attemptIndex: a.index,
        fallbackIndex: step,
        errorClass: a.errorClass,
        durationMs: a.durationMs,
        costUsd: undefined,
      }));
      allAttempts.push(...stepAttempts);

      if (!retryRun.result) {
        lastError = retryRun.error ?? new Error('LlmRouter.invokeStream: unknown failure');
        lastErrorClass = stepAttempts[stepAttempts.length - 1]?.errorClass ?? 'unknown';
        this.recordSpend(opts, adapter.provider, link.model, stepAttempts, undefined, lastError);
        if (!isTerminal(lastErrorClass)) {
          this.circuitBreaker.recordFailure(adapter.provider);
        } else {
          break;
        }
        if (totalCostUsd > maxCost) break;
        continue;
      }

      // Stream established — drain it, yielding events; capture the final result.
      const { iterator, first } = retryRun.result;
      let result: InvokeResult | undefined;
      let drainError: unknown;
      try {
        if (first.done) {
          result = first.value;
        } else {
          yield first.value;
          while (true) {
            const s = await iterator.next();
            if (s.done) {
              result = s.value;
              break;
            }
            yield s.value;
          }
        }
      } catch (err) {
        drainError = err;
      }

      if (drainError || !result) {
        // Mid-stream failure AFTER emitting — can't fall back to another model
        // cleanly (events already flowed downstream). Surface it.
        lastError = drainError instanceof Error
          ? drainError
          : new Error(String(drainError ?? 'stream ended without a result'));
        lastErrorClass = classify(lastError) ?? 'unknown';
        this.recordSpend(opts, adapter.provider, link.model, stepAttempts, undefined, lastError);
        if (!isTerminal(lastErrorClass)) this.circuitBreaker.recordFailure(adapter.provider);
        throw new RouterError(
          `route '${opts.tag}' stream failed mid-flight on ${link.model}: ${lastError.message}`,
          { attempts: allAttempts, cause: lastError },
        );
      }

      const last = stepAttempts[stepAttempts.length - 1];
      if (last) last.costUsd = result.costUsd;
      totalCostUsd += result.costUsd;
      this.recordSpend(opts, adapter.provider, link.model, stepAttempts, result, undefined);
      this.circuitBreaker.recordSuccess(adapter.provider);
      const outcome: RouteOutcome = {
        result,
        attempts: allAttempts,
        totalDurationMs: Math.max(0, this.now() - startedAt),
        totalCostUsd,
      };
      this.populateBudgetRemaining(outcome, opts);
      return outcome;
    }

    const finalErr = lastError ?? new Error('LlmRouter.invokeStream: chain produced no error and no result');
    throw new RouterError(`route '${opts.tag}' failed: ${finalErr.message}`, {
      attempts: allAttempts,
      cause: finalErr,
    });
  }

  /**
   * Agentic chain walk — the reliability core for full agent spawns (one-shot
   * runner AND each turn of a multi-turn session). Drop-in replacement for the
   * old `runWithChainFallback`, but layered: each chain entry's attempt is
   * wrapped in per-error-class **backoff retry** (`runWithRetry`) and gated by
   * the **circuit breaker**; classification is the unified `classifyError`.
   *
   * On a fall-back-eligible failure the model is burned, the breaker records a
   * failure, the durable `resolvePrefill` produces the continuation for the
   * next model, and the walk advances. Terminal (auth/content/invalid) and
   * non-eligible (`unknown`) errors surface immediately — no burn, no walk.
   *
   * This is what fixes the production failure: a connect-time `fetch failed`
   * now backs off (letting the socket pool recycle) and recovers on the same
   * model before burning, instead of the zero-backoff chain burn-through.
   */
  async runAgent<T, P = unknown>(
    opts: AgentChainOptions<P>,
    attempt: (model: string, prefill?: P) => Promise<T>,
  ): Promise<AgentChainResult<T>> {
    const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
    const burned = new Set<string>();
    const attempts: RouteAttempt[] = [];
    let prefill: P | undefined;
    let lastErr: unknown;

    const providerOf = opts.providerOf ?? ((m: string): string => {
      try {
        return this.resolver?.resolve(m).provider ?? 'unknown';
      } catch {
        return 'unknown';
      }
    });
    const policyFor = (cls: ErrorClass): RetryPolicy =>
      this.config.retryPolicy[cls] ?? DEFAULT_RETRY_POLICY[cls];
    const random = this.random ?? Math.random;
    const now = this.now;
    const sleep = this.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    // ONE attempt per chain entry — agent spawns are expensive, so we do NOT
    // re-spawn the same model in a tight loop (that's what `invoke`'s
    // `runWithRetry` is for). Instead, on a fall-back-eligible failure we burn
    // the model, BACK OFF (the fix — lets a poisoned socket pool / quota
    // recover), then let `resolveModel` pick the next entry. When the caller's
    // resolver ignores the burn set (cli: one pinned model) this naturally
    // becomes same-model retry-with-backoff; when it excludes burns (dashboard
    // liveness walker) it's cross-model fallback. Terminal + `unknown` errors
    // surface immediately — no burn, no backoff — matching the prior
    // `runWithChainFallback` semantics (a generic error is a bug, not a
    // provider fault).
    for (let i = 0; i < maxAttempts; i += 1) {
      let model: string;
      try {
        model = opts.resolveModel(burned);
      } catch (err) {
        lastErr = err;
        break;
      }
      const provider = providerOf(model);
      const classify = (err: unknown): ErrorClass =>
        this.errorClassifiers[provider]?.(err) ?? classifyError(err);

      // Circuit breaker open → skip this provider, burn its model, walk on.
      if (!this.circuitBreaker.canAttempt(provider)) {
        attempts.push({ model, provider, attemptIndex: i, fallbackIndex: i, durationMs: 0 });
        burned.add(model);
        continue;
      }
      this.circuitBreaker.reserveAttempt(provider);

      const startedAt = now();
      try {
        const result = await attempt(model, prefill);
        attempts.push({ model, provider, attemptIndex: i, fallbackIndex: i, durationMs: Math.max(0, now() - startedAt) });
        this.circuitBreaker.recordSuccess(provider);
        return { result, model, attempts };
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const cls = classify(lastErr);
        attempts.push({ model, provider, attemptIndex: i, fallbackIndex: i, errorClass: cls, durationMs: Math.max(0, now() - startedAt) });

        // Terminal or non-eligible (unknown) → surface immediately.
        if (isTerminal(cls) || !isFallbackEligibleErrorClass(cls)) {
          throw lastErr;
        }
        this.circuitBreaker.recordFailure(provider);
        burned.add(model);
        const status = (lastErr as { status?: number | string }).status ?? '?';
        const message = (lastErr as Error).message?.slice(0, 200) ?? 'unknown';

        // Backoff for the NEXT attempt — honor Retry-After when present, else
        // the per-error-class curve. `model_unavailable` has a zero-delay
        // policy, so a phantom-model id hops instantly. Zero on the final
        // attempt (nothing to wait for). Computed BEFORE onBurn so the UI can
        // render the backoff the burn is about to incur.
        const hasNext = i + 1 < maxAttempts;
        const policy = policyFor(cls);
        const headerDelay = parseRetryAfterMs((lastErr as { headers?: Record<string, string | undefined> }).headers);
        const delayMs = hasNext ? (headerDelay ?? computeDelay(policy, i, random)) : 0;
        opts.onBurn?.({ stageName: opts.stage, model, status, message, errorClass: cls, delayMs });

        if (hasNext) {
          if (delayMs > 0) {
            try {
              await sleep(delayMs, opts.signal);
            } catch (e) {
              lastErr = e;
              break;
            }
          }
          if (opts.resolvePrefill) {
            let nextModel: string | undefined;
            try {
              nextModel = opts.resolveModel(burned);
            } catch {
              nextModel = undefined;
            }
            try {
              prefill = await opts.resolvePrefill({ burnedModel: model, attemptIndex: i + 1, nextModel });
            } catch {
              prefill = undefined;
            }
          }
        }
      }
    }

    throw lastErr ?? new Error(`LlmRouter.runAgent: chain exhausted for stage '${opts.stage}'`);
  }

  /** Build the ordered chain of (model, on-gate) steps for a given tag. */
  protected buildChain(opts: InvokeOpts): Array<{ model: string; on?: ErrorClass[] }> {
    if (opts.model) {
      // Pinned model — no fallbacks (escape hatch).
      return [{ model: opts.model }];
    }
    const route: RouteConfig | undefined = this.config.routes.find((r) => r.tag === opts.tag);
    if (!route) {
      throw new Error(`LlmRouter: no route for tag '${opts.tag}' (and no opts.model pin)`);
    }
    const chain: Array<{ model: string; on?: ErrorClass[] }> = [{ model: route.primary }];
    for (const fb of route.fallbacks ?? []) {
      chain.push({ model: fb.model, on: fb.on });
    }
    return chain;
  }

  /** Decide whether to try this fallback step given the prior error class. */
  protected shouldTryFallback(
    fallback: { on?: ErrorClass[] },
    priorClass: ErrorClass | undefined,
  ): boolean {
    if (!priorClass) return false;
    if (isTerminal(priorClass)) return false;
    // No `on` filter means "any retryable error".
    if (!fallback.on || fallback.on.length === 0) return true;
    return fallback.on.includes(priorClass);
  }

  // ── Budget + ledger helpers ────────────────────────────────────────────

  protected enforceBudgetPreflight(opts: InvokeOpts): void {
    if (!this.ledger || !this.config.budgets) return;
    const remaining = this.computeRemainingBudget(opts);
    if (remaining === undefined) return;
    if (remaining > 0) return;
    const breach = this.config.budgets.onBreach;
    if (breach === 'fail') {
      throw new Error(`LlmRouter: budget exhausted for tag='${opts.tag}' (run='${opts.runId ?? ''}')`);
    }
    if (breach === 'queue') {
      throw new Error(`LlmRouter: budget exhausted; queue mode not yet implemented`);
    }
    // 'downgrade' — Phase 5 will pick a cheaper fallback. Phase 4 lets the call
    // through and trusts the per-call cap.
  }

  protected computeRemainingBudget(opts: InvokeOpts): number | undefined {
    if (!this.ledger || !this.config.budgets) return undefined;
    const b = this.config.budgets;
    let remaining: number | undefined;
    const setMin = (val: number) => {
      remaining = remaining === undefined ? val : Math.min(remaining, val);
    };
    if (b.dailyUsd !== undefined) {
      const since = startOfTodayIso();
      setMin(b.dailyUsd - this.ledger.totalUsd({ since }));
    }
    if (b.perRunUsd !== undefined && opts.runId) {
      setMin(b.perRunUsd - this.ledger.totalUsd({ runId: opts.runId }));
    }
    const tagCap = b.perTagUsd?.[opts.tag];
    if (tagCap !== undefined) {
      setMin(tagCap - this.ledger.totalUsd({ tag: opts.tag }));
    }
    return remaining;
  }

  protected populateBudgetRemaining(outcome: RouteOutcome, opts: InvokeOpts): void {
    const r = this.computeRemainingBudget(opts);
    if (r !== undefined) outcome.budgetRemainingUsd = r;
  }

  protected recordSpend(
    opts: InvokeOpts,
    provider: string,
    modelId: string,
    attempts: ReadonlyArray<RouteAttempt>,
    result: InvokeResult | undefined,
    err: Error | undefined,
  ): void {
    if (!this.ledger) return;
    const last = attempts[attempts.length - 1];
    this.ledger.record({
      id: this.newId(),
      ts: new Date(this.now()).toISOString(),
      runId: opts.runId,
      project: opts.project,
      user: opts.user,
      tag: opts.tag,
      provider,
      model: modelId,
      inputTokens: result?.usage.inputTokens ?? 0,
      outputTokens: result?.usage.outputTokens ?? 0,
      cacheReadTokens: result?.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: result?.usage.cacheWriteTokens ?? 0,
      costUsd: result?.costUsd ?? 0,
      durationMs: attempts.reduce((a, x) => a + x.durationMs, 0),
      fallbackIndex: last?.fallbackIndex ?? 0,
      attemptCount: attempts.length,
      errorClass: err ? (last?.errorClass ?? 'unknown') : undefined,
    });
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

  // ── Build invoke options for the underlying adapter ───────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────

function startOfTodayIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function defaultNewId(): string {
  // Cheap monotonic id — Date.now in base36 + a 6-char random suffix.
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `s-${ts}-${rand}`;
}

function isTerminal(cls: ErrorClass | undefined): boolean {
  return cls === 'auth' || cls === 'content_policy' || cls === 'invalid_request';
}
