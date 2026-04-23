/**
 * test-executor — real executor for TestRuns.
 *
 * Given a set of TestCase[] authored against a TestSpec, this module spawns
 * the appropriate test runner (vitest / jest / mocha / pytest / go-test),
 * parses its structured output where possible, maps results back to the
 * TestCase.id, re-runs failing cases for flakiness detection, and returns a
 * final ExecuteResult the caller can persist to TestRunStore.
 *
 * Design goals:
 *   - Streamed stdout/stderr (no blocking on huge buffers).
 *   - Wall-clock timeout with graceful SIGTERM → SIGKILL escalation.
 *   - Best-effort caseId mapping: falls back to an "aggregate" case when the
 *     reporter's output can't be tied to individual cases.
 *   - Defensive parsing: a malformed JSON report never throws; we fall back
 *     to a regex-aggregate path and surface the parse failure via onLog.
 */

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  Runner,
  TestCase,
  TestRun,
  TestRunResult,
} from './test-types.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface ExecuteOptions {
  project: string;
  repoLocalPath: string;
  runner: Runner;
  cases: TestCase[];
  filePaths?: string[];
  timeoutMs?: number;
  flakinessRerunCount?: number;
  onLog?: (stream: 'stdout' | 'stderr', line: string) => void;
}

export interface ExecuteResult {
  results: TestRunResult[];
  status: TestRun['status'];
  verdict: TestRun['verdict'];
  flakyQuarantined: string[];
  rawOutput: string;
  durationMs: number;
}

// ── Internal types ───────────────────────────────────────────────────────

interface SpawnResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  combined: string;        // concatenated in the order lines arrived
  timedOut: boolean;
  spawnError?: string;
}

/**
 * A single per-test outcome from a parsed reporter. `file` is a repo-relative
 * path; `title` is the test's display name; `ord` is its zero-based index
 * within that file (used for disambiguation when multiple TestCases share a
 * file).
 */
interface ParsedOutcome {
  file: string;
  title: string;
  pass: boolean;
  durationMs: number;
  failure?: string;
  ord: number;
}

interface ParsedReport {
  outcomes: ParsedOutcome[];
  parseError?: string;
}

const MAX_RAW_OUTPUT = 20_000;
const DEFAULT_TIMEOUT_MS = 300_000;
const DEFAULT_FLAKY_RERUNS = 2;

// ── Entry point ──────────────────────────────────────────────────────────

