# Memory Core — Architecture Decision Record

> Companion to [`MEMORY-CORE-EXTRACT-PLAN.md`](./MEMORY-CORE-EXTRACT-PLAN.md). Locks decisions M1–M15, the persistence-site inventory, the public API migration table, the schema shapes Phase 1+ ship verbatim, and the per-phase commit log.
>
> **Status:** Phase 0 — locked 2026-04-29.
> **Depends on:** [`AGENT-CORE-EXTRACT-PLAN.md`](./AGENT-CORE-EXTRACT-PLAN.md) (shipped), [`AGENT-OBSERVABILITY-PLAN.md`](./AGENT-OBSERVABILITY-PLAN.md) (shipped), [`AGENT-HARNESS-PLAN.md`](./AGENT-HARNESS-PLAN.md) (shipped). [`KNOWLEDGE-CORE-EXTRACT-PLAN.md`](./KNOWLEDGE-CORE-EXTRACT-PLAN.md) (shipped) — reused for `structural-hasher.ts`, `vector-store.ts`, `embedder.ts`.

---

## 1. Pre-flight reality check (verified 2026-04-29)

| Check | Result |
|---|---|
| `packages/agent-core/` exists | ✅ |
| `packages/agent-core/src/skills/loader.ts` exists (Plan C shipped) | ✅ |
| `packages/agent-core/src/telemetry/tracer.ts` exists (Plan B shipped) | ✅ |
| `packages/knowledge-core/src/structural-hasher.ts` exists | ✅ |
| `packages/cli/src/memory/` exists (current implementation, 18 files / ~743 LOC) | ✅ |
| `packages/memory-core/` does **not** exist yet | ✅ |
| `MEMORY-CORE-ADR.md` does **not** exist yet | ✅ → this file |

No reconciliation needed.

---

## 2. Decisions

The decisions below paraphrase the plan's §"Decisions" table, with one-line `Why` qualifiers so future-readers don't have to bounce back to the plan.

### M1 — Storage substrate

**Choice:** Hybrid — append-only JSONL archive (auditable, git-friendly source of truth) + SQLite hot index (`better-sqlite3` + FTS5 for BM25 + indexed reads) + LanceDB vector recall (already in tree via `@anvil/knowledge-core`) + SQLite adjacency tables for graph PPR.

**Why:** JSONL survives corruption + is git-mergeable; SQLite scales past 10k entries; no Postgres / Neo4j / Python sidecar. The single-file native dep is `better-sqlite3` (MIT, prebuilds for every platform Node ships on).

### M2 — Graph backend

**Choice:** SQLite adjacency tables; Personalized PageRank computed in TS over JS arrays.

**Why:** ~80 LOC of TS; per-project subgraph stays small enough for in-memory PPR; zero new heavy infra.

### M3 — Sleeptime cadence

**Choice:** Configurable. Defaults to "on PR/CI completion" + "every 25 pipeline runs" + "on idle 30 min" — whichever fires first.

**Why:** CI completion is the natural ratification trigger for a coding agent. Fallbacks ensure consolidation runs even without CI hooks.

### M4 — Memory taxonomy

**Choice:** Five types — `working` (in-context only), `episodic` (run events, PR records), `semantic` (facts; existing kinds become subtypes), `procedural` (how-to rules → proposes SKILL.md via Plan C), `profile` (user preferences).

**Why:** LangMem split, validated by CoALA. `procedural` overlaps with Plan C's skills — sleeptime *proposes* SKILL.md files rather than raw prompt patches.

### M5 — Migration of existing data

**Choice:** One-shot importer (`anvil memory migrate`) reads `~/.anvil/memory/<project>/memories.jsonl` (or wherever current data lives) and ingests with provenance preserved (`source_run_id = "pre-migration"`, original `confidence` + `tags` retained).

**Why:** Existing users' data must not be lost.

### M6 — PII / secret scrubbing

**Choice:** On by default; regex + optional LLM classifier with hard-reject on classified secrets. Disable via `ANVIL_MEMORY_SCRUB=0`.

**Why:** Security default. Users who *want* raw memory are unusual; opt-out is the right escape hatch.

### M7 — Code-fact drift detection

**Choice:** Every memory mentioning code carries `(file_path, structural_hash, last_seen_commit_sha)`; on retrieval, drifted memories auto-downweight or invalidate. Reuses `@anvil/knowledge-core/structural-hasher.ts`.

**Why:** The single largest improvement over current Anvil memory — stops stale memories from poisoning new runs.

### M8 — Bi-temporal model

**Choice:** `valid_at` + `invalid_at` on every memory; never delete; mark invalid.

**Why:** Zep pattern. Lets you query "what did the system know as of T?" — crucial for debugging memory pollution.

### M9 — Sleeptime ratification

**Choice:** Background pass with its own LLM call, separate from agent runs. Auto-learners *propose*; consolidator decides.

