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
import type { AcquireSandboxOpts, SandboxExecArgs, SandboxExecResult, SandboxHandle, SandboxLimits, SandboxRunner, SandboxRunnerListEntry, SandboxSnapshot, SandboxSyncResult } from '@esankhan3/anvil-core-pipeline/sandbox/types.js';
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
export declare class FirecrackerSandboxHandle implements SandboxHandle {
    private readonly runner;
    readonly id: string;
    readonly runtime: "firecracker";
    readonly workdir = "/workspace";
    readonly limits: SandboxLimits;
    readonly hostWorkdir: string;
    readonly image: string;
    readonly vmName: string;
    readonly createdAtMs: number;
    busy: boolean;
    closed: boolean;
    constructor(runner: FirecrackerSandboxRunner, opts: {
        id: string;
        vmName: string;
        hostWorkdir: string;
        image: string;
        limits: SandboxLimits;
    });
    exec(args: SandboxExecArgs): Promise<SandboxExecResult>;
    read(filePath: string): Promise<string>;
    write(filePath: string, content: string | Buffer): Promise<void>;
    edit(filePath: string, oldString: string, newString: string, replaceAll?: boolean): Promise<void>;
    syncToHost(_opts?: {
        mode?: 'merge' | 'replace';
    }): Promise<SandboxSyncResult>;
    snapshot(): Promise<SandboxSnapshot>;
    close(): Promise<void>;
}
export declare class FirecrackerSandboxRunner implements SandboxRunner {
    private readonly handles;
    private readonly opts;
    constructor(opts?: FirecrackerOptions);
    acquire(opts: AcquireSandboxOpts): Promise<SandboxHandle>;
    list(): Promise<readonly SandboxRunnerListEntry[]>;
    sweep(): Promise<{
        closed: number;
    }>;
    shutdown(): Promise<void>;
    execInsideVM(vmName: string, args: SandboxExecArgs, limits: SandboxLimits): Promise<SandboxExecResult>;
    removeVM(vmName: string): Promise<void>;
    /**
     * Probe — returns true iff the ctr binary is on PATH and KVM is
     * accessible. macOS / Windows always fall through to Docker.
     */
    isAvailable(): Promise<boolean>;
    ctrCli(argv: readonly string[]): Promise<{
        exitCode: number | null;
        stdout: string;
        stderr: string;
    }>;
}
//# sourceMappingURL=firecracker-runner.d.ts.map