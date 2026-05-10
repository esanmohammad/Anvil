/**
 * Phase S11 — `anvil sandbox-runtime` command tests.
 *
 * Verifies the Command surface (subcommand names, options, descriptions
 * — i.e. the public CLI contract). Doesn't actually spawn docker —
 * those paths are tested in dashboard/__tests__/docker-runner.test.ts
 * via stubbed spawn.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sandboxRuntimeCommand } from '../sandbox-runtime.js';

describe('anvil sandbox-runtime', () => {
  it('registers the expected subcommands', () => {
    const names = sandboxRuntimeCommand.commands.map((c) => c.name()).sort();
    assert.deepEqual(names, ['prune', 'shell', 'stats']);
  });

  it('shell accepts an optional <stage> arg + --image / --workdir options', () => {
    const shell = sandboxRuntimeCommand.commands.find((c) => c.name() === 'shell');
    assert.ok(shell);
    const optionNames = shell!.options.map((o) => o.long);
    assert.ok(optionNames.includes('--image'));
    assert.ok(optionNames.includes('--workdir'));
  });

  it('prune exposes a --force flag', () => {
    const prune = sandboxRuntimeCommand.commands.find((c) => c.name() === 'prune');
    assert.ok(prune);
    const optionNames = prune!.options.map((o) => o.long);
    assert.ok(optionNames.includes('--force'));
  });

  it('stats has a description', () => {
    const stats = sandboxRuntimeCommand.commands.find((c) => c.name() === 'stats');
    assert.ok(stats);
    assert.match(stats!.description(), /resource usage/);
  });
});
