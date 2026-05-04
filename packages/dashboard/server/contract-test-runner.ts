/**
 * contract-test-runner — execute the contract/ suite in a consumer repo and
 * return an aggregate pass/fail summary. Thin wrapper: spawn → parse counts.
 */

import { spawn } from 'node:child_process';

import type { TestFramework } from './contract-test-author.js';

// ── Public types ────────────────────────────────────────────────────────

export interface ContractRunResult {
  framework: TestFramework;
  passed: number;
  failed: number;
  total: number;
  durationMs: number;
  rawOutput: string;
  /** Non-fatal note, e.g. "count parser fell back to exit code". */
  note?: string;
}

export interface RunInput {
  repoLocalPath: string;
  framework: TestFramework;
  /** Defaults to `contract/`. */
  filterPath?: string;
  timeoutMs?: number;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_FILTER = 'contract/';
const MAX_RAW_OUTPUT = 20_000;

// ── Entry point ─────────────────────────────────────────────────────────

export async function runContractTests(input: RunInput): Promise<ContractRunResult> {
  const start = Date.now();
  const filter = input.filterPath ?? DEFAULT_FILTER;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spec = buildCommand(input.framework, filter);

  const spawnRes = await spawnAndCollect(spec.cmd, spec.args, input.repoLocalPath, timeoutMs);
  const durationMs = Date.now() - start;
  const rawOutput = tail(spawnRes.combined);

  if (spawnRes.timedOut) {
    return {
      framework: input.framework,
      passed: 0,
      failed: 0,
      total: 0,
      durationMs,
      rawOutput,
      note: `timed out after ${Math.round(timeoutMs / 1000)}s`,
    };
  }
  if (spawnRes.spawnError) {
    return {
      framework: input.framework,
      passed: 0,
      failed: 0,
      total: 0,
      durationMs,
      rawOutput: `${spawnRes.spawnError}\n${rawOutput}`,
      note: 'spawn failed',
    };
  }

  const counts = parseCounts(input.framework, spawnRes.combined, spawnRes.code);
  return {
    framework: input.framework,
    passed: counts.passed,
    failed: counts.failed,
    total: counts.total,
    durationMs,
    rawOutput,
    ...(counts.note !== undefined ? { note: counts.note } : {}),
  };
}

// ── Command building — mirrors test-executor's approach (simpler: no JSON) ──

interface CommandSpec {
  cmd: string;
  args: string[];
}

function buildCommand(framework: TestFramework, filter: string): CommandSpec {
  switch (framework) {
    case 'vitest':
      return { cmd: 'npx', args: ['vitest', 'run', filter] };
    case 'jest':
      return { cmd: 'npx', args: ['jest', filter] };
    case 'mocha':
      return { cmd: 'npx', args: ['mocha', `${filter.replace(/\/$/, '')}/**/*.test.*`] };
    case 'pytest':
      return { cmd: 'python', args: ['-m', 'pytest', filter, '-v', '--tb=short'] };
    case 'go-test':
      // `./contract/...` lets Go pick up anything under the filter dir.
      return { cmd: 'go', args: ['test', `./${filter.replace(/\/$/, '')}/...`, '-v'] };
    case 'junit': {
      const target = filter.includes('*') || filter.endsWith('/') ? filter : `${filter}/`;
      return { cmd: 'mvn', args: ['test', `-Dtest=${target.replace(/\//g, '.')}*ContractTest`] };
    }
  }
}

// ── Result counting ─────────────────────────────────────────────────────

interface Counts {
  passed: number;
  failed: number;
  total: number;
  note?: string;
}

function parseCounts(framework: TestFramework, output: string, exitCode: number | null): Counts {
  const byFramework = countForFramework(framework, output);
  if (byFramework.total > 0) return byFramework;
  // Fall back to exit-code-only — we at least know pass vs fail.
  const pass = exitCode === 0;
  return {
    passed: pass ? 1 : 0,
    failed: pass ? 0 : 1,
    total: 1,
    note: 'count parser fell back to exit code',
  };
}

function countForFramework(framework: TestFramework, output: string): Counts {
  switch (framework) {
    case 'vitest':
      return countVitest(output);
    case 'jest':
      return countJest(output);
    case 'mocha':
      return countMocha(output);
    case 'pytest':
      return countPytest(output);
    case 'go-test':
      return countGo(output);
    case 'junit':
      return countJUnit(output);
  }
}

/** Vitest text summary: `Tests  3 passed | 1 failed (4)`. */
function countVitest(output: string): Counts {
  const m = output.match(/Tests\s+(?:(\d+)\s+passed)?(?:\s*\|\s*)?(?:(\d+)\s+failed)?/);
  if (!m) return { passed: 0, failed: 0, total: 0 };
  const passed = int(m[1]);
  const failed = int(m[2]);
  return { passed, failed, total: passed + failed };
}

/** Jest text summary: `Tests: 1 failed, 3 passed, 4 total`. */
function countJest(output: string): Counts {
  const passed = int(output.match(/(\d+)\s+passed/i)?.[1]);
  const failed = int(output.match(/(\d+)\s+failed/i)?.[1]);
  const total = int(output.match(/(\d+)\s+total/i)?.[1]);
  if (!total && !passed && !failed) return { passed: 0, failed: 0, total: 0 };
  return { passed, failed, total: total || passed + failed };
}

/** Mocha spec reporter: `3 passing`, `1 failing`. */
function countMocha(output: string): Counts {
  const passed = int(output.match(/(\d+)\s+passing/i)?.[1]);
  const failed = int(output.match(/(\d+)\s+failing/i)?.[1]);
  return { passed, failed, total: passed + failed };
}

/** Pytest summary: `===== 2 passed, 1 failed in 0.42s =====`. */
function countPytest(output: string): Counts {
  const passed = int(output.match(/(\d+)\s+passed/i)?.[1]);
  const failed = int(output.match(/(\d+)\s+failed/i)?.[1]);
  const errors = int(output.match(/(\d+)\s+error(?:s)?/i)?.[1]);
  return { passed, failed: failed + errors, total: passed + failed + errors };
}

/** `go test -v` emits `--- PASS: TestFoo` / `--- FAIL: TestBar` lines. */
function countGo(output: string): Counts {
  const passed = (output.match(/^\s*---\s+PASS:/gm) ?? []).length;
  const failed = (output.match(/^\s*---\s+FAIL:/gm) ?? []).length;
  return { passed, failed, total: passed + failed };
}

/** Maven Surefire: `Tests run: 4, Failures: 1, Errors: 0, Skipped: 0`. */
function countJUnit(output: string): Counts {
  const m = output.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)/);
  if (!m) return { passed: 0, failed: 0, total: 0 };
  const total = int(m[1]);
  const failed = int(m[2]) + int(m[3]);
  return { passed: Math.max(0, total - failed), failed, total };
}

function int(v: string | undefined): number {
  if (!v) return 0;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

// ── Spawn + collect (thin) ──────────────────────────────────────────────

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  combined: string;
  timedOut: boolean;
  spawnError?: string;
}

function spawnAndCollect(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let combined = '';
    let timedOut = false;
    let settled = false;

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        combined: '',
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const settle = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const wallTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      const hardKill = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
      }, 2_000);
      hardKill.unref?.();
    }, timeoutMs);
    wallTimer.unref?.();

    child.stdout?.on('data', (chunk: Buffer) => {
      combined += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      combined += chunk.toString('utf-8');
    });
    child.on('error', (err) => {
      clearTimeout(wallTimer);
      settle({
        code: null,
        signal: null,
        combined,
        timedOut,
        spawnError: err.message,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(wallTimer);
      settle({ code, signal, combined, timedOut });
    });
  });
}

function tail(text: string): string {
  if (text.length <= MAX_RAW_OUTPUT) return text;
  return `…[truncated ${text.length - MAX_RAW_OUTPUT} chars]…\n` + text.slice(-MAX_RAW_OUTPUT);
}
