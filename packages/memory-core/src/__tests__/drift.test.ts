/**
 * Phase 6 — code-fact drift detection tests.
 *
 * Covers §6.5 acceptance items reachable in this phase:
 *   - drift detector returns fresh / drifted / missing correctly
 *   - verifyCodeBindings counts each bucket and applies the configured policy
 *   - downweight scales decay.strength; invalidate marks rows invalid
 *   - staleAfterDays skips recently-verified memories
 *
 * (Auto-learner population, retrieval-time auto-check, sleeptime cadence,
 * and the cli `verify-code-bindings` surface are deferred to later phases —
 * see ADR §8 Phase 6 deviation note.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ulid } from 'ulid';
import { computeStructuralHash } from '@anvil/knowledge-core';

import {
  HybridMemoryStore,
  checkCodeBindingDrift,
  detectLanguageFromPath,
  verifyCodeBindings,
} from '../index.js';
import type { CodeFactBinding, Memory, MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-drift-'));
}

function bindingFor(filePath: string, source: string, lang: string): CodeFactBinding {
  return {
    filePath,
    structuralHash: computeStructuralHash(source, lang).hash,
    lastSeenCommitSha: 'deadbeef',
    lastVerifiedAt: '2026-04-01T00:00:00.000Z',
  };
}

function fakeMemory(opts: {
  namespace?: MemoryNamespace;
  content: string;
  codeBinding?: CodeFactBinding;
  strength?: number;
}): Memory {
  const now = new Date().toISOString();
  return {
    id: ulid(),
    namespace: opts.namespace ?? { scope: 'project', projectId: 'demo' },
    kind: 'semantic',
    subtype: 'fix-pattern',
    content: opts.content,
    tags: [],
    confidence: 60,
    ttlDays: 30,
    expiresAt: new Date(Date.now() + 86_400_000 * 30).toISOString(),
    bitemporal: { validAt: now },
    decay: { lastAccessed: now, strength: opts.strength ?? 80, rehearseCount: 0 },
    provenance: { createdBy: 'auto-learner', createdAt: now },
    codeBinding: opts.codeBinding,
  };
}

// ── language detection ───────────────────────────────────────────────────

describe('detectLanguageFromPath', () => {
  it('maps common extensions to tree-sitter labels', () => {
    assert.equal(detectLanguageFromPath('src/auth.ts'), 'typescript');
    assert.equal(detectLanguageFromPath('foo/bar.tsx'), 'typescript');
    assert.equal(detectLanguageFromPath('main.go'), 'go');
    assert.equal(detectLanguageFromPath('script.py'), 'python');
    assert.equal(detectLanguageFromPath('lib.rs'), 'rust');
    assert.equal(detectLanguageFromPath('something.unknown-ext'), 'unknown');
  });
});

// ── drift detector ───────────────────────────────────────────────────────

describe('checkCodeBindingDrift', () => {
  it('returns fresh when content is structurally identical', () => {
    const dir = tempDir();
    try {
      const file = 'auth.ts';
      const source = 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n';
      writeFileSync(join(dir, file), source);
      const binding = bindingFor(file, source, 'typescript');

      const result = checkCodeBindingDrift(binding, { workspaceRoot: dir });
      assert.equal(result.status, 'fresh');
      assert.equal(result.currentHash, binding.structuralHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns drifted when the file has structurally diverged', () => {
    const dir = tempDir();
    try {
      const file = 'auth.ts';
      const original = 'export function greet(name: string) {\n  return `hi ${name}`;\n}\n';
      const drifted =
        'export function greet(name: string) {\n  // changed body\n  return `hello, ${name}!`;\n}\n';
      writeFileSync(join(dir, file), original);
      const binding = bindingFor(file, original, 'typescript');
      writeFileSync(join(dir, file), drifted);

      const result = checkCodeBindingDrift(binding, { workspaceRoot: dir });
      assert.equal(result.status, 'drifted');
      assert.notEqual(result.currentHash, binding.structuralHash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns missing when the file no longer exists', () => {
    const dir = tempDir();
    try {
      const binding: CodeFactBinding = {
        filePath: 'gone.ts',
        structuralHash: 'abc',
        lastSeenCommitSha: 'cafef00d',
        lastVerifiedAt: '2026-04-01T00:00:00.000Z',
      };
      const result = checkCodeBindingDrift(binding, { workspaceRoot: dir });
      assert.equal(result.status, 'missing');
      assert.equal(result.currentHash, undefined);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('treats whitespace-only edits as still fresh', () => {
    const dir = tempDir();
    try {
      const file = 'fmt.ts';
      const original = 'export const X = 1;\n';
      const reformatted = 'export const X   =   1;\n';
      writeFileSync(join(dir, file), original);
      const binding = bindingFor(file, original, 'typescript');
      writeFileSync(join(dir, file), reformatted);

      const result = checkCodeBindingDrift(binding, { workspaceRoot: dir });
      // The structural hasher canonicalizes whitespace, so this should be fresh.
      assert.equal(result.status, 'fresh');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── verifyCodeBindings ───────────────────────────────────────────────────

describe('verifyCodeBindings', () => {
  it('counts fresh / drifted / missing / noBinding correctly', () => {
    const dir = tempDir();
    try {
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
      });

      // 1) fresh
      const freshSource = 'export const F = 1;\n';
      writeFileSync(join(dir, 'fresh.ts'), freshSource);
      store.add(
        fakeMemory({
          namespace: ns,
          content: 'fresh fact',
          codeBinding: bindingFor('fresh.ts', freshSource, 'typescript'),
        }),
      );

      // 2) drifted
      const driftSource = 'export const D = 1;\n';
      writeFileSync(join(dir, 'drift.ts'), driftSource);
      const driftBinding = bindingFor('drift.ts', driftSource, 'typescript');
      writeFileSync(join(dir, 'drift.ts'), 'export const D = 2; // changed!\n');
      store.add(
        fakeMemory({
          namespace: ns,
          content: 'drifted fact',
          codeBinding: driftBinding,
          strength: 80,
        }),
      );

      // 3) missing — file deleted before verify
      const missingSource = 'export const M = 1;\n';
      writeFileSync(join(dir, 'missing.ts'), missingSource);
      const missingBinding = bindingFor('missing.ts', missingSource, 'typescript');
      unlinkSync(join(dir, 'missing.ts'));
      store.add(
        fakeMemory({
          namespace: ns,
          content: 'missing fact',
          codeBinding: missingBinding,
        }),
      );

      // 4) no binding
      store.add(fakeMemory({ namespace: ns, content: 'plain fact' }));

      const result = verifyCodeBindings(store, ns, {
        workspaceRoot: dir,
        driftPolicy: 'downweight',
        missingPolicy: 'invalidate',
      });

      assert.equal(result.fresh, 1);
      assert.equal(result.drifted, 1);
      assert.equal(result.missing, 1);
      assert.equal(result.noBinding, 1);
      assert.equal(result.touchedIds.length, 2);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("downweight policy halves decay.strength on drifted memories", () => {
    const dir = tempDir();
    try {
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
      });

      const original = 'export const X = 1;\n';
      writeFileSync(join(dir, 'x.ts'), original);
      const binding = bindingFor('x.ts', original, 'typescript');
      writeFileSync(join(dir, 'x.ts'), 'export const X = 2; // changed\n');

      const m = fakeMemory({
        namespace: ns,
        content: 'will be downweighted',
        codeBinding: binding,
        strength: 80,
      });
      store.add(m);

      const result = verifyCodeBindings(store, ns, {
        workspaceRoot: dir,
        driftPolicy: 'downweight',
        downweightFactor: 0.5,
      });
      assert.equal(result.drifted, 1);

      const after = store.findById(m.id)!;
      assert.equal(after.decay.strength, 40);
      // Memory still visible (not invalidated)
      assert.equal(after.bitemporal.invalidAt, undefined);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("invalidate policy soft-deletes drifted memories with a code-drift reason", () => {
    const dir = tempDir();
    try {
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
      });

      const original = 'export const Y = 1;\n';
      writeFileSync(join(dir, 'y.ts'), original);
      const binding = bindingFor('y.ts', original, 'typescript');
      writeFileSync(join(dir, 'y.ts'), 'export const Y = "two"; // changed!\n');

      const m = fakeMemory({
        namespace: ns,
        content: 'will be invalidated',
        codeBinding: binding,
      });
      store.add(m);

      const result = verifyCodeBindings(store, ns, {
        workspaceRoot: dir,
        driftPolicy: 'invalidate',
        runId: 'run-42',
      });
      assert.equal(result.drifted, 1);

      const after = store.findById(m.id)!;
      assert.ok(after.bitemporal.invalidAt);
      assert.equal(after.provenance.invalidatedBy?.reason, 'code-drift:y.ts');
      assert.equal(after.provenance.invalidatedBy?.runId, 'run-42');
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('staleAfterDays skips memories whose lastVerifiedAt is fresh', () => {
    const dir = tempDir();
    try {
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const store = HybridMemoryStore.open({
        jsonlPath: join(dir, 'memory.jsonl'),
        sqlitePath: join(dir, 'memory.sqlite'),
        skipAutoRebuild: true,
      });

      const source = 'export const Z = 1;\n';
      writeFileSync(join(dir, 'z.ts'), source);
      // Binding was verified just now — ought to skip on a 7-day cutoff.
      const binding: CodeFactBinding = {
        ...bindingFor('z.ts', source, 'typescript'),
        lastVerifiedAt: '2026-04-29T00:00:00.000Z',
      };
      const m = fakeMemory({ namespace: ns, content: 'recent', codeBinding: binding });
      store.add(m);

      const result = verifyCodeBindings(store, ns, {
        workspaceRoot: dir,
        staleAfterDays: 7,
        now: '2026-04-30T00:00:00.000Z',
      });
      assert.equal(result.skippedFresh, 1);
      assert.equal(result.fresh, 0);
      assert.equal(result.drifted, 0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
