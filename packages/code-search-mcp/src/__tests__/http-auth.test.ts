/**
 * HTTP auth: JWT claim validation, refusal to start without a JWT secret,
 * the sliding-window rate limiter (per full API key, Retry-After on 429),
 * auth on /admin/api/status, and the P8 registry's scope + quota enforcement
 * on /mcp.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpRequest, type Server as NodeHttpServer } from 'node:http';
import { Server } from '@modelcontextprotocol/server';
import { startHttpTransport } from '../transports/http-transport.js';
import { SlidingWindow } from '../middleware/rate-limit.js';
import type { ServerConfig } from '../core/env-config.js';
import { BIN, tmp, baseEnv, spawnProc, getJson, waitFor } from './_harness.js';

const PORT = 47386;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 's3cr3t-hs256';

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
function jwt(payload: Record<string, unknown>, secret = SECRET): string {
  const data = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}
const now = () => Math.floor(Date.now() / 1000);

function config(over: Partial<ServerConfig>): ServerConfig {
  return {
    port: PORT,
    host: '127.0.0.1',
    transport: 'streamable-http',
    authEnabled: true,
    authMode: 'api-key',
    authApiKeys: [],
    authJwtSecret: undefined,
    authJwtIssuer: 'code-search-mcp',
    rateLimitPerMinute: 100,
    ...over,
  } as ServerConfig;
}

async function withServer(cfg: ServerConfig, fn: () => Promise<void>): Promise<void> {
  const http: NodeHttpServer = await startHttpTransport({
    config: cfg,
    createMcpServer: async () => ({ server: new Server({ name: 't', version: '0' }, { capabilities: {} }) }),
    getStatus: () => ({ directoryPath: '/secret/path' }),
  });
  try {
    await fn();
  } finally {
    http.closeAllConnections();
    await new Promise((r) => http.close(r));
  }
}

/** GET /admin/api/status on a fresh connection (servers come and go on one
 *  port here; a pooled keep-alive socket would outlive its server). */
function adminStatus(token?: string): Promise<{ status: number; body: any; headers: { get: (h: string) => string | undefined } }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${BASE}/admin/api/status`, {
      agent: false,
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }, (res) => {
      let text = '';
      res.on('data', (c: Buffer) => { text += c.toString(); });
      res.on('end', () => {
        let body: unknown = text;
        try { body = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode ?? 0, body, headers: { get: (h) => res.headers[h.toLowerCase()] as string | undefined } });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('sliding-window limiter', () => {
  it('admits at most `limit` hits in any trailing window (no boundary burst)', () => {
    let t = 0;
    const w = new SlidingWindow(60_000, () => t);
    assert.equal(w.hit('k', 2).ok, true);   // t=0
    t = 59_000;
    assert.equal(w.hit('k', 2).ok, true);   // t=59s
    t = 59_500;
    const denied = w.hit('k', 2);
    assert.equal(denied.ok, false);
    assert.equal(denied.retryAfterSec, 1);
    t = 60_100;
    assert.equal(w.hit('k', 2).ok, true, 'the t=0 hit left the window');
    t = 60_200;
    assert.equal(w.hit('k', 2).ok, false, 'a fixed window would have reset here');
    assert.equal(w.hit('other', 2).ok, true);
  });
});

describe('JWT', () => {
  it('rejects tokens without exp and before nbf; accepts a valid one', async () => {
    await withServer(config({ authMode: 'jwt', authJwtSecret: SECRET }), async () => {
      assert.equal((await adminStatus(jwt({ sub: 'a', iss: 'code-search-mcp', exp: now() + 600 }))).status, 200);
      assert.equal((await adminStatus(jwt({ sub: 'b', iss: 'code-search-mcp' }))).status, 401, 'no exp');
      assert.equal((await adminStatus(jwt({ sub: 'c', iss: 'code-search-mcp', exp: now() + 600, nbf: now() + 3600 }))).status, 401, 'nbf in future');
      assert.equal((await adminStatus(jwt({ sub: 'd', iss: 'code-search-mcp', exp: now() - 5 }))).status, 401, 'expired');
    });
  });

  it('refuses to start in jwt mode without a secret', async () => {
    await assert.rejects(
      () => startHttpTransport({
        config: config({ authMode: 'jwt', authJwtSecret: undefined }),
        createMcpServer: async () => ({ server: new Server({ name: 't', version: '0' }, { capabilities: {} }) }),
      }),
      /CODE_SEARCH_AUTH_JWT_SECRET/,
    );
  });
});

describe('API-key rate limiting + admin auth', () => {
  it('limits per full key and sends Retry-After', async () => {
    const keyA = 'sharedprefix-AAAA-0001';
    const keyB = 'sharedprefix-BBBB-0002';
    await withServer(config({ authApiKeys: [keyA, keyB], rateLimitPerMinute: 2 }), async () => {
      assert.equal((await adminStatus(keyA)).status, 200);
      assert.equal((await adminStatus(keyA)).status, 200);
      const limited = await adminStatus(keyA);
      assert.equal(limited.status, 429);
      assert.ok(Number(limited.headers.get('retry-after')) >= 1, `Retry-After=${limited.headers.get('retry-after')}`);
      assert.equal((await adminStatus(keyB)).status, 200, 'a key sharing the prefix has its own bucket');
    });
  });

  it('/admin/api/status requires auth when auth is enabled', async () => {
    await withServer(config({ authApiKeys: ['k-1234567890'] }), async () => {
      const r = await adminStatus();
      assert.equal(r.status, 401);
      assert.doesNotMatch(JSON.stringify(r.body), /secret\/path/);
    });
  });
});

describe('P8 registry on /mcp', () => {
  let root: string;
  before(() => {
    root = tmp('cs-reg-');
    const dir = join(root, 'data', 'projects', 'proj');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'project.yaml'), [
      `workspace: ${root}`,
      'scopes: [team-a]',
      'quotas:',
      '  max_queries_per_minute: 2',
      '',
    ].join('\n'));
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('enforces project scopes and the per-(identity, project) quota', async () => {
    const env = baseEnv({
      home: join(root, 'home'),
      dataDir: join(root, 'data'),
      extra: { CODE_SEARCH_AUTH_MODE: 'jwt', CODE_SEARCH_AUTH_JWT_SECRET: SECRET, CODE_SEARCH_HOST: '127.0.0.1' },
    });
    const p = spawnProc(BIN.mcp, ['--serve', '--project', 'proj', '--port', String(PORT)], env);
    try {
      await waitFor(async () => (await getJson(`${BASE}/health`)).status === 200, 20_000, `health\n${p.stderr()}`);
      const mcp = (token: string) => fetch(`${BASE}/mcp`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      });
      const teamB = jwt({ sub: 'bob', iss: 'code-search-mcp', exp: now() + 600, scope: 'team-b' });
      assert.equal((await mcp(teamB)).status, 403);
      const noScope = jwt({ sub: 'eve', iss: 'code-search-mcp', exp: now() + 600 });
      assert.equal((await mcp(noScope)).status, 403, 'a token without a scope claim is not admin');

      const teamA = jwt({ sub: 'alice', iss: 'code-search-mcp', exp: now() + 600, scope: 'team-a' });
      for (let i = 0; i < 2; i++) {
        const r = await mcp(teamA);
        assert.ok(r.status !== 403 && r.status !== 429, `request ${i} → ${r.status}`);
        await r.text();
      }
      const over = await mcp(teamA);
      assert.equal(over.status, 429);
      assert.ok(Number(over.headers.get('retry-after')) >= 1);
    } finally {
      p.kill();
      await p.exited;
    }
  });
});
