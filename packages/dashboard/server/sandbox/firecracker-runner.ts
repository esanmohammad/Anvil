/**
 * Firecracker microVM sandbox runner — Phase S9.
 *
 * Same SandboxRunner contract; backed by `firecracker-containerd` (the
 * AWS-maintained Containerd shim that drives Firecracker microVMs).
 * `firecracker-containerd` exposes a CRI-compatible API and a `ctr`
 * CLI; we drive it via `child_process` like Docker.
 *
 * Off by default. Users opt in via:
 *   ~/.anvil/sandbox.yaml: { defaultRuntime: firecracker }
 * or per-stage:
 *   pipeline-policy.overlay.json: { sandbox: { perStage: { build: { runtime: firecracker } } } }
 *
 * Linux + KVM-only. The `isAvailable()` probe checks for the `ctr`
 * binary and `/dev/kvm` access. macOS and Windows fall through to
 * Docker silently.
 *
 * S9 lands the runner shape + isAvailable probe + acquire/exec/close.
 * The block-device snapshot/diff for overlay propagation is a follow-up
 * (Firecracker rootfs diff lives in `infra/sandbox/firecracker-image-build.sh`).
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
} from '@esankhan3/anvil-core-pipeline/sandbox/types.js';
import { collectChildOutput } from './docker-runner.js';

const SANDBOX_WORKDIR = '/workspace';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface FirecrackerOptions {
  /** Override the `ctr` binary (env: FIRECRACKER_CTR_BIN). */
  ctrBin?: string;
  /** Default rootfs image — produced by `infra/sandbox/firecracker-image-build.sh`. */
  defaultImage?: string;
  /** Idle TTL for the in-process pool (default 5 min). */
  idleTtlMs?: number;
  /** Test seam — replace the spawn function. */
  spawnFn?: typeof spawn;
}

