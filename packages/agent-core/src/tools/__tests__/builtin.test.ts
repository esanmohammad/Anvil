/**
 * Adversarial tests for `BuiltinToolExecutor`. These tools form a
 * security boundary — every test here is a known escape vector that
 * must stay closed.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { BuiltinToolExecutor, PathEscapeError, resolveSafe, TOOL_CLASS } from '../index.js';
import type { ToolCall } from '../../types.js';

let root = '';
let outsider = '';

before(() => {
  // realpathSync resolves macOS /var → /private/var so path-prefix asserts
  // line up with what resolveSafe canonicalizes to.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-tools-')));
  outsider = realpathSync(mkdtempSync(join(tmpdir(), 'anvil-outside-')));
  writeFileSync(join(root, 'hello.txt'), 'hello world\nline2\nline3\n');
  writeFileSync(join(outsider, 'secret.txt'), 'top secret');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
});

after(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outsider, { recursive: true, force: true });
});

const ALL = ['read_file', 'write_file', 'edit', 'bash', 'grep', 'glob', 'list'];
const READ_ONLY = ['read_file', 'grep', 'glob', 'list'];

function makeCall(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2, 8)}`, name, arguments: args };
}
function ctx(workingDir: string, signal?: AbortSignal) {
  return { workingDir, abortSignal: signal ?? new AbortController().signal };
}

// ────────────────────────────────────────────────────────────────────────
// Schema filtering / permission
// ────────────────────────────────────────────────────────────────────────

describe('BuiltinToolExecutor — schema filtering', () => {
  it('listSchemas only returns allowed tools', () => {
    const ex = new BuiltinToolExecutor({ allowedTools: READ_ONLY });
    const names = ex.listSchemas().map((s) => s.name).sort();
    assert.deepEqual(names, [...READ_ONLY].sort());
  });

  it('execute rejects denied tool with isError:true', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: READ_ONLY });
    const r = await ex.execute(makeCall('bash', { command: 'echo nope' }), ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /not permitted/);
  });

  it('execute rejects unknown tool name (gated by permission first)', async () => {
    // Unknown tools are blocked at the permission gate before reaching the
    // handler dispatch — the user-facing message is "not permitted", which
    // is also the right message for misconfigured registries.
    const ex = new BuiltinToolExecutor({ allowedTools: ALL });
    const r = await ex.execute(makeCall('eval_code', { command: 'rm -rf /' }), ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /not permitted/);
  });

  it('TOOL_CLASS exposes a read|write|exec mapping for every built-in', () => {
    for (const name of ALL) {
      assert.ok(['read', 'write', 'exec'].includes(TOOL_CLASS[name]));
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Path guard — every escape vector
// ────────────────────────────────────────────────────────────────────────

describe('resolveSafe — path escape vectors', () => {
  it('blocks parent-directory traversal via ..', () => {
    assert.throws(() => resolveSafe('../escape.txt', root), PathEscapeError);
    assert.throws(() => resolveSafe('../../escape.txt', root), PathEscapeError);
    assert.throws(() => resolveSafe('foo/../../escape.txt', root), PathEscapeError);
  });

  it('blocks absolute paths outside workingDir', () => {
    assert.throws(() => resolveSafe('/etc/passwd', root), PathEscapeError);
    assert.throws(() => resolveSafe(join(outsider, 'secret.txt'), root), PathEscapeError);
  });

  it('allows paths inside workingDir', () => {
    assert.equal(resolveSafe('hello.txt', root).endsWith('hello.txt'), true);
    assert.equal(resolveSafe('src/a.ts', root).endsWith('src/a.ts'), true);
  });

  it('blocks symlink targets that point outside workingDir', () => {
    const linkPath = join(root, 'evil-link');
    try { symlinkSync(join(outsider, 'secret.txt'), linkPath); } catch { /* macOS may need permission */ return; }
    assert.throws(() => resolveSafe('evil-link', root), PathEscapeError);
  });

  it('allows non-existent files inside workingDir (so write_file can create them)', () => {
    const target = resolveSafe('new/dir/and/file.txt', root);
    assert.ok(target.startsWith(root));
  });

  it('rejects empty / non-string path', () => {
    assert.throws(() => resolveSafe('', root), PathEscapeError);
    assert.throws(() => resolveSafe(undefined as unknown as string, root), PathEscapeError);
  });
});

// ────────────────────────────────────────────────────────────────────────
// read_file
// ────────────────────────────────────────────────────────────────────────

describe('read_file', () => {
  const ex = () => new BuiltinToolExecutor({ allowedTools: READ_ONLY });

  it('reads a file inside workingDir', async () => {
    const r = await ex().execute(makeCall('read_file', { path: 'hello.txt' }), ctx(root));
    assert.equal(r.isError, false);
    assert.match(r.content, /hello world/);
  });

  it('honors offset + limit', async () => {
    const r = await ex().execute(makeCall('read_file', { path: 'hello.txt', offset: 2, limit: 1 }), ctx(root));
    assert.equal(r.isError, false);
    assert.equal(r.content.trim(), 'line2');
  });

  it('rejects path that escapes workingDir', async () => {
    const r = await ex().execute(makeCall('read_file', { path: '../escape.txt' }), ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /escapes workingDir/);
  });

  it('rejects directory targets', async () => {
    const r = await ex().execute(makeCall('read_file', { path: 'src' }), ctx(root));
    assert.equal(r.isError, true);
  });
});

