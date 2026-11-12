/**
 * Repo profiling and the service-mesh gap-fill call the configured LLM
 * (`ANVIL_LLM_MODEL`, which code-search-mcp fills from `CODE_SEARCH_LLM_MODEL`)
 * through the configured transport — here an OpenAI-compatible gateway such as
 * a LiteLLM proxy, whose model ids (`anthropic/claude-sonnet-5`) are not the
 * provider's own.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { profileRepo, inferOrphanConnections, resetLlmConfig } from '@esankhan3/anvil-knowledge-core';
import type { RepoProfile } from '@esankhan3/anvil-knowledge-core';

const ENV_KEYS = [
  'ANVIL_LLM_MODE', 'ANVIL_LLM_PROVIDER', 'ANVIL_LLM_MODEL', 'ANVIL_LLM_API_KEY', 'ANVIL_LLM_BASE_URL', 'ANVIL_LLM_HEADERS',
  'CODE_SEARCH_LLM_MODE', 'CODE_SEARCH_LLM_PROVIDER', 'CODE_SEARCH_LLM_MODEL', 'CODE_SEARCH_LLM_API_KEY', 'CODE_SEARCH_LLM_BASE_URL',
];

interface Captured { path: string; authorization?: string; accessId?: string; body: { model?: string; messages?: unknown[] } }

describe('LLM phases use the configured model and gateway', () => {
  let server: Server;
  const requests: Captured[] = [];
  let reply = '';
  const saved: Record<string, string | undefined> = {};

  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        requests.push({
          path: req.url ?? '',
          authorization: req.headers.authorization,
          accessId: req.headers['cf-access-client-id'] as string | undefined,
          body: JSON.parse(raw),
        });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
    process.env.ANVIL_LLM_MODE = 'api';
    process.env.ANVIL_LLM_PROVIDER = 'openai-compatible';
    process.env.ANVIL_LLM_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    process.env.ANVIL_LLM_API_KEY = 'gateway-key';
    process.env.ANVIL_LLM_MODEL = 'anthropic/claude-sonnet-5';
    process.env.ANVIL_LLM_HEADERS = 'CF-Access-Client-Id=id.access';
    resetLlmConfig();
  });

  after(async () => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    resetLlmConfig();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('profileRepo sends the configured model to the gateway and records it', async () => {
    requests.length = 0;
    reply = JSON.stringify({ name: 'billing-api', role: 'service', domain: 'billing', description: 'Bills.', technologies: ['go'], exposes: [], consumes: [], entryPoints: [] });
    const profile = await profileRepo({
      repoPath: '/tmp/billing-api',
      repoName: 'billing-api',
      files: [{ relativePath: 'go.mod', content: 'module billing-api' }],
      totalChars: 18,
      fingerprintHash: 'h1',
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, '/v1/chat/completions');
    assert.equal(requests[0].authorization, 'Bearer gateway-key');
    assert.equal(requests[0].accessId, 'id.access');
    assert.equal(requests[0].body.model, 'anthropic/claude-sonnet-5');
    assert.equal(profile.domain, 'billing');
    assert.equal(profile.profiledBy, 'anthropic/claude-sonnet-5');
  });

  it('the service-mesh gap-fill sends the configured model to the gateway', async () => {
    requests.length = 0;
    reply = '[]';
    const orphan = (name: string): RepoProfile => ({
      name, role: 'service', domain: 'billing', description: '', technologies: [], exposes: [], consumes: [],
      entryPoints: [], profiledAt: '', profiledBy: '', fingerprintHash: '',
    });
    await inferOrphanConnections([orphan('a'), orphan('b')], []);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].body.model, 'anthropic/claude-sonnet-5');
  });
});
