/**
 * Image management helpers for the Docker sandbox runner.
 *
 * - `pullAnvilSandboxImage` ensures the canonical sandbox image is
 *   present on the host. Used by `cli/src/commands/doctor.ts
 *   --pull-sandbox` to pre-warm.
 * - `resolveSandboxImageTag` picks the right tag for the running
 *   core-pipeline version so an upgrade doesn't silently keep using
 *   a stale image.
 */
import { spawn } from 'node:child_process';
export interface PullOptions {
    /** Override the docker binary (env: DOCKER_BIN). */
    dockerBin?: string;
    /** Test seam: replace the spawn function. */
    spawnFn?: typeof spawn;
}
export interface PullResult {
    ok: boolean;
    stdout: string;
    stderr: string;
}
/**
 * Pull the canonical sandbox image. No-op when the image is already
 * present at the requested tag. Returns `{ ok: false, ... }` instead
 * of throwing so callers can render the Docker output verbatim.
 */
export declare function pullAnvilSandboxImage(image?: string, opts?: PullOptions): Promise<PullResult>;
/**
 * Best-effort version-pinned tag. Falls back to `:latest` when the
 * core-pipeline version isn't resolvable (e.g. test runs without dist).
 */
export declare function resolveSandboxImageTag(coreVersion: string | undefined): string;
//# sourceMappingURL=docker-image.d.ts.map