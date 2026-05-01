// Phase 7 — composition: stage-policy + models.yaml → routing chain.

import {
  resolveModelForStage,
  UnknownStageError,
  ModelResolutionError,
  _resetStageRoutingCache,
} from '../resolve-model-for-stage.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveModelForStage', () => {
  let tmp: string;

  beforeAll(() => { tmp = mkdtempSync(join(tmpdir(), 'anvil-stage-resolve-')); });
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });

  beforeEach(() => { _resetStageRoutingCache(); });

  function writeModels(modelsYaml: string): string {
    const home = mkdtempSync(join(tmp, 'home-'));
    writeFileSync(join(home, 'models.yaml'), modelsYaml);
    return home;
  }

  it('throws UnknownStageError for an unrecognized stage', () => {
    const home = writeModels(['models:', '  []'].join('\n'));
    expect(() =>
      resolveModelForStage('not-a-stage', { env: { ANVIL_HOME: home } }),
    ).toThrow(UnknownStageError);
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
    // `build` policy: capability=code, complexity=M, prefer=[local, cheap, premium]
    const r = resolveModelForStage('build', { env: { ANVIL_HOME: home } });
    expect(r.primary).toBe('qwen2.5-coder:7b');
    expect(r.fallbacks.map((f) => f.model)).toEqual(['claude-haiku-4-5-20251001']);
  });

  it('throws ModelResolutionError when models.yaml is empty', () => {
    const home = writeModels('models: []');
    expect(() =>
      resolveModelForStage('build', { env: { ANVIL_HOME: home } }),
    ).toThrow(ModelResolutionError);
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
    // Replace yaml underneath; without refresh the cache should keep the old result.
    writeFileSync(join(home, 'models.yaml'), 'models: []');
    const r2 = resolveModelForStage('build', { env: { ANVIL_HOME: home } });
    expect(r2.primary).toBe(r1.primary);
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
    expect(r1.primary).toBe('first');
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
    expect(r2.primary).toBe('second');
  });
});
