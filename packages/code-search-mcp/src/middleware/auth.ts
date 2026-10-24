/**
 * Authentication middleware for HTTP transport.
 *
 * Supports:
 *   - API key auth (Bearer token matched against allowlist)
 *   - JWT auth (HS256 verification)
 *   - No auth (passthrough)
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from '../core/env-config.js';
import { localRateLimiter, type RateLimiter } from './rate-limit.js';

export interface AuthIdentity {
  mode: 'api-key' | 'jwt' | 'anonymous';
  subject: string;
  scopes: string[];
}

// ── JWT verification (HS256) ────────────────────────────────────────────

/** Valid claims, or null. `exp` is required; `nbf`, when present, is honoured. */
function verifyJwt(
  token: string,
  secret: string,
  issuer: string,
): { sub: string; scope?: string } | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
    if (header.alg !== 'HS256') return null;

    // Verify signature
    const data = `${parts[0]}.${parts[1]}`;
    const expected = createHmac('sha256', secret).update(data).digest('base64url');

    const sigBuf = Buffer.from(parts[2], 'base64url');
    const expectedBuf = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);

    // A token that never expires is a permanent credential — refuse it.
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (payload.nbf !== undefined && (typeof payload.nbf !== 'number' || payload.nbf > now)) return null;

    // Check issuer
    if (issuer && payload.iss !== issuer) return null;

    return { sub: payload.sub ?? 'unknown', scope: payload.scope };
  } catch {
    return null;
  }
}

// ── API key comparison ──────────────────────────────────────────────────

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** Stable, non-reversible subject for an API key (keys sharing a prefix get
 *  distinct rate buckets; the key itself is never logged or exposed). */
function apiKeySubject(key: string): string {
  return `key:${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

// ── Main auth function ──────────────────────────────────────────────────

/**
 * Build the per-request authenticator. Throws at creation when the mode
 * can't work (jwt without a secret) so the server refuses to start instead
 * of answering every request with a 500. Rate limiting is a sliding window
 * per identity subject (`rateLimiter` — the cluster primary's window when
 * running as a worker).
 */
export function createAuthMiddleware(config: ServerConfig, opts: { rateLimiter?: RateLimiter } = {}) {
  if (config.authMode === 'jwt' && !config.authJwtSecret) {
    throw new Error('Auth mode "jwt" needs a signing secret: set CODE_SEARCH_AUTH_JWT_SECRET (or auth.jwt_secret in config).');
  }
  const rateLimiter = opts.rateLimiter ?? localRateLimiter;

  const reject = (res: ServerResponse, status: number, error: string, headers: Record<string, string> = {}): null => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify({ error }));
    return null;
  };

  return async function authenticate(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<AuthIdentity | null> {
    // No auth mode — allow everything
    if (config.authMode === 'none') {
      return { mode: 'anonymous', subject: 'anonymous', scopes: ['*'] };
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return reject(res, 401, 'Missing Authorization header');

    const token = authHeader.slice(7);
    let identity: AuthIdentity;

    if (config.authMode === 'api-key') {
      const matched = config.authApiKeys.some((key) => safeCompare(token, key));
      if (!matched) return reject(res, 401, 'Invalid API key');
      identity = { mode: 'api-key', subject: apiKeySubject(token), scopes: ['*'] };
    } else if (config.authMode === 'jwt') {
      const claims = verifyJwt(token, config.authJwtSecret!, config.authJwtIssuer);
      if (!claims) return reject(res, 401, 'Invalid or expired JWT');
      // No `scope` claim → no scopes (least privilege): such a token reaches
      // only projects that require none. API keys are admin (`*`).
      identity = {
        mode: 'jwt',
        subject: claims.sub,
        scopes: claims.scope ? claims.scope.split(' ').filter(Boolean) : [],
      };
    } else {
      return reject(res, 500, `Unknown auth mode: ${config.authMode}`);
    }

    const decision = await rateLimiter(`auth:${identity.subject}`, config.rateLimitPerMinute);
    if (!decision.ok) {
      return reject(res, 429, 'Rate limit exceeded', { 'Retry-After': String(decision.retryAfterSec) });
    }
    return identity;
  };
}
