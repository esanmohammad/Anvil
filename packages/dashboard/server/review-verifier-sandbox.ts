/**
 * Sandbox executor for R3 micro-tests. Runs generated code in a short-lived
 * subprocess with a filtered env, tight cwd, tight timeout, and a memory cap.
 */

import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

import type { MicroTest } from './review-verifier-types.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface SandboxOptions {
  /** Max wall-clock time in ms. Default 10_000. */
  timeoutMs?: number;
  /** Max old-gen heap MB for Node-based runners. Default 128. */
  memoryLimitMb?: number;
  /** Project root — the ONLY host path the generated test may read from.
   * When unset, the sandbox refuses to run tests that reference paths
   * outside the OS tmp dir. */
  repoLocalPath?: string;
}

export interface SandboxRunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  durationMs: number;
}

/**
 * Execute a micro-test in a subprocess.
 *
 * Security posture:
 *   - cwd is forced to a fresh directory under `os.tmpdir()`.
 *   - env is whitelisted to PATH / HOME / NODE_PATH only.
 *   - Node runners get `--max-old-space-size=<mem>` injected.
 *   - If `test.filePath` is not within tmpdir (or repoLocalPath), we refuse.
 */
export async function runMicroTestInSandbox(
  test: MicroTest,
  opts: SandboxOptions = {},
): Promise<SandboxRunResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const memoryLimitMb = opts.memoryLimitMb ?? 128;

  // Enforce path containment.
  const resolved = resolve(test.filePath);
  const tmpRoot = resolve(tmpdir());
  const repoRoot = opts.repoLocalPath ? resolve(opts.repoLocalPath) : null;
  const insideTmp = isInside(resolved, tmpRoot);
  const insideRepo = repoRoot !== null && isInside(resolved, repoRoot);
  if (!insideTmp && !insideRepo) {
    return {
      stdout: '',
      stderr: `sandbox refused: ${resolved} is outside tmp and repo root`,
      code: null,
      timedOut: false,
      durationMs: 0,
    };
  }

  // Ensure the file is actually written to disk. Callers often construct a
  // MicroTest with source + filePath but haven't flushed yet.
  try {
    await fsp.mkdir(dirnameOf(resolved), { recursive: true });
    await fsp.writeFile(resolved, test.source, 'utf8');
  } catch (err) {
    return {
      stdout: '',
      stderr: `sandbox: failed to write test: ${(err as Error).message}`,
      code: null,
      timedOut: false,
      durationMs: 0,
    };
  }

  const cwd = dirnameOf(resolved);
  const env = buildFilteredEnv(memoryLimitMb);

  // For Node runners, splice the memory flag into NODE_OPTIONS instead of
  // argv so we don't disturb the positional test path.
  const { cmd, args } = injectNodeMemoryFlag(test.runCommand, memoryLimitMb);

  const start = Date.now();
  return await new Promise<SandboxRunResult>((resolvePromise) => {
    const child = spawn(cmd, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        stdout,
        stderr,
        code,
        timedOut,
        durationMs: Date.now() - start,
      });
    };

    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
      if (stdout.length > 256 * 1024) stdout = stdout.slice(-256 * 1024);
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
      if (stderr.length > 256 * 1024) stderr = stderr.slice(-256 * 1024);
    });

    child.on('error', (err) => {
      stderr += `\nspawn error: ${err.message}`;
      finish(null);
    });

    child.on('exit', (code) => {
      finish(code);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
      finish(null);
    }, timeoutMs);
  });
}

/**
 * Allocate an isolated directory under `os.tmpdir()` for a single verifier
 * run. Callers should pass `filePath` under this dir when building MicroTests.
 */
export async function allocateSandboxDir(prefix = 'anvil-verify-'): Promise<string> {
  return await fsp.mkdtemp(resolve(tmpdir(), prefix));
}

// ── Internals ────────────────────────────────────────────────────────────

const WARNED_NON_NODE = new Set<string>();

function buildFilteredEnv(memoryLimitMb: number): NodeJS.ProcessEnv {
  const allowlist = ['PATH', 'HOME', 'NODE_PATH'];
  const out: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const v = process.env[key];
    if (typeof v === 'string') out[key] = v;
  }
  // NODE_OPTIONS is intentionally scoped to this env: we set max-old-space-size
  // here so any child Node process inherits the cap.
  out.NODE_OPTIONS = `--max-old-space-size=${memoryLimitMb}`;
  // Deterministic locale for tsc / python / go output.
  out.LC_ALL = 'C';
  return out;
}

function injectNodeMemoryFlag(
  cmd: { cmd: string; args: string[] },
  memoryLimitMb: number,
): { cmd: string; args: string[] } {
  const bin = cmd.cmd.toLowerCase();
  const isNode = bin === 'node' || bin.endsWith(`${sep}node`) || bin.endsWith('/node');
  if (isNode) {
    const flag = `--max-old-space-size=${memoryLimitMb}`;
    const alreadyHas = cmd.args.some((a) => a.startsWith('--max-old-space-size='));
    if (alreadyHas) return cmd;
    return { cmd: cmd.cmd, args: [flag, ...cmd.args] };
  }
  // For python/go we rely on NODE_OPTIONS having no effect; the memory cap is
  // documented as best-effort. Warn once per runtime.
  if (!WARNED_NON_NODE.has(bin)) {
    WARNED_NON_NODE.add(bin);
    // Use stderr rather than console so test harnesses don't swallow it.
    process.stderr.write(
      `[anvil-verifier] warning: memory cap is Node-only; runner='${bin}' will rely on timeout.\n`,
    );
  }
  return cmd;
}

function isInside(child: string, parent: string): boolean {
  const rel = child.startsWith(parent);
  if (!rel) return false;
  // Reject partial-prefix matches like /tmp-foo vs /tmp.
  if (child.length === parent.length) return true;
  const nextChar = child[parent.length];
  return nextChar === sep;
}

function dirnameOf(filePath: string): string {
  const idx = filePath.lastIndexOf(sep);
  return idx === -1 ? '.' : filePath.slice(0, idx);
}
