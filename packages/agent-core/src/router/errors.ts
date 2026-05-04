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
  headers?: Record<string, string | undefined> | undefined;
  /** Some providers nest error info under `.error`. */
  error?: { type?: string; code?: string; message?: string } | undefined;
}

/**
 * Map a raw error to an `ErrorClass`.
 *
 * Recognizes:
 *   - 429 → rate_limit
 *   - 5xx → server_5xx
 *   - 401/403 → auth
 *   - 400 + content/safety hints → content_policy
 *   - 400 → invalid_request
 *   - timeout/abort/etimedout/econnreset/socket-hang-up → timeout
 *   - otherwise → unknown
 */
export function classifyError(err: unknown): ErrorClass {
  if (!err) return 'unknown';
  const e = err as ErrorLike;

  // Network / timeout heuristics first — these can co-exist with no status.
  const codeStr = typeof e.code === 'string' ? e.code.toUpperCase() : '';
  if (codeStr === 'ETIMEDOUT' || codeStr === 'ECONNRESET' || codeStr === 'ECONNABORTED') {
    return 'timeout';
  }
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return 'timeout';

  const message = (e.message ?? '').toLowerCase();
  if (message.includes('timeout') || message.includes('timed out') || message.includes('socket hang up')) {
    return 'timeout';
  }

  const status = e.status ?? e.statusCode;
  if (typeof status === 'number') {
    if (status === 429) return 'rate_limit';
    if (status >= 500 && status < 600) return 'server_5xx';
    if (status === 401 || status === 403) return 'auth';
    if (status === 400) {
      // Content-policy filter signals
      const innerType = e.error?.type?.toLowerCase() ?? '';
      const innerCode = e.error?.code?.toLowerCase() ?? '';
      if (
        innerType.includes('content') ||
        innerType.includes('safety') ||
        innerCode.includes('content_policy') ||
        innerCode.includes('safety') ||
        message.includes('content policy') ||
        message.includes('safety filter') ||
        message.includes('refused')
      ) {
        return 'content_policy';
      }
      return 'invalid_request';
    }
  }

  // Non-status providers (e.g. SDK throws with content_filter type)
  const innerType = e.error?.type?.toLowerCase() ?? '';
  if (innerType.includes('content') || innerType.includes('safety')) {
    return 'content_policy';
  }
  if (e.type && /content|safety/i.test(e.type)) {
    return 'content_policy';
  }

  return 'unknown';
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
