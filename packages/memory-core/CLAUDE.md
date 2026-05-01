# CLAUDE.md — `@anvil/memory-core`

Guidance for Claude Code when working inside `packages/memory-core/`. The
long-term memory layer for Anvil — five-type taxonomy, bi-temporal facts,
hybrid retrieval, sleeptime ratification, code-fact drift detection.

## What this package owns

- `Memory<T>` canonical schema (`src/types.ts`) — locked verbatim in ADR §7.
  Five `MemoryKind` values: `working` | `episodic` | `semantic` |
  `procedural` | `profile`. `SemanticSubtype` carries the legacy
  `fix-pattern` / `success` / `approach` / `flaky-test` / `performance` /
  `manual` vocabulary.
- `HybridMemoryStore` (`src/storage/hybrid-store.ts`) — JSONL append-only
  canonical + SQLite hot index. Every `add()` writes JSONL first, then
  upserts SQLite. Auto-rebuilds the SQLite index from JSONL on open if
  the index is empty but the JSONL has data.
- `SqliteHotIndex` (`src/storage/sqlite-store.ts`) — `better-sqlite3`
  with FTS5 BM25 + tag index + edge table + proposal table. WAL mode +
  idempotent additive migrations.
- `JsonlAppendLog` (`src/storage/jsonl-store.ts`) — auditable,
  git-mergeable source of truth. One `Memory<T>` per line.
- Namespace helpers (`src/namespace/`) — `{scope, projectId?, repoId?, userId?}`
  tuples. `namespaceToRelativePath`, `pathToNamespace`,
  `interpretLegacyDir` (legacy `<dir>/` → `{scope:'project', projectId:<dir>}`).
- Scrubber (`src/scrubber/`) — regex PII/secret rules wired into
  `HybridMemoryStore.add`. `credential`-class matches throw
  `HardRejectError`; PII-class matches redact in place. Mode controlled
  by `ANVIL_MEMORY_SCRUB` (`1`=regex default, `0`=off, `llm`=reserved).
- Drift detection (`src/drift/`) — `checkCodeBindingDrift` re-hashes a
  bound file via `@anvil/knowledge-core:computeStructuralHash` and
  reports `fresh` / `drifted` / `missing`. `verifyCodeBindings` is the
  sleeptime sweep with `downweight` / `invalidate` policies.
- Retrieval (`src/retrieve/`) — BM25 + vector (stub today) + 1-hop graph
  expansion + Reciprocal Rank Fusion. Personalized PageRank
  (`personalizedPageRank` + `pprSearch`) for multi-hop recall.
- Sleeptime (`src/sleeptime/`) — `ProposalQueue` (SQLite-backed),
  `defaultDecide` (hash-dedupe → MERGE-INTO else ADD), `ratifyProposal`
  (4 outcomes), `consolidate` (orchestrator).
- Reflection (`src/reflect/`) — `reflectOnRun` calls a caller-supplied
  invoker, parses JSON, enqueues proposals.
- PR-as-episode (`src/episode/`) — `recordPrEpisode` writes
  `Memory<PrEpisode>` directly to durable storage, bypassing the
  proposal queue (auto-ratified per plan §12).
- Inspector (`src/inspector/`) — `MemoryInspector` is the
  framework-agnostic surface the dashboard's REST handlers consume.
- Migration (`src/migrate/`) — `importLegacyMemories` ingests v0
  `<root>/<project>/memories.jsonl` files into the v2 store. Idempotent
  (id-preserved upserts). Writes `.pre-migration.bak` per file unless
  `skipBackup: true`.
- Legacy primitives (`src/legacy/`) — pre-v2 cli memory store hoisted
  in Phase 2. Pure file movement; no semantic change. Re-exported
  separately from the v2 barrel because `MemoryKind` differs.

Public barrel: `src/index.ts` re-exports everything except `legacy/`,
which is reachable via the `@anvil/memory-core/legacy/index.js` subpath.

## Build + test

```sh
npm -w @anvil/memory-core run build       # tsc -b
npm -w @anvil/memory-core test            # node --test on dist/__tests__/*.test.js
npm -w @anvil/memory-core run dev         # tsc -b --watch
```

Tests live at `src/__tests__/*.test.ts`. Runtime deps:
`@anvil/agent-core`, `@anvil/knowledge-core` (for `computeStructuralHash`),
`better-sqlite3`, `ulid`.

## Conventions

### Writing new memories

- Always go through `HybridMemoryStore.add()` — never write directly to
  JSONL or SQLite. The scrubber (Phase 7) sits inside `add()`.
- Catch `HardRejectError` at every call site that touches user-supplied
  text. The error carries `redactions` so callers can log which rules
  matched.
- Use ULID for `id` (`import { ulid } from 'ulid'`). ULIDs sort
  lexicographically by creation time so `ORDER BY id` doubles as
  chronological order.