**Why:** Letta pattern. Architectural defense against mem0's documented 97.8%-junk failure mode.

### M10 — Skills overlap

**Choice:** Procedural memory proposes new SKILL.md files; does NOT duplicate the skill loader. Plan C owns the skills *reader*; memory plan extends it as a *writer*.

**Why:** Single ownership for the skills surface; memory adds the production side.

### M11 — Auto-learner gating

**Choice:** Auto-learners (`recordFixPattern`, `recordSuccess`, `recordApproach`) write to the proposal queue, not directly to durable store. Existing call sites unchanged.

**Why:** Same defense as M9; preserves existing public API while routing through proposals internally.

### M12 — Convention-rule integration

**Choice:** `packages/cli/src/conventions/` does NOT move to memory-core in v1; it stays in cli but gains a "publish to procedural memory" outlet.

**Why:** Conventions are cli-specific (factory.yaml, rule-generator). Procedural-memory bridge is small + reversible.

### M13 — Run records & audit logs

**Choice:** Stay in cli's `RunStore` / `AuditLog` for v1; memory-core READS them for episodic memory but doesn't move them.

**Why:** RunStore is heavily integrated with cli's pipeline. Moving = bigger blast radius than this plan should swallow.

### M14 — Multi-tenancy

**Choice:** LangMem namespace tuples — `(scope: 'global'|'user'|'project'|'repo', projectId?, repoId?, userId?)`.

**Why:** Single-key lookups are fast; range queries on prefixes are SQLite-natural.

### M15 — Forgetting policy

**Choice:** Two-stage. (a) Hard TTL — existing 30-day default kept. (b) Decay-and-rehearse (MemoryBank) — each retrieval refreshes `last_accessed`; entries below `strength_threshold` are pruned by sleeptime.

**Why:** Long-lived patterns survive even past TTL if they're being used. New addition; doesn't break existing TTL semantics.

---

## 3. Persistence-site inventory under `~/.anvil/`

Surveyed against the user's actual home directory on 2026-04-29.

### 3.1 Memory-shaped (target of this plan)

| Path | Format | Owner | Lifetime | Retrieval pattern | Disposition |
|---|---|---|---|---|---|
| `~/.anvil/memory/<project>/memories.jsonl` | JSONL append-only | `cli/memory/MemoryStore` | TTL 30d default + 1MB cap | tag/content/top-k | **Migrates to memory-core** (M5 importer) |
| `~/.anvil/memories/<project>/MEMORY.md` | Markdown index | Auto-memory subsystem (Claude Code-style) | Per-conversation | LLM reads on session boot | **Out of scope** — handled by harness/skills, not memory-core |

### 3.2 Episodic-source (memory-core READS, does NOT move)

| Path | Format | Owner | Lifetime | Disposition |
|---|---|---|---|---|
| `~/.anvil/runs/index.jsonl` | JSONL | cli `RunStore` | Per run; manual prune | M13: stays in cli; memory-core reads for episodic memory |
| `~/.anvil/checkpoints/` | JSON files | cli pipeline | Per checkpoint | Stays in cli |
| `~/.anvil/pipeline-audit/` | JSONL | cli audit-log | Per run | Stays in cli |

### 3.3 Procedural-source (memory-core READS + WRITES via M10/M12)

| Path | Format | Owner | Disposition |
|---|---|---|---|
| `~/.anvil/conventions/rules/*.yaml` | YAML | cli conventions | M12: stays in cli; gains a "publish to procedural memory" outlet |
| `<workspace>/.claude/skills/<name>/SKILL.md` | SKILL.md (Plan C) | agent-core skills | M10: memory-core PROPOSES new SKILL.md files; loader reads them |

### 3.4 Cache / non-memory persistence (untouched)

| Path | Owner | Reason |
|---|---|---|
| `~/.anvil/knowledge-base/` | knowledge-core | LanceDB vector + AST graph caches |
| `~/.anvil/features/`, `plans/`, `projects/`, `reviews/`, `pipeline-pauses/`, `cost-ledger/`, `cost-breaches/`, `tests/`, `state.json` | cli pipeline state | Not memory-shaped |

---

## 4. Public API surface — `packages/cli/src/memory/`

Each export is tagged with disposition: **moves** (lifts into memory-core), **stays** (cli-specific), **wraps** (memory-core ships v2; cli keeps a shim for backwards compat).

### 4.1 From `cli/src/memory/index.ts`

