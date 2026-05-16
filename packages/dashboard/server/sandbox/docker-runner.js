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
import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { dockerRunLimitArgs, detectLimitKill } from './resource-limits.js';
import { buildCacheMounts, dockerCacheMountArgs } from './cache-mounts.js';
import { dockerRunNetworkArgs, resolveNetworkPolicy } from './network-policy.js';
import { applyOverlay, captureBaselineMtimes } from './overlay-fs.js';
/** Default base image. Overridable via `AcquireSandboxOpts.image`. */
export const DEFAULT_SANDBOX_IMAGE = 'anvil/sandbox:latest';
/** Per-stream stdio cap. Matches the agent-core BuiltinToolExecutor. */
const DEFAULT_STDIO_CAP = 64 * 1024;
/** Soft default timeout when the stage policy doesn't supply one. */
const DEFAULT_EXEC_TIMEOUT_MS = 10 * 60 * 1000;
/** Where the host workdir mounts inside the sandbox. */
const SANDBOX_WORKDIR = '/workspace';
export class DockerSandboxHandle {
    runner;
    id;
    runtime = 'docker';
    workdir = SANDBOX_WORKDIR;
    limits;
    hostWorkdir;
    image;
    containerName;
    fsMode;
    createdAtMs = Date.now();
    /** Baseline mtimes captured at acquire — used by overlay sync to
     *  detect host edits during the sandbox lifetime. */
    baselineMtimes = null;
    /** Host-side path to the upper tmpdir (real overlay mode). The
     *  container sees this at /workspace.upper. syncToHost walks this
     *  tree to apply the diff. */
    upperDir = null;
    /** Host-side path to the work tmpdir (overlay requires it; we don't
     *  read it, just clean up at close). */
    workDir = null;
    busy = false;
    closed = false;
    constructor(runner, opts) {
        this.runner = runner;
        this.id = opts.id;
        this.containerName = opts.containerName;
        this.hostWorkdir = opts.hostWorkdir;
        this.image = opts.image;
        this.limits = opts.limits;
        this.fsMode = opts.fsMode;
    }
    async exec(args) {
        if (this.closed)
            throw new Error(`sandbox ${this.id} already closed`);
        this.busy = true;
        try {
            return await this.runner.execInsideContainer(this.containerName, args, this.limits);
        }
        finally {
            this.busy = false;
        }
    }
    async read(filePath, opts) {
        if (this.closed)
            throw new Error(`sandbox ${this.id} already closed`);
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
    async write(filePath, content) {
        if (this.closed)
            throw new Error(`sandbox ${this.id} already closed`);
        const safe = sandboxRelative(filePath);
        const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        // `docker cp -` reads a tar stream from stdin — overkill for a single
        // file. We use base64 + tee inside the container for portability.
        const b64 = buf.toString('base64');
        const dir = path.posix.dirname(safe) || '.';
        const cmd = `mkdir -p ${shellQuote(dir)} && ` +
            `printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(safe)}`;
        const r = await this.runner.execInsideContainer(this.containerName, {
            command: cmd,
        }, this.limits);
        if (r.exitCode !== 0) {
            throw new Error(`sandbox write failed for ${filePath}: ${r.stderr}`);
        }
    }
    async edit(filePath, oldString, newString, replaceAll = false) {
        if (this.closed)
            throw new Error(`sandbox ${this.id} already closed`);
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
    async grep(pattern, opts) {
        if (this.closed)
            throw new Error(`sandbox ${this.id} already closed`);
        const target = opts?.path ? sandboxRelative(opts.path) : '.';
        const globFlag = opts?.glob ? `--glob ${shellQuote(opts.glob)} ` : '';
        const cmd = `rg --no-heading --line-number --color=never -e ${shellQuote(pattern)} ${globFlag}${shellQuote(target)}`;
        const r = await this.runner.execInsideContainer(this.containerName, { command: cmd }, this.limits);
        // ripgrep exits 1 when no matches; treat as empty result, not error.
        if (r.exitCode === 1 && !r.stderr)
            return '';
        if (r.exitCode !== 0 && r.exitCode !== 1) {
            throw new Error(`sandbox grep failed (exit ${r.exitCode}): ${r.stderr}`);
        }
        return r.stdout;
    }
    async glob(pattern, opts) {
        if (this.closed)
            throw new Error(`sandbox ${this.id} already closed`);
        const target = opts?.path ? sandboxRelative(opts.path) : '.';
        const cmd = `rg --files --glob ${shellQuote(pattern)} ${shellQuote(target)}`;
        const r = await this.runner.execInsideContainer(this.containerName, { command: cmd }, this.limits);
        if (r.exitCode === 1 && !r.stderr)
            return '';
        if (r.exitCode !== 0 && r.exitCode !== 1) {
            throw new Error(`sandbox glob failed (exit ${r.exitCode}): ${r.stderr}`);
        }
        return r.stdout;
    }
    async syncToHost(opts) {
        void opts;
        if (this.fsMode === 'bind' || this.fsMode === 'none') {
            // Host already sees every write; nothing to propagate.
            return { added: [], modified: [], removed: [], conflictResolution: 'merged' };
        }
        // P1 — real overlay. When upperDir is set, walk it for the diff
        // and apply onto hostWorkdir via applyOverlay.
        if (this.upperDir) {
            const r = await applyOverlay(this.upperDir, this.hostWorkdir, {
                ...(this.baselineMtimes ? { baselineMtimes: this.baselineMtimes } : {}),
            }).catch((err) => {
                // syncToHost should never throw — log and return empty.
                // Future: surface via state broadcast.
                void err;
                return null;
            });
            if (!r)
                return { added: [], modified: [], removed: [], conflictResolution: 'merged' };
            return {
                added: r.added,
                modified: r.modified,
                removed: r.removed,
                conflictResolution: r.conflictResolution,
            };
        }
        // Overlay disabled (ANVIL_SANDBOX_REAL_OVERLAY=0) — fall back
        // to F3 behavior: detect conflicts via baseline mtimes only.
        if (!this.baselineMtimes) {
            return { added: [], modified: [], removed: [], conflictResolution: 'merged' };
        }
        const r = await applyOverlay(this.hostWorkdir, this.hostWorkdir, {
            dryRun: true,
            baselineMtimes: this.baselineMtimes,
        }).catch(() => null);
        if (!r)
            return { added: [], modified: [], removed: [], conflictResolution: 'merged' };
        return {
            added: r.added,
            modified: r.modified,
            removed: r.removed,
            conflictResolution: r.conflictResolution,
        };
    }
    async snapshot() {
        if (this.closed)
            throw new Error(`sandbox ${this.id} already closed`);
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
        }
        catch { /* ignore */ }
        return {
            contentHash: 'sha256:docker-runner-placeholder',
            sizeBytes,
            fileCount,
            capturedAt: new Date().toISOString(),
        };
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        await this.runner.removeContainer(this.containerName).catch(() => { });
        // P1 — clean up host-side overlay tmpdirs unless the user opted
        // out for debugging. The parent sandbox-state/<runId>/<stage>/<uuid>
        // dir holds both upper + work; nuke the uuid level.
        if (process.env.ANVIL_SANDBOX_KEEP_UPPER !== '1' && this.upperDir) {
            const parent = path.dirname(this.upperDir);
            await fsp.rm(parent, { recursive: true, force: true }).catch(() => { });
        }
    }
}
export class DockerSandboxRunner {
    handles = new Map();
    opts;
    constructor(opts = {}) {
        this.opts = {
            dockerBin: opts.dockerBin ?? process.env.DOCKER_BIN ?? 'docker',
            defaultImage: opts.defaultImage ?? DEFAULT_SANDBOX_IMAGE,
            idleTtlMs: opts.idleTtlMs ?? 5 * 60 * 1000,
            cacheMode: opts.cacheMode ?? 'read-only',
            ...(opts.spawnFn ? { spawnFn: opts.spawnFn } : {}),
        };
    }
    async acquire(opts) {
        const containerName = `anvil-sb-${opts.runId.slice(0, 8)}-${opts.stage}-${randomUUID().slice(0, 8)}`;
        const image = opts.image ?? this.opts.defaultImage;
        const hostWorkdir = path.resolve(opts.hostWorkdir);
        await fsp.access(hostWorkdir).catch(() => {
            throw new Error(`hostWorkdir does not exist: ${hostWorkdir}`);
        });
        const fsMode = opts.fsMode ?? 'overlay';
        // P1 — when fsMode='overlay', materialize host-side upper + work
        // tmpdirs that the container mounts via fuse-overlayfs. Path lives
        // under the sandbox-state root so a crashed dashboard can find
        // (and gc) orphaned upper trees later.
        let upperDir = null;
        let workDir = null;
        if (fsMode === 'overlay' && process.env.ANVIL_SANDBOX_REAL_OVERLAY !== '0') {
            const stateRoot = process.env.ANVIL_SANDBOX_STATE_ROOT
                ?? path.join(process.env.HOME ?? '/tmp', '.anvil', 'sandbox-state');
            const sandboxStateDir = path.join(stateRoot, opts.runId, opts.stage, randomUUID().slice(0, 8));
            upperDir = path.join(sandboxStateDir, 'upper');
            workDir = path.join(sandboxStateDir, 'work');
            await fsp.mkdir(upperDir, { recursive: true });
            await fsp.mkdir(workDir, { recursive: true });
        }
        const cacheMounts = buildCacheMounts({
            defaultMode: this.opts.cacheMode,
        });
        // F9 — bind cache mounts inherit host uid/gid via --user. Without
        // this, RW cache mounts (e.g. npm install populating ~/.npm) fail
        // when the container's `anvil` user (uid 1001) tries to write to
        // a directory owned by the host user (typically uid 501 on macOS,
        // 1000 on Linux). Read-only mounts also benefit because tools
        // like `git` refuse to operate on a tree owned by a different uid
        // (the "dubious ownership" warning).
        // F3 — resolve and splice the per-stage network policy. The
        // AcquireSandboxOpts surface doesn't yet pass a fully-resolved
        // policy, so we synthesise one from the limits.network field
        // (set by core-pipeline's STAGE_SANDBOX_POLICY) plus any
        // pre-resolved overlay the caller passed via opts.limits.network.
        const resolved = opts.limits?.network
            ? resolveNetworkPolicy({
                stagePolicy: { mode: 'container', fsMode: 'overlay', limits: { network: opts.limits.network } },
                projectOverlay: undefined,
            })
            : null;
        // P1 — overlay mount triple. When fsMode='overlay' AND the runner
        // materialized upper/work tmpdirs, the entrypoint script
        // (`anvil-init-overlay`) mounts fuse-overlayfs across them.
        // Otherwise the legacy bind-mount path runs unchanged.
        const overlayMounts = (upperDir && workDir)
            ? [
                '--mount', `type=bind,src=${hostWorkdir},dst=/workspace.lower,readonly`,
                '--mount', `type=bind,src=${upperDir},dst=/workspace.upper`,
                '--mount', `type=bind,src=${workDir},dst=/workspace.work`,
                // fuse-overlayfs needs /dev/fuse access. macOS Docker Desktop
                // exposes it via the underlying Linux VM.
                '--device', '/dev/fuse',
                // AppArmor on some hosts blocks fuse mounts without this.
                '--security-opt', 'apparmor=unconfined',
            ]
            : [
                // Legacy bind-mode — host = sandbox at /workspace.
                '--mount', `type=bind,src=${hostWorkdir},dst=${SANDBOX_WORKDIR}`,
            ];
        const args = [
            'run',
            '-d', // detached
            '--name', containerName,
            '--workdir', SANDBOX_WORKDIR,
            ...this.userArgs(),
            ...overlayMounts,
            // S5: per-stage resource limits — memory, cpus, pids, disk.
            ...dockerRunLimitArgs(opts.limits),
            // S8: read-only package-manager cache mounts.
            ...dockerCacheMountArgs(cacheMounts),
            // F3: per-stage network policy (default-deny + allow-list).
            ...(resolved ? dockerRunNetworkArgs(resolved) : []),
            // Block exec without a TTY so a poisoned container can't run an
            // interactive shell to phone home.
            '--init',
            // Keep the container alive — we'll exec into it.
            image,
            'sh', '-c', 'tail -f /dev/null',
        ];
        const out = await this.dockerCli(args);
        if (out.exitCode !== 0) {
            throw new DockerRunnerError(`docker run failed (exit ${out.exitCode}): ${out.stderr.trim() || out.stdout.trim()}`, { stderr: out.stderr });
        }
        const handle = new DockerSandboxHandle(this, {
            id: containerName,
            containerName,
            hostWorkdir,
            image,
            limits: opts.limits ?? {},
            fsMode,
        });
        if (upperDir)
            handle.upperDir = upperDir;
        if (workDir)
            handle.workDir = workDir;
        if (fsMode === 'overlay') {
            // F3 — capture baseline mtimes so syncToHost can detect host
            // edits during the sandbox lifetime. Best-effort; failures
            // degrade to "no baseline → no conflict detection".
            handle.baselineMtimes = await captureBaselineMtimes(hostWorkdir).catch(() => new Map());
        }
        this.handles.set(handle.id, handle);
        return handle;
    }
    async list() {
        const now = Date.now();
        return Array.from(this.handles.values()).map((h) => ({
            id: h.id,
            runtime: 'docker',
            ageMs: now - h.createdAtMs,
            busy: h.busy,
        }));
    }
    async sweep() {
        const now = Date.now();
        let closed = 0;
        for (const [id, h] of this.handles) {
            if (h.busy)
                continue;
            if (h.closed || now - h.createdAtMs > this.opts.idleTtlMs) {
                await h.close();
                this.handles.delete(id);
                closed += 1;
            }
        }
        return { closed };
    }
    async shutdown() {
        for (const h of this.handles.values()) {
            await h.close().catch(() => { });
        }
        this.handles.clear();
    }
    /**
     * Return `--user <uid>:<gid>` so bind-mounted writes land owned by
     * the host user. F9 — fixes uid mismatch between container's
     * `anvil` user (uid 1001) and host user (501 on macOS / 1000 on
     * Linux). Defaults to `process.getuid()` / `process.getgid()`.
     * On platforms without these (Windows-ish), returns no flag.
     */
    userArgs() {
        if (process.env.ANVIL_SANDBOX_NO_USER === '1')
            return [];
        // Type guard — Node 22 always has these on POSIX, undefined elsewhere.
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        const gid = typeof process.getgid === 'function' ? process.getgid() : null;
        if (uid === null || gid === null)
            return [];
        return ['--user', `${uid}:${gid}`];
    }
    async execInsideContainer(containerName, args, limits) {
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
        if (args.stdin)
            dockerArgs.push('-i');
        dockerArgs.push(containerName, 'sh', '-c', args.command);
        return this.runDockerExec(dockerArgs, args, startedAt, timeoutMs);
    }
    async removeContainer(name) {
        await this.dockerCli(['rm', '-f', name]).catch(() => { });
    }
    /** Pull (or build) the sandbox image. Idempotent — `docker pull` is a
     *  no-op when the image is already present at the requested tag. */
    async ensureImage(image = this.opts.defaultImage) {
        const r = await this.dockerCli(['image', 'inspect', image]);
        if (r.exitCode === 0)
            return;
        const pull = await this.dockerCli(['pull', image]);
        if (pull.exitCode !== 0) {
            throw new DockerRunnerError(`docker pull ${image} failed: ${pull.stderr.trim() || pull.stdout.trim()}`, { stderr: pull.stderr });
        }
    }
    /** Test/diagnostic — returns true iff the docker CLI is on PATH and
     *  responds to `docker version`. */
    async isAvailable() {
        const r = await this.dockerCli(['version', '--format', '{{.Server.Version}}']).catch(() => null);
        return !!r && r.exitCode === 0;
    }
    /** Low-level: spawn `docker` with the provided argv. Used internally
     *  + by S4/S5 helpers for network / limit setup. */
    async dockerCli(argv) {
        return runDockerProcess(this.opts.dockerBin, argv, { spawnFn: this.opts.spawnFn });
    }
    runDockerExec(dockerArgs, execArgs, startedAt, timeoutMs) {
        return new Promise((resolve) => {
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
                const out = {
                    exitCode: res.exitCode,
                    stdout: res.stdout,
                    stderr: res.stderr,
                    durationMs: Date.now() - startedAt,
                };
                if (res.killedByLimit) {
                    out.killedByLimit = res.killedByLimit;
                }
                else {
                    // S5: classify exit codes / stderr for OOM / disk / pid kills.
                    const detected = detectLimitKill({
                        exitCode: res.exitCode,
                        stderr: res.stderr,
                    });
                    if (detected)
                        out.killedByLimit = detected;
                }
                if (res.truncated)
                    out.truncated = res.truncated;
                resolve(out);
            });
        });
    }
}
export class DockerRunnerError extends Error {
    name = 'DockerRunnerError';
    stderr;
    constructor(message, opts) {
        super(message);
        if (opts?.stderr)
            this.stderr = opts.stderr;
    }
}
// ───────────────────────────────────────────────────────────────────────
// Helpers
// ───────────────────────────────────────────────────────────────────────
function sandboxRelative(p) {
    if (!p)
        throw new Error('path is required');
    if (path.isAbsolute(p)) {
        if (p.startsWith(SANDBOX_WORKDIR + '/') || p === SANDBOX_WORKDIR) {
            return p;
        }
        throw new Error(`path escapes sandbox workdir: ${p}`);
    }
    // Reject `..` traversal regardless of intermediate joins.
    const segs = p.split('/');
    if (segs.includes('..'))
        throw new Error(`path escapes sandbox workdir: ${p}`);
    return p;
}
function shellQuote(s) {
    if (s.length === 0)
        return "''";
    if (/^[A-Za-z0-9_./-]+$/.test(s))
        return s;
    return `'${s.replace(/'/g, `'\\''`)}'`;
}
function pickTimeoutMs(args, limits) {
    const fromArgs = args.timeoutMs;
    const fromLimits = limits.timeoutSeconds !== undefined ? limits.timeoutSeconds * 1000 : undefined;
    if (fromArgs !== undefined && fromLimits !== undefined)
        return Math.min(fromArgs, fromLimits);
    return fromArgs ?? fromLimits ?? DEFAULT_EXEC_TIMEOUT_MS;
}
export function collectChildOutput(child, opts) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        let stdoutTrunc = 0;
        let stderrTrunc = 0;
        let killedByLimit;
        let finished = false;
        const finish = () => {
            if (finished)
                return;
            finished = true;
            try {
                child.kill('SIGKILL');
            }
            catch { /* already exited */ }
        };
        const timer = setTimeout(() => {
            killedByLimit = 'timeout';
            finish();
        }, opts.timeoutMs);
        const onAbort = () => finish();
        if (opts.signal?.aborted) {
            clearTimeout(timer);
            onAbort();
        }
        else if (opts.signal) {
            opts.signal.addEventListener('abort', onAbort, { once: true });
        }
        if (opts.stdin && child.stdin) {
            child.stdin.end(opts.stdin);
        }
        child.stdout?.on('data', (b) => {
            const remaining = opts.stdioCap - stdout.length;
            if (remaining > 0)
                stdout += b.toString('utf8').slice(0, remaining);
            if (b.length > remaining)
                stdoutTrunc += Math.max(0, b.length - Math.max(0, remaining));
        });
        child.stderr?.on('data', (b) => {
            const remaining = opts.stdioCap - stderr.length;
            if (remaining > 0)
                stderr += b.toString('utf8').slice(0, remaining);
            if (b.length > remaining)
                stderrTrunc += Math.max(0, b.length - Math.max(0, remaining));
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            const result = {
                exitCode: null,
                stdout,
                stderr: stderr + (stderr ? '\n' : '') + `spawn error: ${err.message}`,
            };
            resolve(result);
        });
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            opts.signal?.removeEventListener('abort', onAbort);
            const result = { exitCode: code, stdout, stderr };
            if (killedByLimit)
                result.killedByLimit = killedByLimit;
            else if (signal)
                result.killedByLimit = 'timeout';
            if (stdoutTrunc > 0 || stderrTrunc > 0) {
                result.truncated = { stdout: stdoutTrunc, stderr: stderrTrunc };
            }
            resolve(result);
        });
    });
}
async function runDockerProcess(bin, argv, opts) {
    return new Promise((resolve) => {
        const spawnFn = opts.spawnFn ?? spawn;
        const child = spawnFn(bin, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (b) => { stdout += b.toString('utf8'); });
        child.stderr?.on('data', (b) => { stderr += b.toString('utf8'); });
        child.on('error', (err) => {
            resolve({ exitCode: null, stdout, stderr: stderr + `\nspawn error: ${err.message}` });
        });
        child.on('exit', (code) => resolve({ exitCode: code, stdout, stderr }));
    });
}
//# sourceMappingURL=docker-runner.js.map