/**
 * Sandbox-runner contract — every isolated workspace runtime
 * (`none` / `docker` / `podman` / `firecracker` / `gvisor`) implements
 * this surface. See `docs/sandbox-isolation-plan.md` §E for design notes.
 *
 * One `SandboxHandle` = one isolated workspace. Stages call
 * `exec` / `read` / `write` / `edit` / `syncToHost` / `snapshot` against
 * the handle. `close()` releases the underlying container/VM. The
 * `SandboxRunner` factory mints handles on demand and runs the pool +
 * eviction lifecycle.
 */

/** All concrete runtimes. The factory in `runner-registry.ts` maps each. */
export type SandboxRuntime =
  | 'none'         // Mode 0: passthrough — runs on the host.
  | 'docker'       // Mode 1: Docker (default container runtime).
  | 'podman'       // Mode 1: rootless alternate.
  | 'firecracker'  // Mode 2: hardware-isolated microVM.
  | 'gvisor';      // Mode 2: user-space kernel.

export interface NetworkPolicy {
  /** Default-deny vs default-allow. */
  default: 'deny' | 'allow';
  /** Hosts/CIDR explicitly allowed (regardless of default). */
  allowList?: readonly string[];
  /** Hosts/CIDR explicitly blocked (regardless of default). */
  blockList?: readonly string[];
  /** Allow loopback. Default true (so localhost dev servers work). */
  allowLoopback?: boolean;
  /** DNS resolver inside the sandbox. Defaults to the runtime's. */
  dnsResolver?: string;
}

export interface SandboxLimits {
  /** Max RAM in MiB. */
  memoryMiB?: number;
  /** Max CPU shares (1.0 = one full core). */
  cpus?: number;
  /** Max wall-clock seconds. */
  timeoutSeconds?: number;
  /** Max processes (PID limit). */
  pids?: number;
  /** Max disk usage in MiB. */
  diskMiB?: number;
  /** Network policy. */
  network?: NetworkPolicy;
}

export interface SandboxExecArgs {
  /** The command line. Always passed to `sh -c` inside the sandbox. */
  command: string;
  /** Override workdir for this exec. Defaults to `handle.workdir`. */
  cwd?: string;
  /** Extra env vars layered on top of the sandbox's baseline. */
  env?: Record<string, string>;
  /** Soft timeout. Caps at `handle.limits.timeoutSeconds`. */
  timeoutMs?: number;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Optional stdin. */
  stdin?: string | Buffer;
}

export type LimitKind = 'timeout' | 'memory' | 'cpu' | 'disk' | 'pid' | 'oom';

export interface SandboxExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when the runtime killed the process for resource exhaustion. */
  killedByLimit?: LimitKind;
  /** Wall-clock duration. */
  durationMs: number;
  /** How many bytes were truncated past the cap, per stream. */
  truncated?: { stdout: number; stderr: number };
}

export interface SandboxSnapshot {
  /** SHA-256 of the sandbox's content tree (workdir only). */
  contentHash: string;
  /** Byte size of the workdir. */
  sizeBytes: number;
  /** Number of files. */
  fileCount: number;
  /** When the snapshot was taken. */
  capturedAt: string;
}

export interface SandboxSyncResult {
  /** Files added since the previous sync. */
  added: readonly string[];
  /** Files modified since the previous sync. */
  modified: readonly string[];
  /** Files removed since the previous sync. */
  removed: readonly string[];
  /** Conflict resolution: which side won (sandbox vs host). */
  conflictResolution: 'sandbox-wins' | 'host-wins' | 'merged';
}

export interface SandboxHandle {
  /** Stable id for telemetry + durable log. */
  readonly id: string;
  /** The runtime that vends this handle. */
  readonly runtime: SandboxRuntime;
  /** Inside-the-sandbox path of the project workspace. */
  readonly workdir: string;
  /** Resource limits applied to the sandbox. */
  readonly limits: SandboxLimits;

  /**
   * Run a command inside the sandbox. Stdout/stderr captured + capped
   * (default 64 KiB per stream). Exit code is part of the result —
   * non-zero is NOT an error here; the caller decides.
   *
   * Must respect `signal` for cancellation.
   */
  exec(args: SandboxExecArgs): Promise<SandboxExecResult>;

