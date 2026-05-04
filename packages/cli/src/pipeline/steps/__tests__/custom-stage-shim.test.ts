// Phase 6 — custom-stage shim tests.
//
// Coverage:
//   - factory.yaml entry with insertAfter: <step-id> registers in the
//     correct slot
//   - factory.yaml entry with insertBefore: <step-id> registers in the
//     correct slot
//   - legacy `after: <step-name>` still works (backwards-compat)
//   - entry with neither field appends to the end
//   - missing prompt file falls through to a sensible default

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryStepRegistry } from '@anvil/core-pipeline';
import {
  registerCustomStages,
  type CustomStageConfigV2,
} from '../custom-stage-shim.js';

function setupTmp(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-shim-'));
  return {
    dir,
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* swallow */
      }
    },
  };
}

function writePrompt(dir: string, name: string, body: string): void {
  const stagesDir = join(dir, '.anvil', 'stages');
  mkdirSync(stagesDir, { recursive: true });
  writeFileSync(join(stagesDir, `${name}.md`), body, 'utf8');
}

function makeRegistry(): InMemoryStepRegistry {
  const r = new InMemoryStepRegistry();
  r.register({ id: 'clarify', run: async () => undefined });
  r.register({ id: 'requirements', run: async () => undefined });
  r.register({ id: 'build', run: async () => undefined });
  r.register({ id: 'validate', run: async () => undefined });
  r.register({ id: 'ship', run: async () => undefined });
  return r;
}

describe('registerCustomStages (Phase 6)', () => {
  it('respects insertAfter: <step-id>', () => {
    const { dir, cleanup } = setupTmp();
    try {
      writePrompt(dir, 'security-scan', '# security scan');
      const cfg: CustomStageConfigV2 = {
        'security-scan': { persona: 'tester', insertAfter: 'build' },
      };
      const registry = makeRegistry();
      const records = registerCustomStages(registry, cfg, dir);
      expect(records).toEqual([
        { stepId: 'security-scan', position: 'insertAfter', reference: 'build' },
      ]);
      expect(registry.steps().map((s) => s.id)).toEqual([
        'clarify',
        'requirements',
        'build',
        'security-scan',
        'validate',
        'ship',
      ]);
    } finally {
      cleanup();
    }
  });

  it('respects insertBefore: <step-id>', () => {
    const { dir, cleanup } = setupTmp();
    try {
      writePrompt(dir, 'pre-flight', '# pre-flight');
      const cfg: CustomStageConfigV2 = {
        'pre-flight': { persona: 'tester', insertBefore: 'validate' },
      };
      const registry = makeRegistry();
      const records = registerCustomStages(registry, cfg, dir);
      expect(records).toEqual([
        { stepId: 'pre-flight', position: 'insertBefore', reference: 'validate' },
      ]);
      expect(registry.steps().map((s) => s.id)).toEqual([
        'clarify',
        'requirements',
        'build',
        'pre-flight',
        'validate',
        'ship',
      ]);
    } finally {
      cleanup();
    }
  });

  it('legacy "after" still works for backwards compatibility', () => {
    const { dir, cleanup } = setupTmp();
    try {
      writePrompt(dir, 'lint-extra', '# lint-extra');
      const cfg: CustomStageConfigV2 = {
        'lint-extra': { persona: 'tester', after: 'requirements' },
      };
      const registry = makeRegistry();
      const records = registerCustomStages(registry, cfg, dir);
      expect(records).toEqual([
        { stepId: 'lint-extra', position: 'insertAfter', reference: 'requirements' },
      ]);
      expect(registry.steps().map((s) => s.id)).toEqual([
        'clarify',
        'requirements',
        'lint-extra',
        'build',
        'validate',
        'ship',
      ]);
    } finally {
      cleanup();
    }
  });

  it('appends when no positional fields and unknown reference are supplied', () => {
    const { dir, cleanup } = setupTmp();
    try {
      writePrompt(dir, 'tail-end', '# tail-end');
      const cfg: CustomStageConfigV2 = {
        'tail-end': { persona: 'tester', after: 'does-not-exist' },
      };
      const registry = makeRegistry();
      const records = registerCustomStages(registry, cfg, dir);
      expect(records).toEqual([{ stepId: 'tail-end', position: 'append' }]);
      expect(registry.steps().map((s) => s.id)).toEqual([
        'clarify',
        'requirements',
        'build',
        'validate',
        'ship',
        'tail-end',
      ]);
    } finally {
      cleanup();
    }
  });

  it('skips entries whose prompt file is missing (mirrors loadCustomStages)', () => {
    const { dir, cleanup } = setupTmp();
    try {
      const cfg: CustomStageConfigV2 = {
        'missing-prompt': { persona: 'tester', insertAfter: 'build' },
      };
      const registry = makeRegistry();
      const records = registerCustomStages(registry, cfg, dir);
      expect(records).toEqual([]);
      expect(registry.steps().map((s) => s.id)).toEqual([
        'clarify',
        'requirements',
        'build',
        'validate',
        'ship',
      ]);
    } finally {
      cleanup();
    }
  });
});
