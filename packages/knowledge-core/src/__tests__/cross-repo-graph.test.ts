/**
 * Cross-repo edges must reach the code graph.
 *
 * File-scoped graph queries (impact_analysis / detect_changes →
 * nodesInFiles + dependents) look a file up by its repo-relative path, so the
 * cross-repo endpoints buildKB writes into the system graph must be keyed the
 * same way — not by wherever the repo happened to be checked out. Signals an
 * older version stored with absolute paths are re-extracted once.
 *
 * Drives the real buildKB over two temp git repos (no embedding needed).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildKBFromPath, getGraphStore, invalidateGraphStores, resolveStorage } from '@esankhan3/anvil-knowledge-core';
import type { CrossRepoSignals } from '../cross-repo-detector.js';

const git = (cwd: string, ...args: string[]): void => {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, stdio: 'ignore' });
};

function commitRepo(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
}

async function consumersOf(project: string, repo: string, file: string): Promise<string[]> {
  await invalidateGraphStores(project);
  const store = await getGraphStore(project);
  assert.ok(store, 'system graph missing');
  return store.dependents(store.nodesInFiles(repo, [file]), 10).repos;
}

describe('buildKB — cross-repo edges in the system graph', () => {
  it('file-scoped dependents include consumers in other repos, also after an upgrade', async () => {
    process.env.ANVIL_LLM_MODE = 'none';
    const root = join(tmpdir(), `kc-xrepo-${randomBytes(6).toString('hex')}`);
    const ws = join(root, 'ws');
    const prevDataDir = process.env.CODE_SEARCH_DATA_DIR;
    process.env.CODE_SEARCH_DATA_DIR = join(root, 'data');
    try {
      commitRepo(join(ws, 'billing'), {
        'src/server.ts': "export function getInvoice(req: any, res: any) { res.json({}); }\napp.get('/api/invoices/:id', getInvoice);\n",
      });
      commitRepo(join(ws, 'billing-ui'), {
        'src/client.ts': "export function loadInvoice(id: string) {\n  return fetch('http://billing/api/invoices/:id');\n}\n",
      });
      const project = `xrepo-${randomBytes(4).toString('hex')}`;

      await buildKBFromPath(project, ws);
      assert.deepEqual(await consumersOf(project, 'billing', 'src/server.ts'), ['billing-ui']);

      // Simulate signals stored by an older version: no version, absolute paths.
      const blobs = resolveStorage(project).blobs;
      const stale: CrossRepoSignals = { apiClients: { '/api/invoices/:param': join(ws, 'billing-ui', 'src', 'client.ts') } };
      await blobs.putJson('billing-ui/signals.json', stale);

      // Nothing changed in git — the outdated signals alone force a re-extract.
      await buildKBFromPath(project, ws);
      const fresh = await blobs.getJson<CrossRepoSignals>('billing-ui/signals.json');
      assert.equal(fresh?.apiClients?.['/api/invoices/:param'], join('src', 'client.ts'));
      assert.deepEqual(await consumersOf(project, 'billing', 'src/server.ts'), ['billing-ui']);
    } finally {
      await invalidateGraphStores();
      if (prevDataDir === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
      else process.env.CODE_SEARCH_DATA_DIR = prevDataDir;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
