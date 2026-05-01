# `@anvil/memory-core` — Architecture

Reference for what physically lives in `packages/memory-core/src/` and how
the modules wire together. No future-tense roadmap content — only what
compiles today.

## 1. Layered module map

```
                ┌──────────────────────────────────────────────────────┐
                │ Consumers: cli, dashboard, agent runners             │
                └──────────────────────────────────────────────────────┘
                                        │
                                        ▼
        ┌────────────────────────────────────────────────────────────────┐
        │ src/index.ts — public barrel (everything except legacy/)       │
        │ src/legacy/index.ts — separate barrel for v0 primitives        │
        └────────────────────────────────────────────────────────────────┘
              │              │              │             │            │
              ▼              ▼              ▼             ▼            ▼
   ┌───────────────┐ ┌──────────────┐ ┌───────────┐ ┌──────────┐ ┌─────────────┐
   │ Inspector     │ │ Sleeptime    │ │ Reflect   │ │ Episode  │ │ Migrate     │
   │ (dashboard)   │ │ + Reflect    │ │           │ │          │ │ (importer)  │
   │ src/inspector │ │ src/sleeptime│ │ src/reflect│ │src/episode│ │ src/migrate │
   └───────────────┘ └──────────────┘ └───────────┘ └──────────┘ └─────────────┘
              │              │              │             │            │
              └──────────────┴──────────────┴─────────────┴────────────┘
                                        │
                                        ▼
                ┌────────────────────────────────────────────┐
                │ HybridMemoryStore (src/storage/)           │
                │   ├─ JsonlAppendLog (canonical)            │
                │   ├─ SqliteHotIndex (FTS5 BM25 + tags +    │
                │   │   edges + proposals + bitemporal cols) │
                │   └─ scrubber wired into add()             │
                └────────────────────────────────────────────┘
                                        │
                ┌─────────────────┬─────┴─────────────┬───────────────────┐
                ▼                 ▼                   ▼                   ▼
        ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────────┐
        │ retrieve/    │ │ drift/       │ │ scrubber/    │ │ namespace/      │
        │ BM25 + graph │ │ structural   │ │ regex rules  │ │ {scope,...}     │
        │ + RRF + PPR  │ │ hash drift   │ │ + hard reject│ │ path resolver   │
        └──────────────┘ └──────────────┘ └──────────────┘ └─────────────────┘
                                        │
                                        ▼
                          ┌─────────────────────────────┐
                          │ types.ts (canonical schema) │
                          │  Memory<T>, MemoryNamespace,│
                          │  Proposal, PrEpisode, ...   │
                          └─────────────────────────────┘
```

## 2. Type surface (`src/types.ts`)

Locked verbatim per ADR §7. Additive-only changes.

### 2.1 `MemoryKind` taxonomy

```ts
type MemoryKind = 'working' | 'episodic' | 'semantic' | 'procedural' | 'profile';

type SemanticSubtype =
  | 'fix-pattern' | 'success' | 'approach'
  | 'flaky-test' | 'performance' | 'manual';
```

| Kind         | When                                       | Persistence              |
|--------------|--------------------------------------------|--------------------------|
| `working`    | In-context only (scratchpad)               | **never** — runtime only |
| `episodic`   | Run events, PR records, observed traces    | durable                  |
| `semantic`   | Facts (carries `subtype`)                  | durable                  |
| `procedural` | How-to rules; sleeptime PROPOSES SKILL.md  | durable                  |
| `profile`    | User preferences inferred from interaction | durable                  |

### 2.2 `MemoryNamespace`

```ts
interface MemoryNamespace {
  scope: 'global' | 'user' | 'project' | 'repo';
  projectId?: string;
  repoId?: string;
  userId?: string;
}
```

Filesystem layout:

```
~/.anvil/memory/
  global/
  user/<userId>/
  project/<projectId>/
  repo/<projectId>/<repoId>/
  <legacy-project>/         ← treated as {scope:'project', projectId:<dir>}
```

### 2.3 `Memory<T>`

