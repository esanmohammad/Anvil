/**
 * Stage-level chain fallback — wraps an `attempt(model)` callback and
 * retries with a fresh model when the inner call throws a retryable
 * upstream error (HTTP 429 / 502 / 503 / 504, or any error with
 * `name === 'UpstreamError' && retryable === true`).
 *
 * Lives in core-pipeline so cli and dashboard share the same retry
 * semantics. The model resolver is injected — dashboard plugs in its
 * liveness-aware `pickAliveModelFromChainSync`; cli plugs in a no-op
 * resolver that returns the same model each call (effectively no
 * fallback for cli today, but the surface is identical).
 */

export interface ChainFallbackOptions<P = unknown> {
  /** Stage name for telemetry. */
  stageName: string;
  /** Resolves the next model to try, given the burned-set so it can skip. */
  resolveModel: (excludeModels: ReadonlySet<string>) => string;
  /**
   * Optional callback fired when a model gets burned. Lets the caller emit
   * a project-event / log line so the UI surfaces the fallback decision.
   */
  onBurn?: (info: BurnInfo) => void;
  /** Cap on attempts. Default 5. */
  maxAttempts?: number;
  /**
   * Turn-level durable resume (v2 ADR §2.3 / §2.4). Called AFTER a
   * retryable burn to obtain the prefill the *next* attempt should
   * continue from — typically by reading the most-recent non-invalidated
   * assistant-partial for this (runId, stepId) out of the DurableStore.
   * The returned value is passed as the second arg to `attempt`. When
   * omitted (cli, legacy callers, tests), every attempt gets
   * `prefill === undefined` and behavior is identical to pre-H2.
   *
   * `burnedModel` is the model that just failed; `attemptIndex` is the
   * zero-based index of the attempt about to run with this prefill;
   * `nextModel` is the model the walker resolved for that attempt (so a
   * prefill resolver can size the §2.3.3 truncation budget against the
   * target before handing the prefill over). `nextModel` is undefined on
   * the final iteration (no further attempt).
   */
  resolvePrefill?: (info: {
    burnedModel: string;
    attemptIndex: number;
    nextModel?: string;
  }) => Promise<P | undefined>;
}

export interface BurnInfo {
  stageName: string;
  model: string;
  status: number | string;
  message: string;
}

/**
 * Run `attempt(model)` with chain fallback. On a retryable failure,
 * burn the failing model and retry with the next one resolveModel
 * picks. Non-retryable errors propagate immediately. Returns the
 * first attempt that succeeds, or throws the last error after
 * exhausting `maxAttempts`.
 */
export async function runWithChainFallback<T, P = unknown>(
  opts: ChainFallbackOptions<P>,
  attempt: (model: string, prefill?: P) => Promise<T>,
): Promise<T> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 5);
  const burned = new Set<string>();
  let lastErr: unknown;
  // Prefill handed to the NEXT attempt after a burn — the partial the
  // burned model streamed before dying. undefined on the first attempt
  // and whenever `resolvePrefill` is not wired.
  let prefill: P | undefined;

  for (let i = 0; i < maxAttempts; i += 1) {
    const model = opts.resolveModel(burned);
    try {
      return await attempt(model, prefill);
    } catch (err) {
      lastErr = err;
      if (!isRetryableUpstreamError(err)) {
        throw err;
      }
      burned.add(model);
      const status = (err as { status?: number | string }).status ?? '?';
      const message = (err as Error).message?.slice(0, 200) ?? 'unknown';
      opts.onBurn?.({ stageName: opts.stageName, model, status, message });
      // Resolve the prefill for the next attempt. Best-effort: if the
      // read fails, fall back to a clean (prefill-less) retry rather
      // than failing the whole run. Resolve the next model first (with
      // `model` now burned) so the resolver can size the prefill against
      // the actual target window (§2.3.3). Tolerate a resolver throw here
      // — the loop's own resolveModel re-runs on the next iteration and
      // surfaces exhaustion there.
      if (opts.resolvePrefill && i + 1 < maxAttempts) {
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
  throw lastErr;
}

/**
 * Duck-type detector for the agent-core `UpstreamError` shape. Uses
 * structural matching instead of `instanceof` because module bundling
 * can desync class identity across packages.
 */
export function isRetryableUpstreamError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; retryable?: unknown; status?: unknown };
  if (e.retryable === true) return true;
  if (e.name === 'UpstreamError' && typeof e.status === 'number') {
    return e.status === 429 || e.status === 502 || e.status === 503 || e.status === 504;
  }
  return false;
}
