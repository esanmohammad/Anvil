// Pre-bundle TASKS.md scope files into an XML-ish <files> block for the engineer agent.

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