```ts
interface Memory<T = string> {
  id: string;                       // ULID
  namespace: MemoryNamespace;
  kind: MemoryKind;
  subtype?: SemanticSubtype;
  content: T;
  embedding?: number[];             // lazy (Phase 8)
  tags: string[];
  confidence: number;               // 0..100
  ttlDays: number;                  // -1 = never
  expiresAt: string;                // ISO; createdAt + ttlDays
  bitemporal: BiTemporal;           // validAt + invalidAt?
  decay: DecayState;                // lastAccessed + strength + rehearseCount
  codeBinding?: CodeFactBinding;    // filePath + structuralHash + lastSeenCommitSha + lastVerifiedAt
  provenance: MemoryProvenance;     // createdBy + timestamps + invalidatedBy
  links?: MemoryLink[];             // graph edges
}
```

Well-known link relations: `MEMORY_LINK_RELATIONS.SUPERSEDES` /
`REFERENCES` / `DERIVED_FROM`.

### 2.4 `Proposal` + `PrEpisode`

```ts
interface Proposal {
  id: string;
  candidate: Memory;
  reason: string;
  status: 'pending' | 'ratified' | 'rejected' | 'merged-into';
  ratifiedTo?: string;
  rejectedReason?: string;
  proposedAt: string;
  decidedAt?: string;
}

interface PrEpisode {
  prUrl, intent, plan, filesChanged[], commitShas[], testsAdded[];
  ciStatus: 'pass' | 'fail' | 'pending' | 'skipped';
  reviewOutcome?: 'approved' | 'changes-requested' | 'commented';
  mergeStatus?: 'merged' | 'closed' | 'open';
  durationMs: number;
  costUsd: number;
}
```

## 3. Storage layer (`src/storage/`)

### 3.1 `HybridMemoryStore`

```
HybridMemoryStore.open({ jsonlPath, sqlitePath, skipAutoRebuild?, scrubber? })
  ├─ new JsonlAppendLog(jsonlPath)
  ├─ new SqliteHotIndex(sqlitePath)        ← applies SCHEMA_SQL idempotently
  └─ if !skipAutoRebuild && jsonl.exists() && sqlite.count() === 0:
        rebuildIndexFromJsonl()            ← stderr warns
```

Public API:

- `add(m: Memory): ScrubResult | null` — scrub → JSONL append → SQLite upsert.
  Throws `HardRejectError` when credential rules match.
- `findById(id)` / `searchByTags(tags, opts)` / `searchByText(query, opts)`
  / `validAtTime(at, opts)`.
- `query(ns, opts)` — namespace-scoped: branches on `text` →
  `searchByText`, `tags` → `searchByTags`, `validAt` → `validAtTime`,
  else "all in namespace". Bi-temporal default filters out invalidated
  rows unless `includeInvalidated: true` or explicit `validAt`.
- `queryAll(opts)` — same shape, no namespace filter (admin / migrations).
- `invalidate(id, invalidAt, reason, runId?)` — soft-delete in SQLite +
  tombstone in JSONL.
- `pruneExpired(now?)` — TTL → invalidate.
- `hardDeleteInvalidatedOlderThan(cutoff)` — physical SQLite drop. JSONL
  audit trail kept.
- `neighborsOf(seedIds, opts)` — 1-hop graph expansion via `memory_edge`.
- `rebuildIndexFromJsonl()` — drop SQLite tables + re-upsert every JSONL line.

### 3.2 SQLite schema (`src/storage/schema.ts`)

`SCHEMA_VERSION = 2`. Embedded as a TS string; applied on every open.
Idempotent additive migrations (PRAGMA-detect missing columns + ALTER).

Tables:

| Table | Purpose |
|---|---|
| `memory` | one row per `Memory<T>`; flattened fields, `content_json` carries the payload |
| `memory_fts` | FTS5 virtual table for BM25-ranked text search |
| `memory_tag` | many-to-many tag fan-out |
| `memory_edge` | graph edges (source, target, relation, weight, valid_at, invalid_at) |
| `proposal` | proposal queue (Phase 10) |
| `schema_version` | applied migrations |

