/**
 * `NoneSandboxRunner` — passthrough runner. Vends `NoneSandboxHandle`s
 * that exec on the host and read/write the host filesystem directly.
 *
 * This is the Mode 0 from `docs/sandbox-isolation-plan.md` §D — no
 * isolation, no overhead. It exists so the `SandboxRunner` contract is
 * exercisable end-to-end without dragging Docker/Firecracker into the
 * test surface, and so read-only stages (clarify/requirements/specs/...)
 * can still go through the unified `acquire()` path.
 *
 * Used as the default runner until S12 flips build/test/validate/ship
 * to `'docker'`.
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import type {
  AcquireSandboxOpts,
  SandboxExecArgs,
  SandboxExecResult,
  SandboxHandle,
  SandboxLimits,
  SandboxRunner,
  SandboxRunnerListEntry,
  SandboxSnapshot,
  SandboxSyncResult,
} from './types.js';

/** Per-stream stdio cap (matches agent-core's BuiltinToolExecutor). */
const DEFAULT_STDIO_CAP = 64 * 1024;

export class NoneSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly runtime = 'none' as const;
  readonly workdir: string;
  readonly limits: SandboxLimits;
  /** When this handle was minted (used by the sweep loop). */
  readonly createdAtMs = Date.now();
  /** Set while an exec is in flight; the pool checks before reusing. */
  busy = false;
  closed = false;

  constructor(opts: { id: string; hostWorkdir: string; limits: SandboxLimits }) {
    this.id = opts.id;
    this.workdir = opts.hostWorkdir;
    this.limits = opts.limits;
  }

  async exec(args: SandboxExecArgs): Promise<SandboxExecResult> {
    if (this.closed) throw new Error(`sandbox ${this.id} already closed`);
    this.busy = true;
    try {
      return await runHost(args, this.workdir, this.limits);
    } finally {
      this.busy = false;
    }
  }

  async read(filePath: string, opts?: { offset?: number; limit?: number }): Promise<string> {
    const abs = this.resolveSafe(filePath);
    const buf = await fsp.readFile(abs);
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? buf.length - offset;
    return buf.slice(offset, offset + limit).toString('utf8');
  }

  async write(filePath: string, content: string | Buffer): Promise<void> {
    const abs = this.resolveSafe(filePath);
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content);
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<void> {
    const abs = this.resolveSafe(filePath);
    const content = await fsp.readFile(abs, 'utf8');
    if (!content.includes(oldString)) {
      throw new Error(`edit: oldString not found in ${filePath}`);
    }
    if (!replaceAll) {
      // Mirror the agent-core builtin: oldString must be unique.
      const first = content.indexOf(oldString);
      const second = content.indexOf(oldString, first + oldString.length);
      if (second !== -1) {
        throw new Error(`edit: oldString not unique in ${filePath} (use replaceAll)`);
      }
      const replaced = content.slice(0, first) + newString + content.slice(first + oldString.length);
      await fsp.writeFile(abs, replaced);
      return;
    }
    await fsp.writeFile(abs, content.split(oldString).join(newString));
  }

  async syncToHost(_opts?: { mode?: 'merge' | 'replace' }): Promise<SandboxSyncResult> {
    void _opts;
    // Bind-mode equivalent — host IS the sandbox.
    return {
      added: [],
      modified: [],
      removed: [],
      conflictResolution: 'merged',
    };
  }

  async snapshot(): Promise<SandboxSnapshot> {
    // Cheap snapshot — count files + bytes only. The full Merkle hash is
    // S6's responsibility (`state-hash.ts`). For S1, return placeholders
    // so the contract is exercised; replay determinism arrives in S6.
    let sizeBytes = 0;
    let fileCount = 0;
    try {
      for await (const entry of walkFiles(this.workdir)) {
        const stat = await fsp.stat(entry).catch(() => null);
        if (stat?.isFile()) {
          sizeBytes += stat.size;
          fileCount += 1;
        }
      }
    } catch { /* missing workdir → empty snapshot */ }
    return {
      contentHash: 'sha256:none-runner-placeholder',
      sizeBytes,
      fileCount,
      capturedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /**
   * Resolve a relative path against `workdir`, refusing escape attempts
   * (../, absolute paths that land outside, symlink chase). Mirrors
   * agent-core's `resolveSafe` so paths in `none` mode behave identically
   * to today's BuiltinToolExecutor.
   */
  private resolveSafe(p: string): string {
    const root = path.resolve(this.workdir);
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(root, p);
    const rel = path.relative(root, abs);
    if (rel === '' || rel === '.') return abs;
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`path escapes sandbox workdir: ${p}`);
    }
    return abs;
  }
}