| Symbol | Disposition |
|---|---|
| `MemoryKind`, `MemoryEntry`, `MemoryQueryOpts`, `MemoryStoreConfig` | **moves** (semantic kinds become `SemanticSubtype` in v2 schema) |
| `DEFAULT_TTL_DAYS`, `MAX_SIZE_BYTES` | **moves** |
| `readJSONL`, `appendJSONL`, `writeJSONL` | **moves** |
| `MemoryStore` (with auto-pruning `ManagedMemoryStore` wrapper) | **moves** — constructor becomes path-injectable per plan §2.2 |
| `pruneExpired`, `pruneBySize` | **moves** |
| `queryByTags`, `queryByContent`, `selectTopK` | **moves** |
| `injectMemories` | **moves** |
| `trackMemoryUsage`, `createMemoryEntry` | **moves** |
| `createMemoryStore(project?)` factory (resolves `~/.anvil/memory/<project>/`) | **stays** in cli (project-aware path resolution); cli factory wraps memory-core's path-injectable `MemoryStore` |
| `resolveMemoryPath(project?)` | **stays** in cli (uses `getFFDirs()`, project-aware) |

### 4.2 From `cli/src/memory/learners/`

| Symbol | Disposition |
|---|---|
| `recordFixPattern`, `recordSuccess`, `recordApproach` | **moves** — but per M11 v2 routes through proposal queue |
| `pollution-detector` | **moves** |

### 4.3 From `cli/src/conventions/`

| Symbol | Disposition |
|---|---|
| Whole module | **stays** in cli per M12; gains a "publish to procedural memory" outlet from memory-core's procedural-write path |

---

## 5. External importers (sites that must update on Phase 2 hoist)

Identified via `grep -rln "from.*memory" packages/cli/src/`:

| File | Imports | Action |
|---|---|---|
| `packages/cli/src/pipeline/orchestrator.ts` | `injectMemories`, `createMemoryStore as createNewMemoryStore` | Switch `injectMemories` import to `@anvil/memory-core`; keep `createMemoryStore` from cli (project-aware factory wraps memory-core) |
| `packages/cli/src/commands/memory.ts` | `MemoryStore` | Switch to `@anvil/memory-core` |
| `packages/cli/src/conventions/promotion/violation-tracker.ts` | `readJSONL`, `appendJSONL` | Switch to `@anvil/memory-core` |

`packages/dashboard` and `packages/code-search-mcp` do **not** import cli/memory — confirmed.

---

## 6. Existing memory data — sample volumes (real user data, 2026-04-29)

| Path | Size | Format |
|---|---|---|
| `~/.anvil/memories/space-company/MEMORY.md` | (small) | Markdown auto-memory (out of scope) |
| `~/.anvil/memories/pet-company/MEMORY.md` | (small) | Markdown auto-memory (out of scope) |
| `~/.anvil/memory/<project>/memories.jsonl` | none yet on this machine | JSONL (target for M5 importer) |
| `~/.anvil/runs/index.jsonl` | 232 KB | JSONL run records |
| `~/.anvil/conventions/rules/` | 8 KB | YAML rule files |

The user's primary machine has no `~/.anvil/memory/` directory yet — the M5 importer must be a no-op-tolerant first run. Migration tests should cover both empty + populated states.

---

## 7. Schema decisions (locked — Phase 1 ships verbatim)

Below are the canonical TypeScript shapes future phases consume without further negotiation. Source: plan §1.2.

### 7.1 `MemoryKind` + `SemanticSubtype`

```ts
export type MemoryKind =
  | 'working'      // in-context only; never persisted
  | 'episodic'     // run events, PR records
  | 'semantic'     // facts (legacy fix-pattern/success/approach/flaky/perf live here)
  | 'procedural'   // how-to rules; propose SKILL.md
  | 'profile';     // user preferences

export type SemanticSubtype =
  | 'fix-pattern' | 'success' | 'approach'
  | 'flaky-test'  | 'performance' | 'manual';
```

### 7.2 `MemoryNamespace` (LangMem tuple)

```ts
export interface MemoryNamespace {
  scope: 'global' | 'user' | 'project' | 'repo';
  projectId?: string;
  repoId?: string;
  userId?: string;
}
```

### 7.3 `MemoryProvenance`

```ts
export interface MemoryProvenance {
  sourceRunId?: string;
  sourceMessageId?: string;
  sourceFile?: string;
  sourceCommit?: string;
  createdBy: 'auto-learner' | 'user' | 'reflection' | 'sleeptime' | 'pr-episode' | 'migration';
  createdAt: string;        // ISO-8601
  proposedAt?: string;      // when queued
  ratifiedAt?: string;      // when sleeptime promoted to durable
}
```

### 7.4 `CodeFactBinding` (drift-detection support)

```ts
export interface CodeFactBinding {
  filePath: string;
  structuralHash: string;   // from knowledge-core's structural-hasher
  lastSeenCommitSha: string;
  lastVerifiedAt: string;
}
```

### 7.5 `BiTemporal` (Zep)

```ts
export interface BiTemporal {
  validAt: string;
  invalidAt?: string;       // undefined = still valid
}
```

### 7.6 `DecayState` (MemoryBank)

```ts
export interface DecayState {
  lastAccessed: string;
  strength: number;         // 0..100; refreshes on retrieval
  rehearseCount: number;
}
```

