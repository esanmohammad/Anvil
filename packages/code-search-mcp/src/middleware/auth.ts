/**
 * Authentication middleware for HTTP transport.
 *
 * Supports:
 *   - API key auth (Bearer token matched against allowlist)
 *   - JWT auth (HS256 verification)
 *   - No auth (passthrough)
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ServerConfig } from '../core/env-config.js';

export interface AuthIdentity {
  mode: 'api-key' | 'jwt' | 'anonymous';
  subject: string;
  scopes: string[];
}

// ── Rate limiter (in-memory sliding window) ─────────────────────────────

const rateBuckets = new Map<string, { count: number; resetAt: number }>();

function checkRateLimit(identity: string, maxPerMinute: number): boolean {
  const now = Date.now();
  const bucket = rateBuckets.get(identity);

  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(identity, { count: 1, resetAt: now + 60_000 });
    return true;
  }

  if (bucket.count >= maxPerMinute) return false;
  bucket.count++;
  return true;
}

// Clean up stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
}, 300_000).unref();

// ── JWT verification (HS256) ────────────────────────────────────────────

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

    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;

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

// ── Main auth function ──────────────────────────────────────────────────

export function createAuthMiddleware(config: ServerConfig) {
  return function authenticate(
    req: IncomingMessage,
    res: ServerResponse,
  ): AuthIdentity | null {
    // No auth mode — allow everything
    if (config.authMode === 'none') {
      return { mode: 'anonymous', subject: 'anonymous', scopes: ['*'] };
    }

    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing Authorization header' }));
      return null;
    }

    const token = authHeader.slice(7);

    // API Key mode
    if (config.authMode === 'api-key') {
      const matched = config.authApiKeys.some((key) => safeCompare(token, key));
      if (!matched) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid API key' }));
        return null;
      }

      const identity: AuthIdentity = {
        mode: 'api-key',
        subject: `key:${token.slice(0, 8)}...`,
        scopes: ['*'],
      };

      // Rate limit check
      if (!checkRateLimit(identity.subject, config.rateLimitPerMinute)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return null;
      }

      return identity;
    }

    // JWT mode
    if (config.authMode === 'jwt') {
      if (!config.authJwtSecret) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'JWT secret not configured' }));
        return null;
      }

      const claims = verifyJwt(token, config.authJwtSecret, config.authJwtIssuer);
      if (!claims) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or expired JWT' }));
        return null;
      }

      const identity: AuthIdentity = {
        mode: 'jwt',
        subject: claims.sub,
        scopes: claims.scope ? claims.scope.split(' ') : ['*'],
      };

      if (!checkRateLimit(identity.subject, config.rateLimitPerMinute)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limit exceeded' }));
        return null;
      }

      return identity;
    }

    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `Unknown auth mode: ${config.authMode}` }));
    return null;
  };
}
