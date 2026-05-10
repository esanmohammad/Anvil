/**
 * Docker-backed sandbox runner. The default Mode 1 runtime from
 * `docs/sandbox-isolation-plan.md` §D.
 *
 * Drives the host's `docker` CLI via `child_process` (no `dockerode`
 * dep so user installs without the npm package keep working). Each
 * `acquire()` starts a long-lived container (`docker run -d`) bind-
 * mounting the host workdir at `/workspace`. `exec()` calls
 * `docker exec` against that container; `close()` calls `docker rm -f`.
 *
 * S2 lands the basics:
 *   - acquire / exec / read / write / edit / close
 *   - stdio cap, exit code surface, signal cancellation, timeout
 *   - bind-mount of the host workdir (no overlay yet — that's S3)
 *   - default Docker network (no custom net policy yet — that's S4)
 *   - no resource limits yet (S5)
 *
 * Tests are skip-on-no-docker: see `__tests__/docker-runner.test.ts`
 * for the `ANVIL_RUN_DOCKER_TESTS=1` gate.
 */

import { spawn, type ChildProcess } from 'node:child_process';
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
import { dockerRunLimitArgs, detectLimitKill } from './resource-limits.js';
import { buildCacheMounts, dockerCacheMountArgs, type CacheMode } from './cache-mounts.js';

/** Default base image. Overridable via `AcquireSandboxOpts.image`. */
export const DEFAULT_SANDBOX_IMAGE = 'anvil/sandbox:latest';

/** Per-stream stdio cap. Matches the agent-core BuiltinToolExecutor. */
const DEFAULT_STDIO_CAP = 64 * 1024;

/** Soft default timeout when the stage policy doesn't supply one. */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;

/** Where the host workdir mounts inside the sandbox. */
const SANDBOX_WORKDIR = '/workspace';

export interface DockerSandboxOptions {
  /** Override the `docker` binary path (env: `DOCKER_BIN`). */
  dockerBin?: string;
  /** Default image when `acquire(...)` doesn't specify one. */
  defaultImage?: string;
  /** Idle TTL — handles past this age get swept by `sweep()`. */
  idleTtlMs?: number;
  /** Default cache-mount mode. Default 'read-only'. */
  cacheMode?: CacheMode;
  /** Test seam: replace the spawn function (used by docker-runner tests
   *  to inject a stub `docker` CLI). */
  spawnFn?: typeof spawn;
}

export class DockerSandboxHandle implements SandboxHandle {
  readonly id: string;
  readonly runtime = 'docker' as const;
  readonly workdir = SANDBOX_WORKDIR;
  readonly limits: SandboxLimits;
  readonly hostWorkdir: string;
  readonly image: string;
  readonly containerName: string;
  readonly createdAtMs = Date.now();
  busy = false;
  closed = false;

  constructor(
    private readonly runner: DockerSandboxRunner,
    opts: { id: string; containerName: string; hostWorkdir: string; image: string; limits: SandboxLimits },
  ) {
    this.id = opts.id;
    this.containerName = opts.containerName;
    this.hostWorkdir = opts.hostWorkdir;
    this.image = opts.image;
    this.limits = opts.limits;
  }

  async exec(args: SandboxExecArgs): Promise<SandboxExecResult> {
    if (this.closed) throw new Error(`sandbox ${this.id} already closed`);
    this.busy = true;
    try {
      return await this.runner.execInsideContainer(this.containerName, args, this.limits);
    } finally {
      this.busy = false;
    }
  }

  async read(filePath: string, opts?: { offset?: number; limit?: number }): Promise<string> {
    if (this.closed) throw new Error(`sandbox ${this.id} already closed`);
    const safe = sandboxRelative(filePath);
    const r = await this.runner.execInsideContainer(this.containerName, {
      command: `cat -- ${shellQuote(safe)}`,
    }, this.limits);
    if (r.exitCode !== 0) {
      throw new Error(`sandbox read failed for ${filePath}: ${r.stderr}`);
    }
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? r.stdout.length - offset;
    return r.stdout.slice(offset, offset + limit);
  }

