/**
 * GET /metrics awaits the async collector (vector-index gauges come from the
 * writer's blob record, read at scrape time) and still renders when it throws.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { Server } from '@modelcontextprotocol/server';
import { startHttpTransport } from '../transports/http-transport.js';
import { metrics } from '../observability/metrics.js';
import type { ServerConfig } from '../core/env-config.js';

const config = {
  port: 0,
  host: '127.0.0.1',
  transport: 'streamable-http',
  authEnabled: false,
  authMode: 'none',
  authApiKeys: [],
} as unknown as ServerConfig;

async function scrape(collectMetrics: () => Promise<void>): Promise<{ status: number; body: string }> {
  const httpServer = await startHttpTransport({
    config,
    createMcpServer: async () => ({ server: new Server({ name: 'm', version: '0.0.0' }, { capabilities: {} }) }),
    collectMetrics,
  });
  try {
    const res = await fetch(`http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/metrics`);
    return { status: res.status, body: await res.text() };
  } finally {
    httpServer.close();
  }
}

describe('GET /metrics — async collector', () => {
  it('renders gauges set by the collector', async () => {
    const { status, body } = await scrape(async () => {
      await new Promise((r) => setTimeout(r, 5));
      metrics.vectorIndexUnindexedRows.set(42, { project: 'p' });
      metrics.vectorIndexGrowthRatio.set(0.5, { project: 'p' });
    });
    assert.equal(status, 200);
    assert.match(body, /code_search_vector_index_unindexed_rows\{project="p"\} 42/);
    assert.match(body, /code_search_vector_index_growth_ratio\{project="p"\} 0\.5/);
  });

  it('still returns 200 when the collector throws', async () => {
    const { status, body } = await scrape(async () => { throw new Error('blob store down'); });
    assert.equal(status, 200);
    assert.match(body, /code_search_queries_total/);
  });
});
