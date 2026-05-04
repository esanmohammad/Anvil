// Phase 10 — bootstrap models.yaml + pull missing ollama models.
//
// All tests inject deps; no real fs/spawn touched.

import { bootstrapModels, BootstrapError } from '../bootstrap-models.js';

function makeFakeFs() {
  const files = new Map<string, string>();
  return {
    files,
    deps: {
      readFile: (p: string) => {
        const v = files.get(p);
        if (v === undefined) throw new Error(`fake fs: missing ${p}`);
        return v;
      },
      exists: (p: string) => files.has(p) || files.has(p + '/') || [...files.keys()].some((k) => k === p),
      mkdirRecursive: (p: string) => { files.set(p + '/', ''); },
      copyFile: (src: string, dest: string) => {
        const v = files.get(src);
        if (v === undefined) throw new Error(`fake fs: missing src ${src}`);
        files.set(dest, v);
      },
    },
  };
}

const VALID_REGISTRY_YAML = [
  'models:',
  '  - id: qwen2.5-coder:7b',
  '    provider: ollama',
  '    tier: local',
  '    capabilities: [code, reasoning]',
  '    complexity_max: M',
  '    vram_gb: 5',
  '    exclusive_slot: true',
  '  - id: gemma3:4b',
  '    provider: ollama',
  '    tier: local',
  '    capabilities: [vision, code]',
  '    complexity_max: S',
  '    vram_gb: 3.5',
  '    exclusive_slot: true',
  '  - id: claude-sonnet-4-6',
  '    provider: claude',
  '    tier: premium',
  '    capabilities: [code, reasoning, vision]',
  '    complexity_max: L',
  '    vram_gb: 0',
  '    exclusive_slot: false',
].join('\n');

const ANVIL_HOME = '/fake/anvil';
const MODELS_PATH = '/fake/anvil/models.yaml';

