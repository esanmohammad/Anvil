# ADR 001 — Extract `@anvil/knowledge-core` shared workspace package

- **Status:** Proposed
- **Date:** 2026-04-28
- **Deciders:** @esanmohammad
- **Implements:** Phase 0 of [`KNOWLEDGE-CORE-EXTRACT-PLAN.md`](./KNOWLEDGE-CORE-EXTRACT-PLAN.md)

## Context

`packages/cli/src/knowledge/` and `packages/code-search-mcp/src/core/` host two near-clone implementations of the same indexing + retrieval stack (chunking, AST/tree-sitter, embedders, vector store, BM25, hybrid retrieval, reranker, project graph, structural hashing). Today, every cross-cutting change (e.g. Phase 6 of `TOKEN-OPTIMIZATION-PLAN.md`) has to land in two trees, and the trees drift silently between releases. The extract plan exists to collapse these into one consumable package.

This ADR locks the architectural calls **before** any code move so Phases 1–9 are mechanical.

---

## Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| D1 | Package name | `@anvil/knowledge-core` | Internal-only; matches the `@anvil-dev` / `@esankhan3` naming already in the repo. |
| D2 | Module type | ESM only (`"type": "module"`) | Both consumers are ESM today; mixing CJS would force interop shims. |
| D3 | Build target | `tsc -b` emit to `dist/`, project references from root | Matches cli; mcp's file-by-file esbuild already imports by package name, so no bundler change required (see audit §4). |
| D4 | `project-graph-builder` strategy | Extract `ProjectGraphCore` base class + thin cli/mcp subclasses | Option B (winner-take-all) loses ~250 LOC of cli features; option C (no merge) defeats the refactor entirely. |
| D5 | `context-assembler.ts` placement | **Stays cli-only** | mcp does not import it (audit §3 confirms zero references). Hoisting it would force mcp to depend on prompt-formatting machinery it never calls. |
| D6 | Config-path resolution | Constructor-injected `resolveDataPath(project: string): string` | cli uses `~/.anvil/knowledge-base/<project>`; mcp uses `process.env.CODE_SEARCH_DATA_DIR ?? ~/.anvil/...`. Inject one function instead of forking the file. |
| D7 | Artifact strategy for mcp | No bundler change; mcp's `build.mjs` already compiles file-by-file via esbuild and imports `@anvil/knowledge-core` by name at runtime | The plan's "esbuild externalize" step is a no-op against today's build script. Only revisit if mcp ever switches to a bundled output. |
| D8 | Lockfile strategy | One regen at end of refactor (Phase 8) | Avoid lockfile churn during phases 1–7. |
| D9 | Pre-existing `lancedb` bug | Add `@lancedb/lancedb` to the shared package's deps in Phase 8; remove the dynamic `import()` indirection in `vector-store.ts` | cli's `vector-store.ts` calls `await import('@lancedb/lancedb')` but cli's `package.json` doesn't declare the dep — works only via host resolution (audit §4). Centralizing in shared package fixes this. |
| D10 | `env-config.ts` | Stays mcp-only | mcp-specific server config (`CODE_SEARCH_DATA_DIR`, port, transport). No cli usage. |
| D11 | `graph-query.ts` and `project-graph-builder-legacy.ts` | Move with the graph cluster (Phase 5); `*-legacy.ts` deleted | Legacy file is what mcp currently uses; once `ProjectGraphCore` lands, neither consumer needs it. |

---

## Consequences

### Positive

- One file edit per future cross-cutting change instead of two.
- `~5,500 LOC` of true-clone code disappears from each consumer's dist.
- Native deps (`@lancedb/lancedb`, `web-tree-sitter`, `tree-sitter-wasms`, `graphology*`) install once at the shared package.
- The pre-existing `lancedb` cli bug (D9) gets fixed as a side-effect.

### Negative

- A workspace package adds one more `package.json` and one more `tsconfig.json` to maintain.
- Future contributors need to know which tree owns what (mitigated by the README and updated plan files).
- Phase 4–5 carry real merge risk on `claude-runner.ts`, `indexer.ts`, `ast-graph-builder.ts`, and `project-graph-builder.ts`.

### Neutral

- ESM-only is already the status quo; not a real shift.

---

## Alternatives considered

