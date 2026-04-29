# Plan: Extract `@anvil/memory-core` shared workspace package — long-term memory + every-run-is-better intelligence

> **Status: Proposed.** Self-contained executable plan — does not require prior conversation context. **Depends on [`AGENT-CORE-EXTRACT-PLAN.md`](./AGENT-CORE-EXTRACT-PLAN.md), [`AGENT-OBSERVABILITY-PLAN.md`](./AGENT-OBSERVABILITY-PLAN.md), and [`AGENT-HARNESS-PLAN.md`](./AGENT-HARNESS-PLAN.md) shipping first** — this plan integrates with each of them. Companion to [`KNOWLEDGE-CORE-EXTRACT-PLAN.md`](./KNOWLEDGE-CORE-EXTRACT-PLAN.md) (already shipped); reuses its embedder, vector store, and structural hasher.

---

## Goals (what "done" means)

1. **`@anvil/memory-core` workspace package** owns every "remember-across-runs" surface in the monorepo. The existing `packages/cli/src/memory/` (already production-shape with auto-learners, pollution detection, TTL pruning) lives here; new capabilities described below land alongside it.
2. **Five-type memory taxonomy** explicit in the API: `working` (in-context only), `episodic` (run events, PR records), `semantic` (facts about codebase + user), `procedural` (how-to rules — proposes Skills via Plan C), `profile` (user preferences). Each type has its own storage shape and retrieval mode.
3. **Hybrid storage** — append-only JSONL stays as auditable source-of-truth + git-mergeable archive; an SQLite hot index (`better-sqlite3` with FTS5) provides BM25 + indexed queries; LanceDB (already in tree via `@anvil/knowledge-core`) provides vector recall; SQLite-backed graph adjacency supports Personalized PageRank multi-hop retrieval. **Zero new heavy infrastructure** (no Neo4j, no Postgres, no Python sidecar).
4. **Sleeptime / proposal-queue separation** — auto-learners on the hot path *propose* memories; a background ratification pass (triggered by CI/PR completion or N runs or idle) is the *only* path to durable storage. This is the architectural defense against mem0's documented 97.8%-junk failure mode.
5. **Bi-temporal facts** — contradictions resolved via `valid_at`/`invalid_at` instead of overwrite. Old facts stay queryable for "what did I know as of T?".
6. **Code-fact drift detection** — every memory referencing code carries `(file_path, structural_hash, last_seen_commit_sha)`; on retrieval, drifted memories auto-downweight or invalidate. Reuses `@anvil/knowledge-core/structural-hasher.ts`.
7. **PII/secret scrubber on writes** — regex + optional LLM classifier prevents secrets from entering durable storage. Default ON.
8. **Personalized PageRank multi-hop retrieval** — single-step graph reasoning over a per-project memory subgraph, replacing iterative-RAG patterns. ~80 LOC of TS.
9. **Reflection-on-completion** — every CI/PR completion triggers an extraction LLM call: "what worked, what failed, what surprised you?" Output enters the proposal queue.
10. **PR-as-episode primitive** — every PR shipped via Anvil produces a structured episodic memory `{pr_url, intent, plan, files, commits, tests, ci, review, merge_status}` retrievable on next-similar-task.
11. **Migration importer** — one-shot `anvil memory migrate` reads existing `~/.anvil/memory/{project}/memories.jsonl` files and ingests them into the new model with provenance preserved. Zero data loss.
12. **Existing public API preserved** — `MemoryStore`, `recordFixPattern`, `recordSuccess`, `recordApproach`, `injectMemories`, `pruneExpired`, etc. remain reachable. Internally rewired to delegate to the new package.

---

## Cost-benefit context

### Why now (and not before A/B/C)

Memory composes with the agent stack. Specifically:

