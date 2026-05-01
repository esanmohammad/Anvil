/**
 * Phase 2 — model-registry loader + validator.
 *
 * Covers parsing of valid yaml, missing-file behavior, and every rejection
 * path the validator owns. Filesystem tests use an isolated tmp dir.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadModelRegistry,
  parseModelRegistry,
  findModelsConfigPath,
  ModelRegistryParseError,
  ModelRegistryValidationError,
} from '../router/model-registry.js';

let root = '';

before(() => {
  root = mkdtempSync(join(tmpdir(), 'anvil-models-yaml-'));
});
after(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('parseModelRegistry — happy path', () => {
  it('parses a minimal valid registry', () => {
    const reg = parseModelRegistry({
      models: [
        {
          id: 'qwen2.5-coder:7b',
          provider: 'ollama',
          tier: 'local',
          capabilities: ['code', 'reasoning'],
          complexity_max: 'M',
          vram_gb: 5,
          exclusive_slot: true,
        },
      ],
    });
    assert.equal(reg.models.length, 1);
    assert.equal(reg.models[0].id, 'qwen2.5-coder:7b');
    assert.deepEqual(reg.models[0].capabilities, ['code', 'reasoning']);
  });

  it('accepts optional fields (context_tokens, consumed_by, endpoint)', () => {
    const reg = parseModelRegistry({
      models: [
        {
          id: 'bge-reranker',
          provider: 'ollama',
          tier: 'local',
          capabilities: ['rerank'],
          complexity_max: 'S',
          vram_gb: 0,
          exclusive_slot: false,
          context_tokens: 8192,
          consumed_by: 'knowledge-core',
          endpoint: 'http://localhost:11434',
        },
      ],
    });
    assert.equal(reg.models[0].context_tokens, 8192);
    assert.equal(reg.models[0].consumed_by, 'knowledge-core');
    assert.equal(reg.models[0].endpoint, 'http://localhost:11434');
  });

  it('returns empty registry for null/undefined/empty top level', () => {
    assert.deepEqual(parseModelRegistry(null), { models: [] });
    assert.deepEqual(parseModelRegistry(undefined), { models: [] });
    assert.deepEqual(parseModelRegistry({}), { models: [] });
  });
});

describe('parseModelRegistry — validation errors', () => {
  it('throws on duplicate id', () => {
    assert.throws(
      () =>
        parseModelRegistry({
          models: [
            {
              id: 'dup',
              provider: 'ollama',
              tier: 'local',
              capabilities: ['code'],
              complexity_max: 'S',
              vram_gb: 1,
              exclusive_slot: false,
            },
            {
              id: 'dup',
              provider: 'ollama',
              tier: 'local',
              capabilities: ['code'],
              complexity_max: 'S',
              vram_gb: 1,
              exclusive_slot: false,
            },
          ],
        }),
      ModelRegistryValidationError,
      'duplicate id should throw',
    );
  });

  it('throws on unknown capability', () => {
    assert.throws(
      () =>
        parseModelRegistry({
          models: [
            {
              id: 'x',
              provider: 'ollama',
              tier: 'local',
              capabilities: ['telepathy'],
              complexity_max: 'S',
              vram_gb: 1,
              exclusive_slot: false,
            },
          ],
        }),
      ModelRegistryValidationError,
    );
  });

  it('throws on unknown provider', () => {
    assert.throws(
      () =>
        parseModelRegistry({
          models: [
            {
              id: 'x',
              provider: 'rogue-cloud',
              tier: 'local',
              capabilities: ['code'],
              complexity_max: 'S',
              vram_gb: 1,
              exclusive_slot: false,
            },
          ],
        }),
      ModelRegistryValidationError,
    );
  });

  it('throws on unknown tier', () => {
    assert.throws(
      () =>
        parseModelRegistry({
          models: [
            {
              id: 'x',
              provider: 'ollama',
              tier: 'mid-range',
              capabilities: ['code'],
              complexity_max: 'S',
              vram_gb: 1,
              exclusive_slot: false,
            },
          ],
        }),
      ModelRegistryValidationError,
    );
  });

  it('throws on unknown complexity', () => {
    assert.throws(
      () =>
        parseModelRegistry({
          models: [
            {
              id: 'x',
              provider: 'ollama',
              tier: 'local',
              capabilities: ['code'],
              complexity_max: 'XL',
              vram_gb: 1,
              exclusive_slot: false,
            },
          ],
        }),
      ModelRegistryValidationError,
    );
  });

  it('throws when capabilities array is empty', () => {
    assert.throws(
      () =>
        parseModelRegistry({
          models: [
            {
              id: 'x',
              provider: 'ollama',
              tier: 'local',
              capabilities: [],
              complexity_max: 'S',
              vram_gb: 1,
              exclusive_slot: false,
            },
          ],
        }),
      ModelRegistryValidationError,
    );
  });

  it('throws on negative vram_gb', () => {
    assert.throws(
      () =>
        parseModelRegistry({
          models: [
            {
              id: 'x',
              provider: 'ollama',
              tier: 'local',
              capabilities: ['code'],
              complexity_max: 'S',
              vram_gb: -1,
              exclusive_slot: false,
            },
          ],
        }),
      ModelRegistryValidationError,
    );
  });

  it('throws when models is not an array', () => {
    assert.throws(
      () => parseModelRegistry({ models: 'not-an-array' }),
      ModelRegistryValidationError,
    );
  });
});

describe('loadModelRegistry — filesystem', () => {
  it('returns empty registry when no models.yaml exists', () => {
    const reg = loadModelRegistry({
      env: { ANVIL_HOME: join(root, 'home-empty') },
      homeDir: '/nope',
    });
    assert.deepEqual(reg.models, []);
  });

  it('loads from $ANVIL_HOME/models.yaml when present', () => {
    const home = join(root, 'home-loaded');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'models.yaml'),
      [
        'models:',
        '  - id: gemma3:4b',
        '    provider: ollama',
        '    tier: local',
        '    capabilities: [vision, code]',
        '    complexity_max: S',
        '    vram_gb: 3.5',
        '    exclusive_slot: true',
      ].join('\n'),
    );
    const reg = loadModelRegistry({ env: { ANVIL_HOME: home } });
    assert.equal(reg.models.length, 1);
    assert.equal(reg.models[0].id, 'gemma3:4b');
    assert.deepEqual(reg.models[0].capabilities, ['vision', 'code']);
  });

  it('respects ANVIL_MODELS_CONFIG override', () => {
    const explicit = join(root, 'explicit-models.yaml');
    writeFileSync(
      explicit,
      [
        'models:',
        '  - id: claude-opus-4-7',
        '    provider: claude',
        '    tier: premium',
        '    capabilities: [code, reasoning, vision]',
        '    complexity_max: L',
        '    vram_gb: 0',
        '    exclusive_slot: false',
      ].join('\n'),
    );
    const reg = loadModelRegistry({
      env: { ANVIL_MODELS_CONFIG: explicit, ANVIL_HOME: '/should-not-be-read' },
    });
    assert.equal(reg.models.length, 1);
    assert.equal(reg.models[0].provider, 'claude');
  });

  it('throws ModelRegistryParseError on malformed yaml', () => {
    const home = join(root, 'home-malformed');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'models.yaml'), 'models:\n  - id: x\n  - invalid: [unclosed');
    assert.throws(
      () => loadModelRegistry({ env: { ANVIL_HOME: home } }),
      ModelRegistryParseError,
    );
  });

  it('findModelsConfigPath returns undefined when nothing matches', () => {
    const path = findModelsConfigPath({
      env: { ANVIL_HOME: join(root, 'no-such-dir') },
      homeDir: '/nope',
    });
    assert.equal(path, undefined);
  });
});
