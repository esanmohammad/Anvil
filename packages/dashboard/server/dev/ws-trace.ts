/**
 * WS-trace instrumentation (Phase 0 of WS-EXTRACTION-PLAN).
 *
 * When `ANVIL_WS_TRACE=1`, every broadcast() call writes a JSONL record to
 * `$ANVIL_HOME/ws-trace.jsonl` capturing the emitted event type plus a stable
 * hash of the immediate caller frame. The hash lets us group emissions by
 * call-site without leaking absolute paths or stack noise.
 *
 * Disabled by default — costs ~0 when the env var is unset (we early-return
 * before touching fs or stack capture).
 *
 * See WS-EXTRACTION-PLAN.md Part 7 → Phase 0.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

let traceFilePath: string | null = null;
let ensured = false;

function ensureTraceFile(): string | null {
  if (ensured) return traceFilePath;
  ensured = true;
  if (process.env.ANVIL_WS_TRACE !== '1') return null;
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME ||
    join(process.env.HOME ?? '', '.anvil');
  traceFilePath = join(anvilHome, 'ws-trace.jsonl');
  try {
    mkdirSync(dirname(traceFilePath), { recursive: true });
  } catch { /* ok — likely already exists */ }
  return traceFilePath;
}

/**
 * Hash the first non-trace frame of the stack so we can identify a call-site
 * across runs without writing absolute paths. Returns 8 hex chars.
 */
function callerHash(): string {
  const err = new Error();
  const stack = err.stack ?? '';
  const lines = stack.split('\n');
  // Skip lines: "Error", this fn, traceEmit, then the broadcast() frame.
  // Find the first frame that doesn't reference ws-trace.ts itself.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes('ws-trace')) {
      const trimmed = line.trim()
        // Strip absolute paths to a stable form: "(.../foo.ts:123:45)" → "foo.ts:123"
        .replace(/\(.*?\/([^/)]+):(\d+):\d+\)$/, '($1:$2)');
      return createHash('sha1').update(trimmed).digest('hex').slice(0, 8);
    }
  }
  return 'unknown';
}

export interface TraceRecord {
  ts: number;
  type: string;
  callerHash: string;
}

/**
 * Record a broadcast emission. No-ops unless `ANVIL_WS_TRACE=1` at boot.
 * Failures are silently swallowed — tracing must never break the dashboard.
 */
export function traceEmit(msg: { type?: string } | unknown): void {
  const path = ensureTraceFile();
  if (!path) return;
  try {
    const type = (msg as { type?: string })?.type ?? '<no-type>';
    const rec: TraceRecord = { ts: Date.now(), type, callerHash: callerHash() };
    appendFileSync(path, JSON.stringify(rec) + '\n');
  } catch { /* never throw from tracing */ }
}
