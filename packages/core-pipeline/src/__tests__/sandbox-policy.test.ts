/**
 * Phase S0 — protocol scaffolding tests.
 *
 * Covers `STAGE_SANDBOX_POLICY`, `sandboxPolicyForStage`,
 * `mergeStageSandboxPolicy`, and the `SandboxDeterminismViolationError`
 * type. No runtime under test yet — these guard the contract surface
 * so the rest of the S0–S13 plan has stable types to lean on.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGE_SANDBOX_POLICY,
  PACKAGE_MANAGER_ALLOW_LIST,
  sandboxPolicyForStage,
  stageIsSandboxed,
  mergeStageSandboxPolicy,
} from '../routing/sandbox-policy.js';
import { SandboxDeterminismViolationError } from '../sandbox/types.js';

describe('STAGE_SANDBOX_POLICY — Phase S0', () => {
  it('lists every implementation + read-only stage with a valid mode', () => {
    const required = [
      'clarify', 'requirements', 'repo-requirements', 'specs', 'tasks', 'plan',
      'build', 'test', 'validate', 'ship',
      'fix', 'fix-loop', 'review', 'research', 'reflection',
    ];
    for (const stage of required) {
      const entry = STAGE_SANDBOX_POLICY[stage];
      assert.ok(entry, `missing entry for ${stage}`);
      assert.ok(['none', 'container', 'microVM'].includes(entry.mode));
      assert.ok(['none', 'overlay', 'bind'].includes(entry.fsMode));
    }
  });

  it('Phase S12 keeps read-only stages at mode="none" but flips execute stages to "container"', () => {
    // S12 flipped build/test/validate/ship/fix/fix-loop to "container";
    // every other stage stays "none" because they don't exec.
    const containerStages = new Set(['build', 'test', 'validate', 'ship', 'fix', 'fix-loop']);
    for (const [stage, entry] of Object.entries(STAGE_SANDBOX_POLICY)) {
      const expected = containerStages.has(stage) ? 'container' : 'none';
      assert.equal(entry.mode, expected, `stage ${stage} should be mode=${expected}`);
    }
  });

  it('package-manager allow-list covers every supported toolchain', () => {
    const required = [
      'registry.npmjs.org', 'pypi.org', 'crates.io',
      'proxy.golang.org', 'github.com', 'localhost', '127.0.0.1',
    ];
    for (const host of required) {
      assert.ok(PACKAGE_MANAGER_ALLOW_LIST.includes(host), `missing host ${host}`);
    }
  });

  it('reflection stage gets explicit deny-network limits even at mode=none', () => {
    const entry = STAGE_SANDBOX_POLICY['reflection'];
    assert.equal(entry?.limits?.network?.default, 'deny');
    assert.equal(entry?.limits?.network?.allowLoopback, false);
  });

  it('ship stage allows only git hosts (no npm/pypi/cargo)', () => {
    const allow = STAGE_SANDBOX_POLICY['ship']?.limits?.network?.allowList ?? [];
    assert.ok(allow.includes('github.com'));
    assert.ok(!allow.some(h => h.includes('npmjs')));
    assert.ok(!allow.some(h => h.includes('pypi')));
  });
});

describe('sandboxPolicyForStage', () => {
  it('returns the table entry for a known stage', () => {
    const entry = sandboxPolicyForStage('build');
    assert.equal(entry.fsMode, 'overlay');
    assert.equal(entry.limits?.memoryMiB, 4096);
  });

  it('falls back to none/none for an unknown stage', () => {
    const entry = sandboxPolicyForStage('made-up-stage');
    assert.equal(entry.mode, 'none');
    assert.equal(entry.fsMode, 'none');
  });

  it('stageIsSandboxed reflects the mode', () => {
    assert.equal(stageIsSandboxed('clarify'), false);
    assert.equal(stageIsSandboxed('build'), true); // S12 — container
    assert.equal(stageIsSandboxed('validate'), true);
    assert.equal(stageIsSandboxed('made-up'), false);
  });
});

describe('mergeStageSandboxPolicy', () => {
  it('returns the base unchanged when overlay is undefined', () => {
    const base = sandboxPolicyForStage('build');
    const merged = mergeStageSandboxPolicy(base, undefined);
    assert.equal(merged, base);
  });

  it('overlay fields win over base', () => {
    const base = sandboxPolicyForStage('build');
    const merged = mergeStageSandboxPolicy(base, {
      mode: 'container',
      fsMode: 'bind',
    });
    assert.equal(merged.mode, 'container');
    assert.equal(merged.fsMode, 'bind');
    // Limits inherit from base.
    assert.equal(merged.limits?.memoryMiB, 4096);
  });

  it('limits deep-merge per-field', () => {
    const base = sandboxPolicyForStage('build');
    const merged = mergeStageSandboxPolicy(base, {
      mode: 'container',
      fsMode: 'overlay',
      limits: { memoryMiB: 8192 },
    });
    assert.equal(merged.limits?.memoryMiB, 8192);
    assert.equal(merged.limits?.cpus, 2); // inherited from base
    assert.equal(merged.limits?.timeoutSeconds, 1800);
  });

  it('network policy deep-merges allowList from base + overlay defaults', () => {
    const base = sandboxPolicyForStage('build');
    const merged = mergeStageSandboxPolicy(base, {
      mode: 'container',
      fsMode: 'overlay',
      limits: {
        network: {
          default: 'deny',
          allowList: ['*.docs.example.com'],
        },
      },
    });
    // Overlay's allowList replaces the base's (per the explicit
    // overlay > base ordering described in §H.2).
    assert.deepEqual(merged.limits?.network?.allowList, ['*.docs.example.com']);
    assert.equal(merged.limits?.network?.default, 'deny');
  });
});

describe('SandboxDeterminismViolationError', () => {
  it('captures both hashes for actionable error messages', () => {
    const err = new SandboxDeterminismViolationError(
      'state hash mismatch on replay',
      'sha256:before',
      'sha256:after',
    );
    assert.equal(err.name, 'SandboxDeterminismViolationError');
    assert.equal(err.recordedHash, 'sha256:before');
    assert.equal(err.currentHash, 'sha256:after');
    assert.match(err.message, /state hash mismatch/);
  });
});
