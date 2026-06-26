/**
 * HTTP transport for code-search-mcp.
 *
 * Exposes the MCP server over Streamable HTTP (POST /mcp)
 * with a health endpoint. Each session gets its own Server + Transport pair.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerConfig } from '../core/env-config.js';
import { createAuthMiddleware, type AuthIdentity } from '../middleware/auth.js';
import { registry, metrics } from '../observability/metrics.js';

/** Factory that creates a fresh, fully-wired MCP Server instance */
export type McpServerFactory = () => Promise<{
  server: { connect(transport: any): Promise<void> };
}>;

export interface HttpTransportOptions {
  config: ServerConfig;
  /** Called for each new session to produce an independent MCP Server */
  createMcpServer: McpServerFactory;
  onReady?: (url: string) => void;
  getHealth?: () => Record<string, unknown>;
  /** Detailed indexing status for GET /status */
  getStatus?: () => Record<string, unknown>;
  /** Handler for POST /index — allows triggering indexing via REST */
  onIndex?: (body: { path: string; project?: string; force?: boolean }) => Promise<Record<string, unknown>>;
}

interface Session {
  transport: StreamableHTTPServerTransport;
}

export async function startHttpTransport(opts: HttpTransportOptions): Promise<void> {
  const { config, createMcpServer, onReady, getHealth } = opts;
  const authenticate = createAuthMiddleware(config);

  // P7 — uptime for /admin/api/status.
  const startedAt = Date.now();

  // Map of sessionId → session (with TTL + max limit)
  const sessions = new Map<string, Session & { lastActivity: number }>();
  // Idle session lifetime. 30 min was too aggressive for an all-day interactive
  // MCP client — an idle gap > 30 min got the session reaped, and the next call
  // then failed. Default 120 min, env-overridable; any POST/GET refreshes it.
  const ttlMin = parseInt(process.env.CODE_SEARCH_SESSION_TTL_MINUTES ?? '', 10);
  const SESSION_TTL_MS = (Number.isFinite(ttlMin) && ttlMin > 0 ? ttlMin : 120) * 60 * 1000;
  const maxEnv = parseInt(process.env.CODE_SEARCH_MAX_SESSIONS ?? '', 10);
  const MAX_SESSIONS = Number.isFinite(maxEnv) && maxEnv > 0 ? maxEnv : 100;

  // Clean up stale sessions every 5 minutes
  setInterval(() => {
    const now = Date.now();
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) {
        sessions.delete(id);
      }
    }
  }, 5 * 60 * 1000).unref();

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
        activeSessions: sessions.size,
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
        sessions: sessions.size,
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

      if (req.method === 'POST') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;

        if (sessionId && sessions.has(sessionId)) {
          // Existing session — route to its transport
          sessions.get(sessionId)!.lastActivity = Date.now();
          await sessions.get(sessionId)!.transport.handleRequest(req, res);
          return;
        }

        if (sessionId && !sessions.has(sessionId)) {
          // 404 (not 400) so a spec-compliant client re-initializes a new
          // session instead of treating it as a fatal error.
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Session expired or unknown — reinitialize.' }));
          return;
        }

        // Enforce max session limit
        if (sessions.size >= MAX_SESSIONS) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Too many active sessions. Try again later.' }));
          return;
        }

        // New session — create a dedicated Server + Transport pair
        try {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
          });

          const { server: mcpServer } = await createMcpServer();
          await mcpServer.connect(transport);

          // Clean up on close
          transport.onclose = () => {
            for (const [id, s] of sessions) {
              if (s.transport === transport) {
                sessions.delete(id);
                break;
              }
            }
          };

          // Handle the request (this sends the response with session ID header)
          await transport.handleRequest(req, res);

          // Store session using the ID from response headers
          const newSessionId = res.getHeader('mcp-session-id') as string | undefined;
          if (newSessionId) {
            sessions.set(newSessionId, { transport, lastActivity: Date.now() });
          }
        } catch (err) {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Failed to create session' }));
          }
        }
        return;
      }

      if (req.method === 'GET') {
        // SSE stream for an existing session. Refresh activity here too — this
        // long-lived server→client stream is exactly the case the POST-only
        // refresh missed, so an actively-streaming session was being reaped.
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          sessions.get(sessionId)!.lastActivity = Date.now();
          await sessions.get(sessionId)!.transport.handleRequest(req, res);
          return;
        }
        // Provided-but-unknown session → 404 (reinitialize); missing → 400.
        res.writeHead(sessionId ? 404 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: sessionId ? 'Session expired or unknown — reinitialize.' : 'Session ID required for GET requests' }));
        return;
      }

      if (req.method === 'DELETE') {
        const sessionId = req.headers['mcp-session-id'] as string | undefined;
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.transport.handleRequest(req, res);
          sessions.delete(sessionId);
          return;
        }
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid session ID' }));
        return;
      }

      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    // ── 404 ─────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  return new Promise<void>((resolve) => {
    httpServer.listen(config.port, config.host, () => {
      const url = `http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
      onReady?.(url);
      resolve();
    });
  });
}
