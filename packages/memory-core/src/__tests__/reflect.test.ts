/**
 * Phase 11 — reflection-on-completion tests.
 *
 * Covers §11.5 acceptance items reachable in this phase:
 *   - Parser tolerates malformed JSON (returns empty buckets)
 *   - Parser handles snake_case + camelCase field names
 *   - Mapper enqueues failures → fix-pattern, successes → success,
 *     surprises → manual, skill_proposals → procedural
 *   - reflectOnRun end-to-end with a stub invoker (caller-supplied JSON)
 *
 * Live LLM invocation, the cli `anvil reflect` subcommand, and Plan-C
 * SKILL.md auto-write are deferred — see ADR §8 Phase 11.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  HybridMemoryStore,
  ProposalQueue,
  parseReflectionJson,
  reflectIntoProposals,
  reflectOnRun,
} from '../index.js';
import type { MemoryNamespace } from '../index.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-memory-reflect-'));
}

function open(dir: string): HybridMemoryStore {
  return HybridMemoryStore.open({
    jsonlPath: join(dir, 'memory.jsonl'),
    sqlitePath: join(dir, 'memory.sqlite'),
    skipAutoRebuild: true,
    scrubber: { mode: 'off' },
  });
}

// ── parser ────────────────────────────────────────────────────────────────

describe('parseReflectionJson', () => {
  it('parses well-formed JSON across all four buckets', () => {
    const raw = JSON.stringify({
      failures: [
        {
          what: 'Test runner crashed',
          root_cause: 'Missing await on db migration',
          fix: 'Add await; migrations need to settle before queries',
          file_path: 'src/db/migrate.ts',
        },
      ],
      successes: [
        {
          pattern: 'Use try/finally for resource cleanup',
          applies_when: 'Any test that opens a temp file',
          code_snippet: 'try { ... } finally { rmSync(dir, ...) }',
        },
      ],
      surprises: [
        { what: 'JSONL had a stray BOM', why_surprising: 'BOM survived round-trip' },
      ],
      skill_proposals: [
        {
          name: 'temp-fixture-cleanup',
          description: 'How to write tests that always clean up temp dirs',
          body: '## Steps\n\n1. tempDir()\n2. try {} finally rmSync',
        },
      ],
    });

    const r = parseReflectionJson(raw);
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].rootCause, 'Missing await on db migration');
    assert.equal(r.failures[0].filePath, 'src/db/migrate.ts');
    assert.equal(r.successes.length, 1);
    assert.equal(r.surprises.length, 1);
    assert.equal(r.skillProposals.length, 1);
    assert.equal(r.skillProposals[0].name, 'temp-fixture-cleanup');
  });

  it('tolerates leading/trailing prose around the JSON block', () => {
    const raw = `Here is what I found: { "failures": [{"what":"x","root_cause":"y","fix":"z"}], "successes": [], "surprises": [], "skill_proposals": [] }\n— end —`;
    const r = parseReflectionJson(raw);
    assert.equal(r.failures.length, 1);
  });

  it('returns empty buckets on malformed JSON', () => {
    const r = parseReflectionJson('this is not JSON at all');
    assert.deepEqual(r.failures, []);
    assert.deepEqual(r.successes, []);
    assert.deepEqual(r.surprises, []);
    assert.deepEqual(r.skillProposals, []);
  });

  it('skips items missing required fields without crashing', () => {
    const raw = JSON.stringify({
      failures: [
        { what: 'no root cause' }, // missing root_cause + fix
        { what: 'ok', root_cause: 'x', fix: 'y' },
      ],
      successes: [{ pattern: 'x' }], // missing applies_when
    });
    const r = parseReflectionJson(raw);
    assert.equal(r.failures.length, 1);
    assert.equal(r.successes.length, 0);
  });
});

// ── mapper ────────────────────────────────────────────────────────────────

describe('reflectIntoProposals', () => {
  it('enqueues each bucket with the right kind/subtype', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };

      const result = reflectIntoProposals(
        queue,
        {
          failures: [{ what: 'a', rootCause: 'b', fix: 'c' }],
          successes: [{ pattern: 'p', appliesWhen: 'w' }],
          surprises: [{ what: 's', whySurprising: 'r' }],
          skillProposals: [{ name: 'k', description: 'd', body: 'b' }],
        },
        { namespace: ns, runId: 'run-1' },
      );

      assert.equal(result.proposalIds.length, 4);
      assert.deepEqual(result.byKind, {
        failures: 1,
        successes: 1,
        surprises: 1,
        skillProposals: 1,
      });

      const pending = queue.listPending({ namespace: ns });
      const subtypes = pending.map((p) => `${p.candidate.kind}/${p.candidate.subtype ?? '-'}`);
      assert.ok(subtypes.includes('semantic/fix-pattern'));
      assert.ok(subtypes.includes('semantic/success'));
      assert.ok(subtypes.includes('semantic/manual'));
      assert.ok(subtypes.includes('procedural/-'));

      // Provenance trail wired up.
      for (const p of pending) {
        assert.equal(p.candidate.provenance.createdBy, 'reflection');
        assert.equal(p.candidate.provenance.sourceRunId, 'run-1');
      }
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('applies per-subtype TTL defaults (fix-pattern: 180d, success: 90d, manual: 365d, procedural: 365d)', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const now = '2026-05-21T00:00:00.000Z';
      reflectIntoProposals(
        queue,
        {
          failures: [{ what: 'x', rootCause: 'y', fix: 'z' }],
          successes: [{ pattern: 'p', appliesWhen: 'w' }],
          surprises: [{ what: 's', whySurprising: 'r' }],
          skillProposals: [{ name: 'k', description: 'd', body: 'b' }],
        },
        { namespace: ns, runId: 'r', now },
      );
      const pending = queue.listPending({ namespace: ns });
      const byKey = new Map(
        pending.map((p) => [`${p.candidate.kind}/${p.candidate.subtype ?? '-'}`, p.candidate]),
      );
      assert.equal(byKey.get('semantic/fix-pattern')?.ttlDays, 180);
      assert.equal(byKey.get('semantic/success')?.ttlDays, 90);
      assert.equal(byKey.get('semantic/manual')?.ttlDays, 365);
      assert.equal(byKey.get('procedural/-')?.ttlDays, 365);
      // expiresAt = now + ttlDays
      assert.equal(
        byKey.get('semantic/fix-pattern')?.expiresAt,
        new Date(Date.parse(now) + 180 * 86_400_000).toISOString(),
      );
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('honors explicit ttlDays override across all subtypes', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      reflectIntoProposals(
        queue,
        {
          failures: [{ what: 'a', rootCause: 'b', fix: 'c' }],
          successes: [{ pattern: 'p', appliesWhen: 'w' }],
          surprises: [],
          skillProposals: [],
        },
        { namespace: ns, runId: 'r', ttlDays: 7 },
      );
      const pending = queue.listPending({ namespace: ns });
      for (const p of pending) {
        assert.equal(p.candidate.ttlDays, 7);
      }
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('attaches file:<path> tag when filePath is provided', () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      reflectIntoProposals(
        queue,
        {
          failures: [
            { what: 'x', rootCause: 'y', fix: 'z', filePath: 'src/a.ts' },
          ],
          successes: [],
          surprises: [],
          skillProposals: [],
        },
        { namespace: ns, runId: 'r' },
      );
      const pending = queue.listPending({ namespace: ns });
      assert.ok(pending[0].candidate.tags.includes('file:src/a.ts'));
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── reflectOnRun ──────────────────────────────────────────────────────────

describe('reflectOnRun', () => {
  it('end-to-end: stub invoker returns JSON, items land in queue', async () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };

      const stubOutput = JSON.stringify({
        failures: [{ what: 'flake', root_cause: 'race', fix: 'lock' }],
        successes: [],
        surprises: [],
        skill_proposals: [],
      });
      const result = await reflectOnRun({
        queue,
        namespace: ns,
        runContext: { runId: 'pipeline-1', runSummary: '...diff snippet...' },
        llmInvoke: async () => stubOutput,
      });
      assert.equal(result.byKind.failures, 1);
      assert.equal(result.proposalIds.length, 1);
      assert.equal(queue.pendingCount(), 1);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty model output produces zero proposals (does not throw)', async () => {
    const dir = tempDir();
    try {
      const store = open(dir);
      const queue = new ProposalQueue(store.sqlite);
      const ns: MemoryNamespace = { scope: 'project', projectId: 'demo' };
      const result = await reflectOnRun({
        queue,
        namespace: ns,
        runContext: { runId: 'r', runSummary: '' },
        llmInvoke: async () => '',
      });
      assert.equal(result.proposalIds.length, 0);
      assert.equal(queue.pendingCount(), 0);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
