/**
 * Phase S follow-up #1 — boot registration tests.
 *
 * Verifies the env-var escape hatch + the registration shape. Real
 * runtime probes (`isAvailable()`) require Docker on PATH; we don't
 * gate the tests on that — the helper handles missing runtimes by
 * silently skipping.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  __resetSandboxRegistryForTests,
  isSandboxRunnerRegistered,
} from '@esankhan3/anvil-core-pipeline';

import { registerSandboxRunnersAtBoot } from '../sandbox/register-at-boot.js';

describe('registerSandboxRunnersAtBoot', () => {
  it('skips registration when ANVIL_SANDBOX_FORCE_NONE=1', async () => {
    __resetSandboxRegistryForTests();
    const original = process.env.ANVIL_SANDBOX_FORCE_NONE;
    process.env.ANVIL_SANDBOX_FORCE_NONE = '1';
    try {
      const r = await registerSandboxRunnersAtBoot();
      assert.deepEqual(r.registered, []);
      assert.match(r.skippedReason ?? '', /ANVIL_SANDBOX_FORCE_NONE/);
      assert.equal(isSandboxRunnerRegistered('docker'), false);
    } finally {
      if (original === undefined) delete process.env.ANVIL_SANDBOX_FORCE_NONE;
      else process.env.ANVIL_SANDBOX_FORCE_NONE = original;
    }
  });

  it('returns a registration list (zero or more) without throwing', async () => {
    __resetSandboxRegistryForTests();
    delete process.env.ANVIL_SANDBOX_FORCE_NONE;
    const r = await registerSandboxRunnersAtBoot();
    assert.ok(Array.isArray(r.registered));
    // Whatever the host has, every registered name must be valid.
    for (const name of r.registered) {
      assert.ok(['docker', 'firecracker', 'gvisor'].includes(name));
      assert.equal(isSandboxRunnerRegistered(name), true);
    }
  });
});