Indexes: `(namespace_scope, namespace_project, namespace_repo, namespace_user)`,
`kind`, `subtype`, `expires_at`, `(valid_at, invalid_at)`, `code_file`,
`strength`, `(tag)`, `(source_id)`, `(target_id)`, `(status, proposed_at)`.

Pragmas: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`.

### 3.3 `JsonlAppendLog`

Single file, one JSON object per line. `appendFileSync` per write.
`readAll()` skips blank lines + logs malformed lines to stderr.
`rewrite(records)` overwrites — used by no current path; kept for
forward-compat with migrations.

## 4. Namespaces (`src/namespace/`)

`path-resolver.ts` exports:

```
namespaceToRelativePath(ns)   → 'project/<projectId>'  (validates required fields)
pathToNamespace(relativePath) → MemoryNamespace | null  (v2 layout only)
interpretLegacyDir(dirName)   → MemoryNamespace        (handles legacy + 'global'/'_global')
namespacesEqual(a, b)         → boolean
namespaceKey(ns)              → 'scope:projectId|-:repoId|-:userId|-'
```

`sanitizeSegment`: strips `..`, `\:*?"<>|/`, lowercases, slices to 128
chars.

## 5. Scrubber (`src/scrubber/`)

Wired into `HybridMemoryStore.add()` via the constructor's
`scrubberOpts`. Default mode resolved from env (`ANVIL_MEMORY_SCRUB`):

- `0` / `off` / `false` → `'off'` (input passes through unchanged)
- `llm` → `'llm'` (reserved; falls back to regex today)
- anything else / unset → `'regex'` (default)

`scrub(input, opts)` returns:

```ts
ScrubResult {
  cleaned: string;
  redactions: { rule, category: 'pii'|'credential', count }[];
  hardReject: boolean;
  mode: 'off' | 'regex' | 'llm';
}
```

Categories: `pii` rules redact in place; `credential` rules set
`hardReject = true` (default `hardRejectOnCredential: true`). Callers
catch `HardRejectError`.

`HybridMemoryStore.add` flow:

1. `scrubMemory(m)` — stringify content if non-string (`safeStringify`).
2. If `result.hardReject` → throw `HardRejectError(...)`.
3. If redactions non-empty → if `content` is a string, replace with
   `result.cleaned`; if structured, parse the cleaned JSON or pass
   through (per-shape rewrite is deferred).
4. JSONL append + SQLite upsert.

## 6. Drift detection (`src/drift/`)

Code-fact memories carry `codeBinding`. The drift detector re-hashes the
file via `@anvil/knowledge-core:computeStructuralHash`.

- `checkCodeBindingDrift(binding, { workspaceRoot, language? })` — pure
  function returns `{ status: 'fresh'|'drifted'|'missing', currentHash? }`.
- `detectLanguageFromPath(filePath)` — extension → tree-sitter language.
- `verifyCodeBindings(store, namespace, opts)` — sleeptime sweep:
  - Loads every memory in the namespace (incl. invalidated; useful for
    audits).
  - Skips memories whose `lastVerifiedAt` is fresher than `staleAfterDays`.
  - For each: stamps `lastVerifiedAt = now`; applies policy:
    - `'downweight'` (default for `drifted`) — scales `decay.strength` by
      `downweightFactor` (default 0.5).
    - `'invalidate'` (default for `missing`) — calls `store.invalidate(...)`
      with reason `code-drift:<file>` or `code-missing:<file>`.
  - Errors on a single file log to stderr and continue.

## 7. Retrieval (`src/retrieve/`)

### 7.1 `hybridSearch` — top-level entry

```
hybridSearch(store, query, opts)
  ├─ bm25Hits   = bm25Search(store, query, { namespace, limit:20 })
  ├─ vectorHits = await vectorSearch(...)         ← stub today (returns [])
  ├─ seeds      = dedupeById([...bm25, ...vector])
  ├─ graphHits  = expandNeighbors(store, seeds, { limit:20 })
  └─ return reciprocalRankFusion([
       { results: bm25Hits,   weight: 1   },
       { results: vectorHits, weight: 1   },
       { results: graphHits,  weight: 0.5 },
     ], { k: 60, limit })
```

