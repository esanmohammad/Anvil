/**
 * `embedding.headers` reach an OpenAI-compatible embedding endpoint with every
 * request — e.g. the access headers a gateway behind an auth proxy requires —
 * and never replace the request's own Authorization.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createEmbeddingProvider } from '@esankhan3/anvil-knowledge-core';

describe('OpenAI-compatible embedder request headers', () => {
  let server: Server;
  let baseUrl = '';
  const seen: Array<{ path: string; headers: IncomingHttpHeaders }> = [];

  before(async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push({ path: req.url ?? '', headers: req.headers });
        const { input } = JSON.parse(raw) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: input.map(() => ({ embedding: [0.6, 0.8] })) }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  const headers = {
    'CF-Access-Client-Id': 'id.access',
    'CF-Access-Client-Secret': 's3cret',
    Authorization: 'other',
  };

  for (const provider of ['openai-compatible', 'auto'] as const) {
    it(`${provider}: sends embedding.headers alongside its own auth`, async () => {
      seen.length = 0;
      const embedder = createEmbeddingProvider({
        provider, baseUrl, model: 'openai/text-embedding-3-small', dimensions: 2, apiKey: 'gateway-key', headers,
      });
      const vectors = await embedder.embed(['a', 'b']);
      assert.deepEqual(vectors, [[0.6, 0.8], [0.6, 0.8]]);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].path, '/v1/embeddings');
      assert.equal(seen[0].headers['cf-access-client-id'], 'id.access');
      assert.equal(seen[0].headers['cf-access-client-secret'], 's3cret');
      assert.equal(seen[0].headers.authorization, 'Bearer gateway-key');
    });
  }
});
