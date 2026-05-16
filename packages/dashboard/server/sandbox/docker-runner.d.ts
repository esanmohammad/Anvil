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
import type { AcquireSandboxOpts, SandboxExecArgs, SandboxExecResult, SandboxHandle, SandboxLimits, SandboxRunner, SandboxRunnerListEntry, SandboxSnapshot, SandboxSyncResult } from '@esankhan3/anvil-core-pipeline/sandbox/types.js';
import { type CacheMode } from './cache-mounts.js';
/** Default base image. Overridable via `AcquireSandboxOpts.image`. */
export declare const DEFAULT_SANDBOX_IMAGE = "anvil/sandbox:latest";
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
export declare class DockerSandboxHandle implements SandboxHandle {
    private readonly runner;
    readonly id: string;
    readonly runtime: "docker";
    readonly workdir = "/workspace";
    readonly limits: SandboxLimits;
    readonly hostWorkdir: string;
    readonly image: string;
    readonly containerName: string;
    readonly fsMode: 'overlay' | 'bind' | 'none';
    readonly createdAtMs: number;
    /** Baseline mtimes captured at acquire — used by overlay sync to
     *  detect host edits during the sandbox lifetime. */
    baselineMtimes: Map<string, number> | null;
    /** Host-side path to the upper tmpdir (real overlay mode). The
     *  container sees this at /workspace.upper. syncToHost walks this
     *  tree to apply the diff. */
    upperDir: string | null;
    /** Host-side path to the work tmpdir (overlay requires it; we don't
     *  read it, just clean up at close). */
    workDir: string | null;
    busy: boolean;
    closed: boolean;
    constructor(runner: DockerSandboxRunner, opts: {
        id: string;
        containerName: string;
        hostWorkdir: string;
        image: string;
        limits: SandboxLimits;
        fsMode: 'overlay' | 'bind' | 'none';
    });
    exec(args: SandboxExecArgs): Promise<SandboxExecResult>;
    read(filePath: string, opts?: {
        offset?: number;
        limit?: number;
    }): Promise<string>;
    write(filePath: string, content: string | Buffer): Promise<void>;
    edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<void>;
    grep(pattern: string, opts?: {
        path?: string;
        glob?: string;
    }): Promise<string>;
    glob(pattern: string, opts?: {
        path?: string;
    }): Promise<string>;
    syncToHost(opts?: {
        mode?: 'merge' | 'replace';
    }): Promise<SandboxSyncResult>;
    snapshot(): Promise<SandboxSnapshot>;
    close(): Promise<void>;
}
export declare class DockerSandboxRunner implements SandboxRunner {
    private readonly handles;
    private readonly opts;
    constructor(opts?: DockerSandboxOptions);
    acquire(opts: AcquireSandboxOpts): Promise<SandboxHandle>;
    list(): Promise<readonly SandboxRunnerListEntry[]>;
    sweep(): Promise<{
        closed: number;
    }>;
    shutdown(): Promise<void>;
    /**
     * Return `--user <uid>:<gid>` so bind-mounted writes land owned by
     * the host user. F9 — fixes uid mismatch between container's
     * `anvil` user (uid 1001) and host user (501 on macOS / 1000 on
     * Linux). Defaults to `process.getuid()` / `process.getgid()`.
     * On platforms without these (Windows-ish), returns no flag.
     */
    private userArgs;
    execInsideContainer(containerName: string, args: SandboxExecArgs, limits: SandboxLimits): Promise<SandboxExecResult>;
    removeContainer(name: string): Promise<void>;
    /** Pull (or build) the sandbox image. Idempotent — `docker pull` is a
     *  no-op when the image is already present at the requested tag. */
    ensureImage(image?: string): Promise<void>;
    /** Test/diagnostic — returns true iff the docker CLI is on PATH and
     *  responds to `docker version`. */
    isAvailable(): Promise<boolean>;
    /** Low-level: spawn `docker` with the provided argv. Used internally
     *  + by S4/S5 helpers for network / limit setup. */
    dockerCli(argv: readonly string[]): Promise<{
        exitCode: number | null;
        stdout: string;
        stderr: string;
    }>;
    private runDockerExec;
}
export declare class DockerRunnerError extends Error {
    readonly name = "DockerRunnerError";
    readonly stderr?: string;
    constructor(message: string, opts?: {
        stderr?: string;
    });
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
    truncated?: {
        stdout: number;
        stderr: number;
    };
}
export declare function collectChildOutput(child: ChildProcess, opts: CollectOpts): Promise<CollectResult>;
export {};
//# sourceMappingURL=docker-runner.d.ts.map