### 7.7 `Memory<T>` (the core record)

```ts
export interface Memory<T = string> {
  id: string;               // ulid or uuidv7
  namespace: MemoryNamespace;
  kind: MemoryKind;
  subtype?: SemanticSubtype;

  content: T;
  embedding?: number[];     // lazy

  tags: string[];
  confidence: number;       // 0..100
  ttlDays: number;          // -1 = never expires
  expiresAt: string;

  bitemporal: BiTemporal;
  decay: DecayState;
  codeBinding?: CodeFactBinding;
  provenance: MemoryProvenance;

  links?: Array<{ targetId: string; relation: string; weight: number }>;
}
```

### 7.8 `Proposal` (sleeptime queue)

```ts
export type ProposalStatus = 'pending' | 'ratified' | 'rejected' | 'merged-into';

export interface Proposal {
  id: string;
  candidate: Memory;
  reason: string;
  status: ProposalStatus;
  ratifiedTo?: string;      // memory id if ratified or merged-into
  rejectedReason?: string;
  proposedAt: string;
  decidedAt?: string;
}
```

### 7.9 `PrEpisode` (Phase 12 episodic primitive)

```ts
export interface PrEpisode {
  prUrl: string;
  intent: string;
  plan: string;
  filesChanged: string[];
  commitShas: string[];
  testsAdded: string[];
  ciStatus: 'pass' | 'fail' | 'pending' | 'skipped';
  reviewOutcome?: 'approved' | 'changes-requested' | 'commented';
  mergeStatus?: 'merged' | 'closed' | 'open';
  durationMs: number;
  costUsd: number;
}
```

### 7.10 Identifier choice

**Choice:** `ulid` for `Memory.id` and `Proposal.id`.

