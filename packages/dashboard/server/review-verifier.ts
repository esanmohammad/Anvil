/**
 * review-verifier — R3 orchestrator. For each finding, routes to the matching
 * micro-test generator based on claimType, runs the test in a sandbox, and
 * keeps/drops the finding depending on reproduction.
 */

import {
  isRecord,
  stringField,
  type MicroTest,
  type VerifierLanguage,
  type VerifierResult,
} from './review-verifier-types.js';
import { allocateSandboxDir, runMicroTestInSandbox } from './review-verifier-sandbox.js';
import { generateNullInputTest } from './review-verifier-test-generators/null-input.js';
import {
  generateTypeMismatchTest,
  interpretTscOutput,
} from './review-verifier-test-generators/type-mismatch.js';
import { claimMentionsThrow, generateThrowsTest } from './review-verifier-test-generators/throws.js';
import {
  generateAssertionTest,
  parseExpectation,
} from './review-verifier-test-generators/assertion.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface VerifierDeps {
  /** Absolute path to the repo under review (used only for path containment
   * in the sandbox — we do not read the repo directly). */
  repoLocalPath: string;
  /** file path → contents snapshot. Reserved for future: injecting the real
   * function body into probe placeholders. */
  fileContents: Record<string, string>;
}

export interface VerifierRunOptions {
  /** Max wall-clock per micro-test, ms. Default 10_000. */
  timeoutMs?: number;
  /** Memory cap for Node runners, MB. Default 128. */
  memoryLimitMb?: number;
  /** Max simultaneous verifications. Default 3. */
  concurrency?: number;
}

export interface VerifierRunSummary {
  verified: unknown[];
  dropped: unknown[];
  results: VerifierResult[];
}

export async function verifyFindings(
  findings: unknown[],
  deps: VerifierDeps,
  opts: VerifierRunOptions = {},
): Promise<VerifierRunSummary> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const memoryLimitMb = opts.memoryLimitMb ?? 128;
  const concurrency = Math.max(1, opts.concurrency ?? 3);

  const sandboxDir = await allocateSandboxDir();

  const results: VerifierResult[] = new Array(findings.length);
  let cursor = 0;

  const runOne = async (index: number): Promise<void> => {
    const finding = findings[index];
    const started = Date.now();
    try {
      const res = await verifyOne(finding, deps, { timeoutMs, memoryLimitMb, sandboxDir });
      results[index] = res;
    } catch (err) {
      results[index] = {
        finding,
        verified: false,
        reproduced: false,
        skipped: true,
        error: (err as Error).message,
        durationMs: Date.now() - started,
      };
    }
  };

  const workers: Array<Promise<void>> = [];
  const worker = async () => {
    while (true) {
      const i = cursor++;
      if (i >= findings.length) return;
      await runOne(i);
    }
  };
  for (let w = 0; w < concurrency; w++) workers.push(worker());
  await Promise.all(workers);

  // Partition.
  const verified: unknown[] = [];
  const dropped: unknown[] = [];
  for (const r of results) {
    if (r.skipped) {
      // Informational: keep the finding untouched.
      verified.push(r.finding);
      continue;
    }
    if (r.verified && r.reproduced) {
      verified.push(enrichWithEvidence(r.finding, r.evidence));
      continue;
    }
    // Verifier ran and claim did NOT reproduce → drop.
    dropped.push(r.finding);
  }

  return { verified, dropped, results };
}

// ── Internals ────────────────────────────────────────────────────────────

interface VerifyOneOpts {
  timeoutMs: number;
  memoryLimitMb: number;
  sandboxDir: string;
}

