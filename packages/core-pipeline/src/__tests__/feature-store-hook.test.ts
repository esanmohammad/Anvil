/**
 * Phase 4 — feature-store hook unit tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryEventBus } from '../event-bus.js';
import { attachFeatureStoreHook } from '../hooks/feature-store.hook.js';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'feature-store-test-'));
  try {
    return await fn(dir);
  } finally {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
}

describe('attachFeatureStoreHook', () => {
  it('persists known artifact IDs to disk', async () => {
    await withTmpDir(async (dir) => {
      const bus = new InMemoryEventBus();
      const handle = attachFeatureStoreHook(bus, {
        featureDir: dir,
        artifactPaths: { 'CLARIFICATION.md': 'CLARIFICATION.md' },
      });
      await bus.emit({
        hook: 'artifact:emitted', runId: 'r', stepId: 'clarify', ts: '',
        payload: { artifactId: 'CLARIFICATION.md', data: '# Hello' },
      });
      const written = readFileSync(join(dir, 'CLARIFICATION.md'), 'utf-8');
      assert.equal(written, '# Hello');
      assert.equal(handle.writeCount, 1);
      assert.ok(handle.persistedArtifacts.has('CLARIFICATION.md'));
    });
  });

  it('extracts the .artifact field from object payloads (legacy shape)', async () => {
    await withTmpDir(async (dir) => {
      const bus = new InMemoryEventBus();
      attachFeatureStoreHook(bus, {
        featureDir: dir,
        artifactPaths: { 'REQ.md': 'REQ.md' },
      });
      await bus.emit({
        hook: 'artifact:emitted', runId: 'r', stepId: 's', ts: '',
        payload: { artifactId: 'REQ.md', data: { artifact: '# Reqs', tokenEstimate: 10 } },
      });
      assert.equal(readFileSync(join(dir, 'REQ.md'), 'utf-8'), '# Reqs');
    });
  });

  it('falls back to JSON.stringify for non-string non-artifact payloads', async () => {
    await withTmpDir(async (dir) => {
      const bus = new InMemoryEventBus();
      attachFeatureStoreHook(bus, {
        featureDir: dir,
        artifactPaths: { 'manifest.json': 'manifest.json' },
      });
      await bus.emit({
        hook: 'artifact:emitted', runId: 'r', stepId: 's', ts: '',
        payload: { artifactId: 'manifest.json', data: { foo: 1, bar: 'two' } },
      });
      const written = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf-8'));
      assert.deepEqual(written, { foo: 1, bar: 'two' });
    });
  });

  it('ignores unknown artifact IDs', async () => {
    await withTmpDir(async (dir) => {
      const bus = new InMemoryEventBus();
      const handle = attachFeatureStoreHook(bus, {
        featureDir: dir,
        artifactPaths: { 'CLARIFICATION.md': 'CLARIFICATION.md' },
      });
      await bus.emit({
        hook: 'artifact:emitted', runId: 'r', stepId: 's', ts: '',
        payload: { artifactId: 'DEBUG.json', data: 'whatever' },
      });
      assert.equal(handle.writeCount, 0);
      assert.equal(handle.persistedArtifacts.size, 0);
    });
  });

  it('creates nested subdirectories from artifactPaths values', async () => {
    await withTmpDir(async (dir) => {
      const bus = new InMemoryEventBus();
      attachFeatureStoreHook(bus, {
        featureDir: dir,
        artifactPaths: { 'repo-spec': 'repos/cool-repo/SPECS.md' },
      });
      await bus.emit({
        hook: 'artifact:emitted', runId: 'r', stepId: 's', ts: '',
        payload: { artifactId: 'repo-spec', data: '# Spec' },
      });
      assert.equal(readFileSync(join(dir, 'repos/cool-repo/SPECS.md'), 'utf-8'), '# Spec');
    });
  });

  it('unsubscribe stops persisting', async () => {
    await withTmpDir(async (dir) => {
      const bus = new InMemoryEventBus();
      const handle = attachFeatureStoreHook(bus, {
        featureDir: dir,
        artifactPaths: { 'CLARIFICATION.md': 'CLARIFICATION.md' },
      });
      handle.unsubscribe();
      await bus.emit({
        hook: 'artifact:emitted', runId: 'r', stepId: 's', ts: '',
        payload: { artifactId: 'CLARIFICATION.md', data: 'x' },
      });
      assert.equal(handle.writeCount, 0);
      assert.equal(existsSync(join(dir, 'CLARIFICATION.md')), false);
    });
  });
});