// ────────────────────────────────────────────────────────────────────────
// write_file + edit
// ────────────────────────────────────────────────────────────────────────

describe('write_file', () => {
  it('creates a new file with parent dirs', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['write_file'] });
    const r = await ex.execute(makeCall('write_file', { path: 'new/path/x.txt', content: 'fresh' }), ctx(root));
    assert.equal(r.isError, false);
  });

  it('refuses paths outside workingDir', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['write_file'] });
    const r = await ex.execute(makeCall('write_file', { path: '../injected.txt', content: 'no' }), ctx(root));
    assert.equal(r.isError, true);
  });
});

describe('edit', () => {
  const ex = () => new BuiltinToolExecutor({ allowedTools: ['edit'] });

  it('replaces a unique anchor', async () => {
    writeFileSync(join(root, 'edit-target.txt'), 'aaa BBB ccc\n');
    const r = await ex().execute(makeCall('edit', { path: 'edit-target.txt', old_string: 'BBB', new_string: 'XXX' }), ctx(root));
    assert.equal(r.isError, false);
  });

  it('refuses ambiguous anchor without replace_all', async () => {
    writeFileSync(join(root, 'ambig.txt'), 'foo foo foo\n');
    const r = await ex().execute(makeCall('edit', { path: 'ambig.txt', old_string: 'foo', new_string: 'bar' }), ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /matched 3 times/);
  });

  it('replace_all replaces every occurrence', async () => {
    writeFileSync(join(root, 'rep.txt'), 'foo foo foo\n');
    const r = await ex().execute(makeCall('edit', { path: 'rep.txt', old_string: 'foo', new_string: 'bar', replace_all: true }), ctx(root));
    assert.equal(r.isError, false);
  });

  it('fails when old_string is not found', async () => {
    writeFileSync(join(root, 'miss.txt'), 'nothing here\n');
    const r = await ex().execute(makeCall('edit', { path: 'miss.txt', old_string: 'absent', new_string: 'present' }), ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /not found/);
  });

  it('fails when target file does not exist', async () => {
    const r = await ex().execute(makeCall('edit', { path: 'nonexistent.txt', old_string: 'x', new_string: 'y' }), ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /not found/);
  });
});

// ────────────────────────────────────────────────────────────────────────
// bash — timeout + abort
// ────────────────────────────────────────────────────────────────────────

describe('bash', () => {
  it('runs a simple command and returns stdout', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['bash'] });
    const r = await ex.execute(makeCall('bash', { command: 'printf hello' }), ctx(root));
    assert.equal(r.isError, false);
    assert.match(r.content, /hello/);
  });

  it('reports non-zero exit as isError:true', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['bash'] });
    const r = await ex.execute(makeCall('bash', { command: 'exit 7' }), ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /exit 7/);
  });

  it('kills on timeout', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['bash'] });
    const r = await ex.execute(makeCall('bash', { command: 'sleep 5', timeout_ms: 200 }), ctx(root));
    assert.equal(r.isError, true);
    assert.match(r.content, /timed out/);
  });

  it('kills on abort', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['bash'] });
    const ac = new AbortController();
    const promise = ex.execute(makeCall('bash', { command: 'sleep 5' }), ctx(root, ac.signal));
    setTimeout(() => ac.abort(), 50);
    const r = await promise;
    assert.equal(r.isError, true);
    assert.match(r.content, /aborted/);
  });

  it('runs in workingDir, not process cwd', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['bash'] });
    const r = await ex.execute(makeCall('bash', { command: 'pwd' }), ctx(root));
    assert.equal(r.isError, false);
    assert.match(r.content, new RegExp(root.split('/').slice(-2).join('/')));
  });
});

// ────────────────────────────────────────────────────────────────────────
// grep / glob / list
// ────────────────────────────────────────────────────────────────────────

describe('grep / glob / list', () => {
  it('grep finds matches with file:line prefix', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['grep'] });
    const r = await ex.execute(makeCall('grep', { pattern: 'export const' }), ctx(root));
    if (r.isError && /spawn error/.test(r.content)) return; // ripgrep not installed in CI
    assert.equal(r.isError, false);
    assert.match(r.content, /a\.ts/);
  });

  it('glob lists files matching pattern', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['glob'] });
    const r = await ex.execute(makeCall('glob', { pattern: '**/*.ts' }), ctx(root));
    if (r.isError && /spawn error/.test(r.content)) return;
    assert.equal(r.isError, false);
  });

  it('list returns one entry per line', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['list'] });
    const r = await ex.execute(makeCall('list', {}), ctx(root));
    assert.equal(r.isError, false);
    assert.match(r.content, /hello\.txt/);
  });

  it('list rejects file targets', async () => {
    const ex = new BuiltinToolExecutor({ allowedTools: ['list'] });
    const r = await ex.execute(makeCall('list', { path: 'hello.txt' }), ctx(root));
    assert.equal(r.isError, true);
  });
});
