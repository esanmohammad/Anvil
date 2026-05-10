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
export function dockerRunLimitArgs(limits: SandboxLimits | undefined): string[] {
  if (!limits) return [];
  const args: string[] = [];

  if (limits.memoryMiB !== undefined && limits.memoryMiB > 0) {
    args.push('--memory', `${limits.memoryMiB}m`);
    // memory-swap match prevents the container from spilling to swap
    // (which would defeat the point of the cap).
    args.push('--memory-swap', `${limits.memoryMiB}m`);
  }
  if (limits.cpus !== undefined && limits.cpus > 0) {
    args.push('--cpus', String(limits.cpus));
  }
  if (limits.pids !== undefined && limits.pids > 0) {
    args.push('--pids-limit', String(limits.pids));
  }
  if (limits.diskMiB !== undefined && limits.diskMiB > 0) {
    // Only certain storage drivers honor `--storage-opt size=`. The
    // emit is best-effort — drivers that don't honor it ignore the
    // flag rather than failing the run.
    args.push('--storage-opt', `size=${limits.diskMiB}m`);
  }

  return args;
}

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
export function detectLimitKill(opts: {
  exitCode: number | null;
  signal?: string | null;
  stderr: string;
  oomKilled?: boolean;
}): SandboxExecResult['killedByLimit'] {
  // OOM is the strongest signal — the kernel sent SIGKILL.
  if (opts.oomKilled) return 'oom';

  // signal SIGKILL with a high exit code typically indicates either
  // OOM or our own timeout. The runner's `killedByLimit = 'timeout'`
  // path hits before we get here.
  if (opts.signal === 'SIGKILL') return 'oom';

  // Exit 137 = 128 + 9 (SIGKILL); without OOM, treat as memory kill.
  if (opts.exitCode === 137) return 'oom';

  // Exit 139 = SIGSEGV — not a limit kill, leave undefined.

  // PID-limit symptom: fork/clone errors in stderr.
  if (
    /fork\s*:\s*Resource temporarily unavailable/i.test(opts.stderr) ||
    /clone\s*:\s*Resource temporarily unavailable/i.test(opts.stderr) ||
    /pthread_create.*EAGAIN/i.test(opts.stderr)
  ) {
    return 'pid';
  }

  // Disk-full symptom.
  if (
    /No space left on device/i.test(opts.stderr) ||
    /write error.*disk/i.test(opts.stderr)
  ) {
    return 'disk';
  }

  return undefined;
}

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
export function parseDockerStatsLine(line: string, limits: SandboxLimits): LimitMonitorSnapshot {
  const parts = line.split('|').map((s) => s.trim());
  const memUsage = parts[0] ?? '';
  const cpuPerc = parts[1] ?? '';
  const pids = parts[2] ?? '';

  const memMatch = memUsage.match(/^([\d.]+)\s*(KiB|MiB|GiB|B)\b/i);
  let memoryUsedMiB = 0;
  if (memMatch) {
    const v = Number.parseFloat(memMatch[1]!);
    const unit = (memMatch[2] ?? 'MiB').toUpperCase();
    memoryUsedMiB = unit === 'KIB' ? v / 1024
      : unit === 'GIB' ? v * 1024
      : unit === 'B' ? v / (1024 * 1024)
      : v;
  }

  const cpuMatch = cpuPerc.match(/^([\d.]+)/);
  const cpuPercent = cpuMatch ? Number.parseFloat(cpuMatch[1]!) : 0;
  const pidsUsed = Number.parseInt(pids, 10) || 0;

  return {
    memoryUsedMiB: Math.round(memoryUsedMiB),
    memoryCapMiB: limits.memoryMiB ?? 0,
    cpuPercent,
    pidsUsed,
    pidsCap: limits.pids ?? 0,
    capturedAt: new Date().toISOString(),
  };
}
