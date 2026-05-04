/**
 * mutation-runner — Phase 2 MVP wrapper around Stryker (JS/TS) for
 * Anvil's test-generation feature.
 *
 * Runs after a normal TestRun completes: spawn Stryker against the
 * project's existing tests, parse the JSON mutation report, and return
 * per-file mutation scores the caller can stuff onto the TestRun and
 * feed into TestLearningsStore.updateMutationScore().
 *
 * Out of scope here:
 *   - Python mutmut — stub returns { supported: false, score: null }.
 *   - Go go-mutesting — stub returns { supported: false, score: null }.
 *   - Installing Stryker — we rely on the repo's devDep or `npx` fetch.
 *
 * Zero side effects at module load.
 */

import { spawn as cpSpawn } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { Runner } from './test-types.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface MutationRunOptions {
  repoLocalPath: string;
  runner: Runner;
  /** Which files to mutate (subset). If empty, mutate everything Stryker finds. */
  targetFiles?: string[];
  /** Timeout for the whole mutation run in ms (default 10 min). */
  timeoutMs?: number;
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface MutationRunResult {
  supported: boolean;                   // false for non-JS/TS runners
  score: number | null;                 // 0..1, null if unsupported or error
  killed: number;
  survived: number;
  total: number;
  byFile: Record<string, number>;       // normalized file path → score 0..1
  stryker: {
    ran: boolean;
    configFilePath?: string;
    reportFilePath?: string;
    error?: string;
  };
  durationMs: number;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const SIGKILL_GRACE_MS = 2_000;
const TEMP_CONFIG_NAME = 'stryker.conf.anvil.tmp.json';
const DEFAULT_REPORT_REL = join('reports', 'mutation', 'mutation.json');

const STRYKER_CONFIG_CANDIDATES = [
  'stryker.conf.js',
  'stryker.conf.mjs',
  'stryker.conf.cjs',
  'stryker.conf.json',
  '.stryker.conf.js',
  '.stryker.conf.mjs',
  '.stryker.conf.cjs',
  '.stryker.conf.json',
];

const JS_TS_RUNNERS: ReadonlySet<Runner> = new Set<Runner>(['vitest', 'jest', 'mocha']);

// Stryker mutant statuses (v5/v6/v7 all share these — format differences
// are mostly in file-level fields we don't rely on).
type MutantStatus =
  | 'Killed'
  | 'Survived'
  | 'Timeout'
  | 'NoCoverage'
  | 'RuntimeError'
  | 'CompileError'
  | 'Ignored'
  | 'Pending';

interface StrykerMutant {
  id?: string;
  status?: MutantStatus;
}

interface StrykerFileReport {
  mutants?: StrykerMutant[];
}

interface StrykerJsonReport {
  files?: Record<string, StrykerFileReport>;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function emptyResult(
  supported: boolean,
  error: string | undefined,
  durationMs: number,
  extras: Partial<MutationRunResult['stryker']> = {},
): MutationRunResult {
  const stryker: MutationRunResult['stryker'] = { ran: false, ...extras };
  if (error !== undefined) stryker.error = error;
  return {
    supported,
    score: null,
    killed: 0,
    survived: 0,
    total: 0,
    byFile: {},
    stryker,
    durationMs,
  };
}

function tail(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}

function findExistingStrykerConfig(repoLocalPath: string): string | null {
  for (const name of STRYKER_CONFIG_CANDIDATES) {
    const p = join(repoLocalPath, name);
    try {
      if (existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function writeTempStrykerConfig(
  repoLocalPath: string,
  runner: Runner,
  targetFiles?: string[],
): string {
  const configPath = join(repoLocalPath, TEMP_CONFIG_NAME);
  const mutate =
    targetFiles && targetFiles.length > 0
      ? targetFiles.slice()
      : ['src/**/*.{js,ts,jsx,tsx}', '!src/**/*.spec.*', '!src/**/*.test.*'];

  const cfg = {
    testRunner: runner,
    reporters: ['json'],
    jsonReporter: { fileName: join('reports', 'mutation', 'mutation.json') },
    mutate,
    coverageAnalysis: 'off',
  };
  writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
  return configPath;
}

function safeUnlink(p: string): void {
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* ignore */
  }
}

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  spawnError?: Error;
  stderrTail: string;
}

function runStryker(
  repoLocalPath: string,
  configPath: string | null,
  timeoutMs: number,
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void,
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const args = ['stryker', 'run', '--reporters', 'json'];
    if (configPath) {
      args.push('-c', configPath);
    }

    let child;
    try {
      child = cpSpawn('npx', args, {
        cwd: repoLocalPath,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (err) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        spawnError: err instanceof Error ? err : new Error(String(err)),
        stderrTail: '',
      });
      return;
    }

    let stderrBuf = '';
    const STDERR_KEEP = 4_000; // enough that `tail(..., 2000)` is always safe.

    const splitAndEmit = (
      buf: { value: string },
      chunk: string,
      stream: 'stdout' | 'stderr',
    ) => {
      buf.value += chunk;
      let nl = buf.value.indexOf('\n');
      while (nl !== -1) {
        const line = buf.value.slice(0, nl);
        buf.value = buf.value.slice(nl + 1);
        if (onLog) {
          try {
            onLog(stream, line);
          } catch {
            /* never let a logger break the run */
          }
        }
        nl = buf.value.indexOf('\n');
      }
    };

    const stdoutLineBuf = { value: '' };
    const stderrLineBuf = { value: '' };

    child.stdout?.on('data', (chunk: Buffer) => {
      splitAndEmit(stdoutLineBuf, chunk.toString('utf-8'), 'stdout');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderrBuf += text;
      if (stderrBuf.length > STDERR_KEEP) {
        stderrBuf = stderrBuf.slice(stderrBuf.length - STDERR_KEEP);
      }
      splitAndEmit(stderrLineBuf, text, 'stderr');
    });

    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      // Escalate to SIGKILL if the process hasn't exited within 2s.
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, SIGKILL_GRACE_MS);
    }, timeoutMs);

    const settle = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      // Flush any trailing partial lines.
      if (onLog) {
        if (stdoutLineBuf.value) {
          try { onLog('stdout', stdoutLineBuf.value); } catch { /* ignore */ }
        }
        if (stderrLineBuf.value) {
          try { onLog('stderr', stderrLineBuf.value); } catch { /* ignore */ }
        }
      }
      resolve(result);
    };

    child.on('error', (err) => {
      settle({
        code: null,
        signal: null,
        timedOut,
        spawnError: err,
        stderrTail: tail(stderrBuf, 2_000),
      });
    });

    child.on('exit', (code, signal) => {
      settle({
        code,
        signal,
        timedOut,
        stderrTail: tail(stderrBuf, 2_000),
      });
    });
  });
}

