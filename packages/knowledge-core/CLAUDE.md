# CLAUDE.md — `@esankhan3/anvil-knowledge-core`

Guidance for Claude Code when working inside `packages/knowledge-core/`. The
shared knowledge stack consumed by `@esankhan3/anvil-cli` and
`@esankhan3/code-search-mcp`. Owns chunking, AST parsing, embeddings, vector
store, hybrid retrieval, project graph, structural hashing, repo profiling.

## What this package owns

### Chunking + walking + AST
- `chunkRepo` / `chunkChangedFiles` (`src/chunker.ts`) — splits files at
  definition boundaries: from tree-sitter for the 8 parsed languages
  (top-level definitions and class members, `parentEntity` = the class;
  functions nested in functions stay inside), regex patterns otherwise. A
  definition's leading comments / decorators belong to its chunk. Chunk
  ids are `hash(repoName, filePath, startLine, endLine)` (`CHUNK_ID_VERSION`
  = 2). `chunkChangedFiles` returns the whole repo's `fileIndex` (cached
  entries minus the diffed paths, plus the re-chunked ones).
- `walkDir` / `langFromExt` / `extractImports` / `extractNamedImports` /
  `isSourceFile` / `isIgnoredPath` (`src/file-walker.ts`) — directory walker
  (built-in skip dirs + `chunking.ignorePatterns` path segments), language
  detection, import extraction (`import … from` and `require(…)`).
- `initTreeSitter` / `parseFile` / `supportedLanguages`
  (`src/tree-sitter-parser.ts`) — `web-tree-sitter` WASM parsing for TS,
  JS, TSX, Go, Python, Rust, Java, PHP; grammars from
  `@vscode/tree-sitter-wasm`, queries compiled once per grammar. A grammar
  that fails to load is reported once and callers fall back to regex.
- `getAllChanges` / `getChangedFilesList` / `getDeletedFilesList`
  (`src/git-diff.ts`) — `git diff --name-status` parsing for incremental
  indexing, filtered to the walker's `isSourceFile`. Returns
  `{ added, modified, deleted, renamed, fallbackToFull }`.

### Graph
- `buildAstGraph` / `incrementalGraphUpdate` / `generateGraphReport`
  (`src/ast-graph-builder.ts`) — per-repo entity + import graph with
  6-phase build (workspace nodes, entity extraction, import resolution,
  type refs, call disambiguation, inheritance, contains edges). Node ids
  are `file::entity`, class members `file::Class.member` (label = the
  member name) so same-name methods of different classes stay distinct.
- `createSystemGraphSqliteWriter` / `openSystemGraphStore`
  (`src/graph-store.ts`) + `getGraphStore` (`src/storage/resolve.ts`) — the
  merged system graph. `buildKB` streams each repo's nodes/edges and the
  cross-repo edges into `system_graph.sqlite` (better-sqlite3, else
  `node:sqlite`); `GraphStore` serves slice queries (callers, dependencies,
  dependents, cross-repo edges, neighbors) to the retriever's graph expansion
  and the MCP graph tools. Edges keep `type`, `confidence` and (cross-repo)
  `evidence`. Exact name resolution is case-sensitive and wildcard-free and
  accepts a full `repo::file::entity` id; `dependents` treats
  `SYMMETRIC_EDGE_TYPES` (shared topic / table / key / bucket / type /
  constant / env var / npm dep) as two-way; `crossRepoEdges` includes
  same-repo `workspace-dep` edges.
- `ProjectGraphBuilder` (`src/project-graph-builder-core.ts`) — in-memory
  `graphology` directed multi-graph with Louvain communities; namespaces
  nodes as `<repo>::<id>`. `buildKB` uses it only when no SQLite driver
  loads (then writes `system_graph_v2.json`).
- `buildProjectGraph` / `loadProjectGraph` / `loadProjectSummary` /
  `getProjectGraphStatus` / `estimateProjectGraphCost`
  (`src/project-graph-builder.ts`) — LLM-powered semantic project graph,
  built only by the CLI `graph` command. Its cross-repo edge input comes
  from the system graph store (`system_graph.sqlite`, or the JSON
  fallback).
