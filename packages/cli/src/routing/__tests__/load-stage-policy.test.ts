// Phase 7 — stage-policy.yaml loader + validator.

import {
  loadStagePolicy,
  validateStagePolicy,
  StagePolicyValidationError,
  StagePolicyLoadError,
} from '../load-stage-policy.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('validateStagePolicy', () => {
  it('accepts a minimal valid map', () => {
    const m = validateStagePolicy({
      stages: {
        build: { capability: 'code', complexity: 'M', prefer: ['local', 'premium'] },
      },
    });
    expect(m.stages.build.capability).toBe('code');
    expect(m.stages.build.prefer).toEqual(['local', 'premium']);
  });

  it('rejects unknown capability', () => {
    expect(() =>
      validateStagePolicy({ stages: { x: { capability: 'magic', complexity: 'M', prefer: ['local'] } } }),
    ).toThrow(StagePolicyValidationError);
  });

  it('rejects unknown complexity', () => {
    expect(() =>
      validateStagePolicy({ stages: { x: { capability: 'code', complexity: 'XL', prefer: ['local'] } } }),
    ).toThrow(StagePolicyValidationError);
  });

  it('rejects unknown tier in prefer', () => {
    expect(() =>
      validateStagePolicy({ stages: { x: { capability: 'code', complexity: 'M', prefer: ['rogue'] } } }),
    ).toThrow(StagePolicyValidationError);
  });

  it('rejects empty prefer array', () => {
    expect(() =>
      validateStagePolicy({ stages: { x: { capability: 'code', complexity: 'M', prefer: [] } } }),
    ).toThrow(StagePolicyValidationError);
  });

  it('rejects missing stages key', () => {
    expect(() => validateStagePolicy({})).toThrow(StagePolicyValidationError);
  });

  it('rejects non-object top level', () => {
    expect(() => validateStagePolicy('not-yaml')).toThrow(StagePolicyValidationError);
  });
});

describe('loadStagePolicy — bundled default', () => {
  it('loads the canonical stage-policy.yaml shipped with the cli', () => {
    const m = loadStagePolicy();
    expect(m.stages.build.capability).toBe('code');
    expect(m.stages.specs.complexity).toBe('L');
    expect(Object.keys(m.stages)).toEqual(
      expect.arrayContaining(['clarify', 'requirements', 'specs', 'build', 'validate', 'ship', 'fix']),
    );
  });
});

describe('loadStagePolicy — overrides', () => {
  let tmp: string;

  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'anvil-stage-policy-')); });
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

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
    expect(m.stages['custom-stage'].capability).toBe('vision');
    expect(m.stages.build).toBeUndefined();
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
    expect(m.stages['workspace-stage'].capability).toBe('code');
  });

  it('throws StagePolicyLoadError when the override path is missing', () => {
    expect(() =>
      loadStagePolicy({ env: { ANVIL_STAGE_POLICY: join(tmp, 'does-not-exist.yaml') } }),
    ).toThrow(StagePolicyLoadError);
  });
});