  async write(filePath: string, content: string | Buffer): Promise<void> {
    if (this.closed) throw new Error(`sandbox ${this.id} already closed`);
    const safe = sandboxRelative(filePath);
    const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    // `docker cp -` reads a tar stream from stdin — overkill for a single
    // file. We use base64 + tee inside the container for portability.
    const b64 = buf.toString('base64');
    const dir = path.posix.dirname(safe) || '.';
    const cmd =
      `mkdir -p ${shellQuote(dir)} && ` +
      `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(safe)}`;
    const r = await this.runner.execInsideContainer(this.containerName, {
      command: cmd,
    }, this.limits);
    if (r.exitCode !== 0) {
      throw new Error(`sandbox write failed for ${filePath}: ${r.stderr}`);
    }
  }

  async edit(filePath: string, oldString: string, newString: string, replaceAll = false): Promise<void> {
    if (this.closed) throw new Error(`sandbox ${this.id} already closed`);
    const content = await this.read(filePath);
    if (!content.includes(oldString)) {
      throw new Error(`edit: oldString not found in ${filePath}`);
    }
    if (!replaceAll) {
      const first = content.indexOf(oldString);
      const second = content.indexOf(oldString, first + oldString.length);
      if (second !== -1) {
        throw new Error(`edit: oldString not unique in ${filePath} (use replaceAll)`);
      }
      const replaced = content.slice(0, first) + newString + content.slice(first + oldString.length);
      await this.write(filePath, replaced);
      return;
    }
    await this.write(filePath, content.split(oldString).join(newString));
  }

  async syncToHost(_opts?: { mode?: 'merge' | 'replace' }): Promise<SandboxSyncResult> {
    void _opts;
    // S2 uses bind-mode by default; the host already sees every write.
    // Overlay propagation is S3.
    return {
      added: [], modified: [], removed: [], conflictResolution: 'merged',
    };
  }

  async snapshot(): Promise<SandboxSnapshot> {
    if (this.closed) throw new Error(`sandbox ${this.id} already closed`);
    // Cheap snapshot by stat — Merkle hash arrives in S6.
    let sizeBytes = 0;
    let fileCount = 0;
    try {
      const r = await this.runner.execInsideContainer(this.containerName, {
        command: `find ${SANDBOX_WORKDIR} -type f -printf '%s\\n' 2>/dev/null | awk '{ s+=$1; n+=1 } END { print s; print n }'`,
      }, this.limits);
      const lines = r.stdout.trim().split('\n');
      sizeBytes = Number.parseInt(lines[0] ?? '0', 10) || 0;
      fileCount = Number.parseInt(lines[1] ?? '0', 10) || 0;
    } catch { /* ignore */ }
    return {
      contentHash: 'sha256:docker-runner-placeholder',
      sizeBytes,
      fileCount,
      capturedAt: new Date().toISOString(),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.runner.removeContainer(this.containerName).catch(() => { /* best-effort */ });
  }
}

export class DockerSandboxRunner implements SandboxRunner {
  private readonly handles = new Map<string, DockerSandboxHandle>();
  private readonly opts: {
    dockerBin: string;
    defaultImage: string;
    idleTtlMs: number;
    cacheMode: CacheMode;
    spawnFn?: typeof spawn;
  };

  constructor(opts: DockerSandboxOptions = {}) {
    this.opts = {
      dockerBin: opts.dockerBin ?? process.env.DOCKER_BIN ?? 'docker',
      defaultImage: opts.defaultImage ?? DEFAULT_SANDBOX_IMAGE,
      idleTtlMs: opts.idleTtlMs ?? 5 * 60 * 1000,
      cacheMode: opts.cacheMode ?? 'read-only',
      ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
    };
  }

