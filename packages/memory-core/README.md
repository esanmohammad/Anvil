# @anvil/memory-core

**Memory that doesn't lie. Memory that doesn't bloat.**

A long-term memory layer for AI agents — five memory types, bi-temporal
facts, code-aware drift detection, and a sleeptime ratifier that says
*no* to everything that isn't worth remembering.

---

## Why agent memory needs more than a vector DB

Most "agent memory" today is one of two things: a buffer that loses
context the moment the window scrolls, or a vector index that
remembers everything — including the wrong things, the outdated
things, and the things that contradict each other.

**memory-core takes a stricter line.** Auto-learners can *propose*
memories. A sleeptime ratifier decides what gets written. Every fact
about code carries a structural hash so we know when the underlying
file has drifted. Every fact carries a validity window so we can ask
"what was true on March 14?" Nothing gets hard-deleted without an
audit trail.

```ts
import { HybridMemoryStore } from '@anvil/memory-core';

const store = new HybridMemoryStore('~/.anvil/memories');
const ns = { scope: 'project', projectId: 'space-tourism' };

// Hot-path code proposes — sleeptime ratifies.
proposalQueue.enqueue({
  kind: 'semantic',
  subtype: 'fix-pattern',
  content: 'Booking submissions need optimistic locking on seat tier.',
  codeBinding: {
    filePath: 'src/booking/seat-tier.ts',
    structuralHash: await computeStructuralHash(filePath),
    lastSeenCommitSha: 'a1b2c3',
    lastVerifiedAt: new Date().toISOString(),
  },
}, 'discovered during build-failure recovery');

// Later, scoped retrieval — BM25 + tags + 1-hop graph + RRF fusion.
const results = await store.search(ns, { text: 'seat tier locking' });
```

---

## What you get

### Five memory types, one schema
`working` (in-flight context), `episodic` (what happened),
`semantic` (what we learned), `procedural` (how we do things),
`profile` (who the user is). One canonical `Memory<T>` shape across
all five. The schema is locked — adapters extend it via the generic
payload, never by mutating the core fields.

### Auto-learners propose, sleeptime ratifies
The architectural fix for "every event becomes a memory." Hot-path
code calls `proposalQueue.enqueue(...)` — never `store.add(...)`
directly. A sleeptime job dedupes via content hash, decides
ADD-vs-MERGE-INTO, and writes only what survives ratification.
mem0-style noise simply can't accumulate.

### Bi-temporal by default
Every fact has a `validAt` (when it became true) and an `invalidAt`
(when it stopped being true — null for live facts). Default queries
hide invalidated rows. Pass `validAt: <iso>` to query a historical
slice. Soft-delete with `invalidate(id, ...)`. Hard-delete is gated
behind a configurable retention window.

### Code-fact drift detection
Memories about code carry a `codeBinding` — file path, structural
hash, commit SHA, last-verified timestamp. A sleeptime sweep
re-hashes every bound file and downweights drifted entries,
invalidates entries pointing at deleted files. The hash function is
shared with `@anvil/knowledge-core` so canonicalization can't drift
between packages.

### JSONL canonical, SQLite hot index
The source of truth is an append-only, git-mergeable JSONL file —
one memory per line. SQLite is a rebuildable hot index with FTS5
BM25, tag indexes, an edge table, and a proposal queue. WAL mode,
idempotent migrations, auto-rebuild from JSONL if the index ever
goes stale. If the SQLite write fails, the JSONL append already
succeeded — durability without coordination.

### PII + secret scrubber on every write
Regex-based redaction on the canonical write path. PII gets redacted
in place; credentials throw a `HardRejectError` so the call site
knows it just tried to persist a key. Toggle via
`ANVIL_MEMORY_SCRUB`. The `llm` mode is a reserved slot for
classifier-based scrubbing.

### Hybrid retrieval
BM25 + 1-hop graph expansion + Reciprocal Rank Fusion out of the
box. Personalized PageRank for multi-hop recall. Vector retrieval
is a stub today — the integration seam is there for when embeddings
land.

### PR-as-episode
`recordPrEpisode` writes structured episodic memory directly
(bypassing the proposal queue, since PRs are low-noise structured
events). Every shipped change becomes a queryable artifact:
which repos, which contracts, which tests, which reviewers, what
the verdict was.

---

## Architecture at a glance

```
                       ┌─────────────────────────────┐
   hot path ─propose─▶ │  ProposalQueue   (SQLite)   │
                       └──────────────┬──────────────┘
                                      │ sleeptime
                                      ▼
                       ┌─────────────────────────────┐
                       │  defaultDecide              │
                       │  hash-dedupe → MERGE / ADD  │
                       └──────────────┬──────────────┘
                                      │ ratify
                                      ▼
   ┌────────────────────────────────────────────────────────────────┐
   │  HybridMemoryStore                                             │
   │   ├─ JsonlAppendLog       canonical, append-only, git-mergeable│
   │   └─ SqliteHotIndex       FTS5 + tags + edges + proposals      │
   └────────────────────────────────────────────────────────────────┘
        │                          │
        ▼                          ▼
   bi-temporal queries     drift sweep (sleeptime)
   namespace-scoped        re-hashes bound files
                           downweights drift, invalidates missing
```

Every layer is a single file. Adjacency lives in a `memory_edge`
table; PPR runs in ~140 lines of TypeScript. No graph DB. No
external services.

---

## Namespacing

Memories live in tuples — `{ scope, projectId?, repoId?, userId? }` —
so a single store cleanly serves multi-project, multi-repo, multi-user
deployments. Namespace-scoped queries are the default. Cross-namespace
queries are explicit (`queryAll`), not accidental.

---

## Philosophy

**Quality over volume.** A memory that's wrong is worse than no
memory. Ratification, drift detection, and bi-temporal validity
exist so the answer to "what does the agent know?" is always
defensible.

**Code-aware, not code-blind.** Memories about code carry the hash
of the code they reference. When the code moves, the memory moves
with it — or gets pruned.

**Auditable by default.** JSONL is the source of truth. SQLite is an
optimization. You can `git diff` your agent's memory.

**No graph DB. No vector DB lock-in.** Adjacency is a table. Vector
is an opt-in. Replace either layer without rewriting the rest.

---

## Status

In active development. The core schema (`Memory<T>`), the
proposal-queue ↔ ratification pipeline, drift detection, and
bi-temporal querying are stable. Vector retrieval and LLM-mode
scrubbing are next on deck.

---

## Part of [Anvil](../../) — the AI development pipeline.
