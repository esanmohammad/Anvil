# Plan: Extract `@anvil/knowledge-core` shared workspace package

## Goals (what "done" means)

- Both `packages/cli` and `packages/code-search-mcp` consume a single shared package for: chunking, file-walking, AST/tree-sitter, embedders, vector store, BM25, hybrid retriever, reranker, project graph, structural hashing.
- No file in `cli/src/knowledge/` or `mcp/src/core/` is duplicated logic — anything that exists in both trees lives in the shared package, anything that's package-specific stays in its consumer.
- Native deps (`lancedb`, `tree-sitter-*`, `@xenova/transformers`) install once.
- Both consumers' test suites pass with the same coverage as today.
- A future Phase-N change in the optimization plan touches one file, not two.

---

## Cost-benefit context (from prior analysis)

- **Current footprint:** 21,878 LOC across 53 files (cli/knowledge: 11,395 LOC / 28 files; mcp/core: 10,483 LOC / 25 files).
- **Overlap:** ~75% is true-clone or near-clone. 14 files (5,721 LOC) are byte-identical-ish (diff ≤ 5 lines). 6 files (2,147 LOC) have mild drift. 3 files (2,098 LOC) have real drift. 1 file (`project-graph-builder.ts`, 776 LOC) is essentially two implementations.
- **Net hand-edited LOC for refactor:** ~2,400. **Total PR diff:** ~13,000 lines (most cancel out).
- **One real architectural decision:** how to merge `project-graph-builder.ts`.

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 — Decisions to lock before any move