### 7.2 Personalized PageRank

`personalizedPageRank(adjacency, seeds, opts)` — pure-TS power iteration.
α = damping (default 0.85), maxIterations 100, ε = 1e-6.

`pprSearch(store, namespace, seeds, opts)`:

```
extractNamespaceSubgraph(store, namespace) → { adjacency, nodes }
personalizedPageRank(adjacency, seedMap, opts) → { scores, iterations, converged }
filter scores by namespace.nodes
exclude invalidated (default true)
sort desc by score, limit
```

### 7.3 Stubs / forward compat

- `vectorSearch` returns `[]` today. LanceDB consumption is wired through
  `@anvil/knowledge-core` already; sleeptime will populate embeddings.
- BM25 over SQLite FTS5 is the workhorse.

## 8. Sleeptime (`src/sleeptime/`)

```
auto-learner ─► ProposalQueue.enqueue ─► consolidate ─► HybridMemoryStore
   (hot)            (Phase 10)             (sleeptime)
                          │                     │
                          │                     ├─ defaultDecide (or caller)
                          │                     ├─ ratifyProposal
                          │                     │     'add' | 'merge-into'
                          │                     │     | 'reject' | 'supersede'
                          │                     └─ updateStatus on the queue
                          │
                          └─ reflectOnRun (Phase 11) on PR/CI complete
```

### 8.1 `ProposalQueue`

Thin typed surface around the `proposal` SQLite table.

- `enqueue(candidate, reason, opts?)` → `Proposal` with status='pending'.
- `get(id)`, `listPending(opts?)`, `list(status, opts?)`.
- `updateStatus(id, status, fields?)`.

### 8.2 `defaultDecide` policy

```
findNearestDuplicate(store, proposal.candidate)?
  exact?     → { kind: 'merge-into', targetId: dup.memory.id }
  default    → { kind: 'add' }
```

`findNearestDuplicate` uses `contentDigest` + BM25 nearest neighbor.

### 8.3 `ratifyProposal` outcomes

| Decision      | Effect on durable store | Effect on proposal |
|---------------|-------------------------|--------------------|
| `add`         | `store.add(stamped)`    | status=ratified, ratifiedTo=new id |
| `merge-into`  | bump confidence + strength + rehearseCount on target | status=merged-into, ratifiedTo=targetId |
| `reject`      | (no-op)                 | status=rejected, rejectedReason |
| `supersede`   | new memory + `store.invalidate(targetId, ..., reason: 'superseded-by:<new>')` | status=ratified, ratifiedTo=new id; new memory has `links:[{targetId, relation: SUPERSEDES}]` |

