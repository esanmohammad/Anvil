/**
 * Audit-log hook — appends every pipeline lifecycle event to a JSONL file.
 *
 * Subscribes at priority 100 so it persists before learners (50) /
 * dashboard-state (10) inspect or react. The path defaults to
 * `~/.anvil/runs/<runId>/audit.jsonl`, mirroring the legacy
 * `cli/src/pipeline/audit-log.ts` writer for byte-equivalent diffs.
 *
 * The hook is intentionally fault-tolerant — disk failures (full disk,
 * permission errors) are never allowed to fail the pipeline. On a write
 * error the caller's `emit` still resolves; the failure is surfaced via
 * a `lastError` getter for tests + diagnostics.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventBus, EventListener, PipelineEvent } from '../types.js';

export interface AuditLogHookOptions {
  /** Absolute path to the JSONL log. */
  path: string;
  /** Override priority. Default 100 (runs before learners + dashboard). */
  priority?: number;
}

export interface AuditLogHookHandle {
  unsubscribe: () => void;
  /** Most recent write error, for tests + diagnostics. */
  readonly lastError: Error | undefined;
  /** Number of entries successfully appended. */
  readonly entryCount: number;
}

export const AUDIT_LOG_HOOKS: ReadonlyArray<PipelineEvent['hook']> = [
  'pipeline:started',
  'pipeline:completed',
  'pipeline:failed',
  'step:started',
  'step:completed',
  'step:failed',
  'step:retried',
  'step:skipped',
  'sub-step:started',
  'sub-step:completed',
  'artifact:emitted',
];

export function attachAuditLogHook(bus: EventBus, opts: AuditLogHookOptions): AuditLogHookHandle {
  const priority = opts.priority ?? 100;
  let lastError: Error | undefined;
  let entryCount = 0;

  ensureDir(opts.path);

  const listener: EventListener = (event) => {
    try {
      appendFileSync(opts.path, JSON.stringify(event) + '\n', 'utf8');
      entryCount += 1;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  };

  const offs = AUDIT_LOG_HOOKS.map((hook) => bus.on(hook, listener, { priority }));

  return {
    unsubscribe: () => {
      for (const off of offs) off();
    },
    get lastError() {
      return lastError;
    },
    get entryCount() {
      return entryCount;
    },
  };
}

function ensureDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
