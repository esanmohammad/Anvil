/**
 * buildProjectGraph reads the cross-repo edges for its prompt from the system
 * graph buildKB writes (system_graph.sqlite) — not only from the JSON export
 * that exists only when no SQLite driver loads.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { buildProjectGraph, createSystemGraphSqliteWriter, getKnowledgeBasePath } from '@esankhan3/anvil-knowledge-core';

describe('buildProjectGraph — cross-repo edges', () => {
  it('reads them from system_graph.sqlite', async () => {
    const root = join(tmpdir(), `kc-pg-${randomBytes(6).toString('hex')}`);
    const prev = process.env.CODE_SEARCH_DATA_DIR;
    process.env.CODE_SEARCH_DATA_DIR = join(root, 'data');
    try {
      const project = 'pg';
      const base = getKnowledgeBasePath(project);
      mkdirSync(base, { recursive: true });
      const w = await createSystemGraphSqliteWriter(base);
      assert.ok(w, 'no sqlite driver');
      w.addRepoGraph('web', { nodes: [{ id: 'src/a.ts::f', label: 'f', type: 'function', file: 'src/a.ts' }], links: [] });
      w.addCrossRepoEdges([{
        sourceRepo: 'web', sourceNode: 'src/a.ts::/api/orders', targetRepo: 'orders', targetNode: 'src/s.ts::/api/orders',
        edgeType: 'http', evidence: 'API endpoint: /api/orders', confidence: 0.8,
      }]);
      w.finalize();
      const factory = join(root, 'factory.yaml');
      writeFileSync(factory, 'name: pg\n');

      const logs: string[] = [];
      await buildProjectGraph(project, factory, { dryRun: true, onProgress: (m) => logs.push(m) });
      assert.ok(logs.includes('Read 1 cross-repo relationships'), logs.join('\n'));
    } finally {
      if (prev === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
      else process.env.CODE_SEARCH_DATA_DIR = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