function findReportPath(repoLocalPath: string): string | null {
  const primary = join(repoLocalPath, DEFAULT_REPORT_REL);
  if (existsSync(primary)) return primary;

  const sandbox = join(
    repoLocalPath,
    '.stryker-tmp',
    'sandbox',
    'reports',
    'mutation',
    'mutation.json',
  );
  if (existsSync(sandbox)) return sandbox;

  // Fallback: any `mutation*.json` under `<repo>/reports/`.
  const reportsDir = join(repoLocalPath, 'reports');
  try {
    if (existsSync(reportsDir) && statSync(reportsDir).isDirectory()) {
      const stack: string[] = [reportsDir];
      const MAX_VISITED = 2_000;
      let visited = 0;
      while (stack.length > 0 && visited < MAX_VISITED) {
        const dir = stack.pop()!;
        let entries: string[] = [];
        try {
          entries = readdirSync(dir);
        } catch {
          continue;
        }
        for (const name of entries) {
          visited++;
          if (visited >= MAX_VISITED) break;
          const abs = join(dir, name);
          let st;
          try {
            st = statSync(abs);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
            stack.push(abs);
            continue;
          }
          if (st.isFile() && /^mutation.*\.json$/i.test(name)) {
            return abs;
          }
        }
      }
    }
  } catch {
    /* ignore */
  }

  return null;
}

function normalizeFilePath(p: string): string {
  return p.replace(/\\/g, '/');
}

interface AggregatedReport {
  score: number | null;
  killed: number;
  survived: number;
  total: number;                         // valid mutants (killed + survived + timeout)
  byFile: Record<string, number>;
}

function aggregateReport(report: StrykerJsonReport): AggregatedReport {
  let killedTotal = 0;
  let survivedTotal = 0;
  let timeoutTotal = 0;
  const byFile: Record<string, number> = {};

  const files = report.files ?? {};
  for (const [rawPath, fileReport] of Object.entries(files)) {
    const mutants = fileReport?.mutants ?? [];
    let k = 0;
    let s = 0;
    let t = 0;
    for (const m of mutants) {
      switch (m?.status) {
        case 'Killed':
          k++;
          break;
        case 'Survived':
          s++;
          break;
        case 'Timeout':
          t++;
          break;
        // Excluded from both numerator & denominator:
        //   NoCoverage, Ignored, CompileError, RuntimeError, Pending
        default:
          break;
      }
    }
    killedTotal += k;
    survivedTotal += s;
    timeoutTotal += t;

    const denom = k + s + t;
    if (denom > 0) {
      // Timeout counts as not-killed for file-level score; still in denominator.
      byFile[normalizeFilePath(rawPath)] = k / denom;
    }
  }

  const total = killedTotal + survivedTotal + timeoutTotal;
  const score = total > 0 ? killedTotal / total : null;

  return {
    score,
    killed: killedTotal,
    survived: survivedTotal,
    total,
    byFile,
  };
}

