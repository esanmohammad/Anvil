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

import { DEFAULT_SANDBOX_IMAGE } from './docker-runner.js';

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
export async function pullAnvilSandboxImage(
  image: string = DEFAULT_SANDBOX_IMAGE,
  opts: PullOptions = {},
): Promise<PullResult> {
  const dockerBin = opts.dockerBin ?? process.env.DOCKER_BIN ?? 'docker';
  const spawnFn = opts.spawnFn ?? spawn;

  const inspect = await runDocker(spawnFn, dockerBin, ['image', 'inspect', image]);
  if (inspect.exitCode === 0) {
    return { ok: true, stdout: '', stderr: '' };
  }

  const pull = await runDocker(spawnFn, dockerBin, ['pull', image]);
  return {
    ok: pull.exitCode === 0,
    stdout: pull.stdout,
    stderr: pull.stderr,
  };
}

/**
 * Best-effort version-pinned tag. Falls back to `:latest` when the
 * core-pipeline version isn't resolvable (e.g. test runs without dist).
 */
export function resolveSandboxImageTag(coreVersion: string | undefined): string {
  if (!coreVersion || !/^\d+\.\d+\.\d+/.test(coreVersion)) {
    return DEFAULT_SANDBOX_IMAGE;
  }
  return `anvil/sandbox:${coreVersion}`;
}

function runDocker(
  spawnFn: typeof spawn,
  bin: string,
  argv: readonly string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawnFn(bin, argv as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (b: Buffer) => { stdout += b.toString('utf8'); });
    child.stderr?.on('data', (b: Buffer) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => resolve({ exitCode: null, stdout, stderr: stderr + `\nspawn error: ${err.message}` }));
    child.on('exit', (code) => resolve({ exitCode: code, stdout, stderr }));
  });
}