**Why:** Sortable lexicographically by creation time, URL-safe, 26 chars (vs uuidv7's 36). The `ulid` package is MIT, ~50 LOC of dep weight. Adopted in Phase 1.

---

## 8. Per-phase commit log

Plan ships in 15 phases (0 through 14). Updated incrementally as phases land.

| Phase | Status | Commit | Deviations |
|---|---|---|---|
| 0 — Audit + decisions | ✅ shipped 2026-04-29 | 578d590 | none |
| 1 — Scaffold `@anvil/memory-core` | ✅ shipped 2026-04-29 | b708c84 | Skipped plan §1.3 step "add `@anvil/memory-core: '*'` to cli, knowledge-core, dashboard" — premature in Phase 1 since no consumer imports memory-core yet; workspace symlink materializes via `npm install` from `packages/*` discovery. Phase 2 wires consumer deps when imports actually start. Added `ulid@^2.3.0` per ADR §7.10. `better-sqlite3@^11.7.0` native binding compiled successfully on darwin/arm64. Phase 1 ships canonical types only (per ADR §7) — no functional surface yet, so the runtime barrel exports only `VERSION`. |
| 2 — Hoist `cli/memory/` into memory-core | ✅ shipped 2026-04-29 | f38bdcb | Hoisted only the 9 path-agnostic storage primitives (`types`, `jsonl`, `memory-store`, `entry-factory`, `expiration`, `size-prune`, `query-by-tags`, `query-by-content`, `top-k`) into `memory-core/src/legacy/`. Left in cli: `paths.ts` (project-aware via `getFFDirs()`), `usage-tracker.ts` (uses `getFFDirs().memory`), `injector.ts` (project-aware orchestration), and `learners/*` (depend on cli's `PipelineEvent`). Plan §2.1 envisioned learners moving too; deferred — they tie to cli's pipeline event bus + the proposal queue lands in Phase 10 anyway. **Subpath import deviation:** legacy primitives exposed via `@anvil/memory-core/legacy/index.js` rather than the top-level barrel because the legacy `MemoryKind` (semantic subtypes) and the v2 `MemoryKind` (five-type taxonomy) cannot share a name in the public API. cli's `memory/index.ts` re-exports from the subpath under canonical names so existing consumers keep working unchanged. **External importer fix:** `cli/src/conventions/promotion/violation-tracker.ts` was the only file outside cli/memory/ that imported the moved `jsonl.ts` directly — switched to `@anvil/memory-core/legacy/index.js`. cli + dashboard + code-search-mcp builds clean; agent-core 81/81, knowledge-core 62/62 baselines preserved; memory-core 8/8 new smoke tests covering store round-trip, query helpers, pruning, JSONL primitives. |
| 3 — Hybrid storage: JSONL + SQLite hot index | ✅ shipped 2026-04-29 | _this commit_ | Shipped v2 storage as a **parallel track** to legacy/ — no cli rewiring, no breakage of existing pipeline learnings. New `memory-core/src/storage/` subtree with: `schema.ts` (SCHEMA_SQL embedded as TS string instead of plan §3.2's separate `.sql` file — avoids build-time copy step), `sqlite-store.ts` (SqliteHotIndex over v2 `Memory<T>` shape with FTS5 BM25, namespace filtering, bi-temporal `validAtTime`, `pruneExpired`), `jsonl-store.ts` (JsonlAppendLog), `hybrid-store.ts` (HybridMemoryStore with auto-rebuild on open if SQLite is empty but JSONL has data). Schema includes forward-declared `memory_edge` (Phase 8) + `proposal` (Phase 10) tables to avoid a migration when those phases land. **Test count baseline:** Phase 1 acceptance gate "rebuild works correctly" is verified by deleting the sqlite file mid-test and re-opening — the auto-rebuild reconstructs identical search results. 13 new storage tests. memory-core 21/21 (8 legacy + 13 storage); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. Phase 4 ports `injectMemories` + auto-learners onto the v2 namespace API. |
| 4 — Five-type taxonomy + namespace API | ✅ shipped 2026-04-29 | 1b1b522 | Plan §4.4 acceptance items 1-4 met. Five-type taxonomy was already locked in Phase 1 via `MemoryKind` (working / episodic / semantic / procedural / profile); this phase added namespace plumbing on top. Shipped: `memory-core/src/namespace/path-resolver.ts` (LangMem-style tuple → path mapping per plan §4.2.4: global/, user/<id>/, project/<id>/, repo/<projectId>/<repoId>/) with `interpretLegacyDir` so existing `~/.anvil/memory/<project>/` directories load as `{scope: 'project', projectId: <dir>}` without a hard migration; `HybridMemoryStore.query(ns, opts)` + `queryAll(opts)` namespace-scoped read API; cli `injectMemories` + `createMemoryStore` accept either positional project name (legacy form) or `MemoryNamespace` tuple (v2 form) — second-position polymorphism keeps existing call sites unchanged; cli `anvil memory` command grew `--scope` / `--user-id` / `--repo-id` flags. **Deviations:** auto-learners (`cli/src/memory/learners/*`) still write to the legacy project-keyed `MemoryStore` — porting them to v2 requires structured `Memory<T>` writes (bitemporal, decay, provenance) and the proposal queue, which lands in Phase 10. Plan §4.5 risk "namespace leak" is mitigated by namespace being required at the API boundary (no defaults; v2 query/queryAll separation). 10 new namespace tests added (path resolver round-trip, scope coverage, query filtering, queryAll cross-namespace, text-search-in-namespace). memory-core 31/31 (8 legacy + 13 storage + 10 namespace); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 5 — Bi-temporal model | ✅ shipped 2026-04-29 | 1fc0f90 | Plan §5.5 acceptance items 1-4 met. Schema bumped to v2 with two new columns (`prov_invalidated_run_id`, `prov_invalidated_reason`); idempotent additive migration via `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` keeps pre-Phase-5 sqlite files openable. Shipped: `MemoryProvenance.invalidatedBy?: { runId?, reason }`; `SqliteHotIndex.invalidate(id, invalidAt, reason, runId?)` + `hardDeleteInvalidatedOlderThan(cutoff)`; `HybridMemoryStore.invalidate` mirrors the SQLite update *and* appends a tombstone JSONL record so audit-trail rebuilds preserve history; `pruneExpired` now soft-deletes (sets `invalid_at = now`, stamps `prov_invalidated_reason = 'ttl-expired'`) instead of `DELETE` — Phase 3's existing `pruneExpired` test was updated to assert the new soft-delete semantics; `NamespaceQueryOpts.includeInvalidated?: boolean` (default false) — `query()` and `queryAll()` filter rows with `invalid_at` set unless that flag is true or an explicit `validAt` (which already encodes the historical slice) is passed; `MEMORY_LINK_RELATIONS.SUPERSEDES` constant exported so Phase 10's auto-learners + sleeptime can stamp the relation without spelling drift. **Deviations:** §5.3 cli surface (`anvil memory invalidate`, `--as-of`) deferred to Phase 13 — cli today routes through legacy `MemoryStore` which has no `invalid_at`; wiring v2-only subcommands before the migration importer creates v2 data adds noise without value. §5.2.5 (auto-learners use `invalidate()` for contradictions) deferred alongside the auto-learner v2 cutover in Phase 10. 7 new bi-temporal tests; memory-core 38/38 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 6 — Code-fact drift detection | ✅ shipped 2026-04-29 | b3aa659 | Ships the drift API primitive — `checkCodeBindingDrift(binding, opts)` + `verifyCodeBindings(store, ns, opts)` — so every later phase that needs to scan for stale code-bindings can call into one place. New module under `memory-core/src/drift/`: `language.ts` (file-extension → tree-sitter label), `drift-detector.ts` (reads file, recomputes structural hash via `@anvil/knowledge-core`, returns `'fresh' | 'drifted' | 'missing'`), `verify.ts` (sweeps every memory in a namespace, applies `driftPolicy: 'downweight' | 'invalidate'` and `missingPolicy: 'downweight' | 'invalidate'` independently, supports `staleAfterDays` so sleeptime-style sweeps skip recently-verified rows, stamps `lastVerifiedAt` on every outcome). Downweight halves `decay.strength`; invalidate calls `HybridMemoryStore.invalidate` with reason `code-drift:<file>` or `code-missing:<file>` so audits can grep them. **Deviations:** §6.5 acceptance items 1-4 split — items met by this phase: API primitive + verifier + downweight/invalidate policy + `staleAfterDays` cadence knob; deferred: auto-learner population of `codeBinding` (Phase 10 alongside auto-learner v2 cutover), retrieval-time auto-check (Phase 9 hybrid retrieval), cli `verify-code-bindings` command (Phase 13 alongside migration importer + cli v2 surface). 9 new drift tests covering language detection, all three drift statuses, downweight scaling, invalidate reason tagging, and `staleAfterDays` skipping. memory-core 47/47 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal + 9 drift); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 7 — PII/secret scrubber | ✅ shipped 2026-04-29 | 80168a7 | New `memory-core/src/scrubber/` module: `regex-rules.ts` (Anthropic/OpenAI/GitHub/Slack/AWS/JWT/private-key — `'credential'` category — and email/SSN/phone/credit-card — `'pii'` category), `scrub.ts` (orchestrator returning `{cleaned, redactions, hardReject, mode}` + `HardRejectError`). Wired into `HybridMemoryStore.add()`: every payload is scrubbed before JSONL or SQLite write; credential matches throw `HardRejectError` so neither layer is touched; PII matches are redacted in place. `OpenHybridOptions.scrubber` lets per-store overrides preempt env. `ANVIL_MEMORY_SCRUB` resolution: `0/off/false` → `'off'` (passes input through, documented unsafe), `'llm'` → `'llm'` (mode tag only — classifier itself deferred to a later phase once `LanguageModel` is wired into memory-core), default → `'regex'`. Anthropic rule precedes OpenAI rule with a negative lookahead so `sk-ant-...` is tagged correctly (would otherwise be eaten by the broader `sk-...` rule). **Deviations:** §7.2.1 LLM classifier deferred — `'llm'` mode is a stable mode tag in the API but invokes only the regex pipeline today; the classifier itself lands when memory-core gains a LanguageModel registry. cli surfacing of redaction counts (verbose flag, `anvil memory inspect`) deferred to Phase 13/14 alongside the dashboard inspector. 15 new tests covering each pattern class, env resolution, integration with `add()` (redact-in-place, hard-reject, off-mode passthrough); memory-core 62/62 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal + 9 drift + 15 scrubber); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 8 — Hybrid retrieval (BM25 + vector + graph) | ✅ shipped 2026-04-29 | b23c74a | New `memory-core/src/retrieve/` module: `bm25.ts` (namespace-scoped wrapper over Phase 3's FTS5 BM25), `graph.ts` (`expandNeighbors` 1-hop traversal), `vector.ts` (Phase-8 stub returning `[]` — wired now so the fusion path doesn't churn when Phase 10 sleeptime turns on embeddings + LanceDB), `fusion.ts` (Reciprocal Rank Fusion with `k=60` default, per-stream weight knob, optional limit), `hybrid.ts` (`hybridSearch` orchestration that calls all three retrievers and fuses). Memory edge persistence wired in `SqliteHotIndex.upsert` — `replaceEdges` materializes `Memory.links` into the `memory_edge` table on every upsert; `findById` / `rowToMemory` round-trip links back via the new `linksOf` helper; `neighborsOf(seedIds, opts)` exposes 1-hop expansion with optional relation filter. **Deviations:** §8.6 acceptance items met for BM25, graph, and fusion paths; vector retrieval is a stub (no LanceDB integration yet — `embedding_id` column reserved in Phase 3, populated by Phase 10 sleeptime alongside the embedder). §8.3 embedding strategy + §8.4 cli `anvil memory search` both deferred. injectMemories rewire (plan §8.2.3) deferred to Phase 10 alongside auto-learner v2 cutover. RRF benchmark vs single-mode (§8.5) deferred until Phase 10 puts vector hits in play. 10 new retrieve tests covering BM25 ranking, graph round-trip + relation filter, vector stub return, RRF rank-fusion behavior, fused hybridSearch end-to-end with disable-graph escape hatch. memory-core 72/72 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal + 9 drift + 15 scrubber + 10 retrieve); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 9 — Personalized PageRank retrieval | ✅ shipped 2026-04-29 | 775778b | New `memory-core/src/retrieve/{ppr.ts,subgraph.ts,ppr-search.ts}`. `personalizedPageRank(adjacency, seeds, opts)` is ~140 LOC of pure-TS power iteration with damping/maxIterations/epsilon knobs (defaults α=0.85, max=100, ε=1e-6 — bumped from plan's 50 since geometric convergence at α=0.85 and ε=1e-6 needs ≈86 iterations on small chains). `extractNamespaceSubgraph(store, ns)` pulls the project-scoped subgraph keyed by source memory id. `pprSearch(store, ns, seeds, opts)` is the integration entry point — accepts either `Map<id, weight>` or bare `string[]` seeds, hides invalidated rows by default, returns memories ranked by PPR score plus iteration/convergence metadata. **Deviations:** §9.2.2 LLM "recognition filter" deferred — pprSearch already takes caller-provided seeds, so the integration is forward-compatible; the in-memory-core LLM adapter lands when sleeptime needs it (Phase 10). §9.4 multi-hop benchmark vs iterative-RAG deferred — requires a synthetic dataset + iterative-RAG harness, both out of scope for the API extraction phases. Dangling-mass redistribution is in (cycles back to personalization vector to keep score sum ≈ 1). 7 new PPR tests covering identity / multi-hop transitivity / weight-skewed diffusion / maxIterations cap / namespace subgraph isolation / invalidated filtering. memory-core 79/79 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal + 9 drift + 15 scrubber + 10 retrieve + 7 ppr); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 10 — Sleeptime + proposal queue | ✅ shipped 2026-04-29 | de5016a | New `memory-core/src/sleeptime/`: `proposal-queue.ts` (typed wrapper around the Phase 3 `proposal` table — `enqueue`, `listPending` with namespace filter, `updateStatus` with pending-only guard, `pendingCount`), `dedupe.ts` (`contentDigest` SHA-256 over normalized content+tags + `findNearestDuplicate` reusing Phase 8 BM25), `ratify.ts` (decision applier for ADD / MERGE-INTO / REJECT / SUPERSEDE — supersede composes Phase 5 invalidate + a `MEMORY_LINK_RELATIONS.SUPERSEDES` link on the new memory; `defaultDecide` policy is "MERGE-INTO if exact content-digest twin exists, else ADD"), `consolidate.ts` (orchestrator that walks pending proposals for a namespace, calls a caller-supplied `decideFn` (defaults to `defaultDecide`), and rolls up `{scanned, ratified, merged, rejected, superseded}` counts; async signature so future LLM-judge decideFns slot in without churn). **Deviations (most explicit so far — flagging the architectural debt for Phase 13/14 cleanup):** §10.2.2 hot-path auto-learner rewrite (`recordFixPattern`, `recordSuccess`, `recordApproach` switching from direct-write to enqueue) deferred — those learners live in `cli/src/memory/learners/` and still couple to cli's `PipelineEvent`; the v2 cutover is gated on cli's broader migration to namespace-aware HybridMemoryStore (Phase 13 migration importer). §10.2.4 cli `anvil memory consolidate` command deferred to Phase 13. §10.3 trigger wiring (PR/CI completion event → consolidate hook) deferred until cli pipeline owns the namespace handle. §10.4 cross-process file-lock at `.consolidate.lock` deferred — single-process safety holds via SQLite's WAL + `updateStatus` pending-only guard; multi-process concerns surface only when the cli command lands. §10.2.dedupe.3 LLM tie-breaker deferred until memory-core gains a LanguageModel registry (`findNearestDuplicate` exposes the BM25 candidate so callers can plug in their own judge today). 12 new sleeptime tests covering the queue API, dedupe, all four ratification kinds (including supersede invalidate+link composition with Phase 5/8), and consolidate end-to-end with default + custom decideFn. memory-core 91/91 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal + 9 drift + 15 scrubber + 10 retrieve + 7 ppr + 12 sleeptime); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 11 — Reflection on CI/PR completion | ✅ shipped 2026-04-29 | 64651b6 | New `memory-core/src/reflect/`: `prompts.ts` (`REFLECTION_SYSTEM_PROMPT` asks for four buckets — failures / successes / surprises / skill_proposals — and `buildReflectionUserPrompt(runContext)` formats the per-run user message), `extractor.ts` (`parseReflectionJson` tolerates leading/trailing prose, missing buckets, both snake_case and camelCase field names, and per-item field omissions; bad JSON returns empty buckets), `mapper.ts` (`reflectIntoProposals` shapes each bucket into a typed `Memory` candidate — failures→`semantic.fix-pattern`, successes→`semantic.success`, surprises→`semantic.manual`, skill_proposals→`procedural` — and enqueues via Phase 10 `ProposalQueue`; runId stamped on `provenance.sourceRunId`, `file:<path>` tag attached when the model named a file), `reflector.ts` (`reflectOnRun` orchestrator that takes a caller-supplied `llmInvoke(systemPrompt, userPrompt)` callback, parses the result, and returns enqueue counts + raw output for debugging). **Deviations:** §11.3 SKILL.md auto-write to `<workspace>/.claude/skills/...` deferred — sleeptime needs to know the workspace root, which lives in cli today; the procedural-kind proposal is enqueued, but the file write is gated on Phase 13 cli wiring. §11.4 cli `anvil memory list --created-by=reflection` deferred to Phase 13. §11.6 rate-limit (don't reflect twice on the same run) is the caller's responsibility — `reflectOnRun` is idempotent on the queue side via the proposal id, but the LLM call itself isn't deduped here. The `llmInvoke` injection point is the same shape we'll use when the agent-core `LanguageModel` registry is wired into memory-core. 8 new reflect tests covering parser robustness (well-formed, surrounding prose, malformed, partial items), per-bucket subtype routing, file-path tag attachment, end-to-end with stub invoker, and zero-output safety. memory-core 99/99 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal + 9 drift + 15 scrubber + 10 retrieve + 7 ppr + 12 sleeptime + 8 reflect); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 12 — PR-as-episode primitive | ✅ shipped 2026-04-29 | 810bdfe | New `memory-core/src/episode/pr-episode.ts`: `buildPrEpisodeMemory(episode, opts)` returns a typed `Memory<PrEpisode>` with `kind='episodic'`, structured tags (`pr-episode`, `ci:<status>`, `merge:<status>`, `review:<outcome>`), 365-day default TTL (PR history is long-lived), high default confidence (80) + strength (90) since the data is structured and verifiable. `recordPrEpisode(store, episode, opts)` writes directly to durable — auto-ratified per plan §12.2.2 (PR episodes are inherently low-noise). `retrievePrEpisodes(store, query, opts)` reuses Phase 8 BM25 over the JSON-stringified content (so intent / plan / file paths all participate in matching), filters to `episodic` kind + PrEpisode shape via the structural-typing helper `isPrEpisode`, and defaults `successOnly=true` so callers see merged + ci-pass episodes only (the success-pattern use case). **Deviations:** §12.2.2 cli pipeline-event hook deferred — `recordPrEpisode` is the API; the cli's PR-reviewer pipeline gets wired in Phase 13 alongside the migration importer. §12.3 cli `anvil memory list --kind=episodic --subtype=pr-episode` deferred to Phase 13. §12.6 per-project opt-out via factory.yaml deferred — the Phase 7 scrubber already runs over PR diffs (sk-/email/etc redacted), so per-project opt-out is the only remaining knob and lives in cli config space. Two minor TS-cast bridges (`Memory<PrEpisode>` ↔ default `Memory<string>` storage layer) — boxed via `unknown` casts and called out inline. 5 new pr-episode tests covering builder shape, ttl=-1 escape hatch, persist+retrieve round-trip, successOnly filter, limit cap. memory-core 104/104 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal + 9 drift + 15 scrubber + 10 retrieve + 7 ppr + 12 sleeptime + 8 reflect + 5 pr-episode); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 13 — Dashboard memory inspector (API primitive) | ✅ shipped 2026-04-29 | 691b313 | New `memory-core/src/inspector/inspector.ts`: `MemoryInspector` class wraps `HybridMemoryStore` + `ProposalQueue` with the surface the dashboard memory tab + cli `anvil memory inspect` will consume. API: `list({namespace?, kind?, subtype?, search?, limit?, includeInvalidated?})` (BM25 when `search` is set, otherwise namespace scan with kind/subtype filter), `detail(id)`, `listProposals(status, namespace?, limit?)`, `ratifyProposal(id)` (admin write — caller is responsible for auth), `rejectProposal(id, reason)`, `driftSweep(opts, namespace)` (delegates to Phase 6 `verifyCodeBindings`), `stats(namespace?)` (aggregates total / byKind / bySubtype / topTags / invalidated / withCodeBinding). **Plan-vs-shipped mapping:** plan §13 bundled the API + UI together; this row ships the API primitive in memory-core (kept framework-agnostic so the same surface drives the dashboard server and a future cli inspect command). Plan §13.2.1 dashboard-server REST routes deferred — dashboard-server.ts is 6605 lines of single-file Express handlers; surgical insertion of `/api/memory*` routes is a follow-up that an HTTP-shape adapter file can do without re-reading the whole bootstrap. Plan §13.2.2 React components (`MemoryInspector.tsx`, `MemoryDetail.tsx`, `ProposalQueue.tsx`) deferred. Plan-row title clarified: §13 is the dashboard inspector; the migration importer (originally §13 in the plan when this row was a placeholder) lives in §14. 8 new inspector tests covering list namespace+kind+subtype+search filters, detail round-trip, ratify/reject queue admin flow, stats aggregation including invalidated + codeBinding counts. memory-core 112/112 (8 legacy + 13 storage + 10 namespace + 7 bi-temporal + 9 drift + 15 scrubber + 10 retrieve + 7 ppr + 12 sleeptime + 8 reflect + 5 pr-episode + 8 inspector); agent-core 81/81, knowledge-core 62/62, cli/mcp/dashboard builds clean. |
| 14 — Dashboard inspector + tests + docs | pending | — | — |