function parseReportFile(filePath: string): StrykerJsonReport | { parseError: string } {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    return { parseError: `Failed to read report: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return JSON.parse(raw) as StrykerJsonReport;
  } catch (err) {
    return { parseError: `Failed to parse report JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Public entry point ───────────────────────────────────────────────────

export async function runMutationTesting(
  opts: MutationRunOptions,
): Promise<MutationRunResult> {
  const started = Date.now();
  const { repoLocalPath, runner, targetFiles, timeoutMs, onLog } = opts;
  const effectiveTimeout = typeof timeoutMs === 'number' && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;

  // 1. Unsupported runners: return a deterministic stub immediately.
  if (!JS_TS_RUNNERS.has(runner)) {
    return emptyResult(
      false,
      'Mutation testing only supported for JS/TS runners in Phase 2',
      Date.now() - started,
    );
  }

  // 2. Detect Stryker config or write a temp one.
  const existingConfig = findExistingStrykerConfig(repoLocalPath);
  let tempConfigPath: string | null = null;
  let usedConfigPath: string | null = existingConfig;

  try {
    if (!existingConfig) {
      try {
        tempConfigPath = writeTempStrykerConfig(repoLocalPath, runner, targetFiles);
        usedConfigPath = tempConfigPath;
      } catch (err) {
        return emptyResult(
          true,
          `Failed to write temporary Stryker config: ${err instanceof Error ? err.message : String(err)}`,
          Date.now() - started,
        );
      }
    }

    // 3. Spawn Stryker via npx.
    const strykerConfigArg = tempConfigPath ?? null;
    // Pass -c only when we wrote a temp config; existing configs are auto-discovered.
    const spawnRes = await runStryker(
      repoLocalPath,
      strykerConfigArg,
      effectiveTimeout,
      onLog,
    );

    if (spawnRes.spawnError) {
      const msg = spawnRes.spawnError.message || String(spawnRes.spawnError);
      const isEnoent = /ENOENT/.test(msg);
      return emptyResult(
        true,
        isEnoent
          ? 'Command not found: npx (or stryker unavailable via npx)'
          : `Failed to spawn Stryker: ${msg}`,
        Date.now() - started,
        {
          ran: false,
          ...(usedConfigPath ? { configFilePath: usedConfigPath } : {}),
        },
      );
    }

    if (spawnRes.timedOut) {
      return emptyResult(
        true,
        `Stryker timed out after ${effectiveTimeout}ms`,
        Date.now() - started,
        {
          ran: true,
          ...(usedConfigPath ? { configFilePath: usedConfigPath } : {}),
        },
      );
    }

    const exitCode = spawnRes.code;
    const nonZeroExit = exitCode !== 0;

    // 4. Locate the report regardless of exit code (Stryker may exit non-zero
    //    with a valid report when survivors push below a threshold).
    const reportPath = findReportPath(repoLocalPath);

    if (!reportPath) {
      const stderrHint = spawnRes.stderrTail ? ` stderr: ${spawnRes.stderrTail}` : '';
      const exitHint = exitCode !== null ? `exit ${exitCode}` : `signal ${spawnRes.signal ?? 'unknown'}`;
      return emptyResult(
        true,
        `Stryker produced no report (${exitHint}).${stderrHint}`,
        Date.now() - started,
        {
          ran: true,
          ...(usedConfigPath ? { configFilePath: usedConfigPath } : {}),
        },
      );
    }

    // 5. Parse + aggregate.
    const parsed = parseReportFile(reportPath);
    if ('parseError' in parsed) {
      return emptyResult(
        true,
        parsed.parseError,
        Date.now() - started,
        {
          ran: true,
          reportFilePath: reportPath,
          ...(usedConfigPath ? { configFilePath: usedConfigPath } : {}),
        },
      );
    }

    const agg = aggregateReport(parsed);

    // If the report is structurally valid but had zero valid mutants AND
    // Stryker exited non-zero, prefer surfacing the failure.
    if (agg.total === 0 && nonZeroExit) {
      const stderrHint = spawnRes.stderrTail ? ` stderr: ${spawnRes.stderrTail}` : '';
      return emptyResult(
        true,
        `Stryker exited with code ${exitCode} and report contained no mutants.${stderrHint}`,
        Date.now() - started,
        {
          ran: true,
          reportFilePath: reportPath,
          ...(usedConfigPath ? { configFilePath: usedConfigPath } : {}),
        },
      );
    }

    // 6. Success.
    const stryker: MutationRunResult['stryker'] = {
      ran: true,
      reportFilePath: reportPath,
    };
    if (usedConfigPath) stryker.configFilePath = usedConfigPath;

    return {
      supported: true,
      score: agg.score,
      killed: agg.killed,
      survived: agg.survived,
      total: agg.total,
      byFile: agg.byFile,
      stryker,
      durationMs: Date.now() - started,
    };
  } finally {
    if (tempConfigPath) safeUnlink(tempConfigPath);
  }
}
