// Phase 7 — composition: stage-policy + models.yaml → routing chain.

import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveModelForStage,
  UnknownStageError,
  ModelResolutionError,
  _resetStageRoutingCache,
} from '../routing/resolve-model-for-stage.js';

let tmp = '';
before(() => { tmp = mkdtempSync(join(tmpdir(), 'anvil-stage-resolve-')); });
after(() => { rmSync(tmp, { recursive: true, force: true }); });

beforeEach(() => { _resetStageRoutingCache(); });

function writeModels(modelsYaml: string): string {
  const home = mkdtempSync(join(tmp, 'home-'));
  writeFileSync(join(home, 'models.yaml'), modelsYaml);
  return home;
}

describe('resolveModelForStage', () => {
  it('throws UnknownStageError for an unrecognized stage', () => {
    const home = writeModels(['models:', '  []'].join('\n'));
    assert.throws(
      () => resolveModelForStage('not-a-stage', { env: { ANVIL_HOME: home } }),
      UnknownStageError,
    );
  });

  it('returns a chain when models.yaml satisfies the bundled policy', () => {
    const home = writeModels([
      'models:',
      '  - id: qwen2.5-coder:7b',
      '    provider: ollama',
      '    tier: local',
      '    capabilities: [code, reasoning]',
      '    complexity_max: M',
      '    vram_gb: 5',
      '    exclusive_slot: true',
      '  - id: claude-haiku-4-5-20251001',
      '    provider: claude',
      '    tier: cheap',
      '    capabilities: [code, reasoning]',
      '    complexity_max: L',
      '    vram_gb: 0',
      '    exclusive_slot: false',
    ].join('\n'));
    const r = resolveModelForStage('build', { env: { ANVIL_HOME: home } });
    assert.equal(r.primary, 'qwen2.5-coder:7b');
    assert.deepEqual(r.fallbacks.map((f) => f.model), ['claude-haiku-4-5-20251001']);
  });

  it('throws ModelResolutionError when models.yaml is empty', () => {
    const home = writeModels('models: []');
    assert.throws(
      () => resolveModelForStage('build', { env: { ANVIL_HOME: home } }),
      ModelResolutionError,
    );
  });

  it('caches loaded yaml across calls (no second read without refresh)', () => {
    const home = writeModels([
      'models:',
      '  - id: m',
      '    provider: ollama',
      '    tier: local',
      '    capabilities: [code]',
      '    complexity_max: M',
      '    vram_gb: 1',
      '    exclusive_slot: false',
    ].join('\n'));
    const r1 = resolveModelForStage('build', { env: { ANVIL_HOME: home } });
    writeFileSync(join(home, 'models.yaml'), 'models: []');
    const r2 = resolveModelForStage('build', { env: { ANVIL_HOME: home } });
    assert.equal(r2.primary, r1.primary);
  });

  it('refresh:true picks up changes', () => {
    const home = writeModels([
      'models:',
      '  - id: first',
      '    provider: ollama',
      '    tier: local',
      '    capabilities: [code]',
      '    complexity_max: M',
      '    vram_gb: 1',
      '    exclusive_slot: false',
    ].join('\n'));
    const r1 = resolveModelForStage('build', { env: { ANVIL_HOME: home } });
    assert.equal(r1.primary, 'first');
    writeFileSync(
      join(home, 'models.yaml'),
      [
        'models:',
        '  - id: second',
        '    provider: ollama',
        '    tier: local',
        '    capabilities: [code]',
        '    complexity_max: M',
        '    vram_gb: 1',
        '    exclusive_slot: false',
      ].join('\n'),
    );
    const r2 = resolveModelForStage('build', { env: { ANVIL_HOME: home }, refresh: true });
    assert.equal(r2.primary, 'second');
  });
});