- `detectCrossRepoEdges` (`src/cross-repo-detector.ts`) — 14 strategies,
  split into `extractCrossRepoSignals(repoPath)` (per-repo tree scan, runs in
  the worker while the clone exists, persisted as `<repo>/signals.json`) +
  `correlateCrossRepoEdges(signals, workspaceMaps)` (pure data join — partial
  cycles correlate stored signals without cloning unchanged repos)
  for inter-repo edges (npm/workspace deps, shared types, env vars, shared
  events/topics, HTTP routes, gRPC services, DB schemas, Redis keys, S3
  buckets, OpenAPI contracts, docker-compose + k8s service refs — both
  emitted as `http` — and shared constants). Signal file paths are
  repo-relative (`CROSS_REPO_SIGNALS_VERSION` = 2), so edge endpoints share
  the code graph's file keys. HTTP clients include template-literal URLs
  (`${…}` → `:param`); env vars come from `.env` templates and env reads in
  code (TS/JS, Go, Python, Java), minus runtime generics and vars read by
  more than max(5, 25%) of repos.
- `detectSemanticEdges` (`src/semantic-edge-detector.ts`) — LLM-inferred
  edges between repos. Exported only; `buildKB` doesn't call it.
- `findRelatedNodes` + helpers (`src/graph-query.ts`) — graph traversal.
- `graph-metrics.ts` — quality reports.

### Workspace + structural
- `detectWorkspace` / `detectTsconfigAliases` (`src/workspace-detector.ts`)
  — universal monorepo discovery via declarative manifest registry. Adds
  one ecosystem = one entry.
- `computeStructuralHash` / `computeStructuralHashes` /
  `deduplicateByStructure` (`src/structural-hasher.ts`) — canonicalize
  source (strip comments, collapse whitespace, normalize identifiers),
  SHA-256 the result. Used for `@anvil/memory-core` drift detection; the
  indexer does not dedup chunks (every repo keeps its own copy of shared
  code — retrieval collapses byte-identical results at query time).

### Retrieval
- `HybridRetriever` (`src/retriever.ts`) — vector ⫽ BM25 ⫽ literal tiers
  (entityName exact/substring for bare identifiers, exact phrase for
  multi-token queries) → weighted RRF (`CODE_SEARCH_RRF_K`, default 10) +
  exact-symbol pin + dedupe + per-file cap → one-hop AST expansion →
  optional cross-encoder rerank. Expansion runs only when a reranker is
  configured or the fused pool can't fill `maxChunks`; its chunks are
  appended after the fused pool.
- `VectorStore` (`src/vector-store.ts`) — LanceDB-backed; supports
  vector + FTS search, file-level deletes, FTS index rebuild, IVF vector
  index build / in-place retrain (`ensureVectorIndex`), `vectorIndexState`.
- `maintainVectorIndex` / `planVectorIndex` / `readVectorIndexHealth`
  (`src/vector-index-maintenance.ts`) — write-path vector-index lifecycle:
  build at `minRows`, retrain once rows written since the last training
  reach `trainedRows × CODE_SEARCH_VECTOR_RETRAIN_RATIO` (default 1; 0
  disables), on an index-type config change, or once for an index with no
  training record; then `optimize()`. Records training + health
  (unindexed rows) in `vector_index.json`, surfaced via `getStats().vectorIndex`.
- `createEmbeddingProvider` (`src/embedder.ts`) — 6 providers:
  `codestral` / `voyage` / `openai` / `ollama` / `gemini-oauth` /
  `openai-compatible`, plus `auto`.
- `createReranker` (`src/reranker.ts`) — 4 providers: `ollama` (default,
  model `qwen2.5-coder:7b`), `cohere`, `voyage`, `openai-compatible`.
  `none` → `null`.
