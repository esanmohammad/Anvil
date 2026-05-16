/**
 * Resource limit translator — Phase S5.
 *
 * Maps the runtime-agnostic `SandboxLimits` (§E) onto Docker-specific
 * `docker run` flags, detects when a container was killed for hitting
 * one of those limits, and exposes a periodic limit-monitor poll for
 * the dashboard's status panel.
 *
 * Pure module — no docker process spawning here. The DockerSandboxRunner
 * splices these flags into its `docker run` argv.
 */
import type { SandboxLimits, SandboxExecResult } from '@esankhan3/anvil-core-pipeline/sandbox/types.js';
/**
 * Convert SandboxLimits → docker run flags. Skipped fields land
 * with no flag (Docker uses host defaults).
 */
export declare function dockerRunLimitArgs(limits: SandboxLimits | undefined): string[];
/**
 * Inspect a docker exec result and decide whether the runtime killed
 * the process for resource exhaustion.
 *
 * Inputs:
 *   - exit code + stderr from the exec.
 *   - optional `oom` flag from docker inspect.
 *
 * Returns the appropriate `LimitKind` or undefined when nothing
 * indicates a limit-related kill.
 */
export declare function detectLimitKill(opts: {
    exitCode: number | null;
    signal?: string | null;
    stderr: string;
    oomKilled?: boolean;
}): SandboxExecResult['killedByLimit'];
/**
 * Poll a docker container's resource usage. Returns a snapshot for
 * the dashboard's status panel. Implementation calls the docker
 * runner's `dockerCli` helper.
 */
export interface LimitMonitorSnapshot {
    /** Current memory usage in MiB. */
    memoryUsedMiB: number;
    /** Memory cap in MiB (echoes the SandboxLimits value). */
    memoryCapMiB: number;
    /** Current CPU usage percent (0..100 per allocated core). */
    cpuPercent: number;
    /** Current pid count. */
    pidsUsed: number;
    /** PID cap (echoes the SandboxLimits value). */
    pidsCap: number;
    /** When the snapshot was taken. */
    capturedAt: string;
}
/**
 * Parse `docker stats --no-stream --format ...` output into a snapshot.
 * Format string the runner uses: `{{.MemUsage}} | {{.CPUPerc}} | {{.PIDs}}`.
 *
 * Example input: `"100MiB / 4GiB | 12.34% | 8"`.
 */
export declare function parseDockerStatsLine(line: string, limits: SandboxLimits): LimitMonitorSnapshot;
//# sourceMappingURL=resource-limits.d.ts.map