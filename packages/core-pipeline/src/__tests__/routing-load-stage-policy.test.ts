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
});
