/**
 * HTTP transport for code-search-mcp.
 *
 * Exposes the MCP server over Streamable HTTP (POST /mcp) with a health
 * endpoint. Serving is stateless on every request: `createMcpHandler` answers
 * modern (2026-07-28) envelope traffic natively and 2025-era clients via its
 * per-request legacy fallback — a fresh Server instance per exchange, no
 * session map. This is what cluster workers behind a per-request proxy need,
 * so there is no separate stateless mode any more.
 */

import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createMcpHandler, type Server } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import type { ServerConfig } from '../core/env-config.js';
import { PACKAGE_VERSION } from '../core/version.js';
import { createAuthMiddleware, type AuthIdentity } from '../middleware/auth.js';
import type { RateLimiter } from '../middleware/rate-limit.js';
import { registry } from '../observability/metrics.js';
import { getComponentLogger } from '../observability/logger.js';

const log = getComponentLogger('code-search-mcp');

/** Factory that creates a fresh, fully-wired MCP Server instance */
export type McpServerFactory = () => Promise<{
  server: Server;
}>;

/** An error whose HTTP status the transport should answer with. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** `ok: false` carries the HTTP status + error to answer with. */
export interface AuthzDecision {
  ok: boolean;
  status?: number;
  error?: string;
  retryAfterSec?: number;
}

export interface IndexRequestBody {
  path: string;
  project?: string;
  force?: boolean;
}

/** POST /index bodies are tiny JSON objects; anything bigger is refused. */
const MAX_INDEX_BODY_BYTES = 64 * 1024;

export interface HttpTransportOptions {
  config: ServerConfig;
  /** Called for each request to produce an independent MCP Server */
  createMcpServer: McpServerFactory;
  onReady?: (url: string) => void;
  getHealth?: () => Record<string, unknown>;
  /** Detailed indexing status for GET /status */
  getStatus?: () => Record<string, unknown>;
  /** Refresh gauges that need async reads before GET /metrics renders. */
  collectMetrics?: () => Promise<void>;
  /** Handler for POST /index — allows triggering indexing via REST. Throw an
   *  HttpError to answer with its status. */
  onIndex?: (body: IndexRequestBody) => Promise<Record<string, unknown>>;
  /** Per-request authorization of an authenticated identity on /mcp
   *  (project scopes + query quota). */
  authorize?: (identity: AuthIdentity) => Promise<AuthzDecision>;
  /** Rate limiter behind the auth middleware (default: this process's window). */
  rateLimiter?: RateLimiter;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

/** Read a request body up to `limit` bytes; null when it was larger (413 sent). */
function readBody(req: IncomingMessage, res: ServerResponse, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > limit) {
      sendJson(res, 413, { error: `Request body exceeds ${limit} bytes` }, { Connection: 'close' });
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        sendJson(res, 413, { error: `Request body exceeds ${limit} bytes` }, { Connection: 'close' });
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf-8')); });
    req.on('error', reject);
  });
}

export async function startHttpTransport(opts: HttpTransportOptions): Promise<NodeHttpServer> {
  const { config, createMcpServer, onReady, getHealth } = opts;
  // Throws for an unusable auth config (jwt without a secret) — before listen.
  const authenticate = createAuthMiddleware(config, { rateLimiter: opts.rateLimiter });

  // P7 — uptime for /admin/api/status.
  const startedAt = Date.now();

  // One handler serves every /mcp request: modern 2026-07-28 traffic on the
  // per-request micro-transport, 2025-era clients via the stateless legacy
  // fallback (fresh instance per exchange). GET/DELETE (legacy session verbs)
  // are answered 405 by the handler itself.
  const mcpHandler = createMcpHandler(async () => (await createMcpServer()).server, {
    onerror: (err) => log.error(`MCP handler error: ${err.message}`),
  });
  const handleMcp = toNodeHandler(mcpHandler);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;

    // Add request ID for tracing
    const requestId = randomUUID().slice(0, 8);
    res.setHeader('X-Request-ID', requestId);

    // ── Health check (no auth) ──────────────────────────────────────
    if (path === '/health' && req.method === 'GET') {
      const health = getHealth?.() ?? {};
      sendJson(res, 200, { status: 'ok', ...health });
      return;
    }

    // ── Status (no auth — read-only) ───────────────────────────────
    if (path === '/status' && req.method === 'GET') {
      const status = opts.getStatus?.() ?? {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status, null, 2));
      return;
    }

    // ── Version (P7) ────────────────────────────────────────────────
    if (path === '/version' && req.method === 'GET') {
      sendJson(res, 200, {
        name: 'code-search-mcp',
        version: PACKAGE_VERSION,
        node: process.version,
        platform: process.platform,
      });
      return;
    }

    // ── Readiness (P7) — true only after first index complete ──────
    if (path === '/ready' && req.method === 'GET') {
      const health = getHealth?.() ?? {};
      const ready = health.indexReady === true;
      sendJson(res, ready ? 200 : 503, { ready, ...health });
      return;
    }

    // ── Prometheus metrics (P7) ────────────────────────────────────
    if (path === '/metrics' && req.method === 'GET') {
      try {
        await opts.collectMetrics?.();
      } catch { /* a failed collector must not fail the scrape */ }
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(registry.render());
      return;
    }

    // ── Admin JSON status (P7) — exposes paths + history, so authed ──
    if (path === '/admin/api/status' && req.method === 'GET') {
      if (config.authEnabled && !(await authenticate(req, res))) return;
      const status = opts.getStatus?.() ?? {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: PACKAGE_VERSION,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        ...status,
      }, null, 2));
      return;
    }

    // ── Admin: Index a path (POST /index) ─────────────────────────
    if (path === '/index' && req.method === 'POST') {
      if (config.authEnabled && !(await authenticate(req, res))) return;

      const raw = await readBody(req, res, MAX_INDEX_BODY_BYTES);
      if (raw === null) return;
      let body: IndexRequestBody;
      try {
        body = JSON.parse(raw);
      } catch {
        sendJson(res, 400, { error: 'Body must be a JSON object: {"path": "...", "project"?: "...", "force"?: true}' });
        return;
      }
      if (typeof body !== 'object' || body === null || typeof body.path !== 'string' || !body.path) {
        sendJson(res, 400, { error: '`path` is required' });
        return;
      }
      if (!opts.onIndex) {
        sendJson(res, 501, { error: 'Indexing handler not configured' });
        return;
      }
      try {
        sendJson(res, 200, await opts.onIndex(body));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const status = err instanceof HttpError ? err.status : 500;
        if (!res.headersSent) sendJson(res, status, { error: msg });
      }
      return;
    }

    // ── MCP endpoint ────────────────────────────────────────────────
    if (path === '/mcp') {
      const identity = config.authEnabled
        ? await authenticate(req, res)
        : { mode: 'anonymous' as const, subject: 'anonymous', scopes: ['*'] };
      if (!identity) return;
      if (opts.authorize) {
        const decision = await opts.authorize(identity);
        if (!decision.ok) {
          sendJson(res, decision.status ?? 403, { error: decision.error },
            decision.retryAfterSec ? { 'Retry-After': String(decision.retryAfterSec) } : {});
          return;
        }
      }

      await handleMcp(req, res);
      return;
    }

    // ── 404 ─────────────────────────────────────────────────────────
    sendJson(res, 404, { error: 'Not found' });
  });

  return new Promise<NodeHttpServer>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, config.host, () => {
      httpServer.off('error', reject);
      const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
      onReady?.(url);
      resolve(httpServer);
    });
  });
}