1. **Option B — winner-take-all on `project-graph-builder.ts`:** drop cli's modern version, keep mcp's lean one. Rejected: loses ~250 LOC of cli-only features (project summary rendering, prompt formatting, cost estimation) that `pipeline/orchestrator.ts` depends on.
2. **Option C — leave `project-graph-builder.ts` un-merged in both consumers:** would mean the refactor leaves the single largest pair of duplicated logic untouched. Rejected: defeats most of the dedup benefit.
3. **Single monolithic shared package owning *everything* knowledge-adjacent:** would pull `context-assembler.ts` and `env-config.ts` in too, forcing each consumer to depend on machinery it doesn't use. Rejected per D5/D10.
4. **Symlink `cli/src/knowledge/` ↔ `mcp/src/core/`:** brittle on Windows, breaks `tsc` project graph, hides the duplication problem rather than solving it.

---

## Audit (Phase 0.2 deliverables)

### §1. File inventory + diff buckets (measured 2026-04-28)

Diff line counts use `diff -u` against unified output (4 header lines + ~3 lines per actual change). Bucket boundaries:

- **Clone:** diff ≤ 30 lines (≤ ~7 actual line changes)
- **Mild drift:** 30 < diff ≤ 150
- **Real drift:** 150 < diff ≤ 500
- **Heavy drift:** diff > 500 (effectively two implementations)

#### True clones — 14 files, 5,733 LOC

| File | cli LOC | mcp LOC | diff |
|---|---|---|---|
| `git-diff.ts` | 167 | 167 | 0 |
| `query-classifier.ts` | 256 | 256 | 0 |
| `structural-hasher.ts` | 425 | 425 | 0 |
| `types.ts` | 218 | 218 | 0 |
| `graph-metrics.ts` | 332 | 332 | 8 |
| `cross-repo-detector.ts` | 1126 | 1126 | 10 |
| `query-router.ts` | 355 | 355 | 10 |
| `chunker.ts` | 534 | 534 | 11 |
| `retriever.ts` | 366 | 366 | 11 |
| `semantic-edge-detector.ts` | 221 | 221 | 11 |
| `workspace-detector.ts` | 612 | 612 | 11 |
| `config.ts` | 96 | 100 | 13 |
| `tree-sitter-parser.ts` | 786 | 783 | 15 |
| `file-walker.ts` | 227 | 227 | 20 |

#### Mild drift — 6 files, 2,242 LOC (cli) / 2,261 LOC (mcp)

| File | cli LOC | mcp LOC | diff | Likely cause |
|---|---|---|---|---|
| `vector-store.ts` | 291 | 307 | 31 | Storage path resolution |
| `service-mesh-inferrer.ts` | 419 | 415 | 53 | Path detection heuristics |
| `repo-profiler.ts` | 549 | 546 | 59 | Logging style |
| `rag-evaluator.ts` | 292 | 294 | 103 | Eval set paths / scoring |
| `embedder.ts` | 380 | 444 | 110 | Provider list / type-import suffix `.js` vs none (mcp dropped extensions on type-only imports) |
| `reranker.ts` | 216 | 315 | 123 | TOKEN-OPT Phase 6 landed only on cli; mcp tree is older |

#### Real drift — 3 files, 2,098 LOC (cli) / 2,031 LOC (mcp)

| File | cli LOC | mcp LOC | diff |
|---|---|---|---|
| `indexer.ts` | 703 | 776 | 311 |
| `claude-runner.ts` | 232 | 247 | 324 |
| `ast-graph-builder.ts` | 1163 | 1008 | 403 |

#### Heavy drift — 1 file, 1,011 LOC across two impls

| File | cli LOC | mcp LOC | diff |
|---|---|---|---|
| `project-graph-builder.ts` | 776 | 235 | 976 |

cli also has `project-graph-builder-legacy.ts` (235 LOC) — appears to be the same code mcp ships as `project-graph-builder.ts`. Phase 5 deletes the legacy file and consolidates via `ProjectGraphCore`.

#### Single-tree files (do not move)

- **cli only:** `context-assembler.ts` (292), `graph-query.ts` (101), `project-graph-builder-legacy.ts` (235), `index.ts` (25, the public API barrel)
- **mcp only:** `env-config.ts` (174)

#### Roll-up

- Paired files: 24 (14 clone + 6 mild + 3 real + 1 heavy)
- Total paired LOC: 11,084 (cli side) + 11,038 (mcp side) ≈ **22,122 LOC duplicated logic**
- Plus 4 cli-only knowledge files (653 LOC) and 1 mcp-only file (174 LOC) staying put
- **The plan's earlier estimate of 11,395 + 10,483 = 21,878 LOC tracks reality within 1%.**

#### Plan corrections (numbers in `KNOWLEDGE-CORE-EXTRACT-PLAN.md` to patch in Phase 9 docs sweep)

