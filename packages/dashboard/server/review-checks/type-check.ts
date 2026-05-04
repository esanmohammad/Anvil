/**
 * type-check — shells out to the project's type checker (tsc / pyright / mypy /
 * go vet) to validate a null-deref or type-mismatch claim. Degrades silently
 * when the tool isn't installed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { EnrichedFinding } from '../review-finding-extensions.js';

export interface TypeCheckResult {
  passed: boolean;
  detail?: string;
}

const EXEC_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024; // 16 MB

type Language = 'ts' | 'py' | 'go' | null;

function detectLanguage(filePath: string): Language {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.ts' || ext === '.tsx' || ext === '.js' || ext === '.jsx' ||
      ext === '.mjs' || ext === '.cjs') {
    return 'ts';
  }
  if (ext === '.py') return 'py';
  if (ext === '.go') return 'go';
  return null;
}

interface ExecOutcome {
  ok: boolean;           // command ran to completion
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCmd(cmd: string, args: string[], cwd: string): ExecOutcome {
  try {
    const stdout = execFileSync(cmd, args, {
      cwd,
      timeout: EXEC_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
    return { ok: true, stdout, stderr: '', code: 0 };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stdout?: Buffer | string;
      stderr?: Buffer | string;
      status?: number | null;
      code?: string;
    };
    // ENOENT → tool not installed
    if (e.code === 'ENOENT') {
      return { ok: false, stdout: '', stderr: 'ENOENT', code: null };
    }
    const stdout = typeof e.stdout === 'string' ? e.stdout : e.stdout?.toString() ?? '';
    const stderr = typeof e.stderr === 'string' ? e.stderr : e.stderr?.toString() ?? '';
    // Non-zero exit: still "ran", just with diagnostics.
    return {
      ok: true,
      stdout,
      stderr,
      code: typeof e.status === 'number' ? e.status : null,
    };
  }
}

function claimIsNullOrType(finding: EnrichedFinding): boolean {
  return finding.claimType === 'null-deref' || finding.claimType === 'type-mismatch';
}

function fileHasDiagnostic(output: string, filePath: string, line: number): boolean {
  // tsc/pyright/mypy/go-vet all include a path:line pattern. Be lenient.
  const base = filePath.replace(/\\/g, '/');
  const lines = output.split('\n');
  for (const l of lines) {
    const norm = l.replace(/\\/g, '/');
    if (!norm.includes(base)) continue;
    // Match file:line or file(line,...) variants.
    const m = norm.match(/[:(](\d+)[:,)]/);
    if (!m) continue;
    const reported = parseInt(m[1], 10);
    if (Number.isNaN(reported)) continue;
    // Close enough: same line or adjacent (codegen sometimes shifts by 1).
    if (Math.abs(reported - line) <= 1) return true;
  }
  return false;
}

async function checkTs(
  finding: EnrichedFinding,
  repoLocalPath: string,
  filePath: string,
): Promise<TypeCheckResult> {
  // Prefer a local tsc if present to avoid global version skew.
  const localTsc = join(repoLocalPath, 'node_modules', '.bin', 'tsc');
  const tscBin = existsSync(localTsc) ? localTsc : 'tsc';
  const tsconfig = join(repoLocalPath, 'tsconfig.json');
  if (!existsSync(tsconfig)) {
    return { passed: true, detail: 'skipped: no tsconfig.json' };
  }
  const result = runCmd(tscBin, ['--noEmit', '--pretty', 'false'], repoLocalPath);
  if (!result.ok) {
    return { passed: true, detail: 'skipped: tsc not available' };
  }
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0) {
    // tsc clean → claim of null-deref/type-mismatch is likely hallucinated.
    return { passed: false, detail: 'tsc disagrees: no type errors reported' };
  }
  if (fileHasDiagnostic(combined, filePath, finding.line)) {
    return { passed: true, detail: 'tsc confirms a diagnostic at this location' };
  }
  return {
    passed: false,
    detail: 'tsc disagrees: no diagnostic at the claimed file:line',
  };
}

function checkPy(
  finding: EnrichedFinding,
  repoLocalPath: string,
  filePath: string,
): TypeCheckResult {
  // Try pyright first, fall back to mypy. Skip if neither runs.
  for (const [bin, args] of [
    ['pyright', ['--outputjson', filePath]],
    ['mypy', ['--no-color-output', filePath]],
  ] as const) {
    const result = runCmd(bin, [...args], repoLocalPath);
    if (!result.ok) continue;
    const combined = `${result.stdout}\n${result.stderr}`;
    if (result.code === 0) {
      return { passed: false, detail: `${bin} disagrees: no issues reported` };
    }
    if (fileHasDiagnostic(combined, filePath, finding.line)) {
      return { passed: true, detail: `${bin} confirms a diagnostic at this location` };
    }
    return {
      passed: false,
      detail: `${bin} disagrees: no diagnostic at the claimed file:line`,
    };
  }
  return { passed: true, detail: 'skipped: no python type-checker available' };
}

function checkGo(
  finding: EnrichedFinding,
  repoLocalPath: string,
  filePath: string,
): TypeCheckResult {
  const result = runCmd('go', ['vet', './...'], repoLocalPath);
  if (!result.ok) return { passed: true, detail: 'skipped: go toolchain not available' };
  const combined = `${result.stdout}\n${result.stderr}`;
  if (result.code === 0) {
    return { passed: false, detail: 'go vet disagrees: no issues reported' };
  }
  if (fileHasDiagnostic(combined, filePath, finding.line)) {
    return { passed: true, detail: 'go vet confirms a diagnostic at this location' };
  }
  return {
    passed: false,
    detail: 'go vet disagrees: no diagnostic at the claimed file:line',
  };
}

/**
 * For null-deref/type-mismatch claims, run the language-appropriate checker
 * and see whether it agrees. Returns `passed: true` (skip) when:
 *  - claim type isn't null-deref/type-mismatch
 *  - the language is unsupported
 *  - the tool is not installed
 */
export async function checkTypeClaim(
  finding: EnrichedFinding,
  repoLocalPath: string,
  filePath: string,
): Promise<TypeCheckResult> {
  if (!claimIsNullOrType(finding)) {
    return { passed: true, detail: 'skipped: claim type does not require type-check' };
  }

  const lang = detectLanguage(filePath);
  if (lang === null) {
    return { passed: true, detail: 'skipped: unsupported language for type-check' };
  }

  const absRepo = resolve(repoLocalPath);
  if (lang === 'ts') return checkTs(finding, absRepo, filePath);
  if (lang === 'py') return checkPy(finding, absRepo, filePath);
  return checkGo(finding, absRepo, filePath);
}