- `classifyQuery` (`src/query-classifier.ts`) — `identifier` / `path` /
  `error-code` / `natural-language` / `mixed`; returns adaptive
  `{ vector, bm25, graph }` weights (the retriever reads `vector` / `bm25`;
  `graph` is unused).
- `QueryRouter` / `createQueryRouter` (`src/query-router.ts`) — embeds
  repo profiles + query, picks `'all'` or `'filtered'` strategy. The
  retriever consults it only when `CODE_SEARCH_AUTO_ROUTE=1` (off by
  default: its hard repo pre-filter cost exact-symbol recall).

### LLM-driven
- `profileProject` / `loadProfile` / `loadAllProfiles` (`src/repo-profiler.ts`)
  — fingerprint files → LLM → `RepoProfile`. Cached by fingerprint hash.
  `buildKB` runs it only when `isLlmAvailable()`.
- `inferServiceMesh` (`src/service-mesh-inferrer.ts`) — Phase A
  deterministic endpoint matching (similarity-scored) + Phase B LLM
  gap-fill for orphan repos. `buildKB` runs it only when `isLlmAvailable()`.
- `runLLM` / `runClaude` / `runGemini` / `isLlmAvailable` /
  `resetLlmConfig` (`src/claude-runner.ts`) — **deprecated re-export**
  of `@anvil/agent-core`'s `single-shot.ts`. Kept so existing importers
  (repo-profiler, service-mesh-inferrer, rag-evaluator, indexer) keep
  working without rewrites.
- `rag-evaluator.ts` — generate answers from retrieved context, judge
  quality. Exported only; nothing in the repo calls it.

### Indexer entry points
- `KnowledgeIndexer` class (`src/indexer.ts`) — `buildKB` (chunks +
  graph + edges, no embedding) + `embedChunks` (incremental embedding)
  + `indexProject` (both).
- `discoverRepos(directoryPath)` — zero-config repo discovery (single
  git repo or scan-subdirs).
- `buildKBFromPath` / `embedFromPath` / `indexFromPath` — path-based
  facades. Each accepts an optional `config: KnowledgeConfig` in `opts`;
  when omitted, falls back to `loadKnowledgeConfig(project)`. Consumers
  (cli, dashboard, code-search-mcp) are expected to pass their fully-
  resolved config explicitly — see boundary rules in
  `docs/CODE-SEARCH-MCP-STANDALONE-PLAN.md`.
- `getRetriever(project, configOverride?)` — resolved `HybridRetriever`,
  cached per project + embedding + retrieval settings. On open, walks
  `<basePath>/<repo>/index_meta.json` and **hard-errors** if the recorded
  `embeddingProvider`, `embeddingModel` or `embeddingDimensions` differs
  from the resolved embedder (silent space mismatch returns garbage). A
  cached retriever re-checks `index_generation` every
  `CODE_SEARCH_RETRIEVER_TTL_MS` (default 30 s; 0 disables the check —
  `retrieverFreshnessMs()`); `invalidateRetriever(project)` drops it now.

### Config (P0–P2)
- **`KnowledgeConfig`** — typed config struct. `embedding` is a
  `EmbeddingProviderConfig` (`{provider, model?, dimensions?, apiKey?,
  baseUrl?, ollamaHost?}`), `chunking` is `{maxTokens, contextEnrichment,
  ignorePatterns?}` (path segments the indexer never reads), `retrieval.reranker` is a
  `RerankerProviderConfig` struct (`{provider, model?, apiKey?, baseUrl?,
  timeoutMs?}`) — back-compat: a bare string id is accepted and normalized
  via `normalizeRerankerConfig`. Provider unions
  (`EmbeddingProviderId`, `RerankerProviderId`) match the factory branches
  one-for-one (`provider-unions.test.ts` pins this).