export async function executeTestRun(opts: ExecuteOptions): Promise<ExecuteResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const flakyReruns = opts.flakinessRerunCount ?? DEFAULT_FLAKY_RERUNS;
  const log = opts.onLog ?? (() => {});

  // Short-circuit: no cases → nothing to do.
  if (!opts.cases.length) {
    return {
      results: [],
      status: 'passed',
      verdict: 'pass',
      flakyQuarantined: [],
      rawOutput: '',
      durationMs: Date.now() - start,
    };
  }

  // Pass 1 — run the full set (optionally filtered to provided filePaths).
  const firstPass = await runOnce(opts, opts.filePaths ?? collectFiles(opts.cases), timeoutMs, log);

  if (firstPass.spawn.timedOut) {
    return {
      results: [timeoutResult('aggregate', firstPass.spawn)],
      status: 'error',
      verdict: 'fail',
      flakyQuarantined: [],
      rawOutput: tailOutput(firstPass.spawn.combined || `timed out after ${Math.round(timeoutMs / 1000)}s`),
      durationMs: Date.now() - start,
    };
  }
  if (firstPass.spawn.spawnError) {
    return {
      results: [{
        caseId: 'aggregate',
        pass: false,
        durationMs: Date.now() - start,
        failure: firstPass.spawn.spawnError,
      }],
      status: 'error',
      verdict: 'fail',
      flakyQuarantined: [],
      rawOutput: tailOutput(firstPass.spawn.combined),
      durationMs: Date.now() - start,
    };
  }

  // Map outcomes → TestCase.id.
  const perCaseRuns = new Map<string, Array<{ pass: boolean; durationMs: number; failure?: string }>>();
  for (const c of opts.cases) perCaseRuns.set(c.id, []);

  const firstMapping = mapOutcomesToCases(opts, firstPass.parsed, firstPass.spawn);
  for (const [caseId, rec] of firstMapping) {
    if (perCaseRuns.has(caseId)) {
      perCaseRuns.get(caseId)!.push(rec);
    } else {
      perCaseRuns.set(caseId, [rec]);
    }
  }

  // Flakiness re-runs — only re-run failing cases, up to N extra times.
  let lastRaw = firstPass.spawn.combined;
  if (flakyReruns > 0) {
    for (let i = 0; i < flakyReruns; i++) {
      const failingCaseIds = Array.from(perCaseRuns.entries())
        .filter(([caseId, runs]) => caseId !== 'aggregate' && runs.length > 0 && runs.some((r) => !r.pass))
        .map(([caseId]) => caseId);
      if (failingCaseIds.length === 0) break;

      const failingFiles = dedupe(
        failingCaseIds
          .map((id) => opts.cases.find((c) => c.id === id)?.filePath)
          .filter((v): v is string => !!v),
      );
      if (failingFiles.length === 0) break;

      log('stdout', `[test-executor] flakiness re-run ${i + 1}/${flakyReruns} on ${failingFiles.length} file(s)`);
      const rerun = await runOnce(opts, failingFiles, timeoutMs, log);
      lastRaw = rerun.spawn.combined;
      if (rerun.spawn.timedOut || rerun.spawn.spawnError) {
        // Treat a crash during rerun as "still failing" — don't mutate prior results.
        break;
      }
      const rerunMapping = mapOutcomesToCases(
        { ...opts, cases: opts.cases.filter((c) => failingCaseIds.includes(c.id)) },
        rerun.parsed,
        rerun.spawn,
      );
      for (const [caseId, rec] of rerunMapping) {
        if (perCaseRuns.has(caseId)) perCaseRuns.get(caseId)!.push(rec);
      }
    }
  }

  // Compile final per-case results.
  const results: TestRunResult[] = [];
  const flakyQuarantined: string[] = [];
  for (const [caseId, runs] of perCaseRuns) {
    if (runs.length === 0) {
      // No outcome ever matched — report as failed with a hint.
      results.push({
        caseId,
        pass: false,
        durationMs: 0,
        failure: 'No matching test result found in runner output.',
      });
      continue;
    }
    const passes = runs.filter((r) => r.pass).length;
    const fails = runs.length - passes;
    const totalMs = runs.reduce((a, r) => a + r.durationMs, 0);
    const avgMs = Math.round(totalMs / runs.length);

    if (fails === 0) {
      results.push({ caseId, pass: true, durationMs: avgMs });
    } else if (passes === 0) {
      const lastFail = [...runs].reverse().find((r) => !r.pass);
      const entry: TestRunResult = { caseId, pass: false, durationMs: avgMs };
      if (lastFail?.failure) entry.failure = lastFail.failure;
      results.push(entry);
    } else {
      // Mixed — flaky. Conservatively mark failed + record score.
      const flakyScore = fails / runs.length;
      const lastFail = [...runs].reverse().find((r) => !r.pass);
      const entry: TestRunResult = {
        caseId,
        pass: false,
        durationMs: avgMs,
        flakyScore,
      };
      if (lastFail?.failure) entry.failure = lastFail.failure;
      results.push(entry);
      flakyQuarantined.push(caseId);
    }
  }

  // Verdict / status.
  const hardFail = results.some((r) => !r.pass && r.flakyScore === undefined);
  const anyFlaky = flakyQuarantined.length > 0;
  let status: TestRun['status'];
  let verdict: TestRun['verdict'];
  if (hardFail) {
    status = 'failed';
    verdict = 'fail';
  } else if (anyFlaky) {
    status = 'passed';
    verdict = 'warn';
  } else {
    status = 'passed';
    verdict = 'pass';
  }

  return {
    results,
    status,
    verdict,
    flakyQuarantined,
    rawOutput: tailOutput(lastRaw || firstPass.spawn.combined),
    durationMs: Date.now() - start,
  };
}

