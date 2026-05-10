/**
 * Phase 4.5 — integration test for the stage → permission → executor chain.
 *
 * Stage policy lives in core-pipeline; the executor lives in agent-core.
 * core-pipeline depends on agent-core, so this test pulls both pieces
 * and proves they line up: schemas advertised, calls rejected for the
 * right stages, accepted for the right stages.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuiltinToolExecutor } from '@esankhan3/anvil-agent-core';
import type { ToolCall } from '@esankhan3/anvil-agent-core';
import { allowedToolsForStage, permissionClassesForStage } from '../routing/stage-permissions.js';

function makeCall(name: string, args: Record<string, unknown> = {}): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args };
}
function ctx(workingDir: string) {
  return { workingDir, abortSignal: new AbortController().signal };
}

describe('stage → permissions → executor — full chain', () => {
  it('clarify stage exposes only read tools to the model (built-in FS surface)', () => {
    // clarify resolves to the read_file/grep/glob/list FS surface plus the
    // network web tools (web_search/web_fetch). BuiltinToolExecutor only
    // advertises the FS tools it knows about; the web-tool surface is
    // advertised by a separate executor (Phase H1+). Assert the FS subset
    // here.
    const allowed = allowedToolsForStage('clarify');
    const exec = new BuiltinToolExecutor({ allowedTools: allowed });
    const names = exec.listSchemas().map((s) => s.name).sort();
    assert.deepEqual(names, ['glob', 'grep', 'list', 'read_file']);
  });

  it('build stage exposes the full read+write+exec set', () => {
    const allowed = allowedToolsForStage('build');
    const exec = new BuiltinToolExecutor({ allowedTools: allowed });
    const names = exec.listSchemas().map((s) => s.name).sort();
    assert.deepEqual(names, ['bash', 'edit', 'glob', 'grep', 'list', 'read_file', 'write_file']);
  });

  it('research stage refuses write attempts at execute() time', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-stage-int-')));
    try {
      const allowed = allowedToolsForStage('research');
      const exec = new BuiltinToolExecutor({ allowedTools: allowed });
      const r = await exec.execute(makeCall('write_file', { path: 'x.txt', content: 'no' }), ctx(root));
      assert.equal(r.isError, true);
      assert.match(r.content, /not permitted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('build stage permits a real bash invocation under the executor', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-stage-int-')));
    try {
      const allowed = allowedToolsForStage('build');
      const exec = new BuiltinToolExecutor({ allowedTools: allowed });
      const r = await exec.execute(makeCall('bash', { command: 'printf ok' }), ctx(root));
      assert.equal(r.isError, false);
      assert.match(r.content, /ok/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('unknown stage falls back to read-only at the executor', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-stage-int-')));
    try {
      const allowed = allowedToolsForStage('imagined-stage');
      const exec = new BuiltinToolExecutor({ allowedTools: allowed });
      const r = await exec.execute(makeCall('bash', { command: 'true' }), ctx(root));
      assert.equal(r.isError, true);
      assert.match(r.content, /not permitted/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('permissionClassesForStage maps to a subset of advertised schemas', () => {
    // allowedToolsForStage now layers the web-tool surface on top of FS
    // tools (Phase H0). BuiltinToolExecutor still advertises only its own
    // 7 built-ins; the assertion is that EVERY advertised name is one of
    // the requested tools (no leakage), and at least one classes entry
    // exists.
    const stages = ['clarify', 'requirements', 'build', 'validate', 'review', 'research'];
    const FS_TOOLS = new Set(['read_file', 'write_file', 'edit', 'bash', 'grep', 'glob', 'list']);
    for (const stage of stages) {
      const tools = allowedToolsForStage(stage);
      const classes = permissionClassesForStage(stage);
      const exec = new BuiltinToolExecutor({ allowedTools: tools });
      const advertised = exec.listSchemas().map((s) => s.name).sort();
      const expectedFs = tools.filter((t) => FS_TOOLS.has(t)).sort();
      assert.deepEqual(advertised, expectedFs, `${stage}: schemas mismatch`);
      assert.ok(classes.length > 0, `${stage}: should map to at least one class`);
    }
  });
});