The plan's per-file diff numbers were estimates; measured numbers are higher (because `diff -u` was actually used here). Buckets unchanged, individual numbers to update:

- `chunker.ts` 2 → 11
- `ast-graph-builder.ts` 313 → 403
- `claude-runner.ts` 253 → 324
- `embedder.ts` 72 → 110
- `indexer.ts` 205 → 311
- `project-graph-builder.ts` 935 → 976
- `reranker.ts` 101 → 123
- `service-mesh-inferrer.ts` 14 → 53
- `repo-profiler.ts` 17 → 59
- `rag-evaluator.ts` 24 → 103

### §2. Public API surface (cli's barrel — must be preserved exactly)

From `packages/cli/src/knowledge/index.ts`:

```ts
export * from './types.js';
export * from './config.js';
export { ProjectGraphBuilder } from './project-graph-builder.js';
export {
  assembleKnowledgeContext,
  assembleLayeredContext,
  assembleProjectIdentity,
  getContextLayerForStage,
  getTokenBudgetForLayer,
  formatChunkForPrompt,
} from './context-assembler.js';
export type { ContextLayer, LayeredContextConfig } from './context-assembler.js';
export {
  buildProjectGraph,
  loadProjectGraph,
  loadProjectSummary,
  getProjectGraphStatus,
  estimateProjectGraphCost,
  renderProjectSummary,
  formatProjectGraphForPrompt,
} from './project-graph-builder.js';
export { walkDir, langFromExt, extractImports, extractNamedImports, SOURCE_EXTENSIONS, SKIP_DIRS } from './file-walker.js';
```

After extract, cli's `index.ts` becomes:

```ts
// re-export shared
export * from '@anvil/knowledge-core';
// re-export cli-only
export * from './context-assembler.js';
// re-export cli's ProjectGraphBuilder subclass (preserves the name)
export { ProjectGraphBuilder, buildProjectGraph, loadProjectGraph, /* ... */ } from './project-graph-builder.js';
```

The `ProjectGraphBuilder` symbol must keep its current name and signature so `pipeline/orchestrator.ts` doesn't move.

### §3. External importers

#### cli — 1 file

| File | Imports |
|---|---|
| `packages/cli/src/pipeline/orchestrator.ts` | `context-assembler.js` (cli-only, see D5) |

**There are zero cli importers that need to change post-extract.** Phase 6's cli work is empty.

#### mcp — 7 files

| File | Imports |
|---|---|
| `src/server.ts` | `./core/config.js`, `./core/indexer.js`, `./core/env-config.js` |
| `src/transports/http-transport.ts` | `../core/env-config.js` (mcp-only, stays) |
| `src/middleware/auth.ts` | `../core/env-config.js` (mcp-only, stays) |
| `src/resources/resources.ts` | `../core/config.js`, `../core/repo-profiler.js` |
| `src/tools/index-tools.ts` | `../core/indexer.js` |
| `src/tools/profile.ts` | `../core/repo-profiler.js`, `../core/indexer.js` |
| `src/tools/search.ts` | `../core/indexer.js` |
| `src/tools/graph.ts` | `../core/config.js` |

8 importer-files total once `server.ts` is counted once. Each needs one or two import-path swaps (`../core/foo.js` → `@anvil/knowledge-core/foo.js`). `env-config.js` imports stay untouched (mcp-only file).

### §4. Native dependencies — current state

#### cli `package.json` runtime deps relevant to knowledge

| Dep | Version | Used by | Notes |
|---|---|---|---|
| `graphology` | 0.26.0 | graph-metrics, ast-graph-builder, project-graph-builder | shared with mcp |
| `graphology-communities-louvain` | 2.0.2 | project-graph-builder | shared |
| `graphology-metrics` | 2.4.0 | graph-metrics | shared |
| `graphology-types` | 0.24.8 | graph-metrics | shared (peer-style) |
| `tree-sitter-wasms` | 0.1.13 | tree-sitter-parser | shared |
| `web-tree-sitter` | 0.26.8 | tree-sitter-parser | shared |
| `yaml` | ^2.7.1 | config, factory | cli-only |
| **MISSING:** `@lancedb/lancedb` | — | vector-store, indexer | **cli imports it dynamically but doesn't declare the dep.** Pre-existing bug — fix in Phase 8 (D9). |

cli also lists `react`, `react-dom`, `react-force-graph-2d`, `lucide-react`, `ws` — these belong to the bundled dashboard build and are not knowledge-core deps. They stay in cli.

#### mcp `package.json` runtime deps relevant to knowledge