Edge case: `merge-into` with a missing target falls back to `add`
(don't lose the signal).

### 8.4 `consolidate(store, queue, namespace, opts)`

Walks `queue.listPending({ namespace, limit })`, calls
`opts.decideFn ?? defaultDecide` per proposal, applies via
`ratifyProposal`. Returns `{ scanned, ratified, merged, rejected, superseded }`.

Cross-process locking is deferred (plan §10.4); today's pass relies on
SQLite transaction semantics.

## 9. Reflection (`src/reflect/`)

`reflectOnRun(opts)`:

1. `buildReflectionUserPrompt(runContext)` (`prompts.ts`).
2. `await opts.llmInvoke(REFLECTION_SYSTEM_PROMPT, userPrompt)` —
   caller-supplied invoker. Memory-core does NOT bundle a LanguageModel
   client; the caller plugs in agent-core or any other.
3. `parseReflectionJson(rawOutput)` (`extractor.ts`) — tolerant of
   surrounding prose.
4. `reflectIntoProposals(queue, reflection, { namespace, runId, now, ttlDays })`
   (`mapper.ts`) — enqueues each `failure`/`success`/`surprise`/`skill-proposal`
   as a `Proposal`.

Returns `{ enqueued counts, reflection, rawOutput }`.

## 10. Episode (`src/episode/`)

`recordPrEpisode(store, episode, opts)`:

- Builds a `Memory<PrEpisode>` with `kind='episodic'`, tags
  `['pr-episode', 'ci:<status>', 'merge:<status>?', 'review:<outcome>?']`.
- `provenance.createdBy='pr-episode'`, `ratifiedAt = now` (auto-ratified
  per plan §12 — structured episodes skip the proposal queue).
- `store.add(memory)` — JSON.stringify of the `PrEpisode` becomes the
  FTS-indexed text, so BM25 matches against intent / plan / file paths.

`retrievePrEpisodes(store, query, opts)` — BM25 search filtered to
`pr-episode` tag with optional CI/merge filters.

## 11. Inspector (`src/inspector/`)

`MemoryInspector(store)` is the dashboard / cli read primitive.
Construct over an existing `HybridMemoryStore`; auto-instantiates a
`ProposalQueue` over the same SQLite handle.

API:

- `list(filter)` → `Memory[]` — branches on search/namespace, applies
  kind/subtype filters in JS.
- `detail(id)` → `Memory | null`.
- `listProposals(status='pending', namespace?, limit?)`.
- `ratifyProposal(id)` — admin-only; bypasses `defaultDecide`.
- `rejectProposal(id, reason)` — admin-only.
- `driftSweep(opts, namespace)` → `verifyCodeBindings(...)`.
- `stats(namespace?)` → `{ total, byKind, bySubtype, topTags, invalidated, withCodeBinding }`.

## 12. Migration (`src/migrate/`)

`importLegacyMemories(legacyRoot, store, opts)`:

1. Walk every direct subdirectory of `legacyRoot`.
2. Skip if no `memories.jsonl` inside.
3. Backup `<legacyFile>.pre-migration.bak` (unless `skipBackup` /
   `dryRun`).
4. For each legacy `MemoryEntry` (from `src/legacy/`):
   - Map legacy `kind` (vocabulary like `fix-pattern` / `success` / ...)
     to v2 `kind='semantic'` + `subtype = legacyKind`.
   - Build `Memory<string>` with `namespace = interpretLegacyDir(dir)`,
     `provenance.createdBy='migration'`, `provenance.sourceRunId='pre-migration'`,
     `bitemporal.validAt = legacy.createdAt`, `decay.strength=100`.
   - `store.add(m)` — routes through scrubber. `HardRejectError` →
     `report.rejected += 1`, `errors.push({ file, entryId, reason })`.

Idempotent — `id` preserved; `HybridMemoryStore.add` upserts.

Returns `{ filesScanned, entriesScanned, imported, skipped, scrubbed,
rejected, byNamespace, errors }`.

## 13. Legacy primitives (`src/legacy/`)

Hoisted from `cli/src/memory/` in Phase 2. Pure file movement; cli
re-exports under canonical names. Re-exported separately because the
legacy `MemoryKind` differs from v2's.

Surface: `MemoryKind`, `MemoryEntry`, `MemoryQueryOpts`, `MemoryStoreConfig`,
`DEFAULT_TTL_DAYS`, `MAX_SIZE_BYTES`, `readJSONL`/`appendJSONL`/`writeJSONL`,
`MemoryStore`, `createMemoryEntry`, `pruneExpired`, `pruneBySize`,
`queryByTags`, `queryByContent`, `selectTopK`.

## 14. File layout

```
packages/memory-core/
├── package.json
├── tsconfig.json
├── README.md
├── CLAUDE.md
├── ARCHITECTURE.md
├── FLOW.md
└── src/
    ├── index.ts                     ← public barrel
    ├── version.ts
    ├── types.ts                     ← canonical schema
    ├── storage/
    │   ├── index.ts
    │   ├── schema.ts                ← SCHEMA_SQL + SCHEMA_VERSION
    │   ├── jsonl-store.ts
    │   ├── sqlite-store.ts
    │   └── hybrid-store.ts
    ├── namespace/
    │   ├── index.ts
    │   └── path-resolver.ts
    ├── scrubber/
    │   ├── index.ts
    │   ├── regex-rules.ts
    │   └── scrub.ts
    ├── drift/
    │   ├── index.ts
    │   ├── language.ts
    │   ├── drift-detector.ts
    │   └── verify.ts
    ├── retrieve/
    │   ├── index.ts
    │   ├── bm25.ts
    │   ├── vector.ts                ← stub
    │   ├── graph.ts
    │   ├── fusion.ts                ← Reciprocal Rank Fusion
    │   ├── hybrid.ts
    │   ├── ppr.ts                   ← Personalized PageRank
    │   ├── subgraph.ts
    │   └── ppr-search.ts
    ├── sleeptime/
    │   ├── index.ts
    │   ├── proposal-queue.ts
    │   ├── dedupe.ts                ← contentDigest + findNearestDuplicate
    │   ├── ratify.ts
    │   └── consolidate.ts
    ├── reflect/
    │   ├── index.ts
    │   ├── prompts.ts
    │   ├── extractor.ts
    │   ├── mapper.ts
    │   └── reflector.ts
    ├── episode/
    │   ├── index.ts
    │   └── pr-episode.ts
    ├── inspector/
    │   ├── index.ts
    │   └── inspector.ts
    ├── migrate/
    │   ├── index.ts
    │   └── importer.ts
    ├── legacy/
    │   ├── index.ts                 ← v0 surface; subpath import
    │   ├── types.ts
    │   ├── jsonl.ts
    │   ├── memory-store.ts
    │   ├── entry-factory.ts
    │   ├── expiration.ts
    │   ├── size-prune.ts
    │   ├── query-by-tags.ts
    │   ├── query-by-content.ts
    │   └── top-k.ts
    └── __tests__/
        ├── bitemporal.test.ts
        ├── drift.test.ts
        ├── inspector.test.ts
        ├── legacy-smoke.test.ts
        ├── migrate.test.ts
        ├── namespace.test.ts
        ├── pr-episode.test.ts
        ├── ppr.test.ts
        ├── reflect.test.ts
        ├── retrieve.test.ts
        ├── scrubber.test.ts
        ├── sleeptime.test.ts
        └── storage.test.ts
```

## 15. Runtime dependencies

From `package.json`:

- `@anvil/agent-core` — workspace dep; reserved slot for the eventual
  LanguageModel registry inside memory-core (scrubber `llm` mode +
  reflection invoker default). Not yet consumed at runtime by any
  call path.
- `@anvil/knowledge-core` — `computeStructuralHash` for drift detection.
- `better-sqlite3` (^11.7.0) — synchronous SQLite, single-file, native
  bindings with prebuilds. Replacement cost: rewrite the storage
  adapter (~200 LOC).
- `ulid` (^2.3.0) — ID generation; lex-sortable, URL-safe, 26 chars.

No vendor memory SDK (mem0, Letta, Zep, LangMem, Cognee). No graph DB.

## 16. Tests

`node --test` runs every compiled `dist/__tests__/*.test.js`.

| Test | What |
|---|---|
| `storage.test.ts` | hybrid store add/query/invalidate/rebuild |
| `bitemporal.test.ts` | invalidate / `validAt` slicing / `includeInvalidated` |
| `namespace.test.ts` | path resolver round-trips + legacy interpretation |
| `scrubber.test.ts` | regex rules, hard-reject, mode resolution |
| `drift.test.ts` | structural-hash diff + verify policies |
| `retrieve.test.ts` | bm25 + graph + fusion ranking |
| `ppr.test.ts` | PPR convergence + namespace subgraph |
| `sleeptime.test.ts` | proposal queue + ratify + consolidate |
| `reflect.test.ts` | prompt → JSON parse → enqueue |
| `pr-episode.test.ts` | build + record + retrieve |
| `inspector.test.ts` | list/detail/stats/proposal admin |
| `migrate.test.ts` | importer dry-run + backup + idempotency |
| `legacy-smoke.test.ts` | v0 surface still loads |