  /**
   * Read a file from inside the sandbox. Path is resolved relative to
   * `workdir`. Symlink resolution is sandbox-internal — host paths
   * cannot be reached even if the agent constructs a malicious path.
   */
  read(path: string, opts?: { offset?: number; limit?: number }): Promise<string>;

  /** Write a file inside the sandbox. Auto-creates parent dirs. */
  write(path: string, content: string | Buffer): Promise<void>;

  /**
   * Replace `oldString` with `newString` inside `path`. Same semantics
   * as the existing `edit` builtin tool.
   */
  edit(path: string, oldString: string, newString: string, replaceAll?: boolean): Promise<void>;

  /**
   * Phase P2 — ripgrep dispatched inside the sandbox. Returns
   * stdout from `rg --no-heading --line-number --color=never -e
   * <pattern> <path>` (or workdir when path is omitted).
   * Implementations cap output at 64 KiB to mirror the builtin
   * runProcess behavior.
   */
  grep?(pattern: string, opts?: { path?: string; glob?: string }): Promise<string>;

  /**
   * Phase P2 — glob via `rg --files --glob <pattern> <path>` inside
   * the sandbox. Returns one path per line, relative to the sandbox
   * workdir.
   */
  glob?(pattern: string, opts?: { path?: string }): Promise<string>;

  /**
   * Sync the sandbox's workdir back to the host workdir. Modes vary:
   *   - `'overlay'`: copy-on-write diff propagation.
   *   - `'bind'`: no-op — already shared.
   *   - `'none'`: no-op — sandbox not isolated.
   */
  syncToHost(opts?: { mode?: 'merge' | 'replace' }): Promise<SandboxSyncResult>;

  /**
   * Take a content-addressed snapshot of the sandbox state. Used by
   * the durable layer to record exact-input hashing for replay.
   */
  snapshot(): Promise<SandboxSnapshot>;

  /** Idempotent — calling twice is safe. */
  close(): Promise<void>;
}

export interface AcquireSandboxOpts {
  /** Project + run + stage for telemetry. */
  project: string;
  runId: string;
  stage: string;
  /** Host-side path to the workspace. Bind-mounted into the sandbox. */
  hostWorkdir: string;
  /** Image tag to launch. Defaults to `anvil/sandbox:<core-pipeline-version>`. */
  image?: string;
  /** Per-stage limits. Merged with runtime defaults. */
  limits?: SandboxLimits;
  /** Filesystem propagation mode. Default `'overlay'` for write+exec stages;
   *  `'bind'` for read-only stages that need exec. */
  fsMode?: SandboxFsMode;
  /** Reuse a pooled sandbox vs always cold-start. Default true. */
  reusePool?: boolean;
}

export type SandboxFsMode = 'overlay' | 'bind' | 'none';

export interface SandboxRunner {
  /** Acquire a sandbox handle. Reuses a pooled one when available. */
  acquire(opts: AcquireSandboxOpts): Promise<SandboxHandle>;
  /** Currently-live handles. For the dashboard's status panel. */
  list(): Promise<readonly SandboxRunnerListEntry[]>;
  /** Sweep idle handles past their TTL. Called periodically. */
  sweep(): Promise<{ closed: number }>;
  /** Hard-close everything. Used at shutdown. */
  shutdown(): Promise<void>;
}

export interface SandboxRunnerListEntry {
  id: string;
  runtime: SandboxRuntime;
  ageMs: number;
  busy: boolean;
}

/**
 * Per-stage policy entry — the canonical runtime + fsMode + limits a
 * stage runs with. Lives in `routing/sandbox-policy.ts`.
 */
export interface StageSandboxPolicyEntry {
  /** The mode declared on the policy table. `none` means run-on-host;
   *  `container` resolves to the runtime configured by the user
   *  (`docker` by default; `podman`/`firecracker`/`gvisor` opt-in). */
  mode: 'none' | 'container' | 'microVM';
  /** Filesystem propagation mode. */
  fsMode: SandboxFsMode;
  /** Resource limits for the stage. */
  limits?: SandboxLimits;
  /** Free-text rationale rendered in the dashboard's policy view. */
  notes?: string;
}

/** Anvil-specific replay error: state hash mismatch on `exec` replay. */
export class SandboxDeterminismViolationError extends Error {
  override readonly name = 'SandboxDeterminismViolationError';
  constructor(
    message: string,
    public readonly recordedHash: string,
    public readonly currentHash: string,
  ) {
    super(message);
  }
}
