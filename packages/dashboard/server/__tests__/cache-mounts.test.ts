/**
 * Phase S8 — package-manager cache mount tests.
 *
 * Pure module: no Docker required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCacheMounts,
  dockerCacheMountArgs,
  CACHE_DEFINITIONS,
} from '../sandbox/cache-mounts.js';

describe('buildCacheMounts', () => {
  it('lists every defined toolchain by default (read-only)', () => {
    const mounts = buildCacheMounts({ homeDir: '/home/u' });
    const tools = Object.keys(CACHE_DEFINITIONS);
    assert.equal(mounts.length, tools.length);
    for (const m of mounts) {
      assert.equal(m.mode, 'read-only');
      assert.ok(m.host.startsWith('/home/u/'));
      assert.ok(m.sandbox.startsWith('/home/anvil'));
    }
  });

  it('honors per-tool overrides', () => {
    const mounts = buildCacheMounts({
      homeDir: '/home/u',
      perTool: { npm: 'read-write', cargo: 'off' },
    });
    const npm = mounts.find((m) => m.host.endsWith('.npm'));
    const cargo = mounts.find((m) => m.host.includes('.cargo'));
    assert.equal(npm?.mode, 'read-write');
    assert.equal(cargo, undefined, 'cargo opted off');
  });

  it('honors a global default override', () => {
    const mounts = buildCacheMounts({ homeDir: '/home/u', defaultMode: 'off' });
    assert.equal(mounts.length, 0);
  });
});

describe('dockerCacheMountArgs', () => {
  it('emits --mount type=bind,...,readonly for read-only entries', () => {
    const args = dockerCacheMountArgs([
      { host: '/home/u/.npm', sandbox: '/home/anvil/.npm', mode: 'read-only' },
    ]);
    assert.deepEqual(args, [
      '--mount',
      'type=bind,src=/home/u/.npm,dst=/home/anvil/.npm,readonly',
    ]);
  });

  it('omits readonly for read-write entries', () => {
    const args = dockerCacheMountArgs([
      { host: '/home/u/.npm', sandbox: '/home/anvil/.npm', mode: 'read-write' },
    ]);
    assert.deepEqual(args, [
      '--mount',
      'type=bind,src=/home/u/.npm,dst=/home/anvil/.npm',
    ]);
  });

  it('emits one pair per mount, in order', () => {
    const args = dockerCacheMountArgs([
      { host: '/h/.npm', sandbox: '/s/.npm', mode: 'read-only' },
      { host: '/h/.cargo', sandbox: '/s/.cargo', mode: 'read-write' },
    ]);
    assert.equal(args.length, 4);
    assert.equal(args[0], '--mount');
    assert.equal(args[2], '--mount');
  });
});