- It persists `LanguageModel` invocation traces (Plan A's seam).
- It hooks into the OTel telemetry layer (Plan B's spans become memory candidates).
- Its procedural-memory output produces SKILL.md files (Plan C's skill loader consumes them).
- Its `runAgent` integration carries memory into headless eval runs (Plan C's headless entry).

Building memory before agent-core would mean re-plumbing it after each later plan. After A/B/C, the integration points are stable.

### Current footprint (measured at plan-authoring time)

| Tree | Files | Approx LOC |
|---|---|---|
| `packages/cli/src/memory/` | ~15 (`index`, `types`, `paths`, `jsonl`, `memory-store`, `entry-factory`, `expiration`, `size-prune`, `query-by-tags`, `query-by-content`, `top-k`, `injector`, `usage-tracker`, `learners/*`) | ~1,500 |
| `packages/cli/src/conventions/` | ~6 (`engine`, `loader`, `merger`, `rule-generator`, `extractor`, …) | ~800 |
| `packages/cli/src/run/` (RunStore + audit-log) | ~7 | ~700 |
| Memory-shaped persistence in `~/.anvil/` | runtime data | per-user |

Total candidate footprint: ~28 files / ~3,000 LOC of move-or-rewire, plus ~2,500 LOC of new code (storage, sleeptime, PPR, scrubber, reflection, PR primitive).

### What "every run is better" requires (research-validated)

Five concrete mechanisms:

| Mechanism | Mapping to Anvil today | Phase that delivers |
|---|---|---|
| **Lessons-learned extraction** | partly via `recordApproach` on escalation | Phase 11 (reflection-on-CI) |
| **Failure-mode catalog** | partly via `recordFixPattern` | Phase 5 (bi-temporal) + Phase 11 |
| **Success-pattern catalog** | partly via `recordSuccess` | Phase 11 + Phase 12 |
| **Code-knowledge accumulation** | via `@anvil/knowledge-core` graph (separate today) | Phase 8 (graph linking) + Phase 9 (PPR) |
| **User-preference inference** | minimal; convention rules are user-edited only | Phase 4 (profile namespace) |
| **Procedural prompt patches** | conventions are user-edited | Phase 11 (sleeptime proposes Skills via Plan C) |

### Lock-in budget

- **`better-sqlite3`** (MIT) — sync, single-file, ubiquitous. Native bindings, but every Node has them. Replaceable cost: rewrite the storage adapter (~200 LOC). Acceptable.
- **LanceDB** (Apache-2.0) — already in tree via `@anvil/knowledge-core`. No new commitment.
- **No graph DB** — adjacency tables in SQLite. PPR in TS over JS arrays. ~80 LOC.
- **No mem0, no Letta, no Zep, no LangMem, no Cognee SDKs in dependency tree.** Patterns stolen, code hand-rolled.

### Net hand-edited LOC

- ~3,000 LOC of moves (existing memory subsystem hoisted into shared)
- ~2,500 LOC of new code (sleeptime, PPR, scrubber, bi-temporal, reflection, PR-as-episode, dashboard inspector, migration importer)
- ~200 LOC of edits in callers (import path swaps + new opt-in hooks)

---

## Current state assumed (snapshot at plan-execution time)

This plan assumes:

- `@anvil/agent-core` exists per `AGENT-CORE-EXTRACT-PLAN.md`. The `LanguageModel` interface and `runAgent` entry are available.
- `@anvil/agent-observability` (or rather: agent-core's telemetry module from Plan B) is shipped — OTel spans available.
- `@anvil/agent-core` has skill harness shipped (Plan C) — SKILL.md loader and MCP client available.
- `@anvil/knowledge-core` is shipped — `structural-hasher.ts`, `vector-store.ts`, `embedder.ts`, `retriever.ts`, `graph-query.ts` available.
- `packages/cli/src/memory/` is the current memory implementation (file-based JSONL, ~15 files). Public API matches §H of `AGENT-HARNESS-PLAN.md`'s research output (or whatever the actual current state is — re-grep on Phase 0).
- Existing Anvil deployments have data at `~/.anvil/memory/{project}/memories.jsonl`, `~/.anvil/runs/`, `~/.anvil/conventions/`. **This data must be preserved.**

### Pre-flight reality check

```sh
test -d packages/agent-core || { echo "FAIL: agent-core not extracted; ship plan A first"; exit 1; }
test -f packages/agent-core/src/skills/loader.ts || { echo "FAIL: skill loader missing; ship plan C first"; exit 1; }
test -f packages/agent-core/src/telemetry/tracer.ts || { echo "FAIL: telemetry missing; ship plan B first"; exit 1; }
test -f packages/knowledge-core/src/structural-hasher.ts || { echo "FAIL: knowledge-core missing"; exit 1; }
test -d packages/cli/src/memory || { echo "FAIL: existing memory module missing; reconcile"; exit 1; }
test ! -d packages/memory-core || { echo "FAIL: memory-core already exists"; exit 1; }

# Confirm tests baseline green
npm -w @anvil/knowledge-core test
npm -w @anvil/agent-core test
npm -w @esankhan3/anvil-cli run build
```

If any check fails, stop and reconcile.

---

## Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| M1 | Storage substrate | **Hybrid: JSONL append-only archive + SQLite hot index (`better-sqlite3` with FTS5) + LanceDB vector + SQLite graph adjacency** | JSONL = auditable, git-mergeable source of truth. SQLite = fast queries, BM25, indexed reads. LanceDB = already in tree. No Postgres / Neo4j / Python. |
| M2 | Graph backend | **SQLite adjacency tables; PPR computed in TS over JS arrays** | ~80 LOC; no new heavy infra; per-project subgraph stays small enough for in-memory PPR. |
| M3 | Sleeptime cadence | **Configurable via env var; defaults to "on PR/CI completion" + "every 25 pipeline runs" + "on idle 30 min" — whichever fires first** | CI completion is the natural ratification trigger for a coding agent. The fallbacks ensure consolidation runs even without CI. |
| M4 | Memory taxonomy | **Five types: `working`, `episodic`, `semantic`, `procedural`, `profile`** | LangMem's split, validated by CoALA. `procedural` overlaps with Plan C's skills — sleeptime proposes new SKILL.md files rather than raw prompt patches. |
| M5 | Migration of existing data | **One-shot importer (`anvil memory migrate`) preserves provenance** | Existing Anvil users' `memories.jsonl` files must not be lost. Importer reads them into the new model with `source_run_id` set to "pre-migration" and original `confidence`/`tags` preserved. |
| M6 | PII/secret scrubbing | **On by default; regex + optional LLM classifier with hard-reject on classified secrets** | Security default. Disable via `ANVIL_MEMORY_SCRUB=0` if the user actually wants raw memory (unusual). |
| M7 | Code-fact drift detection | **Every memory mentioning code carries `(file_path, structural_hash, last_seen_commit_sha)`; auto-invalidate on drift** | Reuses `@anvil/knowledge-core/structural-hasher.ts`. The single largest improvement over current Anvil memory. |
| M8 | Bi-temporal model | **`valid_at` + `invalid_at` on every memory; never delete; mark invalid** | Zep pattern. Lets you query "what did the system know as of T?" Crucial for debugging memory pollution. |
| M9 | Sleeptime ratification | **Background pass with its own LLM call (separate from agent runs)** | Letta pattern. Hot-path proposes; consolidator decides. The architectural defense against mem0's pollution problem. |
| M10 | Skills overlap | **Procedural memory proposes new SKILL.md files; does NOT duplicate the skill loader** | Plan C owns the skills surface. Memory plan extends it by being a writer. |
| M11 | Auto-learner gating | **Auto-learners (`recordFixPattern`, etc.) write to the proposal queue, not directly to durable store** | Same defense as M9. Existing call sites unchanged; the implementation routes through proposals now. |
| M12 | Convention-rule integration | **`packages/cli/src/conventions/` does NOT move to memory-core in v1; it stays in cli but gains a "publish to procedural memory" outlet** | Conventions are cli-specific (factory.yaml, rule-generator). Procedural-memory bridge is small and reversible. |
| M13 | Run records & audit logs | **Stay in cli's `RunStore`/`AuditLog` for v1; memory-core READS them for episodic memory but doesn't move them** | RunStore is heavily integrated with cli's pipeline. Moving = bigger blast radius than this plan should swallow. |
| M14 | Multi-tenancy | **LangMem namespace tuples: `(scope: 'global'|'user'|'project'|'repo', projectId?, repoId?, kind, ...)`** | Cleanest model. Single-key lookups are fast; range queries on prefixes are SQLite-natural. |
| M15 | Forgetting policy | **Two-stage: (a) hard TTL (existing 30-day default kept) + (b) decay-and-rehearse (MemoryBank): each retrieval refreshes `last_accessed`; entries below `strength_threshold` are pruned by sleeptime** | Long-lived patterns survive even past TTL if they're being used. New addition; doesn't break existing TTL semantics. |

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 Audit deliverables

Produce `MEMORY-CORE-ADR.md` at repo root (sibling to this plan). Contents:

1. The decisions table above, formalized.
2. **Inventory** of every persistence site under `~/.anvil/`:
   - For each: path, format, kind, owner module, lifetime, retrieval pattern.
   - Cross-reference §"Memory-shaped vs not" — distinguish caches (lancedb, AST graphs), episodic (run records, audit), semantic (memories.jsonl), procedural (conventions).
3. **Public API surface** of `packages/cli/src/memory/index.ts` and `packages/cli/src/conventions/`. Every exported symbol; whether it's "preserved as-is" / "moves to memory-core" / "stays in cli with shim" / "deprecated".
4. **External importers** — every file in cli/dashboard/mcp that imports from cli/memory or cli/conventions. List with file paths.
5. **Existing memory size** — sample real-user `~/.anvil/memory/<project>/memories.jsonl` sizes. Document expected migration data volumes.
6. **Decisions on schema for new types** — finalize:
   - `Memory<T>` generic shape
   - `MemoryProvenance` shape
   - `MemoryNamespace` tuple
   - `BiTemporalEdge` for graph
   - `Proposal` shape (sleeptime queue)
   - `PrEpisode` shape (Phase 12)

### 0.2 Acceptance

- [ ] ADR written
- [ ] Pre-flight reality check passes
- [ ] Schema decisions documented

### 0.3 Rollback

N/A — doc-only.

---

## Phase 1 — Scaffold `@anvil/memory-core` package

**Effort:** 0.5d.

### 1.1 Package skeleton

```
packages/memory-core/
├── package.json          (~50 LOC)
├── tsconfig.json         (~20 LOC)
├── src/
│   ├── index.ts          public barrel
│   ├── types.ts          Memory<T>, Namespace, Provenance, BiTemporalEdge
│   ├── version.ts
│   └── __tests__/        empty for now
└── README.md             (~80 LOC)
```

`package.json`:

```json
{
  "name": "@anvil/memory-core",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./*.js": { "types": "./dist/*.d.ts", "default": "./dist/*.js" }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "dev": "tsc -b --watch",
    "test": "tsc -b && node --test dist/__tests__/*.test.js"
  },
  "dependencies": {
    "better-sqlite3": "^11.7.0",
    "@anvil/knowledge-core": "*",
    "@anvil/agent-core": "*"
  },
  "devDependencies": {
    "@types/better-sqlite3": "^7.6.0",
    "@types/node": "^22.15.2"
  }
}
```

### 1.2 `src/types.ts`

Foundation types:

```ts
// Five-type taxonomy
export type MemoryKind =
  | 'working'                      // in-context only; never persisted
  | 'episodic'                     // run events, PR records
  | 'semantic'                     // facts (existing 'fix-pattern', 'success', 'approach', 'flaky-test', 'performance' subtypes live here)
  | 'procedural'                   // how-to rules; proposes SKILL.md files
  | 'profile';                     // user preferences

// Subtypes for finer-grained classification (preserves existing semantic kinds)
export type SemanticSubtype =
  | 'fix-pattern' | 'success' | 'approach'
  | 'flaky-test' | 'performance' | 'manual';

// LangMem-style namespace tuple
export interface MemoryNamespace {
  scope: 'global' | 'user' | 'project' | 'repo';
  projectId?: string;
  repoId?: string;
  userId?: string;
}

export interface MemoryProvenance {
  sourceRunId?: string;
  sourceMessageId?: string;
  sourceFile?: string;
  sourceCommit?: string;
  createdBy: 'auto-learner' | 'user' | 'reflection' | 'sleeptime' | 'pr-episode' | 'migration';
  createdAt: string;               // ISO-8601
  proposedAt?: string;             // when the proposal was queued
  ratifiedAt?: string;             // when sleeptime promoted to durable
}

export interface CodeFactBinding {
  filePath: string;
  structuralHash: string;          // from knowledge-core's structural-hasher
  lastSeenCommitSha: string;
  lastVerifiedAt: string;
}

// Bi-temporal markers (Zep)
export interface BiTemporal {
  validAt: string;                 // when this fact became true (real-world time)
  invalidAt?: string;              // when this fact became false (or undefined = still valid)
}

// Decay-and-rehearse (MemoryBank)
export interface DecayState {
  lastAccessed: string;
  strength: number;                // 0..100; decays with time, refreshes on retrieval
  rehearseCount: number;
}

export interface Memory<T = string> {
  id: string;                      // ulid or uuidv7
  namespace: MemoryNamespace;
  kind: MemoryKind;
  subtype?: SemanticSubtype;       // semantic only

  content: T;                      // primary payload (string, structured, etc.)
  embedding?: number[];            // vector (lazy populated)

  tags: string[];
  confidence: number;              // 0..100; existing semantic
  ttlDays: number;                 // -1 = never expires
  expiresAt: string;

  bitemporal: BiTemporal;
  decay: DecayState;
  codeBinding?: CodeFactBinding;
  provenance: MemoryProvenance;

  // Graph-related (populated in Phase 8)
  links?: Array<{ targetId: string; relation: string; weight: number }>;
}

// Proposal queue entry (Phase 10)
export type ProposalStatus = 'pending' | 'ratified' | 'rejected' | 'merged-into';
export interface Proposal {
  id: string;
  candidate: Memory;               // the proposed memory
  reason: string;                  // why the auto-learner thought this was worth saving
  status: ProposalStatus;
  ratifiedTo?: string;             // memory id if ratified or merged-into
  rejectedReason?: string;
  proposedAt: string;
  decidedAt?: string;
}

// PR-as-episode (Phase 12)
export interface PrEpisode {
  prUrl: string;
  intent: string;                  // what the agent was asked to do
  plan: string;                    // the plan it produced
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

### 1.3 Wire workspace

- Root `tsconfig.json` references[] — add `{ "path": "packages/memory-core" }`
- Add `@anvil/memory-core: "*"` to: cli, knowledge-core, dashboard

### 1.4 Validation

```sh
npm install
npm -w @anvil/memory-core run build
test -L node_modules/@anvil/memory-core
# All consumers still build (memory-core not yet imported)
npm -w @anvil/agent-core run build
npm -w @anvil/knowledge-core test
npm -w @esankhan3/anvil-cli run build
cd packages/dashboard && npx tsc -p server/tsconfig.json
```

### 1.5 Acceptance

- [ ] `packages/memory-core/` exists with skeleton
- [ ] `npm install` materializes the workspace symlink
- [ ] `npm -w @anvil/memory-core run build` succeeds
- [ ] `better-sqlite3` resolves (native binding compiled at install time)
- [ ] All consumer builds + tests still green

### 1.6 Rollback

Single-commit revert.

### 1.7 Risks

- **`better-sqlite3` native compilation failure** on Apple Silicon / Windows / Alpine. Mitigation: install via prebuilds (default behavior); document fallback to `npm rebuild better-sqlite3` on platforms without prebuilds. If a user can't install, document `npm install --omit=optional` skipping memory-core.

---

## Phase 2 — Hoist `cli/src/memory/` into `@anvil/memory-core`

**Effort:** 1d.

### 2.1 Scope

Move the existing 15-file memory subsystem from cli into the shared package. **No semantic change** in this phase — pure relocation + import-path rewrite. Existing public API preserved verbatim.

Files (verify list against Phase 0 audit; this is the snapshot at plan-authoring time):

```
cli/src/memory/
├── index.ts
├── types.ts
├── paths.ts                      ← splits: paths-related stays in cli (project-aware); pure types/store moves
├── jsonl.ts                      ← moves
├── memory-store.ts               ← moves (becomes path-injectable)
├── entry-factory.ts              ← moves
├── expiration.ts                 ← moves
├── size-prune.ts                 ← moves
├── query-by-tags.ts              ← moves
├── query-by-content.ts           ← moves
├── top-k.ts                      ← moves
├── injector.ts                   ← moves
├── usage-tracker.ts              ← moves (path-injectable)
├── learners/
│   ├── index.ts                  ← moves
│   ├── fix-pattern.ts            ← moves
│   ├── success.ts                ← moves
│   ├── approach.ts               ← moves
│   └── pollution-detector.ts     ← moves
└── memory-store-cli.ts           ← stays in cli (CLI-specific list/export commands)
```

### 2.2 Path injection seam

The current `MemoryStore` resolves `~/.anvil/memory/{project}/memories.jsonl` internally via `paths.ts`. After the move, `MemoryStore` must accept the path as a constructor arg or factory parameter. cli supplies it via `resolveMemoryPath(project)`; tests supply it via fixture dirs.

```ts
// in memory-core
export interface MemoryStoreOptions {
  filePath: string;                // absolute path to memories.jsonl
  ttlDays?: number;
  maxBytes?: number;
}

// in cli
import { MemoryStore } from '@anvil/memory-core';
import { resolveMemoryPath } from './paths.js';

const store = new MemoryStore({ filePath: resolveMemoryPath(project) });
```

### 2.3 Procedure

1. `git mv` files (use `git mv` so history follows; one commit per logical group).
2. Update `MemoryStore` constructor — accept `filePath` instead of resolving internally.
3. Move `paths.ts` content into cli (it's project-aware) — but the unused `resolveMemoryPath()` shape may need to come back to memory-core later if dashboard needs it.
4. Update `cli/src/memory/index.ts` — becomes a thin re-export shim:
   ```ts
   /** @deprecated — use @anvil/memory-core directly */
   export * from '@anvil/memory-core';
   export { resolveMemoryPath } from './paths.js';
   export { createMemoryStore } from './factory.js';      // cli-specific factory
   ```
5. Update every importer of `cli/src/memory/*` outside the memory dir itself — switch to `from '@anvil/memory-core'`. Audit identifies these in Phase 0.
6. Update `cli/src/learn/*` if it exists and depends on memory.
7. Run validation; expect zero behavior changes.

### 2.4 Validation

```sh
npm -w @anvil/memory-core run build
npm -w @esankhan3/anvil-cli run build
npm -w @esankhan3/anvil-cli test       # all existing memory tests still pass
# integration: run a real pipeline; auto-learners still fire
ANVIL_LLM_MODE=none anvil run --project <fixture> --stage clarify
```

### 2.5 Acceptance

- [ ] All 15 files moved
- [ ] Public API of `@anvil/memory-core` matches old `cli/memory` API exactly
- [ ] Existing memory tests pass
- [ ] No behavior regression on auto-learners or pollution detection

### 2.6 Rollback

Per-file revert. Larger blast radius than knowledge-core hoists due to learner cross-imports — split into commits per logical group (jsonl + io / memory-store + factory / queries / learners) so partial revert works.

### 2.7 Risks

- **Hidden cross-imports:** `learners/*.ts` import from `memory-store.ts` and `entry-factory.ts`; verify all relative imports survive the move (they should — same dir).
- **`paths.ts` split:** project-aware path resolution stays in cli; if anything in the moved code reads `~/.anvil/memory/...` directly (not through `MemoryStore`), it breaks. Grep first; use `MemoryStore.filePath` everywhere.

---

## Phase 3 — Hybrid storage: JSONL archive + SQLite hot index

**Effort:** 1.5d.

### 3.1 Why hybrid

| Aspect | JSONL | SQLite | Hybrid |
|---|---|---|---|
| Append-only | ✓ | × | ✓ (writes to JSONL first) |
| Auditable / git-friendly | ✓ | × | ✓ (JSONL is canonical) |
| Indexed query | × | ✓ | ✓ (SQLite is the index) |
| BM25 full-text | × | ✓ (FTS5) | ✓ |
| Survives corruption | ✓ | × | ✓ (rebuild SQLite from JSONL) |
| Scales past 10k entries | × | ✓ | ✓ |

JSONL stays as the source of truth; SQLite is rebuildable hot-index.

### 3.2 SQLite schema

`packages/memory-core/src/storage/schema.sql`:

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  namespace_scope TEXT NOT NULL,   -- 'global'|'user'|'project'|'repo'
  namespace_project TEXT,
  namespace_repo TEXT,
  namespace_user TEXT,
  kind TEXT NOT NULL,              -- 'working'|'episodic'|'semantic'|'procedural'|'profile'
  subtype TEXT,                    -- 'fix-pattern'|...
  content_json TEXT NOT NULL,      -- JSON payload
  tags TEXT NOT NULL,              -- JSON array
  confidence INTEGER NOT NULL,
  ttl_days INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  last_accessed TEXT NOT NULL,
  strength INTEGER NOT NULL,
  rehearse_count INTEGER NOT NULL DEFAULT 0,
  code_file TEXT,
  code_structural_hash TEXT,
  code_last_seen_sha TEXT,
  prov_run_id TEXT,
  prov_message_id TEXT,
  prov_file TEXT,
  prov_commit TEXT,
  prov_created_by TEXT NOT NULL,
  prov_created_at TEXT NOT NULL,
  prov_proposed_at TEXT,
  prov_ratified_at TEXT,
  embedding_id TEXT                -- key into LanceDB
);

CREATE INDEX IF NOT EXISTS idx_memory_namespace
  ON memory(namespace_scope, namespace_project, namespace_repo, namespace_user);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory(expires_at);
CREATE INDEX IF NOT EXISTS idx_memory_valid ON memory(valid_at, invalid_at);
CREATE INDEX IF NOT EXISTS idx_memory_code_file ON memory(code_file);
CREATE INDEX IF NOT EXISTS idx_memory_strength ON memory(strength);

-- BM25 full-text search via FTS5
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED,
  content_text,                    -- denormalized text for full-text
  tokenize = 'unicode61 remove_diacritics 2'
);

-- Tag table for many-to-many tag queries
CREATE TABLE IF NOT EXISTS memory_tag (
  memory_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tag ON memory_tag(tag);

-- Graph edges (Phase 8, schema declared early)
CREATE TABLE IF NOT EXISTS memory_edge (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  PRIMARY KEY (source_id, target_id, relation, valid_at)
);
CREATE INDEX IF NOT EXISTS idx_edge_source ON memory_edge(source_id);
CREATE INDEX IF NOT EXISTS idx_edge_target ON memory_edge(target_id);

-- Proposal queue (Phase 10, schema declared early)
CREATE TABLE IF NOT EXISTS proposal (
  id TEXT PRIMARY KEY,
  candidate_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  ratified_to TEXT,
  rejected_reason TEXT,
  proposed_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposal_status ON proposal(status, proposed_at);

-- Schema version for migrations
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

### 3.3 Storage adapter

`packages/memory-core/src/storage/sqlite-store.ts`:

```ts
import Database from 'better-sqlite3';
import type { Memory, MemoryNamespace } from '../types.js';

export class SqliteHotIndex {
  private db: Database.Database;
  constructor(filePath: string) {
    this.db = new Database(filePath);
    this.db.pragma('journal_mode = WAL');
    this.applySchema();
  }

  private applySchema(): void { /* read schema.sql, exec */ }

  upsert(m: Memory): void {
    const stmt = this.db.prepare(`INSERT INTO memory (...) VALUES (?, ?, ...) ON CONFLICT(id) DO UPDATE SET ...`);
    stmt.run(/* ... */);
    // also insert into FTS + tag tables
  }

  findById(id: string): Memory | null { /* ... */ return null; }

  searchByTags(tags: string[], ns: MemoryNamespace, opts?: { limit?: number }): Memory[] { /* ... */ return []; }

  searchByText(query: string, ns: MemoryNamespace, opts?: { limit?: number }): Memory[] { /* FTS5 BM25 */ return []; }

  validAtTime(at: string, ns: MemoryNamespace): Memory[] { /* bi-temporal query */ return []; }

  pruneExpired(now: string): number { /* delete WHERE expires_at < now AND ttl_days >= 0 */ return 0; }

  close(): void { this.db.close(); }
}
```

### 3.4 Hybrid orchestration

`packages/memory-core/src/storage/hybrid-store.ts`:

```ts
import { JsonlAppendLog } from './jsonl-store.js';
import { SqliteHotIndex } from './sqlite-store.js';
import type { Memory } from '../types.js';

export class HybridMemoryStore {
  constructor(
    private jsonl: JsonlAppendLog,
    private sqlite: SqliteHotIndex,
  ) {}

  add(m: Memory): void {
    this.jsonl.append(m);          // canonical write
    this.sqlite.upsert(m);         // hot index
  }

  rebuildIndexFromJsonl(): { count: number; durationMs: number } {
    // read every JSONL line, upsert into sqlite
    // used by `anvil memory rebuild-index`
  }

  // delegated reads to sqlite for performance
  searchByTags(tags, ns, opts) { return this.sqlite.searchByTags(tags, ns, opts); }
  searchByText(query, ns, opts) { return this.sqlite.searchByText(query, ns, opts); }
}
```

### 3.5 CLI command for index rebuild

cli's `commands/memory.ts` (new or extended):

```sh
anvil memory rebuild-index [--project=<id>]   # rebuild sqlite from jsonl
anvil memory verify [--project=<id>]          # check sqlite matches jsonl
```

### 3.6 Migration path

When `HybridMemoryStore` first opens an existing JSONL file with no SQLite present:
1. Detect missing sqlite (create new file).
2. Auto-rebuild on first read (warn user via stderr: "rebuilding memory index from JSONL — this may take a moment").
3. Future opens are fast.

### 3.7 Validation

```sh
# Existing data preserved
ls ~/.anvil/memory/<project>/  # memories.jsonl unchanged
# After running anything that opens memory:
ls ~/.anvil/memory/<project>/  # memories.jsonl + memories.sqlite
# Tests
npm -w @anvil/memory-core test
# Smoke: write 100 memories, query by tag, by text
```

### 3.8 Acceptance

- [ ] SQLite hot index exists alongside JSONL
- [ ] All existing tests pass (read paths now use SQLite)
- [ ] Tag query and text query measurably faster (benchmark before/after for 1k entries)
- [ ] Rebuild works correctly — drop sqlite, read, rebuilds from jsonl, results identical

### 3.9 Rollback

Per-commit revert. Hybrid store can be reverted to JSONL-only by removing the SQLite read path; JSONL data is unchanged so no data loss.

### 3.10 Risks

- **Sync drift:** sqlite and jsonl can diverge if a write succeeds in one but not the other. Mitigation: write to JSONL first; if SQLite write fails, log + queue a re-index. Periodic verification command (`anvil memory verify`) catches drift.
- **WAL files in `~/.anvil/`:** SQLite WAL mode produces `.wal` and `.shm` files. Document this in user-facing memory-handling docs.
- **better-sqlite3 + ESM:** the package historically had ESM hiccups. Verify in Phase 1 install. Default-export pattern.

---

## Phase 4 — Typed namespaces (LangMem-style)

**Effort:** 1d.

### 4.1 What changes

Today: every memory is keyed `(project, kind)`. Cli's `MemoryStore` either reads `~/.anvil/memory/{project}/memories.jsonl` or `~/.anvil/memory/global/memories.jsonl`.

After: every memory carries a `MemoryNamespace` tuple (M14 in decisions). All read/write paths take an explicit namespace.

### 4.2 Procedure

1. Update `Memory` type to include `namespace: MemoryNamespace` (already did in Phase 1).
2. Update `HybridMemoryStore` API:
   ```ts
   class HybridMemoryStore {
     add(memory: Memory): void;                          // namespace already on memory
     query(ns: MemoryNamespace, opts: QueryOpts): Memory[];
     queryAll(opts: QueryOpts): Memory[];               // cross-namespace; admin-only
   }
   ```
3. Migrate existing `~/.anvil/memory/{project}/memories.jsonl` files: each line gets a namespace tuple `{scope: 'project', projectId: <project>}`. Preserve existing data.
4. New namespace path resolver:
   ```
   ~/.anvil/memory/global/...               -> {scope: 'global'}
   ~/.anvil/memory/user/{userId}/...        -> {scope: 'user', userId}
   ~/.anvil/memory/project/{projectId}/...  -> {scope: 'project', projectId}
   ~/.anvil/memory/repo/{projectId}/{repoId}/... -> {scope: 'repo', projectId, repoId}
   ```
5. Update `injectMemories` (existing function) to accept a namespace explicitly; default to project scope for backwards compat.
6. Update auto-learners to pass `{scope: 'project', projectId}` explicitly.

### 4.3 Validation

```sh
# Existing data still loads (default project namespace assigned)
anvil memory list --project=foo
# Cross-scope query
anvil memory list --scope=global
# Tests
npm -w @anvil/memory-core test
```

### 4.4 Acceptance

- [ ] `Memory` carries explicit namespace
- [ ] All read/write paths take namespace explicitly
- [ ] Existing data migrated to project-scoped on first read
- [ ] cli surfaces a `--scope` flag

### 4.5 Rollback

Per-commit revert. Worst case: namespace defaults back to "always project" if the read code can't find a tuple.

### 4.6 Risks

- **Namespace leak:** if a project memory accidentally gets stored as global, retrieval contaminates other projects. Mitigation: namespace is required at the API boundary; no defaults.

---

## Phase 5 — Bi-temporal facts

**Effort:** 1d.

### 5.1 Why

Mem0's `UPDATE` action overwrites. Anvil's existing `MemoryStore.remove()` also drops data. Both lose the historical record. Zep's bi-temporal model: never delete; mark `invalid_at`. Audit: query "what did the system know as of T?".

### 5.2 Procedure

1. Schema already supports `valid_at` + `invalid_at` (Phase 3).
2. Add `MemoryStore.invalidate(id, invalidAt, reason)` — sets `invalid_at`, doesn't delete the row.
3. Update `pruneExpired` — does NOT touch invalidated rows; just sets `invalid_at = now()` for TTL-expired rows. Hard-delete only after a configurable retention period (default 365 days) for invalidated rows.
4. Update query API: `MemoryStore.query(ns, opts)` accepts `validAt?: string` (default now); returns only memories where `valid_at <= validAt < (invalid_at ?? +∞)`.
5. Update auto-learners: when a fix-pattern is contradicted by a new fix-pattern, the new entry includes `supersedes: <old_id>`; the store invalidates the old entry rather than overwriting.
6. Provenance update: `MemoryProvenance` gains `invalidatedBy?: { runId, reason }`.

### 5.3 CLI surface

```sh
anvil memory show --id=<id> --as-of=<iso-time>   # historical query
anvil memory invalidate --id=<id> --reason="fix doesn't apply post-refactor"
```

### 5.4 Validation

```sh
# unit tests
npm -w @anvil/memory-core test
# manual smoke:
# add a memory, retrieve it, invalidate it, retrieve again — should be gone from default query
# but `--as-of=<before-invalidation>` returns it
```

### 5.5 Acceptance

- [ ] Memories never hard-deleted by normal flows
- [ ] `validAt` query returns historically-correct results
- [ ] Auto-learners use `invalidate()` instead of `remove()` for contradiction
- [ ] Hard-delete only after retention period

### 5.6 Rollback

Per-commit. Worst case: old `remove()` semantics restored; bi-temporal data still in schema (safe).

### 5.7 Risks

- **Storage growth:** never-delete = unbounded growth. Mitigation: hard-delete invalidated rows after retention period; document retention in M8.
- **Accidentally-active history:** if `validAt` parameter is missing, we'd return invalidated rows. Mitigation: default to `now()` everywhere; explicit param required for historical queries.

---

## Phase 6 — Code-fact drift detection (`structural_hash`)

**Effort:** 1d.

### 6.1 Why

A fix-pattern saying "in `auth.ts:42`, the bug is missing `await`" goes stale when `auth.ts` is refactored. Today: stale memory keeps surfacing. After: drift detected, memory auto-downweights or invalidates.

### 6.2 Procedure

1. `Memory.codeBinding` (already in types from Phase 1) populates when the auto-learner can identify a code site. Existing `recordFixPattern` currently doesn't track this — extend its signature.
2. `@anvil/knowledge-core/structural-hasher.ts` provides `computeStructuralHash(content, language)`. Call this when binding.
3. On retrieval: for any memory with `codeBinding`, the retriever:
   - Reads `<file>` from current workspace.
   - Computes current `structural_hash`.
   - Compares to `codeBinding.structuralHash`.
   - If equal → memory is "fresh"; full confidence.
   - If different → memory is "drifted"; downweight by 50% OR invalidate (configurable per kind).
4. Sleeptime task: scan memories with old `lastVerifiedAt` (e.g., older than 7 days), re-verify drift status, invalidate or refresh.

### 6.3 cli surface

```sh
anvil memory verify-code-bindings --project=<id>
# Output: "12 memories drifted (downweighted), 3 invalidated, 87 fresh."
```

### 6.4 Validation

```sh
# fixture: write a memory tied to a file, modify the file, retrieve
# expect: memory marked drifted on next retrieval
npm -w @anvil/memory-core test
```

### 6.5 Acceptance

- [ ] Auto-learners populate `codeBinding` when applicable
- [ ] Retrieval downweights drifted memories
- [ ] Sleeptime verifies bindings periodically
- [ ] cli command exposes verification

### 6.6 Rollback

Per-commit. `codeBinding` is optional; absent = no drift detection.

### 6.7 Risks

- **File deletion cascade:** when a file is deleted, all memories bound to it should auto-invalidate. Add a watcher / sleeptime check.
- **Renaming files:** structural_hash works on content, not path; if a file moves but content unchanged, the binding stays valid (good) but `filePath` becomes stale. Mitigation: re-bind on next verification; or store `lastSeenCommitSha` and check git rename detection.

---

## Phase 7 — PII / secret scrubber

**Effort:** 0.5d.

### 7.1 Why

Memories live for 30+ days, end up in backups, occasionally exported. A leaked API key or customer PII is a real risk.

### 7.2 Procedure

1. New module `packages/memory-core/src/scrubber/`:
   - `regex-rules.ts` — patterns: `sk-[a-zA-Z0-9]{20,}`, `ghp_[a-zA-Z0-9]+`, `xoxb-`, AWS access keys, JWT tokens, email addresses, phone numbers, SSNs, etc.
   - `classifier.ts` — optional LLM classifier for nuanced cases (medical info, financial figures). Calls `LanguageModel.invoke` from agent-core.
   - `scrub.ts` — orchestrator: try regex first (cheap); if `ANVIL_MEMORY_SCRUB_LLM=1` also run classifier; produce `{ cleaned: string, redactions: Array<{ pattern, count }>, hardReject: boolean }`.
2. Integration point: every `HybridMemoryStore.add()` (Phase 3) goes through scrub first.
3. Hard reject behavior: if `hardReject = true` (e.g., classified as "secret credential"), the write is rejected with a clear error. Mostly affects the proposal queue; sleeptime sees the rejection and moves on.
4. Scrub policy is configurable:
   - `ANVIL_MEMORY_SCRUB=1` (default) — regex-only, redact in place.
   - `ANVIL_MEMORY_SCRUB=llm` — also invoke classifier.
   - `ANVIL_MEMORY_SCRUB=0` — disable. **Document this is unsafe.**

### 7.3 Validation

```sh
# fixtures with secrets in them
# expect scrubber removes them or rejects
npm -w @anvil/memory-core test
```

### 7.4 Acceptance

- [ ] All `HybridMemoryStore.add()` paths go through scrubber
- [ ] Common secret patterns redacted by default
- [ ] LLM classifier optional via env
- [ ] Hard-reject path blocks sleeptime ratification

### 7.5 Rollback

Per-commit. Scrubber bypassable via `ANVIL_MEMORY_SCRUB=0`.

### 7.6 Risks

- **Regex false positives:** redacting too aggressively makes memories useless. Mitigation: log every redaction; ship a default-quiet mode that lets users opt into verbose logging.
- **LLM classifier cost:** off by default for cost. Document the cost-benefit in README.

---

## Phase 8 — Hybrid retrieval (BM25 + vector + graph)

**Effort:** 1.5d.

### 8.1 Why

Anvil's existing memory retrieval is tag-query + trigram-on-content. After:
- **BM25** via SQLite FTS5 (Phase 3 already created the table). Best for "exact phrase or keyword."
- **Vector** via LanceDB (existing infra). Best for "semantic similarity."
- **Graph** via SQLite adjacency (Phase 3 schema). Best for "related-to-X via N hops" — Phase 9 adds PPR; Phase 8 just adds 1-hop traversal.
- **Hybrid fusion** via Reciprocal Rank Fusion (RRF) — same scheme `@anvil/knowledge-core/retriever.ts` uses for code retrieval.

### 8.2 Procedure

1. New module `packages/memory-core/src/retrieve/`:
   - `bm25.ts` — wraps SQLite FTS5. `searchByText(query, ns, opts)`.
   - `vector.ts` — wraps LanceDB. Memories with `embedding` get vector-searched.
   - `graph.ts` — 1-hop adjacency expansion: given seed memory ids, return their neighbors.
   - `fusion.ts` — RRF combines BM25 + vector + graph results.
2. Memories opt into vector indexing by setting `embedding` (Phase 3 schema's `embedding_id`). Sleeptime (Phase 10) populates embeddings asynchronously for new memories.
3. Replace `injectMemories` internals: instead of tag + trigram, run hybrid retrieval scoped to namespace.
4. Backwards compat: `injectMemories({ tags })` still works — just becomes one of the seeds in hybrid.

### 8.3 Embedding strategy

Reuse `@anvil/knowledge-core/embedder.ts` (already supports 6 providers). When sleeptime runs:
- For each memory without `embedding`, embed `content + tags.join(' ')`.
- Write embedding into LanceDB; SQLite stores the `embedding_id`.
- Use auto-detected provider (existing logic).

### 8.4 cli surface

```sh
anvil memory search "stripe webhook bug" --project=foo --limit=5
# Output: top 5 hybrid-fused memories
```

### 8.5 Validation

```sh
# Recall benchmark: synthetic dataset (e.g., 100 memories, 20 queries)
# Measure: tag-only vs hybrid recall@5
# Expectation: hybrid noticeably better
npm -w @anvil/memory-core test
```

### 8.6 Acceptance

- [ ] BM25 search returns relevant results for keyword queries
- [ ] Vector search returns semantically-similar results for paraphrased queries
- [ ] Graph 1-hop expansion surfaces related memories
- [ ] Fusion outperforms single-mode retrieval on the benchmark

### 8.7 Risks

- **Embedding cost:** embedding every memory costs LLM-API or local-Ollama time. Mitigation: lazy embedding (only for memories that get retrieved); sleeptime batches.
- **Cold-start vector store:** until sleeptime runs, vector retrieval is empty. Acceptable v1 — BM25 fills the gap.

---

## Phase 9 — Personalized PageRank for multi-hop retrieval

**Effort:** 1d.

### 9.1 Why

Iterative-RAG (query → retrieve → re-query → retrieve → ...) makes multiple LLM calls per multi-hop query. HippoRAG 2's PPR does the same multi-hop in one graph operation; ~10–30× cheaper, ~6–13× faster.

Use case: "find memories related to this Stripe webhook task" — the query touches `stripe`, `webhook`, `auth`, `idempotency`. PPR over the memory graph (entity nodes + memory nodes + relations) returns top memories per random-walk visit count.

### 9.2 Procedure

1. New module `packages/memory-core/src/retrieve/ppr.ts`:
   ```ts
   /** Personalized PageRank over the memory adjacency graph. ~80 LOC. */
   export function personalizedPageRank(
     adjacency: Map<string, Array<{ target: string; weight: number }>>,
     seeds: Map<string, number>,         // node id → personalization weight
     opts?: { dampingFactor?: number; maxIterations?: number; epsilon?: number },
   ): Map<string, number>;
   ```
2. Integration: hybrid retrieval (Phase 8) gets a third mode "ppr":
   - Embed query → vector search → top-K seeds.
   - LLM "recognition" filter (one cheap LLM call): which seeds are actually relevant?
   - Run PPR from filtered seeds.
   - Return top-N memory nodes by PPR score.
3. Edge weights from `memory_edge.weight` (Phase 3 schema).
4. Per-namespace subgraphs — PPR runs only over the project's memory graph (keeps it small).
5. Add as an opt-in retrieval mode: `injectMemories({ mode: 'ppr', query: '...' })`.

### 9.3 Validation

```sh
# Synthetic multi-hop benchmark:
# - Memory A links to memory B (relation: 'depends_on')
# - Memory B links to memory C (relation: 'similar_to')
# - Query for "C-ish topic"
# - Expect: PPR returns A and B as related (multi-hop)
# - Iterative-RAG would need 3 LLM calls; PPR uses 1 + math
npm -w @anvil/memory-core test
```

### 9.4 Acceptance

- [ ] PPR implemented in pure TS (~80 LOC)
- [ ] Per-namespace subgraph extraction
- [ ] Recognition-filter LLM call gates seeds
- [ ] Multi-hop benchmark: PPR vs iterative-RAG — PPR cheaper, comparable recall

### 9.5 Risks

- **Convergence:** PPR can take many iterations on ill-conditioned graphs. Mitigation: cap `maxIterations = 50`, `epsilon = 1e-6`; document.
- **Memory graph quality:** PPR only as good as the edges. Sleeptime (Phase 10) creates edges via fact-extraction; quality depends on the LLM's ability to identify relations.

---

## Phase 10 — Sleeptime / proposal-queue ratification

**Effort:** 1.5d.

### 10.1 Why this is the architectural one

Auto-learners on the hot path are mem0's failure mode in microcosm — every event becomes a memory; junk dominates over months. Letta's solution: hot path *proposes*, background pass *ratifies*. The proposal queue + a separate consolidation LLM is the architectural fix.

### 10.2 Procedure

1. Schema (already in Phase 3): `proposal` table.
2. Auto-learner refactor (`recordFixPattern`, `recordSuccess`, `recordApproach`):
   - Old behavior: write directly to memory store.
   - New behavior: write to proposal queue with `status='pending'`.
3. New module `packages/memory-core/src/sleeptime/`:
   - `triggers.ts` — listens for: PR/CI completion events (from cli pipeline), every-N-runs counter, idle-timer.
   - `consolidator.ts` — runs the ratification pass:
     1. Load pending proposals (filter by namespace).
     2. For each proposal: dedupe-check (hash + nearest-neighbor in vector store). If duplicate, mark `status='merged-into'`, increment target's confidence/strength.
     3. For new proposals: scrubber (Phase 7); if hard-reject, `status='rejected'`.
     4. For survivors: ratify — set `status='ratified'`, write to durable memory store with `prov_ratified_at = now()`.
     5. Bi-temporal: if a new fix-pattern contradicts an existing one (LLM judges), invalidate the old.
     6. Embed new memories (lazy if too many).
     7. Update graph adjacency (add edges for relations the consolidator identifies).
   - `dedupe.ts` — hash + cosine similarity + LLM tie-breaker.
   - `ratify.ts` — the actual `{ADD, UPDATE, REJECT, MERGE-INTO}` decision logic.
4. cli command `anvil memory consolidate [--project=<id>]` — manually trigger sleeptime.

### 10.3 Trigger wiring

- **PR/CI completion:** cli's PR reviewer pipeline already emits a `pipeline-complete` event. Hook the sleeptime trigger there.
- **Every-N-runs:** counter in SQLite; on each pipeline complete, increment; at threshold, fire.
- **Idle:** background timer in dashboard server (or cli daemon if no dashboard).

### 10.4 Concurrency

Sleeptime must not race with hot-path proposals. Use a SQLite advisory lock (`PRAGMA locking_mode = EXCLUSIVE` for the consolidate transaction; release after). Cross-process: use a file lock at `~/.anvil/memory/.consolidate.lock`.

### 10.5 Validation

```sh
# integration: trigger 100 proposals, run consolidate, expect:
# - Some merged
# - Some ratified
# - Junk rejected
anvil memory consolidate --project=foo
anvil memory list --status=pending  # expect: 0 (after consolidate)
npm -w @anvil/memory-core test
```

### 10.6 Acceptance

- [ ] Auto-learners write to proposal queue, not durable
- [ ] Consolidator runs on configured triggers
- [ ] Dedupe correctly merges similar proposals
- [ ] Bi-temporal contradiction handling preserves history
- [ ] Concurrency safety verified

### 10.7 Rollback

Per-commit. Worst case: auto-learners fall back to direct writes (today's behavior).

### 10.8 Risks

- **Sleeptime LLM cost:** each consolidation pass is several LLM calls. Mitigation: cheap model for dedupe (e.g., Haiku); only escalate to Sonnet for contradiction detection.
- **Lock contention:** if pipeline runs faster than sleeptime, queue grows unbounded. Mitigation: monitor queue depth; if > N, fire sleeptime mid-pipeline.

---

## Phase 11 — Reflection-on-completion: "every run is better"

**Effort:** 1d.

### 11.1 Why

The single most important "memory makes future runs better" mechanism. After each pipeline / PR / CI completion: an LLM reflects on what happened. Output goes to proposal queue.

### 11.2 Procedure

1. New module `packages/memory-core/src/reflect/`:
   - `reflector.ts` — the prompt template + LLM invocation logic.
   - `prompts/reflection-system.md` — system prompt that asks for failure modes, success patterns, surprise lessons.
   - `extractor.ts` — parses LLM output into structured proposals.
2. Trigger: pipeline complete (with CI status) emits `runComplete` event.
3. Reflector consumes recent run events (audit log + run record) + diff of files touched + CI status. LLM produces JSON:
   ```json
   {
     "failures": [{ "what": "...", "root_cause": "...", "fix": "..." }],
     "successes": [{ "pattern": "...", "applies_when": "...", "code_snippet": "..." }],
     "surprises": [{ "what": "...", "why_surprising": "..." }],
     "skill_proposals": [{ "name": "...", "description": "...", "body": "..." }]
   }
   ```
4. Each item → proposal queue:
   - `failures` → semantic memory, subtype `fix-pattern`.
   - `successes` → semantic memory, subtype `success`.
   - `surprises` → semantic memory, subtype `manual` (notable, but unstructured).
   - `skill_proposals` → procedural memory; sleeptime emits a SKILL.md draft (Plan C integration — see Phase below).
5. Code references in extracted items get `codeBinding` populated automatically.

### 11.3 SKILL.md proposal flow (Plan C integration)

When the reflector proposes a skill, sleeptime:
1. Writes the SKILL.md to `<workspace>/.claude/skills/<auto-skill-name>/SKILL.md`.
2. Marks it as `auto-generated: true` in frontmatter.
3. Surfaces a notification: "Proposed new skill — review at .claude/skills/<name>/SKILL.md and rename or delete to discard."

User can promote (move out of `.claude/auto-skills/` to `.claude/skills/` with a meaningful name) or delete.

### 11.4 Validation

```sh
# After a pipeline run, check that proposals were created
anvil memory list --status=pending --created-by=reflection
# After consolidate, check ratified
anvil memory list --created-by=reflection
```

### 11.5 Acceptance

- [ ] Reflection fires on pipeline completion (CI complete)
- [ ] Failures, successes, skills proposed
- [ ] Sleeptime ratifies; user-visible skill drafts surface

### 11.6 Risks

- **Reflection LLM cost:** every run = 1 reflection call. Mitigation: short context (only diff + audit); cheap model; rate-limit (don't reflect twice on the same run).

---

## Phase 12 — PR-as-episode primitive

**Effort:** 0.5d.

### 12.1 Why

A PR is the natural atomic unit of work for a coding agent: bounded intent, structured plan, explicit files, ground-truth tests, ground-truth CI, ground-truth review. Storing PRs as episodic memories gives the next-similar-task something concrete to retrieve.

### 12.2 Procedure

1. `Memory.kind = 'episodic'`, `subtype = 'pr-episode'`, `content = PrEpisode` (defined in Phase 1 types).
2. Hook into cli's PR reviewer / pipeline-complete event:
   - Capture PR URL, intent (the original prompt), plan (the planner output), files changed (git diff), commit shas, tests added, CI status, review outcome, merge status.
   - Build a `Memory<PrEpisode>` with `namespace = {scope: 'project', projectId, repoId}`.
   - Write to proposal queue (auto-ratified — PR episodes are inherently structured, low-noise).
3. Retrieval: when a new task arrives, retrieve top-K similar PR episodes by:
   - BM25 on intent text.
   - Vector similarity on intent embedding.
   - Filter to merged + CI-pass PRs (success patterns).
4. Inject into agent's context: "Here are similar PRs from this project: ..."

### 12.3 cli command

```sh
anvil memory list --kind=episodic --subtype=pr-episode --project=foo
anvil memory show --id=<pr-episode-id>
```

### 12.4 Validation

```sh
# After a real PR completes, confirm the episode was created
# Smoke: simulate next task; verify retrieval surfaces the episode
```

### 12.5 Acceptance

- [ ] Every completed PR produces a PrEpisode memory
- [ ] Retrieval surfaces relevant past PRs for similar new tasks
- [ ] Episode content fully populated (CI status, merge status)

### 12.6 Risks

- **Privacy:** PR URLs and diffs may contain proprietary code. Mitigation: scrubber (Phase 7) runs on all content; user can opt-out per-project via `factory.yaml`.

---

## Phase 13 — Dashboard memory inspector

**Effort:** 1d.

### 13.1 Scope

Add a memory tab to the dashboard server (existing `packages/dashboard/`) showing:
- List view: all memories, filterable by namespace / kind / subtype / status.
- Detail view: full memory content + provenance + bitemporal history.
- Proposal queue view: pending proposals, ratify/reject manually.
- Drift status: memories with stale `codeBinding`.
- Stats: counts by kind, top tags, recent additions.

### 13.2 Procedure

1. New API routes in `packages/dashboard/server/`:
   - `GET /api/memory?ns=<scope>&kind=<kind>&limit=...`
   - `GET /api/memory/:id`
   - `GET /api/memory/proposals?status=pending`
   - `POST /api/memory/proposals/:id/ratify` (admin)
   - `POST /api/memory/proposals/:id/reject`
2. New React components in `packages/dashboard/src/`:
   - `MemoryInspector.tsx`
   - `MemoryDetail.tsx`
   - `ProposalQueue.tsx`
3. Reuse existing dashboard auth (run-record permissions).

### 13.3 Validation

```sh
cd packages/dashboard && npm run dev
# open browser, navigate to memory tab, verify all views
```

### 13.4 Acceptance

- [ ] Memory list view loads
- [ ] Detail + proposal views work
- [ ] Manual ratify/reject works

### 13.5 Risks

- **Permission scope:** an admin ratify endpoint must be auth-protected. Mitigation: reuse existing dashboard auth; deny in unauthenticated mode.

---

## Phase 14 — Migration importer + docs + ADR finalization

**Effort:** 0.5d.

### 14.1 Migration importer

`anvil memory migrate` command:
1. Scans `~/.anvil/memory/<project>/memories.jsonl` for every project.
2. For each entry: assigns namespace `{scope:'project', projectId}`, `provenance.createdBy='migration'`, fills `bitemporal.validAt = createdAt`, `decay.lastAccessed = now()`, `decay.strength = 100`.
3. Writes through `HybridMemoryStore.add()` — which goes through scrubber (Phase 7), so any inadvertent secrets get caught now.
4. Reports: "Migrated N memories across M projects, X scrubbed, Y rejected."

The script is idempotent — running twice produces no duplicates (UUID match).

### 14.2 Docs

`packages/memory-core/README.md`:

- What's in the package
- Public API (with code examples)
- Storage layout
- The five memory types
- Sleeptime architecture (high-level diagram)
- Migration guide for existing users
- env var reference: `ANVIL_MEMORY_*` family

`MEMORY-CORE-ADR.md`:
- Finalize "what shipped" section
- List per-phase commits
- Document any deviations from the plan

### 14.3 Acceptance

- [ ] Migration importer works on a real `~/.anvil/memory/` directory without data loss
- [ ] README is sufficient for a new contributor
- [ ] ADR documents shipped state

### 14.4 Risks

- **Migration data loss:** a botched migration loses real user memories. Mitigation: importer makes a `memories.jsonl.pre-migration.bak` copy before running; `--dry-run` flag shows what would happen.

---

## Cross-cutting: validation strategy

After each phase:

1. `npm install` — ensure lockfile and native deps compile.
2. `tsc --build` from root — type-check across all packages.
3. Per-package: `npm -w <name> run build && npm -w <name> test`.
4. Real-data smoke: at minimum after Phase 2 and Phase 14, run `anvil run` against a known-good fixture project and verify auto-learners populate the proposal queue (or directly-write store, depending on phase).
5. Memory-specific benchmark: 1k synthetic memories, time tag-query, BM25, vector search, hybrid fusion, PPR. Track regressions across phases.

---

## Cross-cutting: order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit | Lock decisions before code. |
| 1 | Scaffold | Validate package wiring + native dep install. |
| 2 | Hoist existing | Move 15 files unchanged; preserves API; smallest behavior risk. |
| 3 | Hybrid storage | New SQLite layer; existing JSONL preserved. |
| 4 | Namespaces | Now that storage works, add the typed dimension. |
| 5 | Bi-temporal | Cannot add later without rewriting query paths; do early. |
| 6 | Drift detection | Reuses Phase 5's bi-temporal invalidation path. |
| 7 | Scrubber | Must precede sleeptime so all writes go through it. |
| 8 | Hybrid retrieval | Vector + BM25 + 1-hop graph; foundation for PPR. |
| 9 | PPR | Adds multi-hop on top of Phase 8's 1-hop. |
| 10 | Sleeptime | The architectural one — proposal queue + ratification. |
| 11 | Reflection | Triggers sleeptime; provides "every run is better" mechanism. |
| 12 | PR-as-episode | Clean primitive; depends on Phase 11's hooks. |
| 13 | Dashboard | UI on top of stable foundation. |
| 14 | Migration + docs | Last so docs and importer reflect what shipped. |

---

## Summary table

| Phase | Effort | LOC moved | LOC written | Risk |
|---|---|---|---|---|
| 0 — Audit | 0.5d | 0 | ~120 (ADR) | low |
| 1 — Scaffold | 0.5d | 0 | ~250 (skeleton + types) | low |
| 2 — Hoist existing | 1d | ~1,500 | ~50 (path-injection seam) | medium |
| 3 — Hybrid storage | 1.5d | 0 | ~450 (sqlite-store, hybrid-store, schema) | medium |
| 4 — Namespaces | 1d | 0 | ~150 | medium |
| 5 — Bi-temporal | 1d | 0 | ~150 | medium |
| 6 — Drift detection | 1d | 0 | ~200 | medium |
| 7 — Scrubber | 0.5d | 0 | ~200 | low |
| 8 — Hybrid retrieval | 1.5d | 0 | ~400 (bm25, vector, graph, fusion) | medium |
| 9 — PPR | 1d | 0 | ~150 (ppr.ts ~80 LOC + integration) | medium |
| 10 — Sleeptime | 1.5d | 0 | ~500 (triggers, consolidator, dedupe, ratify) | high |
| 11 — Reflection | 1d | 0 | ~250 (reflector + prompts + extractor) | medium |
| 12 — PR-as-episode | 0.5d | 0 | ~150 | low |
| 13 — Dashboard inspector | 1d | 0 | ~400 (API + components) | low |
| 14 — Migration + docs | 0.5d | 0 | ~250 (importer + README + ADR) | medium |
| **Total** | **~12d** | **~1,500** | **~3,650** | — |

Plus 30% risk premium → realistic calendar **~16 days for a solo eng**, or **~14–18 conversation turns** if executed phase-by-phase.

---

## Failure modes to watch

1. **Mem0-style pollution.** Hot path writes durable memory directly. Defense: M9 + Phase 10 — proposal queue is mandatory; auto-learners route through it.
2. **Sleeptime LLM cost runaway.** Every consolidation pass calls LLMs. Mitigation: tier-route — Haiku for dedup, Sonnet only for contradiction; rate-limit; track per-project sleeptime cost in dashboard.
3. **`better-sqlite3` install fail on exotic platforms.** Mitigation: prebuilds cover most cases; document `npm rebuild` fallback; investigate `node:sqlite` (built-in since Node 22.5) as future replacement.
4. **JSONL/SQLite drift.** Mitigation: `anvil memory verify` periodically; `anvil memory rebuild-index` to recover.
5. **Bi-temporal storage growth.** Never-delete = unbounded. Mitigation: hard-delete invalidated rows after configurable retention period (default 365 days).
6. **Migration data loss.** Mitigation: backup-before-migrate; `--dry-run`; idempotent imports.
7. **Scrubber false positives.** Aggressive regex breaks legitimate memories. Mitigation: log every redaction; `--audit` mode to review without applying.
8. **Drift detection too aggressive.** Every code edit invalidates many memories. Mitigation: structural-hash-based, not text-based; tolerates whitespace / formatting changes; only invalidates on semantic structural change.
9. **PPR convergence.** On ill-conditioned graphs, can take many iterations. Mitigation: `maxIterations = 50`, `epsilon = 1e-6`, fall back to vector retrieval if PPR doesn't converge.
10. **Skills overlap with Plan C.** Auto-generated skills + user-curated skills could collide. Mitigation: separate dirs (`.claude/skills/` user, `.claude/auto-skills/` auto-generated); user-promotion is explicit.

---

## Glossary

- **Memory:** a single durable fact stored across runs. Five types: working / episodic / semantic / procedural / profile.
- **Namespace:** the LangMem-style tuple `(scope, projectId?, repoId?, userId?)` that scopes a memory.
- **Bi-temporal:** every memory has `valid_at` and `invalid_at`. Memories are never deleted; they're invalidated. Lets you query historical state.
- **Decay-and-rehearse:** MemoryBank's forgetting curve. Each memory has `strength` that decays with time-since-access; retrieval rehearses (resets decay).
- **Code binding:** `(file_path, structural_hash, last_seen_commit_sha)` — tracked on every memory mentioning code; auto-invalidates on drift.
- **Provenance:** where a memory came from. `(source_run_id, source_message_id, source_file, source_commit, created_by, created_at, ratified_at)`.
- **Proposal queue:** the SQLite table where auto-learners write candidates. Sleeptime ratifies. Hot path NEVER writes durable memory directly.
- **Sleeptime / consolidator:** the background ratification pass. Triggered on CI completion, every-N-runs, idle. The architectural defense against memory pollution.
- **Reflection:** the LLM call after a run that extracts lessons-learned. Output enters the proposal queue.
- **PR episode:** a structured episodic memory `{intent, plan, files, commits, tests, ci, review, merge}`. Created on PR completion.
- **PPR (Personalized PageRank):** graph-based multi-hop retrieval algorithm from HippoRAG 2. ~80 LOC of TS over SQLite adjacency.
- **Hybrid retrieval:** BM25 (SQLite FTS5) + vector (LanceDB) + graph traversal (1-hop or PPR), fused via Reciprocal Rank Fusion.
- **Hot path:** any code that runs during a user-facing pipeline run. Writes to proposal queue, never directly to durable.
- **Cold path / sleeptime:** the background ratification + consolidation logic. The only path that writes durable memory.
- **Hybrid store:** the dual-write `JsonlAppendLog` (canonical) + `SqliteHotIndex` (queryable) abstraction.

---

## Appendix A — Eight patterns stolen, source-by-source

| Pattern | From | Phase that lands it |
|---|---|---|
| Sleeptime / proposal-queue separation | Letta | Phase 10 |
| Personalized PageRank multi-hop retrieval | HippoRAG 2 (arXiv 2502.14802) | Phase 9 |
| Bi-temporal facts (`valid_at`/`invalid_at`) | Zep / Graphiti (arXiv 2501.13956) | Phase 5 |
| Typed namespace tuples | LangMem | Phase 4 |
| File-based profile + procedural always-in-context | Claude Code | M4 + Phase 11 (skill proposals) |
| `(file_path, structural_hash, last_seen_commit_sha)` drift binding | Anvil-specific (existing structural-hasher.ts) | Phase 6 |
| CI completion as ratification trigger | Coding-agent specific | Phase 10 trigger config + Phase 11 |
| PR as atomic episodic unit | Coding-agent specific | Phase 12 |

## Appendix B — Five anti-patterns explicitly avoided

| Anti-pattern | Source of failure | Anvil's defense |
|---|---|---|
| Permissive memory extraction (mem0's 97.8% junk) | mem0 issue #4573 | M11 + Phase 10: auto-learners write to proposals; consolidator can REJECT; never extract from agent system prompts |
| Auto-commit memories without user visibility | Cursor (removed in v2.1.x) | M5 + Phase 13 dashboard inspector + skill drafts in `.claude/auto-skills/` |
| Tool-calling-only writes (Letta open-source-model failure) | Letta sleeptime docs | Auto-learners are non-tool-call code; sleeptime LLM uses structured-output prompting, not tool-calling |
| Putting profile/procedural in vector DB | Claude Code design choice | M4 + procedural memory output is SKILL.md files, not vector store entries |
| Memories without provenance | research consensus | Phase 1 type schema mandates `provenance` on every memory |

## Appendix C — Existing data preservation contract

The migration importer (Phase 14) MUST satisfy these invariants for a user with prior `~/.anvil/memory/<project>/memories.jsonl`:

1. **Zero data loss.** Every entry in the old file becomes a Memory in the new model.
2. **Provenance preserved.** `provenance.createdBy = 'migration'`, with original `createdAt`, original `tags`, original `confidence`.
3. **Backup before run.** A `.pre-migration.bak` file is written before any modification.
4. **Idempotent.** Running migrate twice produces no duplicates.
5. **Dry-run flag.** `anvil memory migrate --dry-run` reports what would happen without making changes.
6. **Rollback safety.** If migration fails partway, the JSONL is unchanged; only the SQLite hot index needs rebuild.

## Appendix D — env var reference

| Variable | Default | Effect |
|---|---|---|
| `ANVIL_MEMORY_HOME` | `$ANVIL_HOME/memory` | Root path for all memory storage |
| `ANVIL_MEMORY_SCRUB` | `1` | `1` regex; `llm` regex+classifier; `0` disable (unsafe) |
| `ANVIL_MEMORY_SCRUB_LLM_MODEL` | `claude-haiku-4-5` | Cheap model for classifier |
| `ANVIL_MEMORY_SLEEPTIME_TRIGGER` | `ci,every:25,idle:30m` | Comma-separated triggers |
| `ANVIL_MEMORY_TTL_DAYS` | `30` | Default TTL for new memories |
| `ANVIL_MEMORY_DECAY_HALF_LIFE` | `90d` | Strength halves every N days without access |
| `ANVIL_MEMORY_RETENTION_DAYS` | `365` | Hard-delete invalidated rows after N days |
| `ANVIL_MEMORY_PPR_MAX_ITER` | `50` | PPR convergence cap |
| `ANVIL_MEMORY_PPR_DAMPING` | `0.85` | PPR damping factor |
| `ANVIL_MEMORY_DRIFT_VERIFY_DAYS` | `7` | Sleeptime re-verifies code bindings older than N days |
| `ANVIL_MEMORY_DEBUG` | `0` | Verbose logging of writes/retrievals/scrubs |

## Appendix E — Coding-agent-specific signals to use

A coding agent has signals that general agents don't. Use them:

1. **Repo is the ground truth.** Every code-tied memory carries `(file_path, structural_hash, last_seen_sha)`. On retrieval, verify; downweight or invalidate on drift.
2. **Tests are oracles.** Memories tied to passing tests get +confidence; failing tests trigger explicit warnings on retrieval ("this fix-pattern was associated with a now-failing test").
3. **PRs are atomic units.** Phase 12 makes this primitive.
4. **CI is delayed feedback.** Sleeptime triggers on CI completion; reflection runs after CI.
5. **Files have lifecycle.** File deletion → cascade invalidate bound memories.
6. **Cross-repo patterns.** User-style preferences hold across repos → profile memory is `scope: 'user'`. Code knowledge is `scope: 'project'` or `'repo'`.
7. **Skills > prompts.** Auto-extracted procedural memories propose SKILL.md files (Plan C integration), not raw prompt text.
8. **Sandbox state.** Workspace state (deps, env) is its own memory kind; tied to `run_id`. Out of scope for this plan but the namespace model accommodates it.

These eight signals are why a coding-agent memory system can be more accurate than a general-agent memory system — there are more ground-truth handles.
