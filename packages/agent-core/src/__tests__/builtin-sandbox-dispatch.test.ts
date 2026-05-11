/**
 * Phase P2 — BuiltinToolExecutor FS dispatch through sandbox handle.
 *
 * Stub handle records every call. We verify read_file / write_file /
 * edit / grep / glob all dispatch through the handle when set, and
 * fall back to host FS when not.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  BuiltinToolExecutor,
  setCurrentSandboxHandle,
} from '../tools/index.js';

interface RecordedCall { method: string; args: unknown[] }

function makeStubHandle(initialFs: Record<string, string> = {}) {
  const calls: RecordedCall[] = [];
  const fs = new Map(Object.entries(initialFs));
  const handle = {
    id: 'stub',
    runtime: 'docker' as const,
    workdir: '/workspace',
    limits: {},
    async read(p: string, opts?: { offset?: number; limit?: number }) {
      calls.push({ method: 'read', args: [p, opts] });
      const v = fs.get(p);
      if (v === undefined) throw new Error(`not found: ${p}`);
      return v;
    },
    async write(p: string, content: string | Buffer) {
      calls.push({ method: 'write', args: [p, content] });
      fs.set(p, typeof content === 'string' ? content : content.toString('utf8'));
    },
    async edit(p: string, oldS: string, newS: string, all?: boolean) {
      calls.push({ method: 'edit', args: [p, oldS, newS, all] });
      const v = fs.get(p);
      if (v === undefined) throw new Error(`not found: ${p}`);
      fs.set(p, all ? v.split(oldS).join(newS) : v.replace(oldS, newS));
    },
    async grep(pattern: string, opts?: { path?: string; glob?: string }) {
      calls.push({ method: 'grep', args: [pattern, opts] });
      return `match for "${pattern}"`;
    },
    async glob(pattern: string, opts?: { path?: string }) {
      calls.push({ method: 'glob', args: [pattern, opts] });
      return `files matching ${pattern}`;
    },
    async exec() { throw new Error('not used in this test'); },
    async syncToHost() { return { added: [], modified: [], removed: [], conflictResolution: 'merged' as const }; },
    async snapshot() { return { contentHash: 'sha256:stub', sizeBytes: 0, fileCount: 0, capturedAt: new Date().toISOString() }; },
    async close() {},
  };
  return { handle, calls };
}

after(() => {
  setCurrentSandboxHandle(undefined);
});

describe('BuiltinToolExecutor — sandbox handle dispatch (P2)', () => {
  it('read_file dispatches through handle.read when set', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p2-r-'));
    try {
      const { handle, calls } = makeStubHandle({ 'src/x.txt': 'hello from sandbox' });
      setCurrentSandboxHandle(handle);
      try {
        const exec = new BuiltinToolExecutor({ allowedTools: ['read_file'] });
        const r = await exec.execute(
          { id: 'c1', name: 'read_file', arguments: { path: 'src/x.txt' } },
          { workingDir: tmp, abortSignal: new AbortController().signal },
        );
        assert.equal(r.isError, false);
        assert.match(r.content, /hello from sandbox/);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'read');
      } finally {
        setCurrentSandboxHandle(undefined);
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('write_file dispatches through handle.write when set', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p2-w-'));
    try {
      const { handle, calls } = makeStubHandle();
      setCurrentSandboxHandle(handle);
      try {
        const exec = new BuiltinToolExecutor({ allowedTools: ['write_file'] });
        const r = await exec.execute(
          { id: 'c2', name: 'write_file', arguments: { path: 'out.txt', content: 'wrote' } },
          { workingDir: tmp, abortSignal: new AbortController().signal },
        );
        assert.equal(r.isError, false);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'write');
        // Host fs should NOT have the file.
        const hostExists = await fsp.access(path.join(tmp, 'out.txt')).then(() => true).catch(() => false);
        assert.equal(hostExists, false, 'write should not leak to host when sandbox is set');
      } finally {
        setCurrentSandboxHandle(undefined);
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('edit dispatches through handle.edit when set', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p2-e-'));
    try {
      const { handle, calls } = makeStubHandle({ 'x.txt': 'old' });
      setCurrentSandboxHandle(handle);
      try {
        const exec = new BuiltinToolExecutor({ allowedTools: ['edit'] });
        const r = await exec.execute(
          { id: 'c3', name: 'edit', arguments: { path: 'x.txt', old_string: 'old', new_string: 'new' } },
          { workingDir: tmp, abortSignal: new AbortController().signal },
        );
        assert.equal(r.isError, false);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'edit');
      } finally {
        setCurrentSandboxHandle(undefined);
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('grep dispatches through handle.grep when set', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p2-g-'));
    try {
      const { handle, calls } = makeStubHandle();
      setCurrentSandboxHandle(handle);
      try {
        const exec = new BuiltinToolExecutor({ allowedTools: ['grep'] });
        const r = await exec.execute(
          { id: 'c4', name: 'grep', arguments: { pattern: 'foo' } },
          { workingDir: tmp, abortSignal: new AbortController().signal },
        );
        assert.equal(r.isError, false);
        assert.match(r.content, /match for "foo"/);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'grep');
      } finally {
        setCurrentSandboxHandle(undefined);
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('glob dispatches through handle.glob when set', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p2-gl-'));
    try {
      const { handle, calls } = makeStubHandle();
      setCurrentSandboxHandle(handle);
      try {
        const exec = new BuiltinToolExecutor({ allowedTools: ['glob'] });
        const r = await exec.execute(
          { id: 'c5', name: 'glob', arguments: { pattern: '*.ts' } },
          { workingDir: tmp, abortSignal: new AbortController().signal },
        );
        assert.equal(r.isError, false);
        assert.match(r.content, /files matching \*.ts/);
        assert.equal(calls.length, 1);
        assert.equal(calls[0]!.method, 'glob');
      } finally {
        setCurrentSandboxHandle(undefined);
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to host FS when no handle is set', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p2-host-'));
    try {
      setCurrentSandboxHandle(undefined);
      await fsp.writeFile(path.join(tmp, 'host.txt'), 'host content');
      const exec = new BuiltinToolExecutor({ allowedTools: ['read_file'] });
      const r = await exec.execute(
        { id: 'c6', name: 'read_file', arguments: { path: 'host.txt' } },
        { workingDir: tmp, abortSignal: new AbortController().signal },
      );
      assert.equal(r.isError, false);
      assert.match(r.content, /host content/);
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });

  it('handle errors translate to isError:true tool results', async () => {
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'anvil-p2-err-'));
    try {
      const { handle } = makeStubHandle({}); // empty fs — read of missing path throws
      setCurrentSandboxHandle(handle);
      try {
        const exec = new BuiltinToolExecutor({ allowedTools: ['read_file'] });
        const r = await exec.execute(
          { id: 'c7', name: 'read_file', arguments: { path: 'missing.txt' } },
          { workingDir: tmp, abortSignal: new AbortController().signal },
        );
        assert.equal(r.isError, true);
        assert.match(r.content, /not found/);
      } finally {
        setCurrentSandboxHandle(undefined);
      }
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  });
});
