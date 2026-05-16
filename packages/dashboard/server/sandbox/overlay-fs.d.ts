/**
 * Overlay filesystem helpers — Phase S3.
 *
 * Implements the `overlay` propagation mode from
 * `docs/sandbox-isolation-plan.md` §G.2:
 *
 *   host: /Users/user/project/repo  ──── lower (read-only) ─┐
 *                                                            ├──► sandbox: /workspace
 *   sandbox-private upper (RW)  ────────────────────────────┘
 *
 * The sandbox sees the host workdir as a read-only base. All writes
 * land in a sandbox-private upper layer. At sync-to-host, this module
 * walks the upper, diffs against the lower (host), and applies the
 * delta as add/modify/delete operations.
 *
 * Conflict semantics (§G.2):
 *   - default `host-wins`: if the host file changed during the sandbox
 *     lifetime (mtime drift), the host's content stays and the
 *     sandbox's edit lands in `<file>.anvil-conflict`.
 *   - `sandbox-wins`: ship-stage default — the sandbox always wins,
 *     no conflict file.
 *
 * Pure module: no Docker required. The Docker runner uses `docker cp`
 * to populate the upper directory from inside the container; this
 * module then handles the diff walk + apply.
 */
export type ConflictPolicy = 'host-wins' | 'sandbox-wins';
export interface OverlayDiff {
    /** Files present in upper but missing in host. */
    added: string[];
    /** Files present in both with different content. */
    modified: string[];
    /** Files marked as removed in the upper (whiteout file). */
    removed: string[];
    /** Files where host changed during sandbox life — recorded but not
     *  silently applied. The caller's policy determines who wins. */
    conflicts: string[];
}
export interface ApplyResult extends OverlayDiff {
    conflictResolution: 'sandbox-wins' | 'host-wins' | 'merged';
    /** Conflict files written next to the original (`<path>.anvil-conflict`). */
    conflictFiles: string[];
}
export interface ApplyOptions {
    /** When `true`, do everything except write to the host. */
    dryRun?: boolean;
    /** Resolution policy. Default `host-wins`. */
    policy?: ConflictPolicy;
    /** Mtime baseline of the host workdir at sandbox-start. Conflict
     *  detection compares each host file's current mtime against this
     *  map; missing entries treat the host file as unchanged (i.e. the
     *  sandbox wins for files that didn't exist when the sandbox started). */
    baselineMtimes?: Map<string, number>;
    /** Skip-globs — files matching these are NEVER propagated. Default
     *  excludes `node_modules`, `.git`, `dist`, build outputs. */
    skipPatterns?: readonly RegExp[];
}
/** Walk the host workdir, recording each file's current mtime in ms. */
export declare function captureBaselineMtimes(hostRoot: string, skipPatterns?: readonly RegExp[]): Promise<Map<string, number>>;
/**
 * Diff an upper-layer directory against the host. Returns the set of
 * adds/modifies/removes/conflicts; does NOT write anything.
 */
export declare function diffOverlay(upperRoot: string, hostRoot: string, opts?: ApplyOptions): Promise<OverlayDiff>;
/**
 * Apply the overlay's diff to the host. Returns the lists of files
 * affected and the conflict resolution chosen.
 */
export declare function applyOverlay(upperRoot: string, hostRoot: string, opts?: ApplyOptions): Promise<ApplyResult>;
//# sourceMappingURL=overlay-fs.d.ts.map