// ── Command selection ────────────────────────────────────────────────────

interface CommandSpec {
  cmd: string;
  args: string[];
  /** When true, the reporter writes JSON to stdout (we parse spawn stdout). */
  jsonOnStdout: boolean;
  /** Path the reporter writes JSON to on disk (if it's not stdout). */
  reportFile?: string;
}

interface PkgJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readPkg(repo: string): PkgJson | null {
  try {
    const p = join(repo, 'package.json');
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8')) as PkgJson;
  } catch {
    return null;
  }
}

function hasDep(pkg: PkgJson | null, name: string): boolean {
  if (!pkg) return false;
  return !!((pkg.dependencies && pkg.dependencies[name]) ||
    (pkg.devDependencies && pkg.devDependencies[name]));
}

function hasPytestJsonReport(repo: string): boolean {
  // Heuristic: pyproject.toml mentioning pytest-json-report, or a venv with it.
  try {
    const py = join(repo, 'pyproject.toml');
    if (existsSync(py)) {
      const text = readFileSync(py, 'utf-8');
      if (/pytest-json-report/i.test(text)) return true;
    }
    const req = join(repo, 'requirements.txt');
    if (existsSync(req)) {
      const text = readFileSync(req, 'utf-8');
      if (/pytest-json-report/i.test(text)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

function buildCommand(
  runner: Runner,
  repoLocalPath: string,
  filePaths: string[] | undefined,
): CommandSpec {
  const pkg = readPkg(repoLocalPath);
  switch (runner) {
    case 'vitest': {
      const args = ['vitest', 'run', '--reporter=json'];
      if (filePaths && filePaths.length) args.push(...filePaths);
      return { cmd: 'npx', args, jsonOnStdout: true };
    }
    case 'jest': {
      const args = ['jest', '--json', '--silent', '--testLocationInResults'];
      if (filePaths && filePaths.length) args.push(...filePaths);
      return { cmd: 'npx', args, jsonOnStdout: true };
    }
    case 'mocha': {
      const args = ['mocha', '--reporter', 'json'];
      if (filePaths && filePaths.length) args.push(...filePaths);
      return { cmd: 'npx', args, jsonOnStdout: true };
    }
    case 'pytest': {
      const hasJsonPlugin = hasPytestJsonReport(repoLocalPath);
      if (hasJsonPlugin) {
        const args = ['-m', 'pytest', '--json-report', '--json-report-file=-'];
        if (filePaths && filePaths.length) args.push(...filePaths);
        return { cmd: 'python', args, jsonOnStdout: true };
      }
      const args = ['-m', 'pytest', '-v', '--tb=short'];
      if (filePaths && filePaths.length) args.push(...filePaths);
      return { cmd: 'python', args, jsonOnStdout: false };
    }
    case 'go-test': {
      // Go test doesn't take file paths cleanly — skip the filter.
      return { cmd: 'go', args: ['test', '-json', './...'], jsonOnStdout: true };
    }
    case 'unknown':
    default: {
      // Prefer `npm test` if one is declared; otherwise fall back to a bare invoke.
      if (pkg?.scripts?.test) {
        return { cmd: 'npm', args: ['test', '--silent'], jsonOnStdout: false };
      }
      return { cmd: 'npm', args: ['test'], jsonOnStdout: false };
    }
  }
}

// ── Spawn + stream ───────────────────────────────────────────────────────

function spawnAndCollect(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  log: (stream: 'stdout' | 'stderr', line: string) => void,
): Promise<SpawnResult> {
  return new Promise<SpawnResult>((resolve) => {
    let stdout = '';
    let stderr = '';
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
        stdout: '',
        stderr: '',
        combined: '',
        timedOut: false,
        spawnError: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const settle = (result: SpawnResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const wallTimer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGTERM');
      } catch { /* ignore */ }
      // Force kill if still alive after 2s.
      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch { /* ignore */ }
      }, 2_000);
      // Make sure we don't leak the timer.
      hardKill.unref?.();
    }, timeoutMs);
    wallTimer.unref?.();

    const onLine = (stream: 'stdout' | 'stderr', line: string) => {
      if (!line) return;
      log(stream, line);
    };

    let stdoutBuf = '';
    let stderrBuf = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      stdout += s;
      combined += s;
      stdoutBuf += s;
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        onLine('stdout', stdoutBuf.slice(0, idx));
        stdoutBuf = stdoutBuf.slice(idx + 1);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      stderr += s;
      combined += s;
      stderrBuf += s;
      let idx: number;
      while ((idx = stderrBuf.indexOf('\n')) !== -1) {
        onLine('stderr', stderrBuf.slice(0, idx));
        stderrBuf = stderrBuf.slice(idx + 1);
      }
    });

    child.on('error', (err) => {
      clearTimeout(wallTimer);
      settle({
        code: null,
        signal: null,
        stdout,
        stderr,
        combined,
        timedOut,
        spawnError: err.message,
      });
    });
    child.on('close', (code, signal) => {
      clearTimeout(wallTimer);
      if (stdoutBuf) onLine('stdout', stdoutBuf);
      if (stderrBuf) onLine('stderr', stderrBuf);
      settle({ code, signal, stdout, stderr, combined, timedOut });
    });
  });
}

