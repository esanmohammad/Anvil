/**
 * Partial-cycle chunks.json carry-forward.
 *
 * A reindex only shards the repos (and, on the git-diff incremental path,
 * only the FILES) re-chunked this cycle. Before the carry-forward fix,
 * dedupShardsToChunks rewrote chunks.json from those shards alone — every
 * scheduled partial reindex silently dropped the unchanged repos' chunks
 * (get_code_snippet decay, wrong totals). Pins:
 *   1. an untouched repo's chunks survive a cycle that re-chunks another repo
 *   2. an incrementally re-chunked repo keeps its untouched files' chunks
 *   3. deleted files' chunks are gone
 *   4. new content is present
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execSync } from 'node:child_process';
import { buildKBFromPath, getBlobStore, getGraphStore, invalidateRetriever } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';

const root = join(tmpdir(), `kc-partial-${randomBytes(6).toString('hex')}`);
const dataDir = join(root, 'data');
const prevDataDir = process.env.CODE_SEARCH_DATA_DIR;
const prevLlm = process.env.CODE_SEARCH_LLM_MODE;
process.env.CODE_SEARCH_DATA_DIR = dataDir;
process.env.CODE_SEARCH_LLM_MODE = 'none';

const sh = (c: string) => execSync(c, { stdio: 'pipe' });
const git = (repo: string, c: string) =>
  sh(`cd ${join(root, repo)} && git ${c.startsWith('commit') ? `-c user.email=t@t -c user.name=t ${c}` : c}`);

after(async () => {
  await invalidateRetriever();
  if (prevDataDir === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
  else process.env.CODE_SEARCH_DATA_DIR = prevDataDir;
  if (prevLlm === undefined) delete process.env.CODE_SEARCH_LLM_MODE;
  else process.env.CODE_SEARCH_LLM_MODE = prevLlm;
  rmSync(root, { recursive: true, force: true });
});

async function readChunks(project: string): Promise<CodeChunk[]> {
  const out: CodeChunk[] = [];
  for await (const c of getBlobStore(project).iterateNdjson<CodeChunk>('chunks.json')) out.push(c);
  return out;
}

describe('partial cycle — chunks.json carry-forward', () => {
  it('preserves unchanged repos and untouched files; drops deleted files; adds new content', async () => {
    const project = `partial-${randomBytes(4).toString('hex')}`;

    // repoA: two files (one will change, one stays); a third that will be deleted.
    mkdirSync(join(root, 'repoA'), { recursive: true });
    writeFileSync(join(root, 'repoA', 'stable.ts'), 'export interface SharedPayload { id: string }\nexport function stableFnA(): number {\n  return 1;\n}\n');
    writeFileSync(join(root, 'repoA', 'hot.ts'), 'export function hotFnOld(): number {\n  return 2;\n}\n');
    writeFileSync(join(root, 'repoA', 'doomed.ts'), 'export function doomedFn(): number {\n  return 3;\n}\n');
    git('repoA', 'init -q');
    git('repoA', 'add -A');
    git('repoA', 'commit -qm init');

    // repoB: untouched across the whole test.
    mkdirSync(join(root, 'repoB'), { recursive: true });
    writeFileSync(join(root, 'repoB', 'calm.ts'), 'export interface SharedPayload { id: string }\nexport function calmFnB(): number {\n  return 4;\n}\n');
    git('repoB', 'init -q');
    git('repoB', 'add -A');
    git('repoB', 'commit -qm init');

    // Cycle 1 — full build.
    await buildKBFromPath(project, root, { onProgress: () => {} });
    const gen1 = await getBlobStore(project).getJson<{ generation: number }>('index_generation');
    assert.ok(gen1?.generation, 'cycle 1 bumps index_generation');
    const c1 = await readChunks(project);
    assert.ok(c1.some((c) => c.repoName === 'repoB'), 'cycle 1 has repoB');
    assert.ok(c1.some((c) => c.entityName === 'doomedFn'), 'cycle 1 has doomedFn');

    // Change ONLY repoA: modify hot.ts, delete doomed.ts, leave stable.ts.
    writeFileSync(join(root, 'repoA', 'hot.ts'), 'export function hotFnNew(): number {\n  return 22;\n}\n');
    rmSync(join(root, 'repoA', 'doomed.ts'));
    git('repoA', 'add -A');
    git('repoA', 'commit -qm change');

    // Cycle 2 — partial (repoB skipped via sha; repoA incremental via git diff).
    const logs: string[] = [];
    await buildKBFromPath(project, root, { onProgress: (m) => logs.push(m) });
    assert.ok(logs.some((m) => m.includes('Skipping repoB')), 'repoB skipped — not re-cloned/re-parsed');
    const gen2 = await getBlobStore(project).getJson<{ generation: number }>('index_generation');
    assert.ok(gen2!.generation > gen1!.generation, 'cycle 2 advances the generation read replicas poll');
    const c2 = await readChunks(project);

    assert.ok(c2.some((c) => c.repoName === 'repoB' && c.entityName === 'calmFnB'),
      'unchanged repoB carried forward');
    assert.ok(c2.some((c) => c.repoName === 'repoA' && c.entityName === 'stableFnA'),
      'untouched file of incrementally-chunked repoA carried forward');
    assert.ok(c2.some((c) => c.entityName === 'hotFnNew'), 'new content present');
    assert.ok(!c2.some((c) => c.entityName === 'hotFnOld'), 'stale chunk of changed file replaced');
    assert.ok(!c2.some((c) => c.entityName === 'doomedFn'), 'deleted file dropped');

    // C2: the system graph after a partial cycle still carries the SKIPPED
    // repo's nodes (streamed from its stored graph.json) and the cross-repo
    // edge (correlated from persisted signals — no working tree needed).
    const store = await getGraphStore(project);
    assert.ok(store, 'system graph present');
    assert.ok(store!.resolveNodes('calmFnB').length > 0, "skipped repoB's nodes in the merged graph");
    const { edges } = store!.crossRepoEdges(undefined, 50);
    assert.ok(
      edges.some((e) => /SharedPayload/.test(`${e.source} ${e.target}`)),
      `shared-type cross-repo edge survives the partial cycle (got: ${JSON.stringify(edges).slice(0, 200)})`,
    );
  });
});
