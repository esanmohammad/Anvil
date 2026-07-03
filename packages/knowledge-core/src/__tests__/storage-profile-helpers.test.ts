/**
 * P0c-2 — the shared exported helpers (loadProfile / loadAllProfiles /
 * readRepoIndexMeta) now read through BlobStorePort and are async. These pin
 * the round-trip: an artifact written via the port is read back by the helper.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  FsBlobStore, loadProfile, loadAllProfiles, getKnowledgeBasePath,
} from '@esankhan3/anvil-knowledge-core';
// readRepoIndexMeta is internal (repo-pipeline isn't re-exported from the barrel).
import { readRepoIndexMeta } from '../repo-pipeline.js';

const dataDir = join(tmpdir(), `kc-helpers-${randomBytes(6).toString('hex')}`);
const prev = process.env.CODE_SEARCH_DATA_DIR;

before(() => { process.env.CODE_SEARCH_DATA_DIR = dataDir; });
after(() => {
  if (prev === undefined) delete process.env.CODE_SEARCH_DATA_DIR;
  else process.env.CODE_SEARCH_DATA_DIR = prev;
  rmSync(dataDir, { recursive: true, force: true });
});

describe('P0c-2 — shared profile/meta helpers via BlobStorePort', () => {
  it('loadProfile + loadAllProfiles round-trip a profile written through the port', async () => {
    const project = `proj-${randomBytes(4).toString('hex')}`;
    const blobs = new FsBlobStore(getKnowledgeBasePath(project));
    const profile = { name: 'r1', role: 'svc', domain: 'd', description: 'x', technologies: ['ts'], entryPoints: [], exposes: [], consumes: [] };
    await blobs.putJson('r1/profile.json', profile);

    assert.deepEqual(await loadProfile(project, 'r1'), profile);
    assert.equal(await loadProfile(project, 'missing'), null);

    const all = await loadAllProfiles(project);
    assert.equal(all.length, 1);
    assert.equal(all[0]?.name, 'r1');
  });

  it('loadAllProfiles returns [] for an unindexed project', async () => {
    assert.deepEqual(await loadAllProfiles(`empty-${randomBytes(4).toString('hex')}`), []);
  });

  it('readRepoIndexMeta reads index_meta written through the port', async () => {
    const project = `proj-${randomBytes(4).toString('hex')}`;
    const base = getKnowledgeBasePath(project);
    await new FsBlobStore(base).putJson('r1/index_meta.json', { lastIndexedSha: 'abc', chunkCount: 5 });

    const meta = await readRepoIndexMeta(base, 'r1');
    assert.equal(meta?.lastIndexedSha, 'abc');
    assert.equal(meta?.chunkCount, 5);
    assert.equal(await readRepoIndexMeta(base, 'missing'), null);
  });
});