| Decision | Default | Rationale |
|---|---|---|
| Package name | `@anvil/knowledge-core` | Internal-only, scope `@anvil` matches existing `@anvil-dev/dashboard` |
| Module type | ESM only, `"type": "module"` | Both consumers are ESM today |
| Build target | `tsc -b` emit to `dist/` | Matches cli; mcp's `build.mjs` will externalize this dep |
| `project-graph-builder` strategy | **Extract `ProjectGraphCore` base class + two thin subclasses** | Option B (winner-take-all) loses ~250 LOC of cli features; option C (no merge) defeats the refactor |
| `context-assembler.ts` placement | **Stays cli-only** (mcp doesn't use it) | Avoids forcing mcp to depend on context machinery |
| Config-path resolution | Constructor-injected `resolveDataPath(project: string): string` | cli uses `~/.anvil/knowledge-base/<project>`; mcp uses `CODE_SEARCH_DATA_DIR ?? ~/.anvil/...` — inject, don't fork |
| Artifact for mcp | Externalize via esbuild `external: ['@anvil/knowledge-core']` | Avoids double-bundling lancedb |
| Lockfile | One regen at end of refactor | Avoid churn during phases |

### 0.2 — Audit deliverables

- File inventory with LOC + diff buckets (clones / mild / real / heavy / single-tree)
- List of public symbols in `packages/cli/src/knowledge/index.ts` (current public API contract)
- List of every external importer in both packages
- List of every native dep currently in both `package.json` files

### 0.3 — Acceptance

- [x] Decisions written to ADR [`KNOWLEDGE-CORE-ADR.md`](./KNOWLEDGE-CORE-ADR.md)
- [ ] Audit document approved by reviewer

### 0.4 — Rollback

N/A — no code change.

---

## Phase 1 — Scaffold + proof-of-life

**Effort:** 0.5d.

### 1.1 — Create the package skeleton

```
packages/knowledge-core/
├── package.json          (~30 LOC)
├── tsconfig.json         (~20 LOC, extends root)
├── src/
│   └── index.ts          (~5 LOC, just exports types for now)
└── README.md             (~30 LOC, short)
```

Workspace wiring:
- Root `package.json` `workspaces` array — add entry
- Root `tsconfig.json` `references` — add `{ "path": "packages/knowledge-core" }`

### 1.2 — Move `types.ts` end-to-end (218 LOC, diff=0 between trees)

This is the proof-of-life: a 100% clone, zero risk, validates the entire pipeline.

- `packages/cli/src/knowledge/types.ts` → `packages/knowledge-core/src/types.ts`
- Delete from `packages/code-search-mcp/src/core/types.ts`
- Add `export * from './types.js'` to `packages/knowledge-core/src/index.ts`
- Update `packages/cli/src/knowledge/index.ts` to re-export from `@anvil/knowledge-core` (preserves cli's public API)
- Update every internal import in both trees: `from './types.js'` → `from '@anvil/knowledge-core/types.js'` (or via the index re-export)

### 1.3 — Add to both consumers' dependencies

- `packages/cli/package.json` deps: `"@anvil/knowledge-core": "workspace:*"`
- `packages/code-search-mcp/package.json` deps: same

### 1.4 — Validation

- `npm -w @anvil/knowledge-core run build` succeeds
- `npm -w @esankhan3/anvil-cli run build` succeeds
- `npm -w @esankhan3/anvil-cli test` — 71/71 pass (Phase 6 baseline)
- `npm -w @anvil-dev/dashboard run test:server` — same pass count (430/436 with 6 pre-existing failures)
- `npm -w @anvil-dev/code-search-mcp run build` (or whatever its build is)

### 1.5 — Acceptance

- [ ] Shared package builds standalone
- [ ] Both consumers build + test green
- [ ] `types.ts` exists in exactly one place

### 1.6 — Rollback

Revert the commit. No persisted state, no schema migrations.

### 1.7 — Risks

- ESM module resolution gotchas with the workspace protocol — surface in Phase 1 to fix once, not 14 times in Phase 2.
- mcp's `build.mjs` may need `external: ['@anvil/knowledge-core']` already at this stage — verify.

---

## Phase 2 — Bulk-move true clones

**Effort:** 1d.

### 2.1 — Scope

Move 13 files (5,503 LOC, diff ≤ 5 lines each):

| File | LOC | Notes |
|---|---|---|
| `chunker.ts` | 534 | diff=2, formatting |
| `config.ts` | 96 | diff=4, the `getKnowledgeBasePath` mismatch — inject via `resolveDataPath` |
| `file-walker.ts` | 227 | diff=4 |
| `git-diff.ts` | 167 | diff=0, true clone |
| `graph-metrics.ts` | 332 | diff=2 |
| `graph-query.ts` (cli only) | 101 | move with the graph cluster |
| `query-classifier.ts` | 256 | diff=0 |
| `query-router.ts` | 355 | diff=2 |
| `structural-hasher.ts` | 425 | diff=0 |
| `tree-sitter-parser.ts` | 786 | diff=5 |
| `workspace-detector.ts` | 612 | diff=2 |
| `retriever.ts` | 366 | diff=2 |
| `cross-repo-detector.ts` | 1126 | diff=2 |
| `semantic-edge-detector.ts` | 221 | diff=2 |

### 2.2 — Per-file procedure (apply to all 13)

1. Diff cli vs mcp version, accept whichever has more recent edits (mostly identical anyway).
2. Move to `packages/knowledge-core/src/<file>.ts`.
3. Delete from `cli/src/knowledge/<file>.ts` and `mcp/src/core/<file>.ts`.
4. Update internal cross-imports within shared package (most are already relative `./types.js` etc. and survive).
5. Update consumers' import paths.

### 2.3 — `config.ts` special handling

Inject the data-path resolver:

```ts
// packages/knowledge-core/src/config.ts
export interface KnowledgeContext {
  resolveDataPath: (project: string) => string;
}
// Remove the hardcoded getKnowledgeBasePath; consumers provide one.
```

cli passes `(p) => join(homedir(), '.anvil', 'knowledge-base', p)`.
mcp passes `(p) => process.env.CODE_SEARCH_DATA_DIR ? join(env, p) : join(homedir(), '.anvil', 'knowledge-base', p)`.

~10 LOC of API change, ~20 LOC of consumer updates.

### 2.4 — Validation

Run after each batch of 3-4 files, not after every single one:
- `tsc --build` from root (verifies project references)
- `npm -w @esankhan3/anvil-cli test` (71+ pass)
- `npm -w @anvil-dev/dashboard run test:server` (430+ pass)

### 2.5 — Acceptance

- [ ] 13 files moved, ~5,500 LOC deleted from each consumer
- [ ] Both consumers build + test green
- [ ] Phase 6's `retriever-defaults.test.ts` still passes (regression guard for Phase 6)

### 2.6 — Rollback

Per-file revert is safe. Worst-case: revert the entire phase commit.

### 2.7 — Risks

- `tree-sitter-parser.ts` (786 LOC) imports tree-sitter native modules. If both consumers' `node_modules` end up with different tree-sitter versions, runtime breaks. Mitigation: make `tree-sitter-*` peer deps of the shared package, force version alignment via root.

---

## Phase 3 — Reconcile mild-drift files

**Effort:** 1d.

### 3.1 — Scope

6 files (~2,147 LOC, diff 5-100):

| File | LOC | Diff lines | Likely cause |
|---|---|---|---|
| `service-mesh-inferrer.ts` | 419 | 14 | Path detection heuristics |
| `rag-evaluator.ts` | 292 | 24 | Eval set paths or scoring tweak |
| `vector-store.ts` | 291 | 18 | Storage path resolution |
| `repo-profiler.ts` | 549 | 17 | Logging style |
| `embedder.ts` | 380 | 72 | Provider list / default fallback |
| `reranker.ts` | 216 | 101 | Phase 6's recent edits to mcp side |

### 3.2 — Per-file procedure

1. `diff -u cli mcp` to read the actual deltas.
2. Identify the dominant version (newer / more features).
3. Surface differences as constructor params or feature flags rather than forking the file.
4. Move to shared package, delete from both consumers.

### 3.3 — `reranker.ts` special handling

The 101-line diff is mostly because Phase 6 of TOKEN-OPTIMIZATION-PLAN landed only on the mcp tree (we changed the cli path). Take the cli version as canonical (it has the latest reranker work) and port any mcp-specific bits.

### 3.4 — `embedder.ts` special handling

Likely difference is provider auto-detection logic. Make the provider list a constructor arg with sensible default:

```ts
export function createEmbeddingProvider(
  cfg: EmbeddingConfig,
  opts?: { auth?: AuthLookup },
): EmbeddingProvider;
```

### 3.5 — Validation + Acceptance + Rollback

Same as Phase 2.

### 3.6 — Risks

- `embedder.ts` is on the hot path for every retrieval. A behavior delta missed during merge silently degrades retrieval quality. Mitigation: a smoke test that runs a known query against a known fixture and checks top-1 chunk ID.

---

## Phase 4 — Reconcile real-drift files (3 sub-phases)

**Effort:** 2d total (0.5d each + 0.5d slack).

### 4a. `claude-runner.ts` (232/247 LOC, diff=253 → ~50% rewrite)

**Why diverged:** different auth/session models between cli and mcp.

**Approach:**
- Extract a `ClaudeRunnerCore` with the shared subprocess machinery (stream parsing, cost extraction).
- Inject auth via constructor: `{ authStrategy: 'cli-login' | 'api-key' | 'oauth' }`.
- Each consumer keeps a thin `claude-runner.ts` (~50 LOC) wrapping the core.

**Validation:** Smoke test in each consumer that runs a one-shot claude prompt against the runner.

### 4b. `indexer.ts` (703/776 LOC, diff=205 → ~50 unique lines per side)

**Why diverged:** different startup logging, different graph-loading paths, mcp has env-config bootstrap.

**Approach:**
- Phase 6 already proved both indexers share the retriever-construction code.
- Extract `buildHybridRetriever()` + `buildIndex()` into shared functions taking config + resolver.
- Each consumer's `indexer.ts` becomes a thin orchestration layer (~150 LOC each) calling shared functions.

**Validation:** Run `cli index` against a fixture project; run mcp's index tool against the same project; assert equivalent vector store contents.

### 4c. `ast-graph-builder.ts` (1163/1008 LOC, diff=313 → ~75 lines per side)

**Why diverged:** cli has additional graph metrics + legacy fallback; mcp leaner.

**Approach:**
- Take cli version as canonical (155 LOC more, all features).
- Port any mcp-specific extensions (likely just import path tweaks).
- One file in shared package, ~1,150 LOC.

**Validation:** Existing chunker + tree-sitter tests cover most paths. Add one test asserting the graph builder produces the same node count for a fixed input.

### 4.4 — Acceptance (all sub-phases)

- [ ] 3 files in shared package
- [ ] Both consumers' indexer + retriever flows tested end-to-end on a fixture project
- [ ] No behavior regression vs. pre-refactor (compare before/after vector store contents)

### 4.5 — Rollback

Each sub-phase is its own commit. Revert independently. Sub-phase 4b is the riskiest because indexer is the orchestration entry point — keep it last.

### 4.6 — Risks

- **claude-runner**: different auth flows could mean different env-var contracts. Mitigation: itemize env vars used by each before merging.
- **indexer**: easy to accidentally regress incremental-index behavior (StructuralHasher gating). Mitigation: add a test that re-indexes the same repo twice and asserts the second run does no embedding work.

---

## Phase 5 — `project-graph-builder` extract (the architectural one)

**Effort:** 1d.

### 5.1 — Scope

`project-graph-builder.ts` cli=776 LOC, mcp=235 LOC, diff=935 lines (basically two implementations).

Looking at the file lists:
- cli has `project-graph-builder.ts` (776) + `project-graph-builder-legacy.ts` (235)
- mcp has `project-graph-builder.ts` (235) — looks like cli's legacy

So mcp is using what cli calls "legacy." Real merge:
- Take cli's modern version as canonical (776 LOC).
- Extract the methods that mcp uses (likely the leaner subset) into a `ProjectGraphCore` (~500 LOC).
- cli's `ProjectGraphBuilder` extends `ProjectGraphCore` with the additional features (project summary, prompt rendering, cost estimation) — ~250 LOC subclass.
- mcp drops its file entirely; constructs `ProjectGraphCore` directly OR a thinner mcp subclass (~50 LOC).
- Delete `project-graph-builder-legacy.ts` (235 LOC) — now obsolete.

### 5.2 — Net LOC

- New shared base: ~500 LOC
- cli subclass: ~250 LOC (down from 776)
- mcp subclass: ~50 LOC or none (down from 235)
- Deleted legacy: -235 LOC
- **Net: ~800 LOC live (was 1,246 LOC across three files) → ~36% reduction**

### 5.3 — Public API for cli's existing exports

`cli/src/knowledge/index.ts` re-exports `ProjectGraphBuilder`, `buildProjectGraph`, `loadProjectGraph`, `loadProjectSummary`, etc. Preserve every name — re-export from cli's subclass, not from the shared core, so external cli consumers (`pipeline/orchestrator.ts`) don't break.

### 5.4 — Validation

- Existing cli tests for project graph (if any)
- Smoke: build a project graph with cli's builder, compare node/edge count to pre-refactor
- mcp's graph tool (`packages/code-search-mcp/src/tools/graph.ts`) returns identical structure for the same input

### 5.5 — Acceptance

- [ ] One shared `ProjectGraphCore`, one cli subclass, one mcp subclass (or direct usage)
- [ ] `project-graph-builder-legacy.ts` deleted
- [ ] Both consumers' graph tools produce identical output for a fixture repo

### 5.6 — Rollback

Higher-effort revert because this touches both consumers' graph code paths. Mitigation: land 5 as its own commit with no other Phase work bundled.

### 5.7 — Risks

- Graph schema drift between cli and mcp (node attribute names) would surface here, not before. Mitigation: dump JSON of pre-refactor graphs from both consumers, diff against post-refactor.

---

## Phase 6 — External importer cleanup

**Effort:** 0.5d.

### 6.1 — Scope

8 files importing from the (now-deleted) per-package knowledge dirs:

**cli (1 file):**
- `packages/cli/src/pipeline/orchestrator.ts`

**mcp (7 files):**
- `src/middleware/auth.ts`
- `src/tools/{search,profile,graph,index-tools}.ts`
- `src/transports/http-transport.ts`
- `src/resources/resources.ts`

### 6.2 — Procedure

For each: replace `from '../knowledge/foo.js'` or `from '../core/foo.js'` with `from '@anvil/knowledge-core/foo.js'` (or via the index barrel).

Mostly mechanical. ~80 lines edited.

### 6.3 — Validation

- `tsc --build` from root — must be clean
- Both consumers' test suites unchanged
- mcp's HTTP transport responds to a test request (the 7 importers are server-side surface area)

### 6.4 — Acceptance

- [ ] `grep -rn "from.*knowledge/" packages/cli/src` returns 0 (outside the new package)
- [ ] `grep -rn "from.*core/" packages/code-search-mcp/src` returns 0 (outside the new package)

### 6.5 — Rollback

Single mechanical commit. Revert if any consumer breaks.

---

## Phase 7 — Test migration + new shared-API tests

**Effort:** 1d.

### 7.1 — Scope

Move 5 existing test files from `cli/src/knowledge/__tests__/` to `packages/knowledge-core/src/__tests__/`:
- `chunker.test.ts`
- `claude-runner.test.ts`
- `query-classifier.test.ts`
- `structural-hasher.test.ts`
- `retriever-defaults.test.ts` (Phase 6's contract)

### 7.2 — New tests for shared-API seams

- `config.test.ts` — `resolveDataPath` injection produces correct paths
- `embedder.test.ts` — provider auto-selection across configs
- `project-graph-core.test.ts` — base class extension contract

~150 LOC of new test code.

### 7.3 — Update test commands

- New package's `package.json`: `"test": "tsc -b && node --test dist/__tests__/*.test.js"`
- Root `npm test` runs all three packages

### 7.4 — Validation

- New package tests: at least 71+ pass (Phase 6 baseline) + new shared-API tests
- cli's remaining tests (whatever doesn't move to shared) still pass
- mcp's tests still pass

### 7.5 — Acceptance

- [ ] Total test count ≥ pre-refactor count
- [ ] Zero new failures
- [ ] Phase 6's `retriever-defaults.test.ts` is in the shared package, not cli

---

## Phase 8 — Build/CI consolidation

**Effort:** 1d.

### 8.1 — Native dep dedup

Move from each consumer's `package.json` to the shared package:
- `@xenova/transformers` (or whatever embedder needs)
- `lancedb`
- `tree-sitter`, `tree-sitter-typescript`, `tree-sitter-python`, etc.
- `graphology` (the graph library)

Remove from cli + mcp `package.json`. Run lockfile regen once.

Expected lockfile churn: ~500-2,000 lines auto-generated. Review focuses on: are versions consistent across the three packages now.

### 8.2 — mcp's `build.mjs` externalization

```js
// packages/code-search-mcp/build.mjs
esbuild.build({
  // ...
  external: [...nodeBuiltins, '@anvil/knowledge-core'],
});
```

Verifies mcp's dist no longer bundles the shared code (a flag that things are wired right).

### 8.3 — CI matrix

`.github/workflows/ci.yml` (or wherever): add `@anvil/knowledge-core` to:
- build job's matrix
- test job's matrix
- lint job's matrix

If using `tsc -b` with project references, the root build covers all three packages already.

### 8.4 — Validation

- Fresh `npm ci` from root succeeds
- `npm -w <each-package> run build` succeeds
- `npm test` (root) green
- mcp's dist size measurably smaller (sanity check that externalization worked)

### 8.5 — Acceptance

- [ ] Native deps appear in exactly one `package.json`
- [ ] CI matrix includes the new package
- [ ] Lockfile regenerated and committed

### 8.6 — Risks

- **Lockfile merge conflicts** if main has moved during the refactor. Mitigation: regen lockfile in the very last commit before merge.
- **Native deps version mismatch** if cli or mcp had pinned to older `lancedb` etc. Mitigation: pick the highest pinned version of each, run all tests.

---

## Phase 9 — Docs + ADR

**Effort:** 0.5d.

### 9.1 — Deliverables

- `packages/knowledge-core/README.md` — what it is, how to consume it, API surface
- `KNOWLEDGE-CORE-ADR.md` — why we did this, what was decided in Phase 0, what was hard (Phase 0 scaffolds the initial version)
- Update root `CLAUDE.md` if it mentions package layout
- Update `TOKEN-OPTIMIZATION-PLAN.md` "Files touched" section so future phases know where the truth lives

### 9.2 — Acceptance

- [ ] ADR explains the `project-graph-builder` decision
- [ ] README is enough for a fresh contributor to consume the package

---

## Cross-cutting: validation strategy

After each phase:
1. `npm ci` from root (catches lockfile + workspace issues)
2. `tsc --build` from root (catches type errors across project refs)
3. `npm test` from each package
4. Smoke: index a small fixture project, run a known query, check top-1 chunk
5. Phase-specific checks (per acceptance section)

---

## Cross-cutting: order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit/decisions | Lock the architectural calls before any move |
| 1 | Scaffold + 1 file | Validate the package mechanism with zero risk |
| 2 | True clones | Highest-LOC-per-effort; proves bulk move pattern |
| 3 | Mild drift | Easier merges before harder ones; surfaces DI patterns we'll reuse in 4 |
| 4 | Real drift | Now we know the shape; tackle the hard merges with confidence |
| 5 | project-graph-builder | The architectural one — best done after the simpler stuff has tested the package shape |
| 6 | Importer cleanup | Mechanical; do once everything is in place |
| 7 | Tests | Move + add tests; this is also when we verify nothing regressed |
| 8 | Build/CI | Native dep dedup is risky enough to deserve its own phase |
| 9 | Docs | Last so the docs reflect what actually shipped |

---

## Summary table

| Phase | Effort | LOC moved | LOC written | Risk |
|---|---|---|---|---|
| 0 — Audit | 0.5d | 0 | ~50 (ADR) | low |
| 1 — Scaffold | 0.5d | 218 | ~150 | low |
| 2 — True clones | 1d | 5,503 | ~50 | low |
| 3 — Mild drift | 1d | 2,147 | ~150 | medium |
| 4 — Real drift (3 sub) | 2d | 2,098 | ~400 | high |
| 5 — Project graph | 1d | ~800 (net reduction) | ~300 | high |
| 6 — Importers | 0.5d | 0 | ~80 | low |
| 7 — Tests | 1d | ~600 | ~150 | medium |
| 8 — Build/CI | 1d | 0 | ~150 | medium |
| 9 — Docs | 0.5d | 0 | ~150 | low |
| **Total** | **~9d** | **~11,366** | **~1,680** | — |

Plus the 30% risk premium from the cost analysis: realistic calendar **~12 days for a solo eng**, or **~10-12 conversation turns** if executed phase-by-phase like the optimization plan.

---

## Failure modes to watch

1. **ESM workspace resolution** — Phase 1 catches this if it's going to bite. If it does, fix once at the package boundary, not 14 times during Phase 2.
2. **Native deps doubled** — if `lancedb` / `tree-sitter-*` install once at the shared package but consumers still have them in their own `package.json`, you get two installs in `node_modules` and runtime chaos. Phase 8 is a hard gate on this.
3. **mcp esbuild bundling shared code** — if you forget the `external` entry, mcp's dist ships the shared code inline, defeating the dedup. Sanity check by comparing dist size before/after.
4. **Embedder behavior drift** — silently degrades retrieval quality without breaking tests. Smoke test in Phase 3.6 is mandatory.
5. **`project-graph-builder` schema mismatch** — node attribute names diverge between cli and mcp. Phase 5.7 mitigation: dump pre-refactor JSON from both, diff post-refactor.
6. **Phase 6 (TOKEN-OPTIMIZATION) tests regress** — `retriever-defaults.test.ts` pins critical defaults. If they get lost during the move, the cost saving from optimization Phase 6 is silently reverted. Acceptance gate in this plan's Phase 2 + Phase 7.

---

## Glossary

- **Shared package:** `@anvil/knowledge-core`, the new workspace package this plan creates.
- **Consumer:** any package that imports from the shared package — currently `@esankhan3/anvil-cli` and `@anvil-dev/code-search-mcp`.
- **True clone:** file with diff ≤ 5 lines between cli and mcp trees.
- **Real drift:** file with diff 100-500 lines, requiring careful 3-way merge.
- **DI seam:** a constructor parameter or factory option used to surface what was previously a hardcoded difference between cli and mcp versions of a file.
- **Optimization Phase N:** refers to phases in `TOKEN-OPTIMIZATION-PLAN.md` (separate plan, Phases 0–7 already shipped).