describe('bootstrapModels — happy paths', () => {
  it('returns no-op when all ollama models are already installed', async () => {
    const { files, deps } = makeFakeFs();
    files.set(MODELS_PATH, VALID_REGISTRY_YAML);
    let pullCount = 0;

    const result = await bootstrapModels({
      ...deps,
      env: { ANVIL_HOME },
      listInstalledOllama: () => ['qwen2.5-coder:7b', 'gemma3:4b'],
      pullOllamaModel: async () => { pullCount += 1; },
      log: () => {},
    });

    expect(pullCount).toBe(0);
    expect(result.pulled).toEqual([]);
    expect(result.alreadyPresent).toEqual(['qwen2.5-coder:7b', 'gemma3:4b']);
    expect(result.failed).toEqual([]);
    expect(result.createdFromTemplate).toBe(false);
  });

  it('pulls every missing ollama model sequentially', async () => {
    const { files, deps } = makeFakeFs();
    files.set(MODELS_PATH, VALID_REGISTRY_YAML);

    const callOrder: string[] = [];
    const result = await bootstrapModels({
      ...deps,
      env: { ANVIL_HOME },
      listInstalledOllama: () => [],
      pullOllamaModel: async (id) => {
        callOrder.push(`start:${id}`);
        await new Promise((r) => setTimeout(r, 5));
        callOrder.push(`end:${id}`);
      },
      log: () => {},
    });

    expect(result.pulled).toEqual(['qwen2.5-coder:7b', 'gemma3:4b']);
    // Strict serialization — no overlapping starts.
    expect(callOrder).toEqual([
      'start:qwen2.5-coder:7b',
      'end:qwen2.5-coder:7b',
      'start:gemma3:4b',
      'end:gemma3:4b',
    ]);
  });

  it('skips already-installed models, pulls only the missing ones', async () => {
    const { files, deps } = makeFakeFs();
    files.set(MODELS_PATH, VALID_REGISTRY_YAML);

    const pulls: string[] = [];
    const result = await bootstrapModels({
      ...deps,
      env: { ANVIL_HOME },
      listInstalledOllama: () => ['qwen2.5-coder:7b'],
      pullOllamaModel: async (id) => { pulls.push(id); },
      log: () => {},
    });

    expect(pulls).toEqual(['gemma3:4b']);
    expect(result.alreadyPresent).toEqual(['qwen2.5-coder:7b']);
    expect(result.pulled).toEqual(['gemma3:4b']);
  });

  it('matches `<name>` in registry against `<name>:latest` in installed', async () => {
    const { files, deps } = makeFakeFs();
    files.set(
      MODELS_PATH,
      [
        'models:',
        '  - id: nomic-embed-text',
        '    provider: ollama',
        '    tier: local',
        '    capabilities: [embed]',
        '    complexity_max: S',
        '    vram_gb: 0.3',
        '    exclusive_slot: false',
      ].join('\n'),
    );

    const result = await bootstrapModels({
      ...deps,
      env: { ANVIL_HOME },
      listInstalledOllama: () => ['nomic-embed-text:latest'],
      pullOllamaModel: async () => {},
      log: () => {},
    });

    expect(result.alreadyPresent).toEqual(['nomic-embed-text']);
    expect(result.pulled).toEqual([]);
  });

  it('treats non-ollama providers as registry-only (no pulls)', async () => {
    const { files, deps } = makeFakeFs();
    files.set(
      MODELS_PATH,
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
    let listCalled = false;
    const result = await bootstrapModels({
      ...deps,
      env: { ANVIL_HOME },
      listInstalledOllama: () => { listCalled = true; return []; },
      pullOllamaModel: async () => {
        throw new Error('should not be called for claude');
      },
      log: () => {},
    });
    expect(listCalled).toBe(false);
    expect(result.pulled).toEqual([]);
  });
});

describe('bootstrapModels — file-creation', () => {
  it('writes models.yaml from the bundled template when missing', async () => {
    const { files, deps } = makeFakeFs();
    // resolveTemplatePath computes a module-relative path; we accept any
    // path ending in /templates/models-default.yaml so the test isn't
    // coupled to the build layout.
    const isTemplatePath = (p: string) => p.endsWith('/templates/models-default.yaml');

    const result = await bootstrapModels({
      ...deps,
      env: { ANVIL_HOME },
      exists: (p) => isTemplatePath(p) || deps.exists(p),
      copyFile: (src, dest) => {
        if (isTemplatePath(src)) {
          files.set(dest, VALID_REGISTRY_YAML);
          return;
        }
        deps.copyFile(src, dest);
      },
      listInstalledOllama: () => ['qwen2.5-coder:7b', 'gemma3:4b'],
      pullOllamaModel: async () => {},
      log: () => {},
    });

    expect(result.createdFromTemplate).toBe(true);
    expect(files.get(MODELS_PATH)).toBe(VALID_REGISTRY_YAML);
  });

  it('throws BootstrapError when no template can be found anywhere', async () => {
    const { deps } = makeFakeFs();
    await expect(
      bootstrapModels({
        ...deps,
        env: { ANVIL_HOME },
        // Force exists to return false for every path so resolveTemplatePath fails.
        exists: () => false,
        listInstalledOllama: () => [],
        pullOllamaModel: async () => {},
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(BootstrapError);
  });
});

describe('bootstrapModels — error paths', () => {
  it('throws BootstrapError when ollama list fails', async () => {
    const { files, deps } = makeFakeFs();
    files.set(MODELS_PATH, VALID_REGISTRY_YAML);

    await expect(
      bootstrapModels({
        ...deps,
        env: { ANVIL_HOME },
        listInstalledOllama: () => { throw new Error('command not found: ollama'); },
        pullOllamaModel: async () => {},
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(BootstrapError);
  });

  it('records pulls that fail without aborting the whole run', async () => {
    const { files, deps } = makeFakeFs();
    files.set(MODELS_PATH, VALID_REGISTRY_YAML);

    const result = await bootstrapModels({
      ...deps,
      env: { ANVIL_HOME },
      listInstalledOllama: () => [],
      pullOllamaModel: async (id) => {
        if (id === 'qwen2.5-coder:7b') throw new Error('disk full');
      },
      log: () => {},
    });

    expect(result.pulled).toEqual(['gemma3:4b']);
    expect(result.failed).toEqual([{ id: 'qwen2.5-coder:7b', error: 'disk full' }]);
  });

  it('throws BootstrapError on malformed yaml', async () => {
    const { files, deps } = makeFakeFs();
    files.set(MODELS_PATH, 'models:\n  - id: x\n  - invalid: [unclosed');

    await expect(
      bootstrapModels({
        ...deps,
        env: { ANVIL_HOME },
        listInstalledOllama: () => [],
        pullOllamaModel: async () => {},
        log: () => {},
      }),
    ).rejects.toBeInstanceOf(BootstrapError);
  });
});