// ── Orchestration per pass ───────────────────────────────────────────────

async function runOnce(
  opts: ExecuteOptions,
  filePaths: string[] | undefined,
  timeoutMs: number,
  log: (stream: 'stdout' | 'stderr', line: string) => void,
): Promise<{ spawn: SpawnResult; parsed: ParsedReport }> {
  const spec = buildCommand(opts.runner, opts.repoLocalPath, filePaths);
  const commandLine = `${spec.cmd} ${spec.args.join(' ')}`;
  log('stdout', `[test-executor] $ ${commandLine} (cwd: ${opts.repoLocalPath})`);

  const result = await spawnAndCollect(spec.cmd, spec.args, opts.repoLocalPath, timeoutMs, log);

  if (result.timedOut) {
    return { spawn: result, parsed: { outcomes: [] } };
  }
  if (result.spawnError) {
    return { spawn: result, parsed: { outcomes: [] } };
  }

  const parsed = parseReport(opts.runner, spec, result, log);
  return { spawn: result, parsed };
}

// ── Parse reporter output ────────────────────────────────────────────────

function parseReport(
  runner: Runner,
  spec: CommandSpec,
  res: SpawnResult,
  log: (stream: 'stdout' | 'stderr', line: string) => void,
): ParsedReport {
  try {
    switch (runner) {
      case 'vitest':
        return parseVitest(res.stdout);
      case 'jest':
        return parseJest(res.stdout);
      case 'mocha':
        return parseMocha(res.stdout);
      case 'pytest':
        return spec.jsonOnStdout ? parsePytestJson(res.stdout) : parsePytestText(res.combined);
      case 'go-test':
        return parseGoTest(res.stdout);
      case 'unknown':
      default:
        return { outcomes: [] };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('stderr', `[test-executor] reporter parse failed: ${msg} — falling back to aggregate`);
    return { outcomes: [], parseError: msg };
  }
}

/**
 * Vitest JSON reporter is Jest-compatible — shared parser.
 */
function parseVitest(stdout: string): ParsedReport {
  return parseJestLike(stdout);
}

function parseJest(stdout: string): ParsedReport {
  return parseJestLike(stdout);
}

interface JestJson {
  testResults?: Array<{
    name?: string;
    testFilePath?: string;
    assertionResults?: Array<{
      title?: string;
      fullName?: string;
      status?: string;     // 'passed' | 'failed' | 'pending' | 'skipped' | ...
      duration?: number | null;
      failureMessages?: string[];
    }>;
  }>;
}

function parseJestLike(stdout: string): ParsedReport {
  const json = extractJsonObject(stdout);
  if (!json) return { outcomes: [], parseError: 'no JSON object in stdout' };
  const parsed = JSON.parse(json) as JestJson;
  const outcomes: ParsedOutcome[] = [];
  const fileCounters = new Map<string, number>();
  for (const tr of parsed.testResults ?? []) {
    const file = tr.testFilePath ?? tr.name ?? '';
    for (const ar of tr.assertionResults ?? []) {
      const ord = fileCounters.get(file) ?? 0;
      fileCounters.set(file, ord + 1);
      const pass = ar.status === 'passed';
      const out: ParsedOutcome = {
        file,
        title: ar.fullName ?? ar.title ?? '',
        pass,
        durationMs: Math.max(0, Math.round(ar.duration ?? 0)),
        ord,
      };
      if (!pass && ar.failureMessages && ar.failureMessages.length) {
        out.failure = ar.failureMessages.join('\n').slice(0, 4_000);
      }
      outcomes.push(out);
    }
  }
  return { outcomes };
}

interface MochaJson {
  passes?: Array<{ fullTitle?: string; title?: string; file?: string; duration?: number }>;
  failures?: Array<{
    fullTitle?: string;
    title?: string;
    file?: string;
    duration?: number;
    err?: { message?: string; stack?: string };
  }>;
}

function parseMocha(stdout: string): ParsedReport {
  const json = extractJsonObject(stdout);
  if (!json) return { outcomes: [], parseError: 'no JSON object in stdout' };
  const parsed = JSON.parse(json) as MochaJson;
  const outcomes: ParsedOutcome[] = [];
  const fileCounters = new Map<string, number>();
  const push = (
    entry: { fullTitle?: string; title?: string; file?: string; duration?: number; err?: { message?: string; stack?: string } },
    pass: boolean,
  ) => {
    const file = entry.file ?? '';
    const ord = fileCounters.get(file) ?? 0;
    fileCounters.set(file, ord + 1);
    const out: ParsedOutcome = {
      file,
      title: entry.fullTitle ?? entry.title ?? '',
      pass,
      durationMs: Math.max(0, Math.round(entry.duration ?? 0)),
      ord,
    };
    if (!pass && entry.err) {
      const msg = [entry.err.message, entry.err.stack].filter(Boolean).join('\n');
      if (msg) out.failure = msg.slice(0, 4_000);
    }
    outcomes.push(out);
  };
  for (const p of parsed.passes ?? []) push(p, true);
  for (const f of parsed.failures ?? []) push(f, false);
  return { outcomes };
}

interface PytestJson {
  tests?: Array<{
    nodeid?: string;
    outcome?: string;             // 'passed' | 'failed' | 'skipped' | 'error'
    duration?: number;            // seconds
    call?: { longrepr?: string; duration?: number };
    longrepr?: string;
  }>;
}

function parsePytestJson(stdout: string): ParsedReport {
  const json = extractJsonObject(stdout);
  if (!json) return { outcomes: [], parseError: 'no JSON object in stdout' };
  const parsed = JSON.parse(json) as PytestJson;
  const outcomes: ParsedOutcome[] = [];
  const fileCounters = new Map<string, number>();
  for (const t of parsed.tests ?? []) {
    const nodeid = t.nodeid ?? '';
    const [file, ...rest] = nodeid.split('::');
    const ord = fileCounters.get(file) ?? 0;
    fileCounters.set(file, ord + 1);
    const durSec = t.duration ?? t.call?.duration ?? 0;
    const pass = t.outcome === 'passed';
    const out: ParsedOutcome = {
      file,
      title: rest.join('::') || nodeid,
      pass,
      durationMs: Math.max(0, Math.round(durSec * 1000)),
      ord,
    };
    if (!pass) {
      const rep = t.call?.longrepr ?? t.longrepr ?? '';
      if (rep) out.failure = rep.slice(0, 4_000);
    }
    outcomes.push(out);
  }
  return { outcomes };
}

/**
 * Fallback pytest parser — regex over the verbose "-v" text output.
 * Matches lines like:
 *   tests/test_foo.py::test_bar PASSED           [ 25%]
 *   tests/test_foo.py::test_bar FAILED           [ 50%]
 */
function parsePytestText(text: string): ParsedReport {
  const outcomes: ParsedOutcome[] = [];
  const fileCounters = new Map<string, number>();
  const re = /^([^\s]+\.py)::([^\s]+)\s+(PASSED|FAILED|ERROR|SKIPPED)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const file = m[1];
    const title = m[2];
    const status = m[3];
    const ord = fileCounters.get(file) ?? 0;
    fileCounters.set(file, ord + 1);
    outcomes.push({
      file,
      title,
      pass: status === 'PASSED',
      durationMs: 0,
      ord,
      ...(status === 'PASSED' ? {} : { failure: `pytest reported ${status}` }),
    });
  }
  return { outcomes };
}

