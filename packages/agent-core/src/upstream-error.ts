/**
 * Shared upstream-error contract for all `ModelAdapter` implementations.
 *
 * The dashboard's `runStageWithFallback` (in
 * `packages/dashboard/server/pipeline-runner.ts`) duck-types this shape
 * — `name === 'UpstreamError' && retryable === true` — to decide whether
 * to burn the current model and re-resolve the chain. Adapters that
 * throw plain `Error` lose chain-fallback even when the failure is
 * obviously transient (429 quota, 503 outage).
 *
 * The class is provider-agnostic on purpose. CLI adapters (claude,
 * gemini-cli) don't get an HTTP status — pass `synthesizeStatusFromCli`
 * the stderr text and we'll map known vendor patterns to a synthetic
 * status code that callers can switch on the same way they switch on
 * real HTTP status codes.
 */

export class UpstreamError extends Error {
  readonly status: number;
  readonly body: string;
  /**
   * True when the failure class warrants chain-fallback (insufficient
   * quota, rate limited, upstream outage). Auth / bad-request errors
   * are NOT retryable — they need a config fix, not a different model.
   */
  readonly retryable: boolean;

  constructor(status: number, body: string, opts: { provider?: string; retryable?: boolean } = {}) {
    const provider = opts.provider ?? 'upstream';
    super(`${provider} ${status}: ${truncate(body, 400)}`);
    this.name = 'UpstreamError';
    this.status = status;
    this.body = body;
    this.retryable = opts.retryable ?? (isRetryableStatus(status) || bodyLooksRetryable(body));
  }
}

/**
 * Default retryable-status map. Matches what the dashboard's
 * `runStageWithFallback` checks. Adapters can pass an explicit
 * `retryable` override when they need finer control (e.g. Anthropic's
 * "Credit balance too low" is 400 with a specific body — not
 * retryable to a different model from the SAME provider, but the
 * dashboard should still fall back to a DIFFERENT provider in the
 * chain, so we mark it retryable=true with a synthetic 402).
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 ||  // Request Timeout
         status === 425 ||  // Too Early
         status === 429 ||  // Too Many Requests / quota
         status === 502 ||  // Bad Gateway
         status === 503 ||  // Service Unavailable
         status === 504 ||  // Gateway Timeout
         status === 0;      // network / empty body / DNS
}

/**
 * Body-pattern matcher for cases where the upstream returns 200/400
 * but the body indicates a transient condition. Common with Anthropic
 * (`overloaded_error`) and OpenRouter's wrapped-provider errors.
 */
export function bodyLooksRetryable(body: string): boolean {
  if (!body) return false;
  return /insufficient[\s_-]?quota|rate[\s_-]?limit|overloaded[\s_-]?error|resource[\s_-]?exhausted|quota[\s_-]?exceeded|server\s+(?:is\s+)?busy|temporarily\s+(?:un)?available|temporarily\s+rate-?limited|too\s+many\s+requests/i.test(body);
}

/**
 * For CLI subprocess adapters (claude, gemini-cli) — map stderr text
 * patterns to a synthetic HTTP-style status code. Returns `undefined`
 * when the stderr doesn't look like a known transient condition; the
 * adapter should then throw a plain (non-retryable) `Error`.
 *
 * Patterns curated from observed stderr output:
 *   - Anthropic Claude CLI: "rate_limit_error", "overloaded_error",
 *     "Credit balance is too low" (the last is a hard block — but we
 *     mark it retryable so the chain hops to another provider).
 *   - Google Gemini CLI: "RESOURCE_EXHAUSTED", "Quota exceeded",
 *     "rate limit exceeded", "429".
 */
export function synthesizeStatusFromCli(stderr: string): { status: number; retryable: boolean } | undefined {
  if (!stderr) return undefined;
  const s = stderr.toLowerCase();

  // Quota / billing — provider-side. Hop to another provider's chain entry.
  if (/credit\s+balance\s+is\s+too\s+low|insufficient[\s_-]?credit|insufficient[\s_-]?quota|quota[\s_-]?exceeded|resource[\s_-]?exhausted/.test(s)) {
    return { status: 429, retryable: true };
  }
  // Rate-limit / overload — usually transient. Other models help.
  if (/rate[\s_-]?limit|too\s+many\s+requests|overloaded_error|server\s+(?:is\s+)?busy|\b429\b/.test(s)) {
    return { status: 429, retryable: true };
  }
  // Outage signals.
  if (/internal\s+server\s+error|\b503\b|\b502\b|\b504\b|service\s+unavailable|gateway\s+timeout|temporarily\s+unavailable/.test(s)) {
    return { status: 503, retryable: true };
  }
  // Auth / config errors — terminal. The chain-fallback would just hit
  // the same wall on the next model from the same provider.
  if (/invalid\s+api\s+key|api\s+key\s+not\s+valid|unauthorized|\b401\b|\b403\b|permission[\s_-]?denied/.test(s)) {
    return { status: 401, retryable: false };
  }
  // Default: caller should treat as terminal.
  return undefined;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n) + '…';
}