async function* walkFiles(dir: string): AsyncIterable<string> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

async function runHost(
  args: SandboxExecArgs,
  workdir: string,
  limits: SandboxLimits,
): Promise<SandboxExecResult> {
  const startedAt = Date.now();
  const timeoutMs = pickTimeoutMs(args, limits);

  return new Promise<SandboxExecResult>((resolve) => {
    const child = spawn('sh', ['-c', args.command], {
      cwd: args.cwd ?? workdir,
      env: { ...process.env, ...(args.env ?? {}) },
      stdio: [args.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      shell: false,
    });

    let stdout = '';
    let stderr = '';
    let stdoutTrunc = 0;
    let stderrTrunc = 0;
    let killedByLimit: SandboxExecResult['killedByLimit'];
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    };

    const timer = setTimeout(() => {
      killedByLimit = 'timeout';
      finish();
    }, timeoutMs);

    const onAbort = () => {
      finish();
    };

    if (args.signal?.aborted) {
      clearTimeout(timer);
      onAbort();
    } else {
      args.signal?.addEventListener('abort', onAbort, { once: true });
    }

    if (args.stdin && child.stdin) {
      child.stdin.end(args.stdin);
    }

    child.stdout?.on('data', (b: Buffer) => {
      const remaining = DEFAULT_STDIO_CAP - stdout.length;
      if (remaining > 0) {
        stdout += b.toString('utf8').slice(0, remaining);
      }
      if (b.length > remaining) {
        stdoutTrunc += Math.max(0, b.length - Math.max(0, remaining));
      }
    });
    child.stderr?.on('data', (b: Buffer) => {
      const remaining = DEFAULT_STDIO_CAP - stderr.length;
      if (remaining > 0) {
        stderr += b.toString('utf8').slice(0, remaining);
      }
      if (b.length > remaining) {
        stderrTrunc += Math.max(0, b.length - Math.max(0, remaining));
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      args.signal?.removeEventListener('abort', onAbort);
      resolve({
        exitCode: null,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + `spawn error: ${err.message}`,
        durationMs: Date.now() - startedAt,
      });
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      args.signal?.removeEventListener('abort', onAbort);
      const result: SandboxExecResult = {
        exitCode: code,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      };
      if (killedByLimit) result.killedByLimit = killedByLimit;
      else if (signal) result.killedByLimit = 'timeout';
      if (stdoutTrunc > 0 || stderrTrunc > 0) {
        result.truncated = { stdout: stdoutTrunc, stderr: stderrTrunc };
      }
      resolve(result);
    });
  });
}

function pickTimeoutMs(args: SandboxExecArgs, limits: SandboxLimits): number {
  const fromArgs = args.timeoutMs;
  const fromLimits = limits.timeoutSeconds !== undefined ? limits.timeoutSeconds * 1000 : undefined;
  if (fromArgs !== undefined && fromLimits !== undefined) return Math.min(fromArgs, fromLimits);
  return fromArgs ?? fromLimits ?? 60_000;
}

export class NoneSandboxRunner implements SandboxRunner {
  private readonly handles = new Map<string, NoneSandboxHandle>();
  /** Idle-TTL — handles past this age get swept by `sweep()`. */
  private readonly idleTtlMs: number;

  constructor(opts: { idleTtlMs?: number } = {}) {
    this.idleTtlMs = opts.idleTtlMs ?? 5 * 60 * 1000; // 5 min
  }

  async acquire(opts: AcquireSandboxOpts): Promise<SandboxHandle> {
    const handle = new NoneSandboxHandle({
      id: `none-${opts.runId}-${opts.stage}-${randomUUID().slice(0, 8)}`,
      hostWorkdir: opts.hostWorkdir,
      limits: opts.limits ?? {},
    });
    this.handles.set(handle.id, handle);
    return handle;
  }

  async list(): Promise<readonly SandboxRunnerListEntry[]> {
    const now = Date.now();
    return Array.from(this.handles.values()).map((h) => ({
      id: h.id,
      runtime: 'none',
      ageMs: now - h.createdAtMs,
      busy: h.busy,
    }));
  }

  async sweep(): Promise<{ closed: number }> {
    const now = Date.now();
    let closed = 0;
    for (const [id, h] of this.handles) {
      if (h.busy) continue;
      if (h.closed || now - h.createdAtMs > this.idleTtlMs) {
        await h.close();
        this.handles.delete(id);
        closed += 1;
      }
    }
    return { closed };
  }

  async shutdown(): Promise<void> {
    for (const h of this.handles.values()) {
      await h.close();
    }
    this.handles.clear();
  }
}
