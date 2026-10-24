/**
 * Per-repo chunk files: a cycle writes, embeds and sweeps only the repos that
 * changed; a removed repo's rows go by name; an index from before per-repo
 * files (one project-wide chunks.json) is read as is, then split by the next
 * cycle that builds anything — without re-embedding.
 * Drives the real buildKB + embedChunks (kb-fixture.ts).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';
import { EMBED_PENDING_KEY, LEGACY_CHUNKS_KEY, repoChunksKey } from '../repo-chunks.js';
import { fn, withKbFixture } from './kb-fixture.js';

const chunkFile = (project: string, repo: string) =>
  join(process.env.CODE_SEARCH_DATA_DIR!, project, repoChunksKey(repo));

describe('per-repo chunk files', () => {
  it('a change in one repo rewrites only its chunk file and embeds only its chunks', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('one', { 'a.ts': fn('alphaOne') });
      f.repo('two', { 'b.ts': fn('betaTwo') });
      await f.index();
      const twoBefore = statSync(chunkFile(f.project, 'two')).mtimeMs;

      f.write('one', 'a.ts', fn('alphaOne', ' + 1'));
      f.commit('one');
      const before = f.embedded();
      await f.index();

      assert.equal(statSync(chunkFile(f.project, 'two')).mtimeMs, twoBefore, "unchanged repo's file rewritten");
      assert.equal(f.embedded() - before, 1, 'only the edited chunk is embedded');
      const rows = await f.rows();
      assert.ok(rows.some((r) => r.repoName === 'one' && r.content.includes('+ 1')));
      assert.ok(rows.some((r) => r.repoName === 'two'), "the other repo's rows stay");
      assert.deepEqual(await f.storage().blobs.getJson(EMBED_PENDING_KEY), { all: false, repos: [], removed: [] });
    });
  });

  it('a repo removed from the workspace loses its rows and chunk file', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('keep', { 'k.ts': fn('keepFn') });
      f.repo('gone', { 'g.ts': fn('goneFn') });
      await f.index();
      rmSync(join(f.ws, 'gone'), { recursive: true, force: true });
      await f.index();
      assert.ok(!(await f.rows()).some((r) => r.repoName === 'gone'));
      assert.equal(await f.storage().blobs.exists(repoChunksKey('gone')), false);
    });
  });

  it('reads a project-wide chunks.json, then splits it on the next build, without re-embedding', async (t) => {
    await withKbFixture(t, async (f) => {
      f.repo('one', { 'a.ts': fn('alphaOne') + fn('gammaOne') });
      f.repo('two', { 'b.ts': fn('betaTwo') });
      await f.index();
      // Rewind to the older layout: every repo's chunks in one file, no pending list.
      const blobs = f.storage().blobs;
      const all: CodeChunk[] = [];
      for (const repo of ['one', 'two']) {
        for (const line of readFileSync(chunkFile(f.project, repo), 'utf8').split('\n')) if (line) all.push(JSON.parse(line));
        await blobs.delete(repoChunksKey(repo));
      }
      await blobs.putNdjson(LEGACY_CHUNKS_KEY, all);
      await blobs.delete(EMBED_PENDING_KEY);
      const ids = (await f.rows()).map((r) => r.id).sort();

      // A cycle with nothing to build leaves the layout alone and still reads it.
      let before = f.embedded();
      await f.index();
      assert.equal(f.embedded() - before, 0, 're-embedded from the legacy file');
      assert.deepEqual((await f.rows()).map((r) => r.id).sort(), ids);

      // The next cycle that builds anything splits it.
      f.write('one', 'a.ts', fn('alphaOne', ' + 1') + fn('gammaOne'));
      f.commit('one');
      before = f.embedded();
      await f.index();
      assert.equal(await blobs.exists(LEGACY_CHUNKS_KEY), false, 'legacy file removed');
      for (const repo of ['one', 'two']) assert.ok(await blobs.exists(repoChunksKey(repo)), `${repo} has its own file`);
      assert.equal(f.embedded() - before, 1, 'only the edited chunk is embedded');
      const rows = await f.rows();
      assert.equal(rows.length, all.length);
      assert.ok(rows.some((r) => r.repoName === 'two'), "the untouched repo's rows stay");
      const stats = await blobs.getJson<{ totalChunks: number }>('index_stats.json');
      assert.equal(stats?.totalChunks, all.length);
    });
  });
});
