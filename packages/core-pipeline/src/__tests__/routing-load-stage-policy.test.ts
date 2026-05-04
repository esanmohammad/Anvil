// Phase 7 — stage-policy.yaml loader + validator. (Now in core-pipeline.)

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  loadStagePolicy,
  validateStagePolicy,
  StagePolicyValidationError,
  StagePolicyLoadError,
} from '../routing/load-stage-policy.js';

let tmp = '';
before(() => { tmp = mkdtempSync(join(tmpdir(), 'anvil-stage-policy-')); });
after(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('validateStagePolicy', () => {
  it('accepts a minimal valid map', () => {
    const m = validateStagePolicy({
      stages: {
        build: { capability: 'code', complexity: 'M', prefer: ['local', 'premium'] },
      },
    });
    assert.equal(m.stages.build.capability, 'code');
    assert.deepEqual(m.stages.build.prefer, ['local', 'premium']);
  });

  it('rejects unknown capability', () => {
    assert.throws(
      () => validateStagePolicy({ stages: { x: { capability: 'magic', complexity: 'M', prefer: ['local'] } } }),
      StagePolicyValidationError,
    );
  });

  it('rejects unknown complexity', () => {
    assert.throws(
      () => validateStagePolicy({ stages: { x: { capability: 'code', complexity: 'XL', prefer: ['local'] } } }),
      StagePolicyValidationError,
    );
  });

  it('rejects unknown tier in prefer', () => {
    assert.throws(
      () => validateStagePolicy({ stages: { x: { capability: 'code', complexity: 'M', prefer: ['rogue'] } } }),
      StagePolicyValidationError,
    );
  });

  it('rejects empty prefer array', () => {
    assert.throws(
      () => validateStagePolicy({ stages: { x: { capability: 'code', complexity: 'M', prefer: [] } } }),
      StagePolicyValidationError,
    );
  });

  it('rejects missing stages key', () => {
    assert.throws(() => validateStagePolicy({}), StagePolicyValidationError);
  });

  it('rejects non-object top level', () => {
    assert.throws(() => validateStagePolicy('not-yaml'), StagePolicyValidationError);
  });
});

describe('loadStagePolicy — bundled default', () => {
  it('loads the canonical stage-policy.yaml shipped with core-pipeline', () => {
    const m = loadStagePolicy();
    assert.equal(m.stages.build.capability, 'code');
    assert.equal(m.stages.specs.complexity, 'L');
    for (const id of ['clarify', 'requirements', 'specs', 'build', 'validate', 'ship', 'fix']) {
      assert.ok(m.stages[id], `expected stage "${id}" in bundled policy`);
    }
  });
});

describe('loadStagePolicy — overrides', () => {
  it('respects ANVIL_STAGE_POLICY env override', () => {
    const path = join(tmp, 'custom.yaml');
    writeFileSync(
      path,
      [
        'stages:',
        '  custom-stage:',
        '    capability: vision',
        '    complexity: S',
        '    prefer: [local]',
      ].join('\n'),
    );
    const m = loadStagePolicy({ env: { ANVIL_STAGE_POLICY: path } });
    assert.equal(m.stages['custom-stage'].capability, 'vision');
    assert.equal(m.stages.build, undefined);
  });

  it('respects workspaceRoot/.anvil/stage-policy.yaml', () => {
    const ws = join(tmp, 'workspace');
    mkdirSync(join(ws, '.anvil'), { recursive: true });
    writeFileSync(
      join(ws, '.anvil', 'stage-policy.yaml'),
      [
        'stages:',
        '  workspace-stage:',
        '    capability: code',
        '    complexity: M',
        '    prefer: [cheap]',
      ].join('\n'),
    );
    const m = loadStagePolicy({ workspaceRoot: ws, env: {} });
    assert.equal(m.stages['workspace-stage'].capability, 'code');
  });

  it('throws StagePolicyLoadError when the override path is missing', () => {
    assert.throws(
      () => loadStagePolicy({ env: { ANVIL_STAGE_POLICY: join(tmp, 'does-not-exist.yaml') } }),
      StagePolicyLoadError,
    );
  });

  it('respects ~/.anvil/stage-policy.yaml (per-user override)', () => {
    // Use a fake $HOME so the test doesn't trip on the developer's
    // real ~/.anvil. The loader joins homeDir with `.anvil` itself.
    const fakeHome = join(tmp, 'home-user');
    mkdirSync(join(fakeHome, '.anvil'), { recursive: true });
    writeFileSync(
      join(fakeHome, '.anvil', 'stage-policy.yaml'),
      [
        'stages:',
        '  user-stage:',
        '    capability: reasoning',
        '    complexity: L',
        '    prefer: [premium]',
      ].join('\n'),
    );
    const m = loadStagePolicy({ homeDir: fakeHome, env: {} });
    assert.equal(m.stages['user-stage'].capability, 'reasoning');
    // Bundled default's `build` stage MUST NOT leak through — the
    // override is a full replacement, not a merge.
    assert.equal(m.stages.build, undefined);
  });

  it('respects ANVIL_HOME when picking the per-user override', () => {
    const altHome = join(tmp, 'alt-anvil-home');
    mkdirSync(altHome, { recursive: true });
    writeFileSync(
      join(altHome, 'stage-policy.yaml'),
      [
        'stages:',
        '  alt-stage:',
        '    capability: code',
        '    complexity: S',
        '    prefer: [local]',
      ].join('\n'),
    );
    const m = loadStagePolicy({
      homeDir: '/nonexistent-default-home',  // ignored when ANVIL_HOME is set
      env: { ANVIL_HOME: altHome },
    });
    assert.equal(m.stages['alt-stage'].capability, 'code');
  });

  it('precedence: ANVIL_STAGE_POLICY > workspaceRoot > ~/.anvil > bundled', () => {
    // Set up all three override paths simultaneously and assert that
    // each higher-precedence one wins.
    const env = join(tmp, 'env.yaml');
    const ws = join(tmp, 'precedence-ws');
    const home = join(tmp, 'precedence-home');
    mkdirSync(join(ws, '.anvil'), { recursive: true });
    mkdirSync(join(home, '.anvil'), { recursive: true });
    const stagePolicy = (label: string) => [
      'stages:',
      `  ${label}:`,
      '    capability: code',
      '    complexity: M',
      '    prefer: [local]',
    ].join('\n');
    writeFileSync(env, stagePolicy('from-env'));
    writeFileSync(join(ws, '.anvil', 'stage-policy.yaml'), stagePolicy('from-ws'));
    writeFileSync(join(home, '.anvil', 'stage-policy.yaml'), stagePolicy('from-home'));

    // env wins over workspaceRoot
    let m = loadStagePolicy({ workspaceRoot: ws, homeDir: home, env: { ANVIL_STAGE_POLICY: env } });
    assert.ok(m.stages['from-env'], 'env override should win');
    assert.equal(m.stages['from-ws'], undefined);
    assert.equal(m.stages['from-home'], undefined);

    // workspaceRoot wins over ~/.anvil
    m = loadStagePolicy({ workspaceRoot: ws, homeDir: home, env: {} });
    assert.ok(m.stages['from-ws'], 'workspace override should win');
    assert.equal(m.stages['from-home'], undefined);

    // ~/.anvil wins over bundled default when no other override is set
    m = loadStagePolicy({ homeDir: home, env: {} });
    assert.ok(m.stages['from-home'], '~/.anvil override should win over bundled');
    // bundled would have provided `build`; it MUST NOT leak through here
    assert.equal(m.stages.build, undefined);
  });
});