export class FirecrackerSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly runtime = 'firecracker' as const;
  readonly workdir = SANDBOX_WORKDIR;
  readonly limits: SandboxLimits;
  readonly hostWorkdir: string;
  readonly image: string;
  readonly vmName: string;
  readonly createdAtMs = Date.now();
  busy = false;
  closed = false;

  constructor(
    private readonly runner: FirecrackerSandboxRunner,
    opts: { id: string; vmName: string; hostWorkdir: string; image: string; limits: SandboxLimits },
  ) {
    this.id = opts.id;
    this.vmName = opts.vmName;
    this.hostWorkdir = opts.hostWorkdir;
    this.image = opts.image;
    this.limits = opts.limits;
  }

  async exec(args: SandboxExecArgs): Promise<SandboxExecResult> {
    if (this.closed) throw new Error(`firecracker sandbox ${this.id} already closed`);
    this.busy = true;
    try {
      return await this.runner.execInsideVM(this.vmName, args, this.limits);
    } finally {
      this.busy = false;
    }
  }

  async read(filePath: string): Promise<string> {
    const r = await this.runner.execInsideVM(this.vmName, {
      command: `cat -- ${shellQuote(sandboxRelative(filePath))}`,
    }, this.limits);
    if (r.exitCode !== 0) throw new Error(`firecracker read failed for ${filePath}: ${r.stderr}`);
    return r.stdout;
  }

  async write(filePath: string, content: string | Buffer): Promise<void> {
    const safe = sandboxRelative(filePath);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const b64 = buf.toString('base64');
    const dir = path.posix.dirname(safe) || '.';
    const cmd =
      `mkdir -p ${shellQuote(dir)} && ` +
      `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(safe)}`;
    const r = await this.runner.execInsideVM(this.vmName, { command: cmd }, this.limits);
    if (r.exitCode !== 0) throw new Error(`firecracker write failed for ${filePath}: ${r.stderr}`);
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<void> {
    const content = await this.read(filePath);
    if (!content.includes(oldString)) throw new Error(`edit: oldString not found in ${filePath}`);
    if (!replaceAll) {
      const first = content.indexOf(oldString);
      const second = content.indexOf(oldString, first + oldString.length);
      if (second !== -1) throw new Error(`edit: oldString not unique in ${filePath} (use replaceAll)`);
      await this.write(filePath, content.slice(0, first) + newString + content.slice(first + oldString.length));
      return;
    }
    await this.write(filePath, content.split(oldString).join(newString));
  }

  async syncToHost(_opts?: { mode?: 'merge' | 'replace' }): Promise<SandboxSyncResult> {
    void _opts;
    // Block-device snapshot/diff is a follow-up — S9 vends bind-mode
    // semantics so the host already sees writes.
    return { added: [], modified: [], removed: [], conflictResolution: 'merged' };
  }

  async snapshot(): Promise<SandboxSnapshot> {
    return {
      contentHash: 'sha256:firecracker-runner-placeholder',
      sizeBytes: 0,
      fileCount: 0,
      capturedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.runner.removeVM(this.vmName).catch(() => { /* best-effort */ });
  }
}

export class FirecrackerSandboxRunner implements SandboxRunner {
  private readonly handles = new Map<string, FirecrackerSandboxHandle>();
  private readonly opts: { ctrBin: string; defaultImage: string; idleTtlMs: number; spawnFn?: typeof spawn };

  constructor(opts: FirecrackerOptions = {}) {
    this.opts = {
      ctrBin: opts.ctrBin ?? process.env.FIRECRACKER_CTR_BIN ?? 'ctr',
      defaultImage: opts.defaultImage ?? 'anvil/sandbox-firecracker:latest',
      idleTtlMs: opts.idleTtlMs ?? 5 * 60 * 1000,
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    };
  }

  async acquire(opts: AcquireSandboxOpts): Promise<SandboxHandle> {
    const vmName = `anvil-fc-${opts.runId.slice(0, 8)}-${opts.stage}-${randomUUID().slice(0, 8)}`;
    const image = opts.image ?? this.opts.defaultImage;
    const hostWorkdir = path.resolve(opts.hostWorkdir);
    await fsp.access(hostWorkdir).catch(() => {
      throw new Error(`hostWorkdir does not exist: ${hostWorkdir}`);
    });

    // ctr run --rm -d --runtime aws.firecracker --mount ... <image> <vmName> <init>
    const args = [
      '--namespace', 'firecracker',
      'run',
      '-d',
      '--runtime', 'aws.firecracker',
      '--mount', `type=bind,src=${hostWorkdir},dst=${SANDBOX_WORKDIR}`,
      image,
      vmName,
      'sh', '-c', 'tail -f /dev/null',
    ];
    const r = await this.ctrCli(args);
    if (r.exitCode !== 0) {
      throw new Error(`firecracker ctr run failed (exit ${r.exitCode}): ${r.stderr.trim()}`);
    }

    const handle = new FirecrackerSandboxHandle(this, {
      id: vmName, vmName, hostWorkdir, image, limits: opts.limits ?? {},
    });
    this.handles.set(handle.id, handle);
    return handle;
  }

  async list(): Promise<readonly SandboxRunnerListEntry[]> {
    const now = Date.now();
    return Array.from(this.handles.values()).map((h) => ({
      id: h.id, runtime: 'firecracker' as const, ageMs: now - h.createdAtMs, busy: h.busy,
    }));
  }

  async sweep(): Promise<{ closed: number }> {
    const now = Date.now();
    let closed = 0;
    for (const [id, h] of this.handles) {
      if (h.busy) continue;
      if (h.closed || now - h.createdAtMs > this.opts.idleTtlMs) {
        await h.close();
        this.handles.delete(id);
        closed += 1;
      }
    }
    return { closed };
  }

  async shutdown(): Promise<void> {
    for (const h of this.handles.values()) await h.close().catch(() => {});
    this.handles.clear();
  }

  async execInsideVM(vmName: string, args: SandboxExecArgs, limits: SandboxLimits): Promise<SandboxExecResult> {
    const startedAt = Date.now();
    const timeoutMs = pickTimeoutMs(args, limits);
    const ctrArgs = [
      '--namespace', 'firecracker', 'task', 'exec', '--exec-id', randomUUID().slice(0, 12),
      vmName, 'sh', '-c', args.command,
    ];
    return new Promise<SandboxExecResult>((resolve) => {
      const spawnFn = this.opts.spawnFn ?? spawn;
      const child = spawnFn(this.opts.ctrBin, ctrArgs, {
        stdio: [args.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      const collected = collectChildOutput(child, {
        timeoutMs,
        signal: args.signal,
        stdin: args.stdin,
        stdioCap: 64 * 1024,
      });
      collected.then((res) => {
        const out: SandboxExecResult = {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          durationMs: Date.now() - startedAt,
        };
        if (res.killedByLimit) out.killedByLimit = res.killedByLimit;
        if (res.truncated) out.truncated = res.truncated;
        resolve(out);
      });
    });
  }

  async removeVM(vmName: string): Promise<void> {
    await this.ctrCli(['--namespace', 'firecracker', 'task', 'kill', vmName]).catch(() => {});
    await this.ctrCli(['--namespace', 'firecracker', 'task', 'delete', vmName]).catch(() => {});
    await this.ctrCli(['--namespace', 'firecracker', 'container', 'delete', vmName]).catch(() => {});
  }

  /**
   * Probe — returns true iff the ctr binary is on PATH and KVM is
   * accessible. macOS / Windows always fall through to Docker.
   */
  async isAvailable(): Promise<boolean> {
    if (process.platform !== 'linux') return false;
    const kvm = await fsp.access('/dev/kvm').then(() => true).catch(() => false);
    if (!kvm) return false;
    const r = await this.ctrCli(['version']).catch(() => null);
    return !!r && r.exitCode === 0;
  }

  async ctrCli(argv: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      const spawnFn = this.opts.spawnFn ?? spawn;
      const child = spawnFn(this.opts.ctrBin, argv as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
      child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
      child.on('error', (err) => resolve({ exitCode: null, stdout, stderr: stderr + `\nspawn error: ${err.message}` }));
      child.on('exit', (code) => resolve({ exitCode: code, stdout, stderr }));
    });
  }
}

// ───────────────────────────────────────────────────────────────────────
// helpers — shared with docker-runner; reproduced to avoid cross-runner
// import coupling.
// ───────────────────────────────────────────────────────────────────────

function sandboxRelative(p: string): string {
  if (!p) throw new Error('path is required');
  if (path.isAbsolute(p)) {
    if (p.startsWith(SANDBOX_WORKDIR + '/') || p === SANDBOX_WORKDIR) return p;
    throw new Error(`path escapes sandbox workdir: ${p}`);
  }
  if (p.split('/').includes('..')) throw new Error(`path escapes sandbox workdir: ${p}`);
  return p;
}

function shellQuote(s: string): string {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function pickTimeoutMs(args: SandboxExecArgs, limits: SandboxLimits): number {
  const fromArgs = args.timeoutMs;
  const fromLimits = limits.timeoutSeconds !== undefined ? limits.timeoutSeconds * 1000 : undefined;
  if (fromArgs !== undefined && fromLimits !== undefined) return Math.min(fromArgs, fromLimits);
  return fromArgs ?? fromLimits ?? DEFAULT_TIMEOUT_MS;
}