/**
 * Go test -json emits a stream of JSON objects (one per line), each with
 * { Action, Test, Package, Output, Elapsed }. We consume pass/fail events
 * for individual Tests (skip Package-level events where Test is absent).
 */
interface GoEvent {
  Action?: string;     // 'run' | 'pass' | 'fail' | 'skip' | 'output' | ...
  Test?: string;
  Package?: string;
  Output?: string;
  Elapsed?: number;    // seconds
}

function parseGoTest(stdout: string): ParsedReport {
  const outcomes: ParsedOutcome[] = [];
  const failureBuf = new Map<string, string>();    // key = Package::Test
  const fileCounters = new Map<string, number>();
  const lines = stdout.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    let ev: GoEvent;
    try {
      ev = JSON.parse(trimmed) as GoEvent;
    } catch {
      continue;
    }
    if (!ev.Test) continue;
    const key = `${ev.Package ?? ''}::${ev.Test}`;
    if (ev.Action === 'output' && typeof ev.Output === 'string') {
      const prev = failureBuf.get(key) ?? '';
      failureBuf.set(key, (prev + ev.Output).slice(0, 8_000));
      continue;
    }
    if (ev.Action === 'pass' || ev.Action === 'fail' || ev.Action === 'skip') {
      const file = ev.Package ?? '';
      const ord = fileCounters.get(file) ?? 0;
      fileCounters.set(file, ord + 1);
      const pass = ev.Action === 'pass';
      const durSec = ev.Elapsed ?? 0;
      const out: ParsedOutcome = {
        file,
        title: ev.Test,
        pass,
        durationMs: Math.max(0, Math.round(durSec * 1000)),
        ord,
      };
      if (!pass) {
        const buf = failureBuf.get(key);
        if (buf) out.failure = buf.slice(0, 4_000);
      }
      outcomes.push(out);
    }
  }
  return { outcomes };
}

