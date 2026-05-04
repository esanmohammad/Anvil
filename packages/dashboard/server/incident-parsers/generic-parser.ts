/**
 * generic-parser — parse a hand-pasted or free-form stack trace into a
 * `ParsedIncident`.
 *
 * The parser recognizes five common trace formats and picks the first
 * user-code frame (skipping frames obviously rooted in node_modules, the
 * standard library, or a test runner). `externalId` is a content hash so
 * re-pasting the exact same trace idempotently resolves to the same
 * incident record.
 *
 * No new dependencies — uses `node:crypto` (Node stdlib) and pure regex.
 */

import { createHash } from 'node:crypto';

import type { FailingSymbol } from '../incident-types.js';
import {
  asString,
  findGithubPrUrl,
  type GenericInput,
  type ParsedIncident,
} from './types.js';

// ── Public API ──────────────────────────────────────────────────────────

export function parseGenericStackTrace(input: GenericInput): ParsedIncident {
  if (!input || typeof input !== 'object') {
    throw new Error('parseGenericStackTrace: input is not an object');
  }
  const stackTrace = typeof input.stackTrace === 'string' ? input.stackTrace : '';
  if (!stackTrace.trim()) {
    throw new Error('parseGenericStackTrace: stackTrace is empty');
  }

  const externalId = hashStack(stackTrace);
  const failingSymbol = extractFailingSymbol(stackTrace);
  const title =
    asString(input.title) ??
    deriveTitle(stackTrace, failingSymbol) ??
    'Manual stack trace';
  const summary = asString(input.summary) ?? title;
  const url = asString(input.url) ?? '';
  const linkedPrUrl = findGithubPrUrl(
    [input.title, input.summary, input.url, stackTrace].filter(Boolean).join('\n'),
  );

  return {
    externalId,
    source: 'manual',
    url,
    title,
    severity: input.severity ?? 'unknown',
    occurredAt: new Date().toISOString(),
    summary,
    stackTrace,
    failingSymbol,
    requestPayload: input.requestPayload,
    linkedPrUrl,
  };
}

// ── Failing-symbol extraction ───────────────────────────────────────────

/**
 * Walk the trace, picking the first frame that looks like user code.
 * Supports Node/browser v8, Python, Go, Java, and Ruby formats.
 *
 * Returns `undefined` if no recognizable frame is found.
 */
export function extractFailingSymbol(stackTrace: string): FailingSymbol | undefined {
  const frames = parseFrames(stackTrace);
  if (frames.length === 0) return undefined;

  const userFrame = frames.find((f) => !isNoiseFrame(f.file)) ?? frames[0];
  if (!userFrame) return undefined;
  return {
    file: userFrame.file,
    function: userFrame.function,
    line: userFrame.line,
  };
}

// ── Internals ───────────────────────────────────────────────────────────

interface Frame {
  file: string;
  function: string;
  line: number;
}

const NOISE_PATTERNS: readonly RegExp[] = [
  /(^|[\\/])node_modules([\\/]|$)/i,
  /^\/usr\/lib\//i,
  /<stdlib>/i,
  /(^|[\\/])runtime([\\/]|$)/i,
  /^builtin$/i,
  /\[builtin\]/i,
  /(^|[\\/])jest([\\/]|$)/i,
  /(^|[\\/])vitest([\\/]|$)/i,
  /(^|[\\/])mocha([\\/]|$)/i,
];

function isNoiseFrame(file: string): boolean {
  if (!file || file === '<unknown>') return true;
  return NOISE_PATTERNS.some((re) => re.test(file));
}

/**
 * Tokenize the trace into `Frame`s. Unknown lines are skipped. Frames are
 * emitted in source order so the caller can pick the "first" user frame.
 *
 * For Go panics the recognizer consumes frames in pairs of lines:
 *   `pkg.Function(args)`
 *   `\t/path/to/file.go:42 +0x1f`
 */
function parseFrames(stackTrace: string): Frame[] {
  const lines = stackTrace.split(/\r?\n/);
  const frames: Frame[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ── Node / browser v8 ───────────────────────────────────────────
    // "    at fn (file:line:col)"
    let m = /^at\s+(.+?)\s+\((.+?):(\d+)(?::\d+)?\)$/.exec(trimmed);
    if (m) {
      frames.push({ function: m[1]!, file: m[2]!, line: Number(m[3]) });
      continue;
    }
    // "    at file:line:col"   (top-level / anonymous)
    m = /^at\s+(.+?):(\d+)(?::\d+)?$/.exec(trimmed);
    if (m) {
      frames.push({ function: '<anonymous>', file: m[1]!, line: Number(m[2]) });
      continue;
    }

    // ── Python ──────────────────────────────────────────────────────
    // 'File "path/to/file.py", line 42, in function_name'
    m = /^File\s+"(.+?)",\s+line\s+(\d+),\s+in\s+(.+)$/.exec(trimmed);
    if (m) {
      frames.push({ file: m[1]!, line: Number(m[2]), function: m[3]! });
      continue;
    }

    // ── Java ────────────────────────────────────────────────────────
    // "at com.pkg.Class.method(File.java:42)"
    m = /^at\s+([\w$.<>]+)\((.+?):(\d+)\)$/.exec(trimmed);
    if (m) {
      frames.push({ function: m[1]!, file: m[2]!, line: Number(m[3]) });
      continue;
    }
    // "at com.pkg.Class.method(Unknown Source)" or "(Native Method)"
    m = /^at\s+([\w$.<>]+)\(([^)]*)\)$/.exec(trimmed);
    if (m && /source|native/i.test(m[2]!)) {
      frames.push({ function: m[1]!, file: '<unknown>', line: 0 });
      continue;
    }

    // ── Ruby ────────────────────────────────────────────────────────
    // "path/to/file.rb:42:in `method_name'"
    m = /^(.+?):(\d+):in\s+`([^']+)'\s*$/.exec(trimmed);
    if (m) {
      frames.push({ file: m[1]!, line: Number(m[2]), function: m[3]! });
      continue;
    }

    // ── Go panic ────────────────────────────────────────────────────
    // Line 1: "pkg.Function(args)"   — no leading whitespace
    // Line 2: "\t/path/to/file.go:42 +0x1f" — tab-indented file:line
    const nextRaw = i + 1 < lines.length ? lines[i + 1]! : '';
    const next = nextRaw.trim();
    const goFn = /^((?:[\w./-]+\.)?[\w.()*$[\]]+)\([^)]*\)$/.exec(trimmed);
    const goFile = /^(.+?\.go):(\d+)(?:\s+\+0x[0-9a-f]+)?$/.exec(next);
    if (goFn && goFile && /^[\t ]/.test(nextRaw)) {
      frames.push({
        function: goFn[1]!,
        file: goFile[1]!,
        line: Number(goFile[2]),
      });
      i++; // consume the file line
      continue;
    }

    // Unknown format — skip.
  }

  return frames;
}

function deriveTitle(
  stackTrace: string,
  symbol: FailingSymbol | undefined,
): string | undefined {
  // Pull the first non-empty line — often the error class/message ("TypeError: x is not a function").
  const firstLine = stackTrace.split(/\r?\n/).find((l) => l.trim().length > 0);
  const headline = firstLine?.trim();
  if (headline && !/^at\s/i.test(headline) && !/^File\s+"/i.test(headline)) {
    return headline.slice(0, 200);
  }
  if (symbol) return `${symbol.function} (${symbol.file}:${symbol.line})`;
  return undefined;
}

function hashStack(stackTrace: string): string {
  return createHash('sha256').update(stackTrace, 'utf8').digest('hex').slice(0, 16);
}