- `loadKnowledgeConfig(project)` — yaml from
  `~/.anvil/projects/<project>/factory.yaml` (or `project.yaml`), then
  overlays `CODE_SEARCH_*` env vars via `applyEnvOverrides` — env wins over
  the yaml / passed config for every field (issue #6 fix,
  pinned by `env-overrides.test.ts`). Recognized env: `EMBEDDING_PROVIDER`,
  `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `EMBEDDING_API_KEY`,
  `EMBEDDING_BASE_URL`, `OLLAMA_HOST`, `RERANKER_PROVIDER`,
  `RERANKER_MODEL`, `RERANKER_API_KEY`, `RERANKER_BASE_URL`,
  `RETRIEVAL_MAX_CHUNKS`, `RETRIEVAL_MAX_TOKENS`, `AUTO_INDEX`.
- `cloneKnowledgeConfig(c)` — deep clone used by every override layer.
- `applyEnvOverrides(c)` — pure transformer, never mutates.
- `getKnowledgeBasePath(project)` — `CODE_SEARCH_DATA_DIR` →
  `ANVIL_HOME/knowledge-base` → `~/.anvil/knowledge-base`.
- `DEFAULT_CONFIG` — `embedding.provider='auto'`, `dimensions=1024`,
  `chunking.maxTokens=500`, `retrieval.maxChunks=8`, `maxTokens=12000`,
  `hybridWeights={vector:0.5, bm25:0.3, graph:0.2}`,
  `reranker={provider:'ollama'}` (now a struct), `autoIndex=true`.

### Provider classes — env reads are deprecated (P2)
Every embedder + reranker constructor takes `apiKey`/`baseUrl`/`ollamaHost`/
`timeoutMs` directly. The classes still fall back to documented env vars
(`MISTRAL_API_KEY`, `VOYAGE_API_KEY`, `OPENAI_API_KEY`, `COHERE_API_KEY`,
`OLLAMA_HOST`, `CODE_SEARCH_EMBEDDING_BASE_URL` / `_MODEL` / `_API_KEY`,
`CODE_SEARCH_RERANKER_BASE_URL` / `_MODEL` / `_API_KEY`,
`RERANKER_MODEL`) for one release cycle, but each first read emits a
one-shot `[knowledge-core] DEPRECATED:` stderr warning via
`deprecatedEnv()`. Library env reads are removed in 1.0; consumers must
pass credentials through the config struct.

### P6 retrieval primitives (exported, not wired)
- `bm25-tokenizers.ts` — `tokenizerFor(language)`; per-language
  tokenizers for `typescript` / `javascript` / `python` / `go` / `rust` /
  `java` / `php` capture lang-significant tokens
  (Rust `'static`, Python `__init__`, Go receivers, Java `@Annotation`,
  PHP `$variable`). Unknown languages fall through to `genericTokenize`.
- `query-expander.ts` — `expandQuery(query, classification, llm, opts)`
  returns `{queries, weights}`. HyDE-lite: skips `identifier`/`path`/
  `error-code` types unless `forceExpand`; LRU 128 / 10-min cache; uses
  any `LlmClient` adapter. `fuseRrf(rankings, weights, k=60)` merges
  expanded retrievals.
- `rerank-cache.ts` — `RerankCache` on-disk LRU keyed by
  SHA(query|chunkId|model). Default 50k entries, debounced 1s
  serialization.

None of the three is wired into `HybridRetriever` — the building blocks are
public so future surgery is local.

Public barrel: `src/index.ts`. Note: `tree-sitter-parser` re-exports are
explicit (not `*`) because it had a `computeStructuralHash` symbol that
collided with `structural-hasher`'s.

## Build + test

```sh
npm -w @esankhan3/anvil-knowledge-core run build   # tsc -b → dist/
npm -w @esankhan3/anvil-knowledge-core test        # tsc -b + node --test on dist/__tests__/
npm -w @esankhan3/anvil-knowledge-core run dev     # tsc -b --watch
```

Tests live in `src/__tests__/*.test.ts` and run from `dist/__tests__/`.

## Conventions

### Comment hygiene — delete stale comments when you touch code

