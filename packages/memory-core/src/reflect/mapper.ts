/**
 * `reflectIntoProposals` — takes a parsed `ReflectionResult` and shapes
 * each item into a `Memory` candidate, then enqueues it through the
 * `ProposalQueue` (Phase 11). The hot path stays unchanged: nothing is
 * written to durable memory until sleeptime ratifies (Phase 10).
 */

import { ulid } from 'ulid';
import type { ProposalQueue } from '../sleeptime/proposal-queue.js';
import type {
  Memory,
  MemoryNamespace,
  SemanticSubtype,
} from '../types.js';
import type {
  ReflectionFailure,
  ReflectionResult,
  ReflectionSkillProposal,
  ReflectionSuccess,
  ReflectionSurprise,
} from './extractor.js';

export interface ReflectIntoProposalsOptions {
  namespace: MemoryNamespace;
  /** Run id stamped on every proposed memory's provenance. */
  runId: string;
  /** ISO-8601; defaults to now. Used for createdAt + validAt + expiresAt. */
  now?: string;
  /** Default TTL on every proposed memory. -1 = never expires. */
  ttlDays?: number;
}

export interface ReflectionEnqueueResult {
  proposalIds: string[];
  byKind: {
    failures: number;
    successes: number;
    surprises: number;
    skillProposals: number;
  };
}

/**
 * Per-subtype TTL table — different memory shapes age at different rates.
 * fix-pattern is load-bearing for the convention-promotion 3-strike loop,
 * so it lives long. flaky-test is short because tests get fixed fast.
 * `manual` is user-authored or surprise-derived → durable.
 *
 * An explicit `opts.ttlDays` override always wins for the legacy
 * "everything uses 90 days" caller shape (preserved for tests).
 */
const SUBTYPE_TTL_DAYS: Record<SemanticSubtype, number> = {
  'fix-pattern': 180,
  success:        90,
  approach:       60,
  'flaky-test':   30,
  performance:   180,
  manual:        365,
};

const PROCEDURAL_TTL_DAYS = 365;

function resolveExpires(
  now: string,
  ttlDays: number,
): string {
  return ttlDays >= 0
    ? new Date(Date.parse(now) + ttlDays * 86_400_000).toISOString()
    : '9999-12-31T00:00:00.000Z';
}

export function reflectIntoProposals(
  queue: ProposalQueue,
  reflection: ReflectionResult,
  opts: ReflectIntoProposalsOptions,
): ReflectionEnqueueResult {
  const now = opts.now ?? new Date().toISOString();
  // Override wins; otherwise per-subtype defaults from SUBTYPE_TTL_DAYS.
  const override = opts.ttlDays;

  const proposalIds: string[] = [];

  const fixTtl = override ?? SUBTYPE_TTL_DAYS['fix-pattern'];
  for (const f of reflection.failures) {
    const m = buildSemantic({
      content: formatFailure(f),
      subtype: 'fix-pattern',
      tags: ['reflection', 'failure', ...(f.filePath ? [`file:${f.filePath}`] : [])],
      ns: opts.namespace,
      runId: opts.runId,
      now,
      expiresAt: resolveExpires(now, fixTtl),
      ttlDays: fixTtl,
    });
    proposalIds.push(queue.enqueue(m, `reflection:failure:${opts.runId}`).id);
  }

  const successTtl = override ?? SUBTYPE_TTL_DAYS.success;
  for (const s of reflection.successes) {
    const m = buildSemantic({
      content: formatSuccess(s),
      subtype: 'success',
      tags: ['reflection', 'success', ...(s.filePath ? [`file:${s.filePath}`] : [])],
      ns: opts.namespace,
      runId: opts.runId,
      now,
      expiresAt: resolveExpires(now, successTtl),
      ttlDays: successTtl,
    });
    proposalIds.push(queue.enqueue(m, `reflection:success:${opts.runId}`).id);
  }

  const manualTtl = override ?? SUBTYPE_TTL_DAYS.manual;
  for (const su of reflection.surprises) {
    const m = buildSemantic({
      content: formatSurprise(su),
      subtype: 'manual',
      tags: ['reflection', 'surprise'],
      ns: opts.namespace,
      runId: opts.runId,
      now,
      expiresAt: resolveExpires(now, manualTtl),
      ttlDays: manualTtl,
    });
    proposalIds.push(queue.enqueue(m, `reflection:surprise:${opts.runId}`).id);
  }

  const procTtl = override ?? PROCEDURAL_TTL_DAYS;
  for (const sp of reflection.skillProposals) {
    const m = buildProcedural({
      skill: sp,
      ns: opts.namespace,
      runId: opts.runId,
      now,
      expiresAt: resolveExpires(now, procTtl),
      ttlDays: procTtl,
    });
    proposalIds.push(queue.enqueue(m, `reflection:skill:${opts.runId}`).id);
  }

  return {
    proposalIds,
    byKind: {
      failures: reflection.failures.length,
      successes: reflection.successes.length,
      surprises: reflection.surprises.length,
      skillProposals: reflection.skillProposals.length,
    },
  };
}

interface SemanticBuilderArgs {
  content: string;
  subtype: SemanticSubtype;
  tags: string[];
  ns: MemoryNamespace;
  runId: string;
  now: string;
  expiresAt: string;
  ttlDays: number;
}

function buildSemantic(args: SemanticBuilderArgs): Memory {
  return {
    id: ulid(),
    namespace: args.ns,
    kind: 'semantic',
    subtype: args.subtype,
    content: args.content,
    tags: args.tags,
    confidence: 50,
    ttlDays: args.ttlDays,
    expiresAt: args.expiresAt,
    bitemporal: { validAt: args.now },
    decay: { lastAccessed: args.now, strength: 70, rehearseCount: 0 },
    provenance: {
      createdBy: 'reflection',
      createdAt: args.now,
      sourceRunId: args.runId,
      proposedAt: args.now,
    },
  };
}

interface ProceduralBuilderArgs {
  skill: ReflectionSkillProposal;
  ns: MemoryNamespace;
  runId: string;
  now: string;
  expiresAt: string;
  ttlDays: number;
}

function buildProcedural(args: ProceduralBuilderArgs): Memory {
  const content = `# Skill Proposal: ${args.skill.name}\n\n${args.skill.description}\n\n${args.skill.body}`;
  return {
    id: ulid(),
    namespace: args.ns,
    kind: 'procedural',
    content,
    tags: ['reflection', 'skill-proposal', `skill:${args.skill.name}`],
    confidence: 50,
    ttlDays: args.ttlDays,
    expiresAt: args.expiresAt,
    bitemporal: { validAt: args.now },
    decay: { lastAccessed: args.now, strength: 70, rehearseCount: 0 },
    provenance: {
      createdBy: 'reflection',
      createdAt: args.now,
      sourceRunId: args.runId,
      proposedAt: args.now,
    },
  };
}

function formatFailure(f: ReflectionFailure): string {
  const lines = [`Failure: ${f.what}`, `Root cause: ${f.rootCause}`, `Fix: ${f.fix}`];
  if (f.filePath) lines.push(`File: ${f.filePath}`);
  return lines.join('\n');
}

function formatSuccess(s: ReflectionSuccess): string {
  const lines = [`Pattern: ${s.pattern}`, `Applies when: ${s.appliesWhen}`];
  if (s.filePath) lines.push(`File: ${s.filePath}`);
  if (s.codeSnippet) lines.push('Snippet:', s.codeSnippet);
  return lines.join('\n');
}

function formatSurprise(s: ReflectionSurprise): string {
  return `Surprise: ${s.what}\nWhy surprising: ${s.whySurprising}`;
}
