/**
 * Router error classification + RouterError type.
 *
 * `classifyError` is a best-effort heuristic over (status, code, message).
 * Per ADR R2, providers can register adapter-specific overrides via
 * `RouterConfig.errorClassifiers[provider]` (Phase 2+).
 */

import type { ErrorClass, RouteAttempt } from './types.js';

/**
 * Error thrown when the entire route walk fails. Carries the full
 * attempt history so callers can introspect what was tried.
 */
export class RouterError extends Error {
  readonly attempts: ReadonlyArray<RouteAttempt>;
  readonly cause?: Error;

  constructor(
    message: string,
    opts: { attempts: ReadonlyArray<RouteAttempt>; cause?: Error },
  ) {
    super(message);
    this.name = 'RouterError';
    this.attempts = opts.attempts;
    this.cause = opts.cause;
  }
}

interface ErrorLike {
  status?: number;
  statusCode?: number;
  code?: string | number;
  message?: string;
  name?: string;
  type?: string;
  /** `UpstreamError` carries the raw provider body separately from `.message`. */
  body?: string;
  /** `UpstreamError` may set this explicitly (e.g. synthesized status from CLI stderr). */
  retryable?: boolean;
  headers?: Record<string, string | undefined> | undefined;
  /** Some providers nest error info under `.error`. */
  error?: { type?: string; code?: string; message?: string } | undefined;
}

// ── Body-pattern matchers (folded in from the former agent-core
//    `UpstreamError.bodyLooksRetryable` + `synthesizeStatusFromCli`, so this
//    is now the SINGLE classifier the whole stack consults) ────────────────

/** Provider can't serve THIS model: phantom id, unsupported op, hard billing. */
const MODEL_UNAVAILABLE_RE =
  /model[^"']{0,40}(?:is\s+)?not\s+found|is\s+not\s+supported\s+for\s+generateContent|model_not_found|no\s+such\s+model|unknown\s+model|credit\s+balance\s+is\s+too\s+low|insufficient[\s_-]?credit/i;

/** Transient capacity/limit conditions that warrant backoff + same-or-next model. */
const RATE_LIMIT_RE =
  /insufficient[\s_-]?quota|rate[\s_-]?limit|overloaded[\s_-]?error|resource[\s_-]?exhausted|quota[\s_-]?exceeded|server\s+(?:is\s+)?busy|temporarily\s+(?:un)?available|too\s+many\s+requests/i;

/** Auth / permission — terminal; a different model from the same wall won't help. */
const AUTH_RE =
  /invalid\s+api\s+key|api\s+key\s+not\s+valid|unauthorized|permission[\s_-]?denied/i;

/**
 * Map a raw error to an `ErrorClass`. This is the single source of truth for
 * error classification across the whole stack — `LlmRouter.invoke` (single
 * shot), `LlmRouter.invokeStream` (streaming), and `LlmRouter.runAgent`
 * (agentic chain walk) all route through here.
 *
 * Recognizes:
 *   - network (status 0 / fetch failed / ECONNRESET / EPIPE / abort / timeout) → timeout
 *   - 429 → rate_limit; 5xx → server_5xx; 401/403 → auth
 *   - 400 + content/safety hints → content_policy; other 400 → invalid_request
 *   - body: phantom-model / hard-billing → model_unavailable
 *   - body: quota / rate-limit / overloaded / resource-exhausted → rate_limit
 *   - body: auth/permission → auth
 *   - explicit `.retryable === true` with no better signal → timeout (fall-back eligible)
 *   - otherwise → unknown
 */
export function classifyError(err: unknown): ErrorClass {
  if (!err) return 'unknown';
  const e = err as ErrorLike;

  // Network / timeout heuristics first — these can co-exist with no status.
  const codeStr = typeof e.code === 'string' ? e.code.toUpperCase() : '';
  if (codeStr === 'ETIMEDOUT' || codeStr === 'ECONNRESET' || codeStr === 'ECONNABORTED'
      || codeStr === 'EPIPE' || codeStr === 'UND_ERR_SOCKET') {
    return 'timeout';
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'timeout';

  // Pattern surface = message + the UpstreamError raw body.
  const text = `${e.message ?? ''} ${e.body ?? ''}`.toLowerCase();
  if (text.includes('fetch failed') || text.includes('socket hang up')
      || text.includes('econnreset') || text.includes('network')
      || text.includes('timeout') || text.includes('timed out')) {
    return 'timeout';
  }

  const status = e.status ?? e.statusCode;
  if (typeof status === 'number') {
    // status 0 = network/empty body/DNS (the "opencode 0: fetch failed" case).
    if (status === 0) return 'timeout';
    if (status === 408 || status === 425) return 'timeout';
    if (status === 429) return 'rate_limit';
    if (status >= 500 && status < 600) return 'server_5xx';
    if (status === 401 || status === 403) return 'auth';
    if (status === 400) {
      const innerType = e.error?.type?.toLowerCase() ?? '';
      const innerCode = e.error?.code?.toLowerCase() ?? '';
      if (
        innerType.includes('content') ||
        innerType.includes('safety') ||
        innerCode.includes('content_policy') ||
        innerCode.includes('safety') ||
        text.includes('content policy') ||
        text.includes('safety filter') ||
        text.includes('refused')
      ) {
        return 'content_policy';
      }
      // A 400 may still be a phantom-model / billing signal in the body.
      if (MODEL_UNAVAILABLE_RE.test(text)) return 'model_unavailable';
      return 'invalid_request';
    }
  }

  // Body-pattern classification (status-less providers, CLI stderr, wrapped
  // OpenRouter/opencode provider errors).
  if (AUTH_RE.test(text)) return 'auth';
  if (MODEL_UNAVAILABLE_RE.test(text)) return 'model_unavailable';
  if (RATE_LIMIT_RE.test(text)) return 'rate_limit';

  // Non-status providers (e.g. SDK throws with content_filter type)
  const innerType = e.error?.type?.toLowerCase() ?? '';
  if (innerType.includes('content') || innerType.includes('safety')) {
    return 'content_policy';
  }
  if (e.type && /content|safety/i.test(e.type)) {
    return 'content_policy';
  }

  // An adapter explicitly flagged this transient (e.g. a synthesized status
  // from CLI stderr) but no pattern matched — treat as a fall-back-eligible
  // transient so the chain still hops instead of dying.
  if (e.retryable === true) return 'timeout';

  return 'unknown';
}

/**
 * Terminal classes never trigger cross-model fallback (a different model from
 * the same wall won't help) and never count toward the circuit breaker.
 */
export function isTerminalErrorClass(cls: ErrorClass): boolean {
  return cls === 'auth' || cls === 'content_policy' || cls === 'invalid_request';
}

/**
 * Fall-back-eligible classes: a transient/provider-side failure where trying a
 * DIFFERENT model in the chain is the right move. This is the unified
 * replacement for the former binary `isRetryableUpstreamError` duck-type. Note
 * `unknown` is intentionally excluded — a generic error is more likely a bug
 * than a provider fault, so it should surface rather than burn the chain.
 */
export function isFallbackEligibleErrorClass(cls: ErrorClass): boolean {
  return cls === 'rate_limit'
    || cls === 'server_5xx'
    || cls === 'timeout'
    || cls === 'model_unavailable';
}

/**
 * Parse a `Retry-After` header value (seconds-since-now or HTTP-date)
 * into a millisecond delay. Returns `null` if absent or unparseable.
 */
export function parseRetryAfterMs(headers?: Record<string, string | undefined>): number | null {
  if (!headers) return null;
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const dateMs = Date.parse(raw);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}
