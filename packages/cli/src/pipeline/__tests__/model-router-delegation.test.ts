// Phase 8 — verify getModelForStage delegates to the new registry-driven
// resolver when ~/.anvil/models.yaml exists, and falls back to the legacy
// weight-class path when it doesn't.

import { getModelForStage } from '../model-router.js';
import { _resetStageRoutingCache } from '@anvil/core-pipeline';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('getModelForStage — delegation to registry resolver', () => {
  let tmp: string;
  let originalAnvilHome: string | undefined;

  beforeAll(() => {
    tmp = mkdtempSync(join(tmpdir(), 'anvil-mr-deleg-'));
  });
  afterAll(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    _resetStageRoutingCache();
    originalAnvilHome = process.env.ANVIL_HOME;
  });
  afterEach(() => {
    if (originalAnvilHome === undefined) delete process.env.ANVIL_HOME;
    else process.env.ANVIL_HOME = originalAnvilHome;
  });

  it('falls back to legacy weight-class path when no models.yaml exists', () => {
    process.env.ANVIL_HOME = join(tmp, 'no-config');
    // Bundled stage-policy.yaml exists; registry is empty → resolver throws
    // ModelResolutionError → delegation falls back to legacy path.
    const m = getModelForStage('build', 'balanced');
    // Legacy default for `balanced` weight class.
    expect(m).toBe('claude-sonnet-4-6');
  });

  it('falls back to legacy path for stages outside stage-policy.yaml', () => {
    const home = join(tmp, 'with-models');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'models.yaml'),
      [
        'models:',
        '  - id: claude-sonnet-4-6',
        '    provider: claude',
        '    tier: cheap',
        '    capabilities: [code, reasoning]',
        '    complexity_max: L',
        '    vram_gb: 0',
        '    exclusive_slot: false',
      ].join('\n'),
    );
    process.env.ANVIL_HOME = home;
    // 'random-stage' isn't in stage-policy.yaml → UnknownStageError →
    // legacy path. Unknown-stage weight defaults to 'balanced' per
    // STAGE_WEIGHTS lookup, regardless of the requested tier.
    const m = getModelForStage('random-stage', 'fast');
    expect(m).toBe('claude-sonnet-4-6');
  });

  it('uses the registry resolver when models.yaml + stage-policy.yaml both match', () => {
    const home = join(tmp, 'matched');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'models.yaml'),
      [
        'models:',
        '  - id: qwen2.5-coder:7b',
        '    provider: ollama',
        '    tier: local',
        '    capabilities: [code]',
        '    complexity_max: M',
        '    vram_gb: 5',
        '    exclusive_slot: true',
      ].join('\n'),
    );
    process.env.ANVIL_HOME = home;
    // build policy → capability=code, complexity=M, prefer=[local, cheap, premium]
    const m = getModelForStage('build', 'thorough');
    expect(m).toBe('qwen2.5-coder:7b');
  });

  it('preserves operator-intent override (configModels) above all delegation', () => {
    const home = join(tmp, 'matched-2');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'models.yaml'),
      [
        'models:',
        '  - id: qwen2.5-coder:7b',
        '    provider: ollama',
        '    tier: local',
        '    capabilities: [code]',
        '    complexity_max: M',
        '    vram_gb: 5',
        '    exclusive_slot: true',
      ].join('\n'),
    );
    process.env.ANVIL_HOME = home;
    const m = getModelForStage('build', 'balanced', { build: 'gpt-4o' });
    expect(m).toBe('gpt-4o');
  });
});