  async acquire(opts: AcquireSandboxOpts): Promise<SandboxHandle> {
    const containerName = `anvil-sb-${opts.runId.slice(0, 8)}-${opts.stage}-${randomUUID().slice(0, 8)}`;
    const image = opts.image ?? this.opts.defaultImage;
    const hostWorkdir = path.resolve(opts.hostWorkdir);
    await fsp.access(hostWorkdir).catch(() => {
      throw new Error(`hostWorkdir does not exist: ${hostWorkdir}`);
    });

    const cacheMounts = buildCacheMounts({
      defaultMode: this.opts.cacheMode,
    });
    const args = [
      'run',
      '-d',                           // detached
      '--name', containerName,
      '--workdir', SANDBOX_WORKDIR,
      // S2: bind-mount only. Overlay arrives in S3.
      '--mount', `type=bind,src=${hostWorkdir},dst=${SANDBOX_WORKDIR}`,
      // S5: per-stage resource limits — memory, cpus, pids, disk.
      ...dockerRunLimitArgs(opts.limits),
      // S8: read-only package-manager cache mounts.
      ...dockerCacheMountArgs(cacheMounts),
      // Block exec without a TTY so a poisoned container can't run an
      // interactive shell to phone home.
      '--init',
      // Keep the container alive — we'll exec into it.
      image,
      'sh', '-c', 'tail -f /dev/null',
    ];

    const out = await this.dockerCli(args);
    if (out.exitCode !== 0) {
      throw new DockerRunnerError(
        `docker run failed (exit ${out.exitCode}): ${out.stderr.trim() || out.stdout.trim()}`,
        { stderr: out.stderr },
      );
    }

    const handle = new DockerSandboxHandle(this, {
      id: containerName,
      containerName,
      hostWorkdir,
      image,
      limits: opts.limits ?? {},
    });
    this.handles.set(handle.id, handle);
    return handle;
  }