- Set `bitemporal.validAt = createdAt` for facts that are true now.
  `invalidAt` is reserved for soft-delete (Phase 5) — set via
  `store.invalidate(id, ...)`, not directly.
- Set `decay.strength = 100` for fresh memories; `lastAccessed = createdAt`.

### Auto-learners on the hot path

- **Propose, don't write.** Use `ProposalQueue.enqueue(candidate, reason)`
  rather than `store.add(...)`. Sleeptime ratifies. This is the
  architectural fix for mem0's "every event becomes a memory" failure mode.
- The only callers that write directly are `recordPrEpisode` (structured
  low-noise) and `importLegacyMemories` (one-shot migration).

### Code-fact memories

- Memories about code MUST carry `codeBinding: { filePath, structuralHash,
  lastSeenCommitSha, lastVerifiedAt }`. The structural hash comes from
  `@anvil/knowledge-core:computeStructuralHash` so canonicalization
  doesn't drift across packages.
- The drift sweep is the sleeptime task that keeps these honest.
  `verifyCodeBindings(store, ns, opts)` defaults to `downweight` for
  `drifted` and `invalidate` for `missing` (a deleted file is a hard signal).

### Bi-temporal queries

- Default queries hide invalidated rows. Pass
  `includeInvalidated: true` (admin / audit) or `validAt: <iso>`
  (historical slice) to peer back.
- TTL expiry → soft-delete via `pruneExpired(now)`. Manual contradictions
  → `invalidate(id, invalidAt, reason, runId?)`.
- Hard delete only happens via `hardDeleteInvalidatedOlderThan(cutoff)`
  past the retention window (default 365 days per ADR §M8). The JSONL
  audit trail is NOT rewritten — only SQLite rows drop.

### Namespace discipline

- Always call namespace-scoped queries: `store.query(ns, opts)`. Use
  `store.queryAll(opts)` only for migrations and dashboard `--scope=*`
  flags.
- Sanitize before letting user input into a namespace tuple — the path
  resolver does basic sanitization (`sanitizeSegment`) but namespaces
  are also persisted into SQLite columns, so don't pass arbitrary text.

### Scrubber

- `ANVIL_MEMORY_SCRUB=0` is documented as **unsafe** — it disables
  redaction entirely. Don't ship code that defaults to off. Tests can
  use the `scrubber.mode='off'` option directly.
- New regex rules go in `src/scrubber/regex-rules.ts` with a category
  (`pii` redacts; `credential` hard-rejects).
- The `llm` mode is a reserved slot — the LLM classifier lands when
  memory-core gains a LanguageModel registry (deferred per ADR §8 Phase 7).

### Migration importer

Idempotent — re-running with the same legacy file is a no-op because
the v2 `id` is preserved from the legacy entry. The importer routes
every entry through the scrubber, so any inadvertent secrets in legacy
data get redacted at import time.

## Architecture decisions you should know

- **JSONL canonical, SQLite hot index** — JSONL is the auditable,
  git-mergeable source of truth. SQLite is rebuildable at any time via
  `rebuildIndexFromJsonl()`. If the SQLite write fails, the JSONL
  append still succeeded.
- **No graph DB.** Adjacency lives in `memory_edge` table; PPR runs in
  TS over JS arrays (~140 LOC). Acceptable replacement cost.
- **Vector retrieval is stubbed.** `src/retrieve/vector.ts` returns
  empty results today. Sleeptime will populate embeddings in a later
  follow-up; LanceDB consumption already in tree via knowledge-core.
- **Auto-learners propose; sleeptime ratifies.** This is non-negotiable
  — direct writes from hot-path code paths should be reviewed.

## Things that don't exist (intentionally)

- No mem0 / Letta / Zep / LangMem / Cognee SDKs. Patterns stolen, code
  hand-rolled.
- No graph database (Neo4j / Memgraph / etc).
- No LLM-driven scrub today (regex only). The slot is reserved.
- No native LanguageModel client inside memory-core. Reflection takes
  a caller-supplied `ReflectionInvoker(systemPrompt, userPrompt) => Promise<string>`.

## Where to look first

- Storage shape? `src/storage/schema.ts` is the single SQL source of
  truth. `src/types.ts` is the canonical `Memory<T>` schema.
- Read path? `HybridMemoryStore.query` → branches on text/tags/validAt.
  Hybrid retrieval? `src/retrieve/hybrid.ts` is ~70 LOC.
- Sleeptime end-to-end? `src/sleeptime/consolidate.ts` calls
  `defaultDecide` → `ratifyProposal`.
- Drift sweep? `src/drift/verify.ts:verifyCodeBindings`.
- Migration? `src/migrate/importer.ts` — single function, ~200 LOC.

## Architecture + flow docs

- `ARCHITECTURE.md` — module map, schema, type surface, public API.
- `FLOW.md` — sequence diagrams for write path, read path, sleeptime
  consolidation, reflection, drift sweep, migration.