/**
 * Pull the first balanced JSON object out of arbitrary stdout. Runners
 * sometimes intersperse warnings or progress lines before the JSON payload,
 * so a pure `JSON.parse(stdout)` is too fragile.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// ── Outcome → TestCase mapping ───────────────────────────────────────────

interface CaseRunRec {
  pass: boolean;
  durationMs: number;
  failure?: string;
}

/**
 * Map parsed outcomes onto TestCase.id. Strategy:
 *   1. Build a map filePath → TestCase[] (in declared order).
 *   2. Walk outcomes grouped by file; assign the Nth outcome in a file to
 *      the Nth case registered for that file.
 *   3. Outcomes whose file matches no case are counted into the aggregate.
 *   4. If nothing maps at all (no outcomes parsed), we fall back to an
 *      aggregate pass/fail derived from the exit code.
 */
function mapOutcomesToCases(
  opts: ExecuteOptions,
  parsed: ParsedReport,
  spawnRes: SpawnResult,
): Map<string, CaseRunRec> {
  const out = new Map<string, CaseRunRec>();

  // No outcomes at all — aggregate from exit code.
  if (parsed.outcomes.length === 0) {
    const pass = spawnRes.code === 0;
    const rec: CaseRunRec = {
      pass,
      durationMs: 0,
    };
    if (!pass) {
      rec.failure = parsed.parseError
        ? `Reporter output unparseable (${parsed.parseError}); runner exited ${spawnRes.code}.`
        : `Runner exited ${spawnRes.code}.`;
    }
    // Best-effort: if the run failed and we have exactly one case, attribute
    // the failure to it; otherwise emit an aggregate.
    if (opts.cases.length === 1) {
      out.set(opts.cases[0].id, rec);
    } else if (pass) {
      // All cases pass when the runner reports green with no detail.
      for (const c of opts.cases) out.set(c.id, { pass: true, durationMs: 0 });
    } else {
      out.set('aggregate', rec);
    }
    return out;
  }

  // Group cases by normalised filePath.
  const casesByFile = new Map<string, TestCase[]>();
  for (const c of opts.cases) {
    const key = normalisePath(c.filePath);
    if (!casesByFile.has(key)) casesByFile.set(key, []);
    casesByFile.get(key)!.push(c);
  }

  // Match each outcome to its file bucket, then to its ordinal case.
  const unmatchedFails: ParsedOutcome[] = [];
  let matchedAny = false;
  for (const o of parsed.outcomes) {
    const normalised = normalisePath(o.file);
    const bucket = findBucket(casesByFile, normalised);
    if (!bucket || bucket.length === 0) {
      if (!o.pass) unmatchedFails.push(o);
      continue;
    }
    // Pick by ordinal; clamp to the last case if the runner produced more
    // outcomes than we have cases for this file (e.g. inner nested tests).
    const idx = Math.min(o.ord, bucket.length - 1);
    const target = bucket[idx];
    const rec: CaseRunRec = { pass: o.pass, durationMs: o.durationMs };
    if (!o.pass && o.failure) rec.failure = o.failure;
    // If we've already assigned this case (duplicate), prefer a failure over a pass
    // (conservative: any observed fail = fail).
    const prev = out.get(target.id);
    if (!prev || (prev.pass && !rec.pass)) out.set(target.id, rec);
    matchedAny = true;
  }

  // Any case we never saw an outcome for, but whose file had *no* outcomes,
  // is treated as passing ONLY if the run exited 0 — otherwise, we surface
  // it as "not found" (caller will see pass=false with a helpful failure).
  const runGreen = spawnRes.code === 0;
  for (const c of opts.cases) {
    if (!out.has(c.id)) {
      if (runGreen) {
        out.set(c.id, { pass: true, durationMs: 0 });
      } else {
        out.set(c.id, {
          pass: false,
          durationMs: 0,
          failure: 'No matching test outcome — check that the case was collected by the runner.',
        });
      }
    }
  }

  // Unmatched failures that didn't map to any case become an aggregate fail,
  // but only if we otherwise had no matched outcomes (avoid double-counting).
  if (!matchedAny && unmatchedFails.length > 0) {
    out.set('aggregate', {
      pass: false,
      durationMs: 0,
      failure: unmatchedFails.slice(0, 3).map((f) => `${f.file}: ${f.title}`).join('\n'),
    });
  }

  return out;
}

