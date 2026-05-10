/**
 * H6 — confirm gate + named context store.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfirmGate } from '../browser/confirm-gate.js';
import { ContextStore } from '../browser/contexts.js';

describe('ConfirmGate', () => {
  it('passes through when ANVIL_AUTOCONFIRM_BROWSE=1', async () => {
    const gate = new ConfirmGate({ env: { ANVIL_AUTOCONFIRM_BROWSE: '1' } });
    await gate.confirm({ tool: 'browser_evaluate', description: 'X' });
  });

  it('throws when no confirmer wired and not auto-confirming', async () => {
    const gate = new ConfirmGate({ env: {} });
    await assert.rejects(
      () => gate.confirm({ tool: 'browser_evaluate', description: 'X' }),
      /requires user confirmation/,
    );
  });

  it('forwards to the user-supplied confirmer', async () => {
    let asked = false;
    const gate = new ConfirmGate({
      ask: async () => { asked = true; return true; },
      env: {},
    });
    await gate.confirm({ tool: 'browser_evaluate', description: 'X' });
    assert.equal(asked, true);
  });

  it('throws when the user denies', async () => {
    const gate = new ConfirmGate({
      ask: async () => false,
      env: {},
    });
    await assert.rejects(
      () => gate.confirm({ tool: 'browser_evaluate', description: 'X' }),
      /denied by user/,
    );
  });
});

describe('ContextStore', () => {
  it('round-trips metadata + storage state', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-ctx-'));
    try {
      const store = new ContextStore({ root });
      store.save(
        { name: 'docs', projectSlug: 'p1', url: 'https://docs.example.com', createdAt: 't0', refreshedAt: 't0' },
        { cookies: [{ name: 'sid', value: 'x' }] },
      );
      const meta = store.read('p1', 'docs');
      assert.equal(meta?.url, 'https://docs.example.com');
      assert.deepEqual(store.list('p1').map((m) => m.name), ['docs']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('list() returns empty array for unknown project', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-ctx-'));
    try {
      const store = new ContextStore({ root });
      assert.deepEqual(store.list('nope'), []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('assertAllowed rejects unlisted contexts', () => {
    const store = new ContextStore({ root: '/tmp' });
    assert.throws(() => store.assertAllowed('foo', undefined), /allow-list/);
    assert.throws(() => store.assertAllowed('foo', []), /allow-list/);
    assert.throws(() => store.assertAllowed('foo', ['bar']), /not allowed/);
  });

  it('assertAllowed accepts listed contexts', () => {
    const store = new ContextStore({ root: '/tmp' });
    store.assertAllowed('foo', ['foo', 'bar']);
  });

  it('delete() removes the context', () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-ctx-'));
    try {
      const store = new ContextStore({ root });
      store.save({ name: 'x', projectSlug: 'p', url: 'https://x', createdAt: 't', refreshedAt: 't' }, {});
      store.delete('p', 'x');
      assert.equal(store.read('p', 'x'), undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