Every comment must be true of the code **as it currently stands**. When a change makes a comment false, irrelevant, or obsolete, update or delete it **in the same edit** — this is not optional.
- Delete references to removed symbols / functions / files (e.g. a comment naming a deleted helper).
- Delete "this used to…", "for now / temporary", "Phase X pending", or "TODO (already done)" narration once it no longer matches reality.
- A comment describing a removed mechanism or a since-completed migration is **worse than no comment** — it actively misleads (humans and agents alike).
- History belongs in commit messages / ADRs, not in code comments. If a comment narrates the past instead of describing the present code, move it or delete it.

### Adding a new embedding provider

Implement `EmbeddingProvider` interface (`name`, `dimensions`, `embed`,
`embedSingle`) → add a class to `src/embedder.ts` → add a `case` to
`createEmbeddingProvider` → add the literal to `KnowledgeConfig.embedding.provider`.

### Adding a new reranker

Implement `Reranker` interface (`rerank`) → add a class to
`src/reranker.ts` → add a `case` to `createReranker`. Failures inside
the retriever are caught and fall back to RRF order.

### Adding a tree-sitter language

Add the grammar to `GRAMMAR_MAP` and its entity / import / call queries to
`queriesForLanguage` in `tree-sitter-parser.ts` (the `.wasm` must ship in
`@vscode/tree-sitter-wasm` — grammars must match web-tree-sitter's ABI),
add a case to `tree-sitter-parse.test.ts`, add language detection to
`langFromExt` in `file-walker.ts`, and ideally a structural-hasher
comment-style entry to `HASH_COMMENT_LANGS` / `SLASH_COMMENT_LANGS` in
`structural-hasher.ts`.

### Adding a cross-repo edge type

Add an extract function (per-repo tree scan → field on `CrossRepoSignals`)
plus a correlate strategy (join over the persisted signals) inside
`cross-repo-detector.ts`. `CrossRepoEdge.edgeType` is a closed string
union — add the new value to `types.ts`.

### Incremental indexing path

`buildKB` consults `index_meta.json` for each repo. It skips the repo when
`lastIndexedSha` matches `git rev-parse HEAD` **and** (local checkouts) the
uncommitted working-tree state matches the `workingTree` snapshot indexed
last time (`getWorkingTreeState`: path → content hash of every file
differing from HEAD) **and** its stored artifacts are current: `graph.json`,
`signals.json` at `CROSS_REPO_SIGNALS_VERSION`, chunks at
`CHUNK_ID_VERSION`. A repo on an older chunk-id version is re-chunked from
scratch (no file cache, nothing carried forward) — so an upgrade that bumps
it re-embeds every chunk once. Otherwise, at an unchanged HEAD the change
set is `diffWorkingTreeStates(indexed, current)` (new/changed edits, plus
reverted ones re-chunked back to HEAD); after new commits it is
`getAllChanges(repo, prevSha)` plus indexed edits no longer dirty → if
non-fallback + non-empty → `chunkChangedFiles` + `incrementalGraphUpdate`;
else full re-chunk (against the file cache) + full graph rebuild. Per-file
metadata lives in `fileIndex` inside `index_meta.json` and always lists
every file the repo has. Chunks of unchanged files are carried forward from
the previous `chunks.json` only while their file is still in that index.
A repo indexed last cycle (per `index_stats.json`) but no longer in the
workspace drops out of `chunks.json` and has its `<repo>/` artifacts
deleted — even when nothing else changed.

`embedChunks` is independently incremental: it diffs `chunks.json`
against existing chunk IDs in LanceDB and only embeds the new ones.
Deleted and changed files are read from `deleted_files.json` (written by
`buildKB`; a repo's first index lists nothing) and their rows removed
**before** the id diff — chunk ids are position-keyed, so a changed file's
unmoved chunks keep their ids and must be wiped first to be re-embedded.
Rows whose ids `chunks.json` no longer lists (removed repos, deletions a
fallback re-chunk caught, older id schemes) are swept; an empty
`chunks.json` is never treated as "delete everything" (the fs backend writes
NDJSON via temp file + rename, so a crash can't leave a truncated one). The
stale-file list is cleared once an embed applies it; `buildKB` merges into a
list not yet applied rather than overwriting it. Every embed run —
including one with nothing new to embed — ends with `maintainVectorIndex`
(build / due retrain / optimize); the nothing-new path then bumps the index
generation because optimize prunes old dataset versions readers may still
hold. The embed step records `embeddingProvider` / `embeddingModel` /
`embeddingDimensions` in each repo's `index_meta.json`.

### Retrieval contract

`HybridRetriever.retrieve(query, opts?)`:

- `mode: 'vector'` / `'bm25'` — single-source shortcut, no fusion, no
  graph, no rerank. `'bm25'` (backs `search_exact`) puts the literal-tier
  hits ahead of the BM25 hits.
- `mode: 'vector+bm25'` / `'vector+graph'` / `'vector+bm25+graph'`
  (default) — fused pipeline; graph expansion only in the `+graph` modes.
- `repoFilter` (or `repos`) scopes the search. With neither, the query
  router filters repos only when `CODE_SEARCH_AUTO_ROUTE=1`.
- Query embedding cached for 10 min (LRU 128).
- Returns `{ chunks, graphContext, totalTokens, query }`. `graphContext`
  is always `''`.

### Project layout on disk

```
<basePath>/<project>/
  chunks.json                    # written by buildKB; consumed by embedChunks
  deleted_files.json             # incremental embed cleanup hints
  system_graph.sqlite            # merged system graph (GraphStore)
  system_graph_v2.json           # merged graph as JSON — only when no SQLite driver loads
  index_stats.json               # stats rollup read by getStats()
  index_generation               # bumped per writer run; readers reopen on change
  profile_embeddings.json        # QueryRouter cache of embedded profiles
  PROJECT_GRAPH.json             # LLM-generated semantic graph (CLI `graph` command)
  PROJECT_SUMMARY.md             # human-readable companion
  lancedb/                       # vector store
  vector_index.json              # vector-index training + health (writer-maintained)
  <repo>/
    profile.json                 # RepoProfile (cached by fingerprintHash)
    graph.json                   # per-repo AST graph
    signals.json                 # cross-repo signals, re-correlated on partial cycles
    GRAPH_REPORT.md              # quality report
    index_meta.json              # { lastIndexedSha, workingTree, lastIndexedAt, files, chunkCount, chunkIdVersion,
                                 #   embeddingProvider, embeddingModel, embeddingDimensions, workspacePackages }
```

## Things that don't exist (intentionally)

- No vendor LLM SDK — `runLLM` / `runClaude` / `runGemini` shim through
  to `@anvil/agent-core`'s `single-shot.ts`.
- No agentic LLM client inside knowledge-core. Anything LLM-driven
  (repo profiling, service mesh inference, RAG eval, project graph)
  goes through the deprecated `claude-runner.ts` shim → agent-core.
- No graph database server. The system graph is an embedded SQLite file
  (`system_graph.sqlite`) queried in-process; `graphology` + Louvain back
  only the no-SQLite fallback.
- No cli/mcp coupling — both consumers re-export this package's
  surface; the package itself doesn't depend on either.

## Where to look first

- Indexing flow end-to-end? `src/indexer.ts:KnowledgeIndexer.buildKB`
  is the step-by-step orchestrator.
- Retrieval end-to-end? `src/retriever.ts:HybridRetriever.retrieve` is
  the whole pipeline, ~200 LOC.
- Chunking strategy? `src/chunker.ts:chunkFile` (tree-sitter boundaries,
  regex fallback, leading annotations).
- Cost / pricing for LLM-driven phases? Goes through agent-core's
  `cost.ts` via the runner shim.
- Provider auto-detect? `embedder.ts:createEmbeddingProvider` `case 'auto':`.

## Architecture + flow docs

- `ARCHITECTURE.md` — module map, type surface, layered design.
- `FLOW.md` — sequence diagrams: indexing, retrieval, profiling,
  service mesh, project graph generation.
