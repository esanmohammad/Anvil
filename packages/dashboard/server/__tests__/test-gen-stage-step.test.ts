/**
 * Phase 4f.5 tests — `runTestGenForProject` and `pickRepoForBehavior`
 * cover the deterministic test-spec generator that
 * `pipeline-runner.ts:runTestGenStage()` used to own.
 *
 * Tests focus on: skip semantics (no plan seed), pickRepoForBehavior
 * routing, the artifact-written event shape. The downstream stores
 * (TestSpecStore, TestCaseStore) write to ANVIL_HOME — we set that to
 * a temp dir for each test to keep filesystem state isolated.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  pickRepoForBehavior,
  runTestGenForProject,
  type TestGenArtifactEvent,
} from '../steps/test-gen-stage.step.js';

let tmpRoot: string;
const ORIG_ANVIL_HOME = process.env.ANVIL_HOME;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'anvil-testgen-'));
  process.env.ANVIL_HOME = tmpRoot;
});

after(() => {
  if (ORIG_ANVIL_HOME) process.env.ANVIL_HOME = ORIG_ANVIL_HOME;
  else delete process.env.ANVIL_HOME;
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ── pickRepoForBehavior ────────────────────────────────────────────────

describe('pickRepoForBehavior', () => {
  it('returns the first repo whose path contains the target file', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-pick-'));
    const apiPath = join(root, 'api');
    const webPath = join(root, 'web');
    mkdirSync(join(apiPath, 'src'), { recursive: true });
    mkdirSync(join(webPath, 'src'), { recursive: true });
    writeFileSync(join(webPath, 'src/login.ts'), 'export {}', 'utf-8');

    const repo = pickRepoForBehavior(
      { target: { file: 'src/login.ts' } },
      { api: apiPath, web: webPath },
    );
    assert.equal(repo, 'web');
    rmSync(root, { recursive: true, force: true });
  });

  it('falls back to first repo when no path resolves', () => {
    const repo = pickRepoForBehavior(
      { target: { file: 'src/missing.ts' } },
      { api: '/tmp/anvil-no-such-path', web: '/tmp/anvil-no-such-path-2' },
    );
    assert.equal(repo, 'api');
  });

  it('returns null when no repos are registered', () => {
    const repo = pickRepoForBehavior({ target: { file: 'x.ts' } }, {});
    assert.equal(repo, null);
  });
});

// ── runTestGenForProject — skip semantics ───────────────────────────────

describe('runTestGenForProject — skip paths', () => {
  it('returns the legacy skip message when planSeed is missing', async () => {
    const summary = await runTestGenForProject({
      planSeed: null,
      project: 'demo',
      model: 'claude',
      workspaceDir: tmpRoot,
      repoLocalPaths: {},
    });
    assert.equal(summary, 'Test stage skipped (no plan seed).');
  });

});

// ── runTestGenForProject — onArtifactWritten + onConventionsDetected ───

describe('runTestGenForProject — callback wiring', () => {
  it('does not call onArtifactWritten when stage is skipped', async () => {
    const calls: TestGenArtifactEvent[] = [];
    await runTestGenForProject({
      planSeed: null,
      project: 'demo',
      model: 'claude',
      workspaceDir: tmpRoot,
      repoLocalPaths: {},
      onArtifactWritten: (event) => calls.push(event),
    });
    assert.equal(calls.length, 0);
  });

  it('does not call onConventionsDetected when stage is skipped', async () => {
    let detected: string | undefined;
    await runTestGenForProject({
      planSeed: null,
      project: 'demo',
      model: 'claude',
      workspaceDir: tmpRoot,
      repoLocalPaths: {},
      onConventionsDetected: (artifact) => { detected = artifact; },
    });
    assert.equal(detected, undefined);
  });
});