async function verifyOne(
  finding: unknown,
  deps: VerifierDeps,
  opts: VerifyOneOpts,
): Promise<VerifierResult> {
  const start = Date.now();

  const language = detectLanguage(finding);
  if (language === 'unsupported') {
    return {
      finding,
      verified: false,
      reproduced: false,
      skipped: true,
      error: 'unsupported language',
      durationMs: Date.now() - start,
    };
  }

  const functionName = extractFunctionName(finding);
  const claimType = stringField(finding, 'claimType');
  const message = stringField(finding, 'description') ?? stringField(finding, 'message');

  const micro = routeGenerator(finding, language, functionName, claimType, message);
  if (!micro) {
    return {
      finding,
      verified: false,
      reproduced: false,
      skipped: true,
      error: 'no generator applied',
      durationMs: Date.now() - start,
    };
  }

  const runnerAvailable = await isRunnerAvailable(micro);
  if (!runnerAvailable) {
    return {
      finding,
      verified: false,
      reproduced: false,
      skipped: true,
      error: `runner '${micro.runCommand.cmd}' not available on PATH`,
      durationMs: Date.now() - start,
    };
  }

  const exec = await runMicroTestInSandbox(micro, {
    timeoutMs: opts.timeoutMs,
    memoryLimitMb: opts.memoryLimitMb,
    repoLocalPath: deps.repoLocalPath,
  });

  if (exec.timedOut) {
    return {
      finding,
      verified: true,
      reproduced: false,
      skipped: false,
      error: `timed out after ${opts.timeoutMs}ms`,
      durationMs: Date.now() - start,
    };
  }

  // Interpretation differs for tsc.
  if (claimType === 'type-mismatch') {
    const expectedType = stringField(finding, 'expectedType');
    const { reproduced, evidence } = interpretTscOutput(exec.stdout, exec.stderr, expectedType);
    return {
      finding,
      verified: true,
      reproduced,
      evidence,
      durationMs: Date.now() - start,
    };
  }

  const combined = `${exec.stdout}\n${exec.stderr}`;
  const reproduced = combined.includes('ANVIL_REPRODUCED');
  const evidence = combined.split('\n').find((l) => l.includes('ANVIL_')) ?? combined.slice(0, 400);
  return {
    finding,
    verified: true,
    reproduced,
    evidence,
    durationMs: Date.now() - start,
  };
}

function routeGenerator(
  finding: unknown,
  language: VerifierLanguage,
  functionName: string,
  claimType: string | undefined,
  message: string | undefined,
): MicroTest | null {
  switch (claimType) {
    case 'null-deref':
      return generateNullInputTest(finding, language, functionName);
    case 'type-mismatch':
      return generateTypeMismatchTest(finding, language, {
        functionName,
        expectedType: stringField(finding, 'expectedType'),
      });
    case 'other': {
      // Prefer an assertion probe if the message has "should be X".
      const expectation = parseExpectation(message);
      if (expectation) {
        const t = generateAssertionTest(finding, language, functionName, expectation);
        if (t) return t;
      }
      if (claimMentionsThrow(message)) {
        return generateThrowsTest(finding, language, functionName);
      }
      return null;
    }
    default:
      return null;
  }
}

function detectLanguage(finding: unknown): VerifierLanguage {
  const file = stringField(finding, 'file');
  if (!file) return 'unsupported';
  const lower = file.toLowerCase();
  if (lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.mts') || lower.endsWith('.cts')) return 'ts';
  if (lower.endsWith('.js') || lower.endsWith('.jsx') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) return 'js';
  if (lower.endsWith('.py')) return 'py';
  if (lower.endsWith('.go')) return 'go';
  return 'unsupported';
}

function extractFunctionName(finding: unknown): string {
  // Prefer targetSymbol; fall back to parsing from quoted.
  const target = stringField(finding, 'targetSymbol');
  if (target) {
    // `user.email` → `email`; `fooBar(` → `fooBar`.
    const last = target.split(/[.#:]/).pop() ?? target;
    const clean = last.replace(/\(.*$/, '').trim();
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(clean)) return clean;
  }
  const quoted = stringField(finding, 'quoted');
  if (quoted) {
    const m = /([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/.exec(quoted);
    if (m) return m[1];
  }
  // Fallback: synthesize a safe probe name so generators don't short-circuit.
  return 'anvilProbe';
}

function enrichWithEvidence(finding: unknown, evidence: string | undefined): unknown {
  if (!isRecord(finding)) return finding;
  return { ...finding, verifierEvidence: evidence ?? null };
}

const RUNNER_CHECK_CACHE = new Map<string, boolean>();

async function isRunnerAvailable(test: MicroTest): Promise<boolean> {
  const cmd = test.runCommand.cmd;
  if (cmd === 'node') return true; // we're running under node.
  if (RUNNER_CHECK_CACHE.has(cmd)) return RUNNER_CHECK_CACHE.get(cmd) as boolean;
  const ok = await probeRunner(cmd);
  RUNNER_CHECK_CACHE.set(cmd, ok);
  return ok;
}

async function probeRunner(cmd: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  return await new Promise<boolean>((resolvePromise) => {
    try {
      const child = spawn(cmd, ['--version'], { stdio: 'ignore', shell: false });
      child.on('error', () => resolvePromise(false));
      child.on('exit', (code) => resolvePromise(code === 0 || code === null));
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* noop */ }
        resolvePromise(false);
      }, 2000);
    } catch {
      resolvePromise(false);
    }
  });
}