  async list(): Promise<readonly SandboxRunnerListEntry[]> {
    const now = Date.now();
    return Array.from(this.handles.values()).map((h) => ({
      id: h.id,
      runtime: 'docker',
      ageMs: now - h.createdAtMs,
      busy: h.busy,
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
    for (const h of this.handles.values()) {
      await h.close().catch(() => { /* best-effort */ });
    }
    this.handles.clear();
  }

  async execInsideContainer(
    containerName: string,
    args: SandboxExecArgs,
    limits: SandboxLimits,
  ): Promise<SandboxExecResult> {
    const startedAt = Date.now();
    const timeoutMs = pickTimeoutMs(args, limits);
    const dockerArgs = ['exec'];

    if (args.cwd) {
      dockerArgs.push('--workdir', args.cwd);
    }
    if (args.env) {
      for (const [k, v] of Object.entries(args.env)) {
        dockerArgs.push('-e', `${k}=${v}`);
      }
    }
    if (args.stdin) dockerArgs.push('-i');

    dockerArgs.push(containerName, 'sh', '-c', args.command);
    return this.runDockerExec(dockerArgs, args, startedAt, timeoutMs);
  }

  async removeContainer(name: string): Promise<void> {
    await this.dockerCli(['rm', '-f', name]).catch(() => { /* best-effort */ });
  }

  /** Pull (or build) the sandbox image. Idempotent — `docker pull` is a
   *  no-op when the image is already present at the requested tag. */
  async ensureImage(image: string = this.opts.defaultImage): Promise<void> {
    const r = await this.dockerCli(['image', 'inspect', image]);
    if (r.exitCode === 0) return;
    const pull = await this.dockerCli(['pull', image]);
    if (pull.exitCode !== 0) {
      throw new DockerRunnerError(
        `docker pull ${image} failed: ${pull.stderr.trim() || pull.stdout.trim()}`,
        { stderr: pull.stderr },
      );
    }
  }

  /** Test/diagnostic — returns true iff the docker CLI is on PATH and
   *  responds to `docker version`. */
  async isAvailable(): Promise<boolean> {
    const r = await this.dockerCli(['version', '--format', '{{.Server.Version}}']).catch(() => null);
    return !!r && r.exitCode === 0;
  }

  /** Low-level: spawn `docker` with the provided argv. Used internally
   *  + by S4/S5 helpers for network / limit setup. */
  async dockerCli(argv: readonly string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
    return runDockerProcess(this.opts.dockerBin, argv as string[], { spawnFn: this.opts.spawnFn });
  }

  private runDockerExec(
    dockerArgs: string[],
    execArgs: SandboxExecArgs,
    startedAt: number,
    timeoutMs: number,
  ): Promise<SandboxExecResult> {
    return new Promise<SandboxExecResult>((resolve) => {
      const spawnFn = this.opts.spawnFn ?? spawn;
      const child = spawnFn(this.opts.dockerBin, dockerArgs, {
        stdio: [execArgs.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      const settled = collectChildOutput(child, {
        timeoutMs,
        signal: execArgs.signal,
        stdin: execArgs.stdin,
        stdioCap: DEFAULT_STDIO_CAP,
      });
      settled.then((res) => {
        const out: SandboxExecResult = {
          exitCode: res.exitCode,
          stdout: res.stdout,
          stderr: res.stderr,
          durationMs: Date.now() - startedAt,
        };
        if (res.killedByLimit) {
          out.killedByLimit = res.killedByLimit;
        } else {
          // S5: classify exit codes / stderr for OOM / disk / pid kills.
          const detected = detectLimitKill({
            exitCode: res.exitCode,
            stderr: res.stderr,
          });
          if (detected) out.killedByLimit = detected;
        }
        if (res.truncated) out.truncated = res.truncated;
        resolve(out);
      });
    });
  }
}

export class DockerRunnerError extends Error {
  override readonly name = 'DockerRunnerError';
  readonly stderr?: string;
  constructor(message: string, opts?: { stderr?: string }) {
    super(message);
    if (opts?.stderr) this.stderr = opts.stderr;
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────

function sandboxRelative(p: string): string {
  if (!p) throw new Error('path is required');
  if (path.isAbsolute(p)) {
    if (p.startsWith(SANDBOX_WORKDIR + '/') || p === SANDBOX_WORKDIR) {
      return p;
    }
    throw new Error(`path escapes sandbox workdir: ${p}`);
  }
  // Reject `..` traversal regardless of intermediate joins.
  const segs = p.split('/');
  if (segs.includes('..')) throw new Error(`path escapes sandbox workdir: ${p}`);
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
  return fromArgs ?? fromLimits ?? DEFAULT_EXEC_TIMEOUT_MS;
}

interface CollectOpts {
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  stdin?: string | Buffer | undefined;
  stdioCap: number;
}

interface CollectResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  killedByLimit?: SandboxExecResult['killedByLimit'];
  truncated?: { stdout: number; stderr: number };
}

export function collectChildOutput(child: ChildProcess, opts: CollectOpts): Promise<CollectResult> {
  return new Promise<CollectResult>((resolve) => {
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
    }, opts.timeoutMs);

    const onAbort = () => finish();
    if (opts.signal?.aborted) {
      clearTimeout(timer);
      onAbort();
    } else if (opts.signal) {
      opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    if (opts.stdin && child.stdin) {
      child.stdin.end(opts.stdin);
    }

    child.stdout?.on('data', (b: Buffer) => {
      const remaining = opts.stdioCap - stdout.length;
      if (remaining > 0) stdout += b.toString('utf8').slice(0, remaining);
      if (b.length > remaining) stdoutTrunc += Math.max(0, b.length - Math.max(0, remaining));
    });
    child.stderr?.on('data', (b: Buffer) => {
      const remaining = opts.stdioCap - stderr.length;
      if (remaining > 0) stderr += b.toString('utf8').slice(0, remaining);
      if (b.length > remaining) stderrTrunc += Math.max(0, b.length - Math.max(0, remaining));
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const result: CollectResult = {
        exitCode: null,
        stdout,
        stderr: stderr + (stderr ? '\n' : '') + `spawn error: ${err.message}`,
      };
      resolve(result);
    });

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      const result: CollectResult = { exitCode: code, stdout, stderr };
      if (killedByLimit) result.killedByLimit = killedByLimit;
      else if (signal) result.killedByLimit = 'timeout';
      if (stdoutTrunc > 0 || stderrTrunc > 0) {
        result.truncated = { stdout: stdoutTrunc, stderr: stderrTrunc };
      }
      resolve(result);
    });
  });
}

async function runDockerProcess(
  bin: string,
  argv: string[],
  opts: { spawnFn?: typeof spawn },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const spawnFn = opts.spawnFn ?? spawn;
    const child = spawnFn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => {
      resolve({ exitCode: null, stdout, stderr: stderr + `\nspawn error: ${err.message}` });
    });
    child.on('exit', (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}
