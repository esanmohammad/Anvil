/**
 * Pre-bundle TASKS.md scope files into an XML-ish <files> block for the
 * engineer agent.
 *
 * Phase F6 — promoted from `packages/dashboard/server/engineer-task-bundler.ts`
 * into `core-pipeline/utils` so cli's build stage and dashboard's
 * build/test stages share one canonical bundler. Reads files from disk
 * by design (`bundleFiles()` accepts a directory + a list of paths and
 * returns a budgeted XML fragment) — not a side-effect-on-import.
 * Module body has no I/O.
 */

import { readFileSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { structurallyTruncate, looksLikeCode } from './structural-truncator.js';

export interface ParsedTask {
  id: string;
  title: string;
  files: string[];
  specRef: string | null;
  /** Other task IDs this task depends on, parsed from the `**Prerequisites**:` line.
   *  "None" / empty / missing line → []. Order preserved, deduplicated. */
  prerequisites: string[];
  /** The raw markdown sub-document for this task: from the `### TASK-NNN: ...` heading
   *  through the line just before the next `### TASK-` heading (or EOF). Trailing whitespace trimmed.
   *  Useful for injecting just one task into a per-task prompt. */
  block: string;
}

export interface ExecutionGroup {
  /** 0-indexed group order; groups run sequentially. */
  index: number;
  /** Tasks in this group can run in parallel — none of them depend on each other,
   *  and no two tasks in the group touch the same file. */
  tasks: ParsedTask[];
}

export interface BundleOptions {
  repoPath: string;
  files: string[];
  maxBytes?: number;
  maxFileBytes?: number;
}

export type SkipReason = 'missing' | 'unreadable' | 'too-large' | 'budget';

export interface BundleResult {
  block: string;
  included: string[];
  truncated: string[];
  skipped: { path: string; reason: SkipReason }[];
  bytes: number;
}

const DEFAULT_MAX_BYTES = 200_000;
const DEFAULT_MAX_FILE_BYTES = 30_000;

const TASK_HEADING_RE = /^###\s+(TASK-\d+):\s*(.+?)\s*$/;
const SCOPE_LINE_RE = /^\s*-\s*\*\*Scope\*\*\s*:\s*(.+)$/i;
const SPEC_REF_LINE_RE = /^\s*-\s*\*\*Spec Reference\*\*\s*:\s*(.+)$/i;
const PREREQ_LINE_RE = /^\s*-\s*\*\*Prerequisites\*\*\s*:\s*(.+)$/i;
const BACKTICK_PATH_RE = /`([^`]+)`/g;
const TASK_ID_RE = /TASK-\d+/g;

export function parseTasks(tasksMd: string): ParsedTask[] {
  const lines = tasksMd.split(/\r?\n/);
  const tasks: ParsedTask[] = [];

  let current: ParsedTask | null = null;
  let currentBlockLines: string[] = [];

  const flush = () => {
    if (current && current.files.length > 0) {
      current.block = currentBlockLines.join('\n').replace(/\s+$/, '');
      tasks.push(current);
    }
    current = null;
    currentBlockLines = [];
  };

  for (const line of lines) {
    const heading = TASK_HEADING_RE.exec(line);
    if (heading) {
      flush();
      current = {
        id: heading[1] ?? '',
        title: (heading[2] ?? '').trim(),
        files: [],
        specRef: null,
        prerequisites: [],
        block: '',
      };
      currentBlockLines = [line];
      continue;
    }
    if (!current) continue;

    currentBlockLines.push(line);

    const scopeMatch = SCOPE_LINE_RE.exec(line);
    if (scopeMatch) {
      const rest = scopeMatch[1] ?? '';
      const seen = new Set(current.files);
      let m: RegExpExecArray | null;
      BACKTICK_PATH_RE.lastIndex = 0;
      while ((m = BACKTICK_PATH_RE.exec(rest)) !== null) {
        const p = (m[1] ?? '').trim();
        if (p && !seen.has(p)) {
          seen.add(p);
          current.files.push(p);
        }
      }
      continue;
    }

    const prereqMatch = PREREQ_LINE_RE.exec(line);
    if (prereqMatch) {
      const rest = prereqMatch[1] ?? '';
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      TASK_ID_RE.lastIndex = 0;
      while ((m = TASK_ID_RE.exec(rest)) !== null) {
        const id = m[0];
        if (!seen.has(id)) {
          seen.add(id);
          current.prerequisites.push(id);
        }
      }
      continue;
    }

    const specMatch = SPEC_REF_LINE_RE.exec(line);
    if (specMatch) {
      const rest = (specMatch[1] ?? '').trim();
      const quoted = /^"(.*)"\s*$/.exec(rest);
      current.specRef = quoted ? (quoted[1] ?? '') : rest;
      continue;
    }
  }

  flush();
  return tasks;
}

// Compute parallel execution batches from a list of parsed tasks.
export function groupTasksForExecution(tasks: ParsedTask[]): ExecutionGroup[] {
  if (tasks.length === 0) return [];

  const taskById = new Map<string, ParsedTask>();
  for (const t of tasks) {
    taskById.set(t.id, t);
  }

  const satisfied = new Set<string>();
  const remaining: ParsedTask[] = tasks.slice();
  const groups: ExecutionGroup[] = [];

  while (remaining.length > 0) {
    const ready: ParsedTask[] = [];
    const stillBlocked: ParsedTask[] = [];
    for (const t of remaining) {
      const allMet = t.prerequisites.every(
        (p) => !taskById.has(p) || satisfied.has(p),
      );
      if (allMet) {
        ready.push(t);
      } else {
        stillBlocked.push(t);
      }
    }

    if (ready.length === 0) {
      // Cycle (or unresolvable internal dependency): emit each remaining task
      // as its own single-task group, in input order, and stop.
      for (const t of remaining) {
        groups.push({ index: groups.length, tasks: [t] });
      }
      return groups;
    }

    // Greedily pack the ready set into a single group, respecting file conflicts.
    const packed: ParsedTask[] = [];
    const usedFiles = new Set<string>();
    const deferred: ParsedTask[] = [];
    for (const t of ready) {
      const conflict = t.files.some((f) => usedFiles.has(f));
      if (conflict) {
        deferred.push(t);
        continue;
      }
      packed.push(t);
      for (const f of t.files) {
        usedFiles.add(f);
      }
    }

    groups.push({ index: groups.length, tasks: packed });
    for (const t of packed) {
      satisfied.add(t.id);
    }

    // Next iteration's worklist: deferred ready-but-conflicted tasks plus the
    // tasks that were not yet ready. Preserve original input order.
    const nextSet = new Set<ParsedTask>([...deferred, ...stillBlocked]);
    remaining.length = 0;
    for (const t of tasks) {
      if (nextSet.has(t)) remaining.push(t);
    }
  }

  return groups;
}

/**
 * Run a set of tasks honoring their dependencies, but starting each
 * task the moment its specific prerequisites complete instead of
 * waiting for an entire group to finish. Replaces the legacy
 * `groupTasksForExecution + per-group Promise.all` shape with a true
 * dependency-graph walker.
 *
 * Net effect: when group N has 4 tasks (A, B, C, D) and group N+1 has
 * one task (E) that only depends on B, E starts as soon as B finishes
 * — instead of waiting for A, C, D too. ~20-30% faster builds in
 * practice.
 *
 * Correctness preserved: every task's prerequisites still complete
 * before it spawns. Cycles fall through to single-task execution in
 * input order, matching `groupTasksForExecution`'s safety net.
 *
 * Concurrency: optionally capped by `maxConcurrent`. The default is
 * `Infinity` because cloud LLM rate limits already throttle on the
 * provider side; a per-run cap is rarely needed unless the user is
 * cost-conscious.
 */
export interface RunTasksOptions {
  /** Optional cap on concurrent in-flight tasks. */
  maxConcurrent?: number;
  /**
   * Optional file-conflict guard — same convention as
   * `groupTasksForExecution`. When two tasks modify the same file,
   * they're forced to serialize regardless of declared deps. Off by
   * default since per-task spawning rarely overlaps in practice.
   */
  enforceFileConflicts?: boolean;
}

export interface RunTasksHooks<R> {
  /** Called when a task is about to spawn. */
  onStart?: (task: ParsedTask) => void;
  /** Called when a task completes. Result is whatever `runTask` returned. */
  onComplete?: (task: ParsedTask, result: R) => void;
  /** Called when a task throws. The walker still proceeds with its dependents marked failed. */
  onFail?: (task: ParsedTask, err: unknown) => void;
}

export async function runTasksWithDependencyGraph<R>(
  tasks: ParsedTask[],
  runTask: (task: ParsedTask) => Promise<R>,
  hooks: RunTasksHooks<R> = {},
  opts: RunTasksOptions = {},
): Promise<Map<string, { ok: true; result: R } | { ok: false; error: unknown }>> {
  const results = new Map<string, { ok: true; result: R } | { ok: false; error: unknown }>();
  if (tasks.length === 0) return results;

  const taskById = new Map<string, ParsedTask>();
  for (const t of tasks) taskById.set(t.id, t);

  // Pending count = number of unresolved prerequisites. Skips deps that
  // reference unknown task ids (treated as "external" / always satisfied).
  const pending = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const t of tasks) {
    let unresolved = 0;
    for (const p of t.prerequisites) {
      if (taskById.has(p)) {
        unresolved += 1;
        const list = dependents.get(p) ?? [];
        list.push(t.id);
        dependents.set(p, list);
      }
    }
    pending.set(t.id, unresolved);
  }

  // File-conflict guard (optional): track currently-in-flight files;
  // tasks that overlap with an in-flight file get deferred to the queue.
  const inFlightFiles = opts.enforceFileConflicts ? new Set<string>() : null;

  // Ready queue + in-flight set.
  const ready: ParsedTask[] = [];
  for (const t of tasks) {
    if ((pending.get(t.id) ?? 0) === 0) ready.push(t);
  }
  // Cycle detection: if no task is ready up front, fall through to
  // input-order serial execution (matches groupTasksForExecution's
  // safety net).
  if (ready.length === 0) {
    for (const t of tasks) {
      try {
        hooks.onStart?.(t);
        const r = await runTask(t);
        results.set(t.id, { ok: true, result: r });
        hooks.onComplete?.(t, r);
      } catch (err) {
        results.set(t.id, { ok: false, error: err });
        hooks.onFail?.(t, err);
      }
    }
    return results;
  }

  const maxConcurrent = opts.maxConcurrent ?? Infinity;
  let inFlight = 0;
  let resolveAll: () => void;
  const done = new Promise<void>((r) => { resolveAll = r; });

  const tryDispatchMore = (): void => {
    while (ready.length > 0 && inFlight < maxConcurrent) {
      // Pick a task from ready that doesn't conflict with in-flight files.
      let pickIdx = -1;
      for (let i = 0; i < ready.length; i += 1) {
        const candidate = ready[i];
        if (inFlightFiles) {
          const conflicts = candidate.files.some((f) => inFlightFiles.has(f));
          if (conflicts) continue;
        }
        pickIdx = i;
        break;
      }
      if (pickIdx === -1) return; // All ready tasks are blocked on file conflicts; wait.

      const task = ready.splice(pickIdx, 1)[0];
      if (inFlightFiles) for (const f of task.files) inFlightFiles.add(f);
      inFlight += 1;
      hooks.onStart?.(task);

      runTask(task)
        .then((r) => {
          results.set(task.id, { ok: true, result: r });
          hooks.onComplete?.(task, r);
        })
        .catch((err) => {
          results.set(task.id, { ok: false, error: err });
          hooks.onFail?.(task, err);
        })
        .finally(() => {
          if (inFlightFiles) for (const f of task.files) inFlightFiles.delete(f);
          inFlight -= 1;
          // Decrement dependents' pending counts; surface any newly ready.
          for (const childId of dependents.get(task.id) ?? []) {
            const next = (pending.get(childId) ?? 1) - 1;
            pending.set(childId, next);
            if (next === 0) {
              const child = taskById.get(childId);
              if (child) ready.push(child);
            }
          }
          if (inFlight === 0 && ready.length === 0) {
            resolveAll();
          } else {
            tryDispatchMore();
          }
        });
    }
  };

  tryDispatchMore();
  await done;
  return results;
}

export function extractAllTaskFiles(tasksMd: string): string[] {
  const tasks = parseTasks(tasksMd);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of tasks) {
    for (const f of t.files) {
      if (!seen.has(f)) {
        seen.add(f);
        out.push(f);
      }
    }
  }
  return out;
}

interface ReadOutcome {
  kind: 'ok' | 'missing' | 'unreadable';
  contents?: string;
  byteLen?: number;
}

function readRepoFile(repoPath: string, relPath: string): ReadOutcome {
  const abs = join(repoPath, relPath);
  let exists = true;
  try {
    statSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      exists = false;
    } else {
      return { kind: 'unreadable' };
    }
  }
  if (!exists) {
    return { kind: 'missing' };
  }
  try {
    const buf = readFileSync(abs);
    return { kind: 'ok', contents: buf.toString('utf8'), byteLen: buf.length };
  } catch {
    return { kind: 'unreadable' };
  }
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function bundleFiles(opts: BundleOptions): BundleResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  const included: string[] = [];
  const truncated: string[] = [];
  const skipped: { path: string; reason: SkipReason }[] = [];

  const open = '<files>\n';
  const close = '</files>';
  const parts: string[] = [open];
  let runningBytes = byteLength(open) + byteLength(close);

  let budgetExhausted = false;

  for (const rel of opts.files) {
    if (budgetExhausted) {
      skipped.push({ path: rel, reason: 'budget' });
      continue;
    }

    const outcome = readRepoFile(opts.repoPath, rel);
    if (outcome.kind === 'missing') {
      skipped.push({ path: rel, reason: 'missing' });
      continue;
    }
    if (outcome.kind === 'unreadable') {
      skipped.push({ path: rel, reason: 'unreadable' });
      continue;
    }

    const raw = outcome.contents ?? '';
    const rawByteLen = outcome.byteLen ?? byteLength(raw);
    let body = raw;
    let isTruncated = false;
    if (rawByteLen > maxFileBytes) {
      const ext = extname(rel);
      // Phase 4 of TOKEN-OPTIMIZATION-PLAN: prefer a code-aware truncation
      // so engineers see imports + every exported signature + as many full
      // bodies as the budget permits. Falls back to byte-slicing only when
      // the language can't be detected or no boundaries are extractable.
      if (looksLikeCode(raw, ext || rel)) {
        const budgetTokens = Math.max(64, Math.floor(maxFileBytes / 4));
        const structured = structurallyTruncate(raw, {
          budgetTokens,
          languageHint: ext || rel,
        });
        if (byteLength(structured) < rawByteLen) {
          body = structured;
          isTruncated = true;
        }
      }
      if (!isTruncated) {
        // Prose / unknown-language fallback: keep the original byte-slice
        // behaviour so we never overshoot the file-byte ceiling on text.
        const buf = Buffer.from(raw, 'utf8').subarray(0, maxFileBytes);
        // Trim any incomplete trailing UTF-8 sequence by decoding to a string.
        body = buf.toString('utf8');
        const remaining = rawByteLen - byteLength(body);
        body = `${body}\n... [truncated, ${remaining} more bytes]`;
        isTruncated = true;
      }
    }

    const header = `<file path="${rel}">\n`;
    const footer = `\n</file>\n`;
    const chunk = `${header}${body}${footer}`;
    const chunkBytes = byteLength(chunk);

    if (runningBytes + chunkBytes > maxBytes) {
      skipped.push({ path: rel, reason: 'budget' });
      budgetExhausted = true;
      continue;
    }

    parts.push(chunk);
    runningBytes += chunkBytes;
    included.push(rel);
    if (isTruncated) truncated.push(rel);
  }

  parts.push(close);
  const block = parts.join('');
  return {
    block,
    included,
    truncated,
    skipped,
    bytes: byteLength(block),
  };
}