| Dep | Version | Used by | Notes |
|---|---|---|---|
| `@lancedb/lancedb` | 0.27.2 | vector-store, indexer | move to shared |
| `graphology` | 0.26.0 | graph-metrics, ast-graph-builder, project-graph-builder | move to shared |
| `graphology-communities-louvain` | 2.0.2 | project-graph-builder | move to shared |
| `graphology-metrics` | 2.4.0 | graph-metrics | move to shared |
| `graphology-types` | 0.24.8 | graph-metrics | move to shared |
| `tree-sitter-wasms` | 0.1.13 | tree-sitter-parser | move to shared |
| `web-tree-sitter` | 0.26.8 | tree-sitter-parser | move to shared |
| `@modelcontextprotocol/sdk` | ^1.29.0 | server, transports | mcp-only |

**No `@xenova/transformers`** anywhere — the plan's mention of it was incorrect. Embedders are HTTP-based (Mistral codestral, Voyage, Cohere — all behind `fetch()`) with optional `OllamaEmbedder` (also HTTP). No JS-side ML runtime.

**Tree-sitter is grammar-via-wasm** (`tree-sitter-wasms` ships compiled grammar bundles + `web-tree-sitter` is the wasm runtime) — there are **no** native `tree-sitter-typescript` / `tree-sitter-python` modules to align across consumers. Simpler to dedup than Phase 8.1 implied.

#### Versions are already aligned

Every shared dep is at the same version in both `package.json` files. Phase 8 lockfile regen has nothing to reconcile.

### §5. Build script implications

mcp's `build.mjs` (47 LOC, file-by-file `npx esbuild ... --format=esm --platform=node`) does not bundle. Each `.ts` file becomes a `.js` file with its imports preserved as bare-specifier strings (rewritten to `.js` by the post-pass). At runtime, Node resolves `@anvil/knowledge-core` from `node_modules/`.

**Therefore D7:** the plan's `external: ['@anvil/knowledge-core']` esbuild option is a no-op against today's build — there is no bundler step that would inline shared code. The shared package gets imported by name, period.

If mcp ever switches to bundled output (single-file `dist/index.js`), revisit Phase 8.2.

### §6. Test inventory

cli `__tests__` (in `packages/cli/src/knowledge/__tests__/`):

```
chunker.test.ts
claude-runner.test.ts
query-classifier.test.ts
structural-hasher.test.ts
retriever-defaults.test.ts   ← TOKEN-OPT Phase 6 contract
```

5 test files — Phase 7 of the extract plan moves these to `packages/knowledge-core/src/__tests__/`. mcp has no analogous knowledge tests (verified by `ls packages/code-search-mcp/src/core/`, no `__tests__/`).

---

## Acceptance — Phase 0

- [x] Decisions written to ADR (this document, §Decisions)
- [x] File inventory with LOC + diff buckets (audit §1)
- [x] Public symbol list for cli's barrel (audit §2)
- [x] External importer list for both packages (audit §3)
- [x] Native dep list for both `package.json` files (audit §4)
- [x] Plan corrections itemized (audit §1, last subsection)
- [ ] **Reviewer sign-off** ← only remaining acceptance gate; awaiting @esanmohammad

## Rollback

N/A — Phase 0 is doc-only. Reverting this commit deletes one file.

## Next phase

[Phase 1 — Scaffold + proof-of-life](./KNOWLEDGE-CORE-EXTRACT-PLAN.md#phase-1--scaffold--proof-of-life). Adds `packages/knowledge-core/` with package.json, tsconfig.json, and a single `types.ts` move. ~218 LOC moved, ~150 LOC written.

---

## Appendix — corrections to apply when patching `KNOWLEDGE-CORE-EXTRACT-PLAN.md`

1. **Diff numbers in §1** above (10 files) — update Phase 2 / Phase 3 / Phase 4 tables.
2. **Phase 8.1 native deps:** drop `@xenova/transformers` from the list; keep `@lancedb/lancedb`, `web-tree-sitter`, `tree-sitter-wasms`, and the `graphology*` family. Note that no `tree-sitter-<lang>` native modules exist — grammars are wasm via `tree-sitter-wasms`.
3. **Phase 8.2 mcp esbuild externalization:** strike or rewrite. Today's build is file-by-file with no bundling, so externalize is a no-op. Action item is "verify dist still imports `@anvil/knowledge-core` by name and Node resolves it at runtime."
4. **Phase 6 cli importer cleanup:** zero work for cli; only the 7 mcp importers need touching (`server.ts` counted as one importer-file containing 3 imports).
5. **Phase 9 D9 entry:** add the cli `lancedb` declaration as a side-effect fix.