// ── Utilities ────────────────────────────────────────────────────────────

function normalisePath(p: string): string {
  if (!p) return '';
  // Drop leading "./" and collapse backslashes for Windows-origin paths.
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Find a case bucket by file. Try an exact normalised match first, then a
 * suffix match (to bridge absolute runner paths against repo-relative
 * TestCase.filePaths).
 */
function findBucket(
  map: Map<string, TestCase[]>,
  outcomeFile: string,
): TestCase[] | undefined {
  if (map.has(outcomeFile)) return map.get(outcomeFile);
  for (const [key, bucket] of map) {
    if (outcomeFile.endsWith(key) || key.endsWith(outcomeFile)) return bucket;
  }
  return undefined;
}

function collectFiles(cases: TestCase[]): string[] {
  return dedupe(cases.map((c) => c.filePath).filter((p): p is string => !!p));
}

function dedupe<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function tailOutput(text: string): string {
  if (text.length <= MAX_RAW_OUTPUT) return text;
  return `…[truncated ${text.length - MAX_RAW_OUTPUT} chars]…\n` + text.slice(-MAX_RAW_OUTPUT);
}

function timeoutResult(caseId: string, s: SpawnResult): TestRunResult {
  return {
    caseId,
    pass: false,
    durationMs: 0,
    failure: `Test run timed out. Last signal: ${s.signal ?? 'SIGTERM'}.`,
  };
}
