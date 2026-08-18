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
import { createAuthMiddleware, type AuthIdentity } from '../middleware/auth.js';
import { registry, metrics } from '../observability/metrics.js';

/** Factory that creates a fresh, fully-wired MCP Server instance */
export type McpServerFactory = () => Promise<{
  server: Server;
}>;

export interface HttpTransportOptions {
  config: ServerConfig;
  /** Called for each request to produce an independent MCP Server */
  createMcpServer: McpServerFactory;
  onReady?: (url: string) => void;
  getHealth?: () => Record<string, unknown>;
  /** Detailed indexing status for GET /status */
  getStatus?: () => Record<string, unknown>;
  /** Handler for POST /index — allows triggering indexing via REST */
  onIndex?: (body: { path: string; project?: string; force?: boolean }) => Promise<Record<string, unknown>>;
}

export async function startHttpTransport(opts: HttpTransportOptions): Promise<NodeHttpServer> {
  const { config, createMcpServer, onReady, getHealth } = opts;
  const authenticate = createAuthMiddleware(config);

  // P7 — uptime for /admin/api/status.
  const startedAt = Date.now();

  // One handler serves every /mcp request: modern 2026-07-28 traffic on the
  // per-request micro-transport, 2025-era clients via the stateless legacy
  // fallback (fresh instance per exchange). GET/DELETE (legacy session verbs)
  // are answered 405 by the handler itself.
  const mcpHandler = createMcpHandler(async () => (await createMcpServer()).server, {
    onerror: (err) => console.error(`[code-search-mcp] MCP handler error: ${err.message}`),
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        ...health,
      }));
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        name: 'code-search-mcp',
        version: '0.1.0',
        node: process.version,
        platform: process.platform,
      }));
      return;
    }

    // ── Readiness (P7) — true only after first index complete ──────
    if (path === '/ready' && req.method === 'GET') {
      const health = getHealth?.() ?? {};
      const ready = health.indexReady === true;
      res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ready, ...health }));
      return;
    }

    // ── Prometheus metrics (P7) ────────────────────────────────────
    if (path === '/metrics' && req.method === 'GET') {
      // Update gauges with current state.
      const status = opts.getStatus?.() ?? {};
      const indexing = (status.indexing as { phase?: string; percent?: number } | undefined);
      metrics.indexAge.set(0, { phase: indexing?.phase ?? 'idle' });
      res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
      res.end(registry.render());
      return;
    }

    // ── Admin JSON status (P7) ─────────────────────────────────────
    if (path === '/admin/api/status' && req.method === 'GET') {
      const status = opts.getStatus?.() ?? {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        version: '0.1.0',
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        ...status,
      }, null, 2));
      return;
    }

    // ── Admin: Index a new path (POST /index) ─────────────────────
    if (path === '/index' && req.method === 'POST') {
      // Auth required even if MCP auth is disabled — this is an admin endpoint
      if (config.authEnabled) {
        const identity = authenticate(req, res);
        if (!identity) return;
      }

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body) as { path: string; project?: string; force?: boolean };
          if (!parsed.path) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: '`path` is required' }));
            return;
          }
          if (!opts.onIndex) {
            res.writeHead(501, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Indexing handler not configured' }));
            return;
          }
          const result = await opts.onIndex(parsed);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: msg }));
          }
        }
      });
      return;
    }

    // ── MCP endpoint ────────────────────────────────────────────────
    if (path === '/mcp') {
      // Auth check
      if (config.authEnabled) {
        const identity = authenticate(req, res);
        if (!identity) return;
      }

      await handleMcp(req, res);
      return;
    }

    // ── 404 ─────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise<NodeHttpServer>((resolve) => {
    httpServer.listen(config.port, config.host, () => {
      const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
      onReady?.(url);
      resolve(httpServer);
    });
  });
}
