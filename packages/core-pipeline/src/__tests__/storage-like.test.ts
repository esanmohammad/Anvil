/**
 * Phase G — pin the *Like interface shapes.
 *
 * These tests don't import from the dashboard (cross-package). They
 * pin the structural shape so any signature change in one of the
 * `*Like` interfaces breaks the test suite — forcing the corresponding
 * dashboard `implements *Like` clause to be updated in lockstep.
 *
 * Compile-time-only assertions: each test creates a stub object that
 * satisfies the interface and tries to call its methods on a fake
 * instance. A wrong shape becomes a TS compile error during the
 * core-pipeline build.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type {
  FeatureStoreLike,
  FeatureManifestStoreLike,
  KbManagerLike,
  ProjectLoaderLike,
} from '../storage-like.js';
import { emptyManifest } from '../utils/feature-manifest-types.js';

describe('storage-like (Phase G)', () => {
  it('FeatureStoreLike accepts a minimal in-memory implementation', () => {
    const map = new Map<string, string>();
    const fs: FeatureStoreLike = {
      getFeatureDir: (project, slug) => `/tmp/${project}/${slug}`,
      writeArtifact: (project, slug, rel, content) => { map.set(`${project}/${slug}/${rel}`, content); },
      readArtifact: (project, slug, rel) => map.get(`${project}/${slug}/${rel}`) ?? null,
    };
    fs.writeArtifact('app', 'feat', 'CLARIFICATION.md', 'q & a');
    assert.equal(fs.readArtifact('app', 'feat', 'CLARIFICATION.md'), 'q & a');
    assert.equal(fs.readArtifact('app', 'feat', 'unknown'), null);
    assert.equal(fs.getFeatureDir('app', 'feat'), '/tmp/app/feat');
  });

  it('FeatureManifestStoreLike accepts a minimal in-memory implementation', () => {
    const records = new Map<string, ReturnType<typeof emptyManifest>>();
    const key = (p: string, s: string) => `${p}/${s}`;

    const ms: FeatureManifestStoreLike = {
      read: (p, s) => records.get(key(p, s)) ?? null,
      ensure: (p, s, feature) => {
        const existing = records.get(key(p, s));
        if (existing) return existing;
        const fresh = emptyManifest(p, s, feature);
        records.set(key(p, s), fresh);
        return fresh;
      },
      patchField: (p, s, field, status, value, writer) => {
        const m = records.get(key(p, s)) ?? emptyManifest(p, s, '');
        (m as unknown as Record<string, unknown>)[field] = {
          status, value, writtenBy: writer, writtenAt: new Date().toISOString(),
        };
        records.set(key(p, s), m);
        return m;
      },
    };

    ms.ensure('app', 'feat', 'login');
    const updated = ms.patchField('app', 'feat', 'acceptanceCriteria', 'partial', ['x'], 'specs');
    assert.equal(updated.acceptanceCriteria.status, 'partial');
    assert.deepEqual(updated.acceptanceCriteria.value, ['x']);
  });

  it('KbManagerLike accepts a minimal stub', async () => {
    let prefetched = 0;
    const kb: KbManagerLike = {
      getIndexForPrompt: () => 'INDEX',
      getAllGraphReports: () => 'GRAPH',
      prefetchHybridContext: async () => { prefetched++; },
    };
    assert.equal(kb.getIndexForPrompt('app'), 'INDEX');
    assert.equal(kb.getAllGraphReports('app'), 'GRAPH');
    await kb.prefetchHybridContext('app', 'add login');
    assert.equal(prefetched, 1);
  });

  it('ProjectLoaderLike accepts a minimal stub', async () => {
    const loader: ProjectLoaderLike = {
      getProject: async (p) => (p === 'known' ? { name: p } : null),
      getConfig: (p) => (p === 'known' ? {} : null),
      getModelForStage: (_p, stage) => `model-for-${stage}`,
    };
    assert.deepEqual(await loader.getProject('known'), { name: 'known' });
    assert.equal(await loader.getProject('unknown'), null);
    assert.equal(loader.getModelForStage('known', 'build'), 'model-for-build');
  });
});
