/**
 * The vector table must stay an exact image of the indexed workspace across
 * every kind of cycle: chunk ids unique per repo, every repo's own copy of
 * shared code kept, per-repo file metadata complete after incremental runs,
 * removed repos and files gone, and rows from an older id scheme replaced.
 *
 * Drives the real buildKB + embedChunks over temp git repos (kb-fixture.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { buildKBFromPath, indexFromPath, KnowledgeIndexer } from '@esankhan3/anvil-knowledge-core';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';
import { fn, withKbFixture } from './kb-fixture.js';

const byRepo = (rows: CodeChunk[], repo: string) => rows.filter((r) => r.repoName === repo);
const names = (rows: CodeChunk[]) => rows.map((r) => r.entityName).sort();

describe('index integrity', () => {
  it('keeps chunk ids unique per repo, so editing one repo never touches another', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('one', { 'src/index.ts': fn('alphaOne') + fn('betaOne') });
      f.repo('two', { 'src/index.ts': fn('gammaTwo') + fn('deltaTwo') });
      await f.index();
      let rows = await f.rows();
      assert.equal(new Set(rows.map((r) => r.id)).size, 4, 'ids collide across repos');

      // Same line ranges, new body: the file must be re-embedded, the other repo untouched.
      f.write('one', 'src/index.ts', fn('alphaOne', ' + 1') + fn('betaOne'));
      f.commit('one');
      const before = f.embedded();
      await f.index();
      assert.ok(f.embedded() > before, 'edited file was not re-embedded');
      rows = await f.rows();
      assert.deepEqual(names(byRepo(rows, 'one')), ['alphaOne', 'betaOne']);
      assert.ok(byRepo(rows, 'one').some((r) => r.content.includes('+ 1')), 'edit not indexed');
      assert.deepEqual(names(byRepo(rows, 'two')), ['deltaTwo', 'gammaTwo']);
    });
  });

  it("keeps every repo's own copy of identical code across partial cycles", async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('ra', { 'src/shared.ts': fn('sharedHelper') });
      f.repo('rb', { 'src/shared.ts': fn('sharedHelper'), 'src/own.ts': fn('onlyInBee') });
      await f.index();
      assert.deepEqual(names(byRepo(await f.rows(), 'rb')), ['onlyInBee', 'sharedHelper']);

      f.write('ra', 'src/shared.ts', fn('sharedHelper', ' + 2'));
      f.commit('ra');
      await f.index();
      assert.deepEqual(names(byRepo(await f.rows(), 'rb')), ['onlyInBee', 'sharedHelper']);
      assert.ok((await f.search('sharedHelper', ['rb'])).some((c) => c.repoName === 'rb'));
    });
  });

  it('records every file after an incremental run, so a later full rescan neither re-embeds nor misses deletions', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'a.ts': fn('aaa'), 'b.ts': fn('bbb') + fn('bbb2'), 'c.ts': fn('ccc') });
      await f.index();
      f.write('svc', 'a.ts', fn('aaa', ' + 3'));
      f.commit('svc');
      await f.index();

      const meta = await f.storage().blobs.getJson<{ files: Record<string, unknown>; chunkCount: number }>('svc/index_meta.json');
      assert.deepEqual(Object.keys(meta?.files ?? {}).sort(), ['a.ts', 'b.ts', 'c.ts']);
      assert.equal(meta?.chunkCount, (await f.rows()).length);
      const stats = await new KnowledgeIndexer().getStats(f.project, f.config);
      assert.equal(stats.repos.find((r) => r.name === 'svc')?.chunkCount, 4);

      // Stored graph gone → the repo is re-processed at the same HEAD with its file cache.
      rmSync(join(process.env.CODE_SEARCH_DATA_DIR!, f.project, 'svc', 'graph.json'));
      const before = f.embedded();
      await f.index();
      assert.equal(f.embedded() - before, 0, 'unchanged files re-embedded');

      // Delete c.ts and rewrite history so the last indexed sha is unreachable → full fallback.
      rmSync(join(f.ws, 'svc', 'c.ts'));
      f.git('svc', 'checkout', '-q', '--orphan', 'rewritten');
      f.commit('svc', 'squashed');
      f.git('svc', 'branch', '-q', '-D', 'main');
      f.git('svc', 'reflog', 'expire', '--expire=now', '--all');
      f.git('svc', 'gc', '-q', '--prune=now');
      await f.index();
      const rows = await f.rows();
      assert.ok(!rows.some((r) => r.filePath === 'c.ts'), 'deleted file still indexed');
      assert.deepEqual(names(rows), ['aaa', 'bbb', 'bbb2']);
    });
  });

  it('drops a repo removed from the workspace, even when nothing else changed', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('keep', { 'k.ts': fn('keepFn') });
      f.repo('gone', { 'g.ts': fn('goneFnUnique') });
      await f.index();
      rmSync(join(f.ws, 'gone'), { recursive: true, force: true });
      await f.index();

      assert.deepEqual(byRepo(await f.rows(), 'gone'), []);
      assert.deepEqual(await f.search('goneFnUnique'), []);
      assert.equal(await f.storage().blobs.exists('gone/index_meta.json'), false);
    });
  });

  it('replaces rows that chunks.json no longer lists, and rebuilds an index from an older id scheme', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('svc', { 'a.ts': fn('aaa'), 'b.ts': fn('bbb') });
      await f.index();
      const blobs = f.storage().blobs;
      // Simulate a pre-upgrade index: meta without a chunk-id version, plus a row under an old-style id.
      const meta = await blobs.getJson<Record<string, unknown>>('svc/index_meta.json');
      delete meta!.chunkIdVersion;
      await blobs.putJson('svc/index_meta.json', meta);
      const v = f.storage().vectors;
      await v.init();
      const [row] = await v.getByIds([(await v.getChunkIds(f.project))[0]]);
      await v.addChunks([{ ...row, id: 'deadbeefdeadbeef', embedding: Array(8).fill(0.1) }]);

      await f.index();
      const rows = await f.rows();
      assert.ok(!rows.some((r) => r.id === 'deadbeefdeadbeef'), 'stale row survived');
      assert.deepEqual(names(rows), ['aaa', 'bbb']);
      const after = await blobs.getJson<{ chunkIdVersion?: number }>('svc/index_meta.json');
      assert.equal(typeof after?.chunkIdVersion, 'number');
    });
  });

  it('reports the real cross-repo edge count, and a first index lists no files as stale', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('pub', { 'p.ts': "export const TOPIC = 'order.created';\n" + fn('publish') });
      f.repo('sub', { 's.ts': "export const TOPIC = 'order.created';\n" + fn('consume') });
      await buildKBFromPath(f.project, f.ws, { config: f.config });
      assert.deepEqual(await f.storage().blobs.getJson('deleted_files.json'), []);
      const first = await indexFromPath(f.project, f.ws, { config: f.config });
      assert.ok(first.crossRepoEdges > 0, 'index result reports 0 cross-repo edges');
      const again = await indexFromPath(f.project, f.ws, { config: f.config }); // nothing changed
      assert.equal(again.crossRepoEdges, first.crossRepoEdges);
    });
  });

  it('leaves paths matching chunking.ignorePatterns out of chunks, rows and graph', async (t) => {
    await withKbFixture(t, async (f) => {
      f.config.chunking.ignorePatterns = ['generated'];
      f.repo('svc', { 'src/a.ts': fn('aaa'), 'generated/client.ts': fn('genClient'), 'src/generated/b.ts': fn('genB') });
      await f.index();
      assert.deepEqual((await f.rows()).map((r) => r.filePath), ['src/a.ts']);
      const graph = await f.storage().blobs.getJson<{ nodes: Array<{ id: string }> }>('svc/graph.json');
      assert.ok(!graph?.nodes.some((n) => n.id.includes('generated/')), 'ignored files in the graph');
    });
  });

  it('re-indexes infra files on uncommitted and committed edits', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('ops', { 'a.ts': fn('aaa'), 'deploy.sh': 'echo marker_v1\n', 'Dockerfile': 'FROM node:20\nRUN echo layer_v1\n' });
      await f.index();

      f.write('ops', 'deploy.sh', 'echo marker_v2\n'); // uncommitted
      await f.index();
      assert.ok((await f.rows()).some((r) => r.content.includes('marker_v2')), 'uncommitted infra edit skipped');

      f.write('ops', 'a.ts', fn('aaa', ' + 5'));
      f.write('ops', 'Dockerfile', 'FROM node:20\nRUN echo layer_v2\n');
      f.commit('ops');
      await f.index();
      const contents = (await f.rows()).map((r) => r.content).join('\n');
      assert.ok(contents.includes('layer_v2') && !contents.includes('layer_v1'), 'committed infra edit missed');
    });
  });
});
