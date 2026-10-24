# `@esankhan3/anvil-knowledge-core` — Architecture

Reference for what physically lives in `packages/knowledge-core/src/` and how
the modules wire together. No future-tense roadmap content — only what
compiles today.

## 1. Layered module map

```
                ┌──────────────────────────────────────────────────────┐
                │ Consumers: @esankhan3/anvil-cli, code-search-mcp     │
                └──────────────────────────────────────────────────────┘
                                        │
                                        ▼
              ┌─────────────────────────────────────────────────────┐
              │ src/index.ts — public barrel                        │
              └─────────────────────────────────────────────────────┘
                                        │
                                        ▼
        ┌──────────────────────────────────────────────────────────────┐
        │ Indexer + path-based facades (src/indexer.ts)                │
        │   KnowledgeIndexer.buildKB / .embedChunks / .indexProject    │
        │   buildKBFromPath / embedFromPath / indexFromPath            │
        │   discoverRepos / getRetriever                               │
        └──────────────────────────────────────────────────────────────┘
                │              │              │             │
                ▼              ▼              ▼             ▼
        ┌──────────────┐ ┌──────────────┐ ┌────────────┐ ┌──────────────┐
        │ Chunking     │ │ Graph        │ │ Retrieval  │ │ LLM-driven   │
        │ + walking +  │ │ AST + cross- │ │ Hybrid 4-  │ │ profile +    │
        │ tree-sitter  │ │ repo + LLM   │ │ phase      │ │ service-mesh │
        │ + git-diff   │ │ project graph│ │ pipeline   │ │ + project    │
        │              │ │              │ │            │ │ graph + RAG  │
        └──────────────┘ └──────────────┘ └────────────┘ │ eval         │
                │              │              │         └──────────────┘
                │              │              │                │
                ▼              ▼              ▼                ▼
        ┌──────────────┐ ┌──────────────┐ ┌────────────┐ ┌──────────────┐
        │ chunker.ts   │ │ ast-graph-   │ │ retriever  │ │ runLLM (shim │
        │ file-walker  │ │  builder     │ │ vector-    │ │ to @anvil/   │
        │ git-diff     │ │ project-     │ │  store     │ │ agent-core)  │
        │ tree-sitter- │ │  graph-      │ │ embedder   │ │              │
        │  parser      │ │  builder     │ │ reranker   │ │              │
        │ structural-  │ │ cross-repo-  │ │ query-     │ │              │
        │  hasher      │ │  detector    │ │  classifier│ │              │
        │ workspace-   │ │ semantic-    │ │ query-     │ │              │
        │  detector    │ │  edge-       │ │  router    │ │              │
        │              │ │  detector    │ │            │ │              │
        │              │ │ graph-query  │ │            │ │              │
        │              │ │ graph-       │ │            │ │              │
        │              │ │  metrics     │ │            │ │              │
        └──────────────┘ └──────────────┘ └────────────┘ └──────────────┘
                                        │
                                        ▼
                ┌────────────────────────────────────────────┐
                │ types.ts (canonical interfaces)            │
                │ config.ts (KnowledgeConfig + DEFAULT)      │
                └────────────────────────────────────────────┘
```

## 2. Type surface (`src/types.ts`)

### 2.1 `CodeChunk`

Atomic unit of knowledge.

```ts
interface CodeChunk {
  id: string;                    // sha256(filePath + startLine + endLine)
  filePath: string;              // relative to repo root
  repoName: string;
  project: string;
  startLine: number;
  endLine: number;
  content: string;               // raw source
  contextPrefix: string;         // file path, scope chain, imports
  contextualizedContent: string; // contextPrefix + '\n' + content (what gets embedded)
  language: string;
  entityType: 'function' | 'class' | 'method' | 'interface' | 'type' | 'module' | 'import' | 'block';
  entityName?: string;
  parentEntity?: string;
  tokens: number;                // chars / 4
  imports: string[];
  exports: string[];
  embedding?: number[];
}
```

### 2.2 `CrossRepoEdge.edgeType`

`shared-type` | `shared-dep` | `api-contract` | `event-schema` | `kafka` |
`http` | `grpc` | `database` | `env-var` | `npm-dep` | `workspace-dep` |
`workspace-import` | `llm-inferred` | `redis` | `s3` | `proto` |
`docker-compose` | `k8s-service` | `shared-constant`.

Emitted: the 14 detector strategies produce `npm-dep`, `shared-type`,
`env-var`, `event-schema`, `http` (routes, docker-compose and k8s service
refs), `workspace-dep`, `grpc`, `database`, `redis`, `s3`, `api-contract`
and `shared-constant`; the service-mesh inferrer adds `kafka`, `http`,
`grpc`, `database`, `redis`, `s3` and `llm-inferred`. `shared-dep`,
`workspace-import`, `proto`, `docker-compose` and `k8s-service` are
declared but never emitted.

### 2.3 `RepoProfile` + `ServiceEndpoint`

```ts
interface RepoProfile {
  name, role, domain, description, technologies[];
  exposes: ServiceEndpoint[];        // HTTP, Kafka topics produced, gRPC, ...
  consumes: ServiceEndpoint[];
  entryPoints: string[];
  profiledAt, profiledBy;
  fingerprintHash: string;           // skip re-profile if unchanged
}

interface ServiceEndpoint {
  type: 'http' | 'grpc' | 'kafka-producer' | 'kafka-consumer' | 'database'
       | 'redis' | 's3' | 'websocket' | 'cron' | 'other';
  identifier: string;                // topic / path / table
  description: string;
}
```

### 2.4 `GraphifyOutput` + `ProjectGraph`

`GraphifyOutput { nodes: GraphifyNode[], links: GraphifyEdge[] }` — the
per-repo on-disk graph format (`<repo>/graph.json`).

`ProjectGraph` — LLM-generated semantic project understanding:
`{ meta, architectureSummary, repoRoles, communityLabels,
relationships, keyFlows }`.

### 2.5 `WorkspaceMap`

```ts
interface WorkspacePackage { name, path, relativePath, ecosystem, manifestFile, dependencies[] }
interface WorkspaceMap     { repoPath, packages, nameToPackage, pathAliases }
```

### 2.6 `RetrievalResult` + `IndexStats`

```ts
interface ScoredChunk { chunk: CodeChunk; score: number; source: 'vector'|'bm25'|'graph'|'fused' }
interface RetrievalResult { chunks: ScoredChunk[]; graphContext: string; totalTokens: number; query: string }
interface IndexStats { project, repos[], totalChunks, totalTokens, embeddingProvider, embeddingDimensions, crossRepoEdges, lastIndexed, indexDurationMs }
```

## 3. Config (`src/config.ts`)

```ts
interface KnowledgeConfig {
  embedding: { provider, model?, dimensions?, apiKeyEnv? };
  chunking: { maxTokens, contextEnrichment };
  retrieval: { maxChunks, maxTokens, hybridWeights, reranker };
  autoIndex: boolean;
}
```

`DEFAULT_CONFIG`:

| Field | Default |
|---|---|
| `embedding.provider` | `'auto'` |
| `embedding.dimensions` | `1024` |
| `chunking.maxTokens` | `500` |
| `chunking.contextEnrichment` | `'structural'` |
| `retrieval.maxChunks` | `8` |
| `retrieval.maxTokens` | `12000` |
| `retrieval.hybridWeights` | `{ vector: 0.5, bm25: 0.3, graph: 0.2 }` |
| `retrieval.reranker` | `{ provider: 'ollama' }` |
| `autoIndex` | `true` |

Knowledge base path resolution (`getKnowledgeBasePath(project)`):

1. `CODE_SEARCH_DATA_DIR` (Docker / production)
2. `ANVIL_HOME/knowledge-base`
3. `~/.anvil/knowledge-base`

`loadKnowledgeConfig(project)` reads
`<anvilHome>/projects/<project>/factory.yaml` (or `project.yaml`),
falls back to `DEFAULT_CONFIG`.

## 4. Chunking + walking (`src/chunker.ts`, `src/file-walker.ts`)

### 4.1 `walkDir`

Recursive directory walker. `isSourceFile(name)`: `SOURCE_EXTENSIONS =
.ts, .tsx, .js, .jsx, .py, .go, .rs, .java, .php` plus the infra formats
`.sh, .bash, .yaml, .yml, .tf, .hcl, .toml` (whole-file chunks), and
`SOURCE_FILENAMES = Dockerfile (+ Dockerfile.*), Makefile, Jenkinsfile`.
`SKIP_DIRS = node_modules, dist, build, .git, vendor, __pycache__, .next`,
plus any `chunking.ignorePatterns` segment (`isIgnoredPath`).

`langFromExt(ext)` → language string. `extractImports(lines, lang)` —
import path strings (`import … from` and `require(…)` for TS/JS).
`extractNamedImports` — `{ source, names[] }`.

### 4.2 `chunkRepo` / `chunkChangedFiles`

Boundaries come from tree-sitter for the 8 parsed languages: every
top-level definition and class member starts a chunk (methods get
`parentEntity` = their class; a function nested in another function stays
in it). Without a grammar (or a parse with no entities) the per-language
regex `BoundaryPattern[]` (TS/JS, Python, Go, Rust, Java) is the fallback.
Each boundary then moves up over the comment / doc-comment / decorator /
attribute lines directly above it, so a definition's leading annotations
belong to its chunk. Config formats (yaml, hcl, toml) are whole-file chunks;
oversized content is split into `name$1`, `name$2`, … parts. Chunk id =
`sha256(repoName \0 filePath \0 startLine \0 endLine)[0:16]`
(`CHUNK_ID_VERSION` = 2).

`chunkChangedFiles(repo, name, project, cfg, gitDiff, onChunk?, cachedFiles?)`
— chunks `gitDiff.added + gitDiff.modified`; its `fileIndex` is
`cachedFiles` minus every diffed path plus the re-chunked files, i.e. the
whole repo.

Returns `{ chunks, fileIndex, deletedFiles, changedFiles }`.

## 5. Tree-sitter (`src/tree-sitter-parser.ts`)

`web-tree-sitter` WASM with grammars from `@vscode/tree-sitter-wasm`
(ABI 14/15). Languages: TypeScript, JavaScript, TSX, Go, Python, Rust, Java,
PHP. Lazy-loaded via `initTreeSitter()`; queries are compiled once per
grammar. A grammar that fails to load is reported once on stderr and
`parseFile` returns null (callers use their regex fallback). Used by the
chunker (boundaries) and the AST graph builder (entities, imports, calls).
A function directly inside a class / impl is a `method` with that
`parent`; a call belongs to its innermost containing entity.

Public API:

```ts
parseFile(filePath, content, language) → FileParseResult
  { entities: TreeSitterEntity[], imports: TreeSitterImport[],
    callSites: TreeSitterCallSite[] }
parseFiles(files) → FileParseResult[]
supportedLanguages() → string[]
```

## 6. Git diff (`src/git-diff.ts`)

`getAllChanges(repoPath, prevSha)` runs `git diff --name-status
<prevSha>..HEAD`. Returns `GitDiff { added, modified, deleted, renamed,
fallbackToFull }`. `fallbackToFull = true` when git invocation fails.

`getChangedFilesList(diff)` = `[...added, ...modified]`. `getDeletedFilesList`
= `diff.deleted`.

Filtered to the walker's `isSourceFile`, so the incremental and full paths
agree on which files count.

## 7. Workspace detection (`src/workspace-detector.ts`)

Declarative manifest registry — one `ManifestDescriptor` per ecosystem.
Each entry: `filename`, `ecosystem`, `extractName`, `extractDeps`,
`extractWorkspaceGlobs`. Adding a new ecosystem = adding one entry.

`detectWorkspace(repoPath)` → `WorkspaceMap` with packages, name→package
map, and tsconfig path aliases.

## 8. Structural hasher (`src/structural-hasher.ts`)

Canonicalize source then SHA-256:

1. Strip comments (preserve string literals via placeholder swap).
2. Collapse whitespace.
3. Normalize identifiers (regex-based; upgrade path: tree-sitter).

Comment style by language: `HASH_COMMENT_LANGS` (python, ruby, bash,
shell, yaml) vs `SLASH_COMMENT_LANGS` (typescript, javascript, tsx,
jsx, go, rust, java, c, cpp, csharp, swift, kotlin, scala, dart, php).

```ts
computeStructuralHash(content, language) → { hash, canonicalSize }
computeStructuralHashes(chunks) → CodeChunk[] with hashes
deduplicateByStructure(chunks) → { unique, duplicates, savings }
```

Consumed by `@anvil/memory-core`'s drift detector — same canonical form,
same hash. The indexer does not dedup chunks with it: every repo keeps its
own copy of shared code (byte-identical results collapse at query time).

## 9. Embedders (`src/embedder.ts`)

| Class | Provider | Default model | Dim |
|---|---|---|---|
| `CodestralEmbedder` | Mistral | `codestral-embed-2505` | 1024 |
| `VoyageEmbedder` | Voyage AI | `voyage-code-3` | 1024 |
| `OpenAIEmbedder` | OpenAI | `text-embedding-3-large` | 1024 |
| `OllamaEmbedder` | Ollama | `bge-m3` | 1024 (per-model table) |
| `GeminiOAuthEmbedder` | Gemini (OAuth or API key) | `text-embedding-004` | 768 |
| `OpenAICompatibleEmbedder` | Custom OpenAI-compat | env-driven | env-driven |

`createEmbeddingProvider({ provider, model?, dimensions? })` switches on
provider. `'auto'` order:

1. `CODE_SEARCH_EMBEDDING_BASE_URL` set → `OpenAICompatibleEmbedder`
2. Ollama running → `OllamaEmbedder`
3. `MISTRAL_API_KEY` → `CodestralEmbedder`
4. `OPENAI_API_KEY` → `OpenAIEmbedder`
5. `VOYAGE_API_KEY` → `VoyageEmbedder`
6. `GOOGLE_API_KEY` / `GEMINI_API_KEY` → `GeminiOAuthEmbedder`
7. gemini CLI authenticated → `GeminiOAuthEmbedder`
8. throw

`batchEmbed(provider, texts, batchSize=50, delayMs=100)`.

## 10. Vector store (`src/vector-store.ts`)

LanceDB-backed. Lazy `import('@lancedb/lancedb')` so a missing native
dep is a runtime error, not a load-time crash.

API:

| Method | Purpose |
|---|---|
| `init({ healCorrupt? })` | open the `chunks` table (the write path drops a corrupt one); FTS is built on the write path only (`ensureFtsIndex`) |
| `upsertChunks(chunks)` | replace the rows with these ids, insert the rest |
| `addChunks(chunks)` | additive insert |
| `vectorSearch(embedding, { limit, filter })` | k-NN by embedding |
| `fullTextSearch(queryText, limit)` | LanceDB FTS BM25 |
| `getByIds(ids)` | direct lookup |
| `getChunksByEntity(lookups)` | `{ repoName, filePath, entityName }` triples |
| `getChunksByFile(repoName, filePath)` | all chunks for a file |
| `deleteChunksByIds(ids)` | targeted delete |
| `deleteFileChunks(project, repo, filePaths)` | bulk file-level delete |
| `getChunkIds(project)` | for incremental embed planning |
| `getStats()` / `hasData()` | row count |
| `ensureVectorIndex({ minRows, retrain })` | build the IVF vector index when absent (≥ `minRows`), or retrain it in place |
| `vectorIndexState()` | row count + the vector index's indexed / unindexed rows |
| `optimizeIndexes()` | fold appended rows into every index, compact, prune old versions |

FTS index on `contextualizedContent` (`contextualizedContent_idx`, with
positions, stop words kept). The write path builds it once; `optimize()` folds
later appends in, and until then they are still found by term search (not by
phrase search). The index name stands for its config: a config change ships
with a new name, and `ensureFtsIndex` builds the new index then drops the old.

The vector index (IVF_FLAT, or IVF_PQ when `storage.vector.lancedb.index` is
set) is managed by `vector-index-maintenance.ts` on the write path. It is built
once the table reaches `minRows`, and `optimize()` folds appends into the
existing centroids. The writer counts rows written since the last training and
retrains in place (`createIndex(..., { replace: true })`) once that reaches
`trainedRows × CODE_SEARCH_VECTOR_RETRAIN_RATIO` (default 1; 0 disables), when
the configured index type changes, or once for an index with no training
record. Training + health are recorded in `vector_index.json`.

## 11. Reranker (`src/reranker.ts`)

| Class | Default endpoint / model |
|---|---|
| `OllamaReranker` | `http://localhost:11434`, `qwen2.5-coder:7b`, 30 s timeout |
| `CohereReranker` | Cohere API |
| `VoyageReranker` | Voyage API |
| `OpenAICompatibleReranker` | env-driven base URL |

`createReranker(provider)` returns `null` for `'none'`. Default branch
checks `CODE_SEARCH_RERANKER_BASE_URL` else `OllamaReranker`.

`parallelMap` helper bounds concurrency.

## 12. Query classifier (`src/query-classifier.ts`)

`classifyQuery(query)` → `{ type, weights, shouldUseTrigram, explanation }`.

| Type | Vector | BM25 | Graph |
|---|---|---|---|
| `identifier` | 0.2 | 0.6 | 0.2 |
| `path` | 0.1 | 0.7 | 0.2 |
| `error-code` | 0.1 | 0.7 | 0.2 |
| `natural-language` | 0.6 | 0.2 | 0.2 |
| `mixed` | 0.4 | 0.35 | 0.25 |

The retriever reads only `vector` and `bm25`; the `graph` column is unused.

Detection patterns: camelCase, snake_case, PascalCase, dotted paths,
file paths/extensions, hex codes, `ERR_*`, numeric error codes, HTTP
status, question words.

## 13. Query router (`src/query-router.ts`)

`createQueryRouter(project, embedder)` — embeds each `RepoProfile`'s
search-text representation, caches the result. `route(query)` embeds
the query, ranks repos by cosine similarity, decides `'all'` vs
`'filtered'` based on score distribution. The retriever consults it only
when `CODE_SEARCH_AUTO_ROUTE=1` — off by default, because filtering repos
by profile similarity before retrieval cost exact-symbol recall.

## 14. Hybrid retriever (`src/retriever.ts`)

```ts
new HybridRetriever(vectorStore, embedder, graphStore, config, reranker?, queryRouter?)
retriever.retrieve(query, { repos?, repoFilter?, maxChunks?, maxTokens?, mode? })
```

Supported modes: `'vector'` | `'bm25'` | `'vector+bm25'` |
`'vector+graph'` | `'vector+bm25+graph'` (default).

Repo scope: `repoFilter` / `repos`; with neither, the query router filters
repos only when `CODE_SEARCH_AUTO_ROUTE=1`.

Pipeline (4 phases):

1. **Phase 1** — in parallel: `vectorSearch(50)`, `fullTextSearch(50)`,
   and two literal tiers — `searchByEntitySubstring` /
   `searchByEntityName` (20) for a bare identifier, `phraseSearch` (20)
   for a multi-token query of ≥ 8 chars. Query embedding cached LRU-128,
   10 min TTL. `'vector'` / `'bm25'` modes return here (`'bm25'` puts the
   literal hits first).
2. **Phase 2** — weighted RRF (`k = CODE_SEARCH_RRF_K`, default 10):
   vector + BM25 with weights from `classifyQuery` (falls back to
   `config.hybridWeights`), literal tiers at weight 1. Then
   `boostExactSymbol` pins exact entityName matches first, exact-content
   duplicates are dropped, chunks are capped per file
   (`CODE_SEARCH_MAX_PER_FILE`, default 2), and the top 15 form the pool.
3. **Phase 3** — AST expansion (`+graph` modes), only when a reranker is
   configured or the pool can't fill `maxChunks`: pick 5 diversified seeds
   (one per file), take their one-hop neighbours in both directions
   (non-`contains` edges with confidence ≥ 0.7, module/package nodes
   dropped), fetch chunks via `getChunksByEntity`. Expanded chunks are
   appended after the pool.
4. **Phase 4** — Cross-encoder rerank over the pool + AST candidates
   when a reranker is configured. Reranker failure → fall back to RRF
   order.

Final selection via `packWithinBudget(chunks, maxTokens, maxChunks)`.

`graphContext` is always `''`.

## 15. AST graph builder (`src/ast-graph-builder.ts`)

6-phase build:

| Phase | What |
|---|---|
| 0 | Workspace package nodes |
| 1 | File walking + entity extraction (tree-sitter; regex when a grammar can't parse; `.tsx` uses the TSX grammar) |
| 2 | Import resolution (relative + module-path + workspace + named) |
| 3 | Type reference edges from entity bodies |
| 4 | Import-aware call disambiguation |
| 5 | Inheritance resolution |
| 6 | Package→file `contains` edges |

Calls, type references, inheritance and named-import `uses` resolve only
within a language family (TS/TSX/JS share one) — a name in a Java file never
binds to a Python definition.

Per-edge `confidence` (0..1). The retriever's expansion and the
`trace_path` tool follow only non-`contains` edges with confidence ≥ 0.7 —
a flat filter, not a weighting.

`incrementalGraphUpdate(existingGraph, changedFiles, deletedFiles,
repoPath, opts)` — re-parses only changed files, drops nodes/edges
from deleted files, merges into the existing graph.

`generateGraphReport(repoName, graph)` — markdown quality report.

## 16. Project graph (`src/project-graph-builder-core.ts` + `project-graph-builder.ts`)

The merged system graph normally lives in `system_graph.sqlite`
(`src/graph-store.ts`): `createSystemGraphSqliteWriter` streams each
repo's nodes/edges plus the cross-repo edges as `buildKB` goes, and
`GraphStore` (`openSystemGraphStore` / `getGraphStore`) serves slice
queries to the retriever and the MCP graph tools. Tables: `nodes(key,
repo, file, label, type, degree, attrs)` and `edges(source, target, type,
confidence, source_repo, target_repo, evidence)` — `evidence` (the
route / topic / table / package a cross-repo edge was matched on) is NULL
for AST edges; files written before the column existed are still read
(`NULL AS evidence`) until the next index rebuilds them.

Query semantics (both the SQLite store and the JSON fallback):
`resolveNodes` is exact by default — full key, `label`, or a `::name` key
suffix, case-sensitive and wildcard-free; `fuzzy` = case-insensitive
substring of symbol labels (`module` / `external` nodes skipped).
`callers` / `dependencies` / `neighborsOf` take an edge-type filter
(omitted = every type but `contains`); `callers` / `dependencies` return
`{ key, type }`. `crossRepoEdges` returns edges between repos plus
same-repo `workspace-dep` edges. `dependents` follows edges into the set
and, for `SYMMETRIC_EDGE_TYPES` (`event-schema`, `database`, `redis`, `s3`,
`shared-type`, `shared-constant`, `env-var`, `npm-dep` — one stored edge
per pair, in arbitrary order), edges out of it too, returned flipped so
`source` is the dependent. `searchNodes` `name` is a case-insensitive
regex over symbol labels (a `regexp` SQL user function; JS filtering on a
driver without user functions); an invalid pattern throws.

`ProjectGraphBuilder` — `graphology` directed multi-graph, used by
`buildKB` only when no SQLite driver loads. Lazy-loads `graphology` +
`graphology-communities-louvain` (`ensureGraphology`).

Methods: `addRepoGraph(name, graphJson)` (namespaces nodes as
`<repo>::<id>`), `addCrossRepoEdges(edges)`, `detectCommunities()`
(Louvain), `exportJson()`, `exportForPrompt(maxChars)`, `getGraph()`.

`buildProjectGraph(project, opts)` — LLM-driven, run by the CLI `graph`
command: assembles factory.yaml + per-repo graph reports + cross-repo
edges → single LLM call → `ProjectGraph` written to `PROJECT_GRAPH.json` +
`PROJECT_SUMMARY.md` under the knowledge-base dir. Cross-repo edges (with
their evidence, first 30) come from the system graph store
(`storage.graph()` — `system_graph.sqlite`, or the JSON fallback).

`loadProjectGraph` / `loadProjectSummary` / `getProjectGraphStatus` /
`estimateProjectGraphCost` — read-side helpers.

## 17. Cross-repo + semantic edges

`detectCrossRepoEdges(repos, workspaceMaps?)`
(`src/cross-repo-detector.ts`) — two halves.
`extractCrossRepoSignals(repoPath, { ignorePatterns })` scans one repo's
tree (bounded by `walkFiles(root, match, maxFiles=5000)`, which works in
repo-relative paths) into a JSON-serializable `CrossRepoSignals` bundle
(`version` = `CROSS_REPO_SIGNALS_VERSION`; file paths repo-relative, so edge
endpoints share the code graph's file keys); `buildKB` runs it in the worker
and persists it as `<repo>/signals.json`. `correlateCrossRepoEdges(signals,
workspaceMaps)` runs the 14 join strategies over those bundles and emits
typed `CrossRepoEdge` rows, so partial cycles correlate stored signals
without re-scanning unchanged repos.

`detectSemanticEdges(...)` (`src/semantic-edge-detector.ts`) — LLM-inferred
edges between repos. Exported only; `buildKB` doesn't call it.

## 18. LLM-driven analysis

### 18.1 Repo profiler (`src/repo-profiler.ts`)

`profileProject(project, repos, opts)`:

1. For each repo: build a `RepoFingerprint` of signal-dense files
   (manifests, READMEs, entry points, top-level config) capped at
   `MAX_FINGERPRINT_CHARS = 6000`.
2. Skip if `fingerprintHash` matches existing `profile.json`.
3. Send to LLM with the `PROFILER_SYSTEM_PROMPT`. Concurrency capped at
   `MAX_CONCURRENT = 3`.
4. Parse JSON → `RepoProfile`. Write to `<basePath>/<repo>/profile.json`.

`loadProfile(project, repo)` / `loadAllProfiles(project)`.

### 18.2 Service mesh inferrer (`src/service-mesh-inferrer.ts`)

`inferServiceMesh(profiles, opts)`:

- **Phase A** — deterministic match: every `consumes` endpoint against
  every other repo's `exposes`. `normalizeIdentifier` (lowercase,
  collapse separators, strip version prefixes, normalize path params)
  enables fuzzy matching.
- **Phase B** — LLM gap-fill for orphan repos (no detected edges).

Returns `CrossRepoEdge[]` to feed into `ProjectGraphBuilder`.

### 18.3 RAG evaluator (`src/rag-evaluator.ts`)

Generates answers from retrieved context + judges quality. Returns
`{ answer, scores: { correctness, completeness, groundedness,
hallucination_count?, similarity?, overall }, costs, durations }`.

### 18.4 LLM runner (`src/claude-runner.ts`)

**Deprecated re-export** of `@anvil/agent-core`'s
`single-shot.ts`. Re-exports `runLLM`, `runClaude`, `runGemini`,
`isLlmAvailable`, `resetLlmConfig`, `LLMRunOptions`, `ClaudeResult`.

## 19. Indexer (`src/indexer.ts`)

### 19.1 `KnowledgeIndexer.buildKB(project, repos, config, opts?)`

Steps:

1. Skip check against `index_meta.json`: HEAD sha (`getRepoSha`), for
   local checkouts the uncommitted working-tree state
   (`getWorkingTreeState`), and current stored artifacts (`graph.json`,
   `signals.json` at `CROSS_REPO_SIGNALS_VERSION`, `chunkIdVersion` =
   `CHUNK_ID_VERSION`). Repos the previous `index_stats.json` listed but the
   workspace no longer has are "removed" — a cycle with removals is never a
   no-op.
2. LLM repo profiling (skipped if `isLlmAvailable() === false`).
3. Chunk repos: incremental via `chunkChangedFiles` if `git diff`
   succeeds + non-fallback + non-empty; else `chunkRepo` (with the file
   cache, unless the repo's chunks use an older id scheme).
4. Merge the per-repo chunk shards plus chunks carried forward from the
   previous corpus (skipped repos; unchanged files still in a partially
   re-chunked repo's `fileIndex`) into `chunks.json`, streamed, deduped by
   chunk id only (`mergeShardsToChunks`).
5. Workspace detection.
6. AST graphs: `incrementalGraphUpdate` if possible; else `buildAstGraph`.
   Write `<repo>/graph.json` + `GRAPH_REPORT.md`.
7. Cross-repo edges (14 strategies): `correlateCrossRepoEdges` over per-repo `signals.json` bundles persisted at index time (extracted in the worker while the tree exists).
8. LLM service mesh inference (skipped if `isLlmAvailable() === false`).
9. Persist the system graph: finalize the streamed `system_graph.sqlite`
   (uploaded when the blob backend is remote). With no SQLite driver, the
   in-memory `ProjectGraphBuilder` runs Louvain and writes
   `system_graph_v2.json` instead.
10. Save `deleted_files.json` (changed + deleted files of previously indexed
    repos; merged into a list not yet applied by an embed run).
11. Per-repo `index_meta.json` writes (complete `files`, `chunkIdVersion`;
    the previous `embeddingModel` / `embeddingDimensions` are kept), delete
    removed repos' `<repo>/` artifacts, write `index_stats.json`.

### 19.2 `KnowledgeIndexer.embedChunks(project, config, opts?)`

1. Open `VectorStore` at `<basePath>/lancedb` (`healCorrupt`).
2. Read `deleted_files.json` (deleted + changed files) → `deleteFileChunks`
   per repo. This runs before the id diff: chunk ids are position-keyed, so
   a changed file's unmoved chunks keep their ids and would otherwise be
   skipped as already embedded.
3. Snapshot existing chunk ids; stream `chunks.json` (NDJSON) to count
   totals and new ids.
4. Sweep rows whose ids `chunks.json` no longer lists (skipped when it is
   empty).
5. Embed the new chunks: batches of `CODE_SEARCH_EMBEDDING_BATCH_SIZE`
   (10 for Ollama, else 128) with `CODE_SEARCH_EMBEDDING_CONCURRENCY`
   in flight (Ollama 1, else 8), streamed — no inter-batch delay; 429s
   back off inside the embedder.
6. `addChunks` the embedded rows in appends of 4,096 (one LanceDB commit
   each, so commits don't scale with chunks / batch size); then
   `ensureFtsIndex`, which builds the full-text index only when it is missing
   or under an older config's name.
7. Build missing scalar indexes, then `maintainVectorIndex` (build / due
   retrain / optimize; writes `vector_index.json`). An embed run with nothing
   new still runs this step and bumps the index generation.
8. Clear `deleted_files.json` (applied), then update each repo's
   `index_meta.json` (`embeddingProvider`, `embeddingModel`,
   `embeddingDimensions`, `lastIndexedAt`).

The returned stats report the cross-repo edge count from buildKB's
`index_stats.json`.

### 19.3 `indexProject` = `buildKB` + `embedChunks`.

### 19.4 Path-based facades

```
discoverRepos(directoryPath): { name, path, language }[]
  ├─ if existsSync(<dir>/.git): single repo
  └─ else: scan subdirs (skip dotfiles, node_modules, dist, .next, build,
                          __pycache__, .venv, vendor, target)

detectLanguage(repoPath):
  go.mod    → 'go'
  Cargo.toml → 'rust'
  pom.xml | build.gradle → 'java'
  composer.json → 'php'
  pyproject.toml | setup.py → 'python'
  package.json + tsconfig.json → 'typescript'
  package.json → 'javascript'
  else      → 'unknown'

buildKBFromPath / embedFromPath / indexFromPath
  └─ discoverRepos → KnowledgeIndexer.<method>
```

`getRetriever(project)` — load config → open store → build embedder +
reranker + graph store + queryRouter → return `HybridRetriever`.

## 20. File layout

```
packages/knowledge-core/
├── package.json
├── tsconfig.json
├── README.md
├── CLAUDE.md
├── ARCHITECTURE.md
├── FLOW.md
└── src/
    ├── index.ts                           ← public barrel
    ├── types.ts                           ← canonical interfaces
    ├── config.ts                          ← KnowledgeConfig + DEFAULT_CONFIG + paths
    ├── claude-runner.ts                   ← deprecated shim → @anvil/agent-core
    │
    ├── chunker.ts                         ← chunkRepo / chunkChangedFiles
    ├── chunks-io.ts                       ← NDJSON chunk shard writer / reader
    ├── file-walker.ts                     ← walkDir + langFromExt + import extraction
    ├── git-diff.ts                        ← getAllChanges + working-tree state
    ├── tree-sitter-parser.ts              ← WASM AST parsing
    ├── structural-hasher.ts               ← canonical hash (memory-core drift)
    ├── workspace-detector.ts              ← manifest registry
    │
    ├── ast-graph-builder.ts               ← per-repo 6-phase graph
    ├── cross-repo-detector.ts             ← 14 strategies
    ├── semantic-edge-detector.ts          ← LLM-inferred edges (not called by buildKB)
    ├── graph-store.ts                     ← system_graph.sqlite writer + GraphStore
    ├── graph-metrics.ts                   ← quality reports
    ├── graph-query.ts                     ← traversal helpers
    ├── project-graph-builder-core.ts      ← ProjectGraphBuilder class
    ├── project-graph-builder.ts           ← LLM-powered builder + re-export
    │
    ├── embedder.ts                        ← 6 providers + factory + auto
    ├── vector-store.ts                    ← LanceDB wrapper
    ├── vector-index-maintenance.ts        ← vector-index build / retrain / health
    ├── reranker.ts                        ← 4 providers + factory
    ├── query-classifier.ts                ← classifyQuery
    ├── query-router.ts                    ← QueryRouter
    ├── retriever.ts                       ← HybridRetriever (4-phase)
    ├── vector-recall.ts                   ← IVF recall@k vs flat-scan check
    ├── bm25-tokenizers.ts / query-expander.ts / rerank-cache.ts ← P6 primitives (not wired)
    │
    ├── repo-profiler.ts                   ← profileProject + caching
    ├── service-mesh-inferrer.ts           ← Phase A + Phase B
    ├── rag-evaluator.ts                   ← answer + judge
    │
    ├── indexer.ts                         ← KnowledgeIndexer + path facades
    ├── repo-pipeline.ts                   ← per-repo chunk + graph + signals (RepoIndexMeta)
    ├── index-pool.ts / index-worker.ts    ← worker-thread pool for repo pipelines
    ├── storage/                           ← ports + fs / mongo blob stores + resolveStorage
    │
    └── __tests__/                         ← node:test suites (see §22)
```

## 21. Runtime dependencies

From `package.json`:

- `@anvil/agent-core` — LLM runner shim (`claude-runner.ts`).
- `@lancedb/lancedb` (0.27.2) — vector store.
- `web-tree-sitter` (0.26.8) + `@vscode/tree-sitter-wasm` (0.3.1, grammars) — AST parsing.
- `better-sqlite3` (optional; `node:sqlite` fallback) — system graph store.
- `graphology` (0.26.0) + `-communities-louvain` (2.0.2) +
  `-metrics` (2.4.0) + `-types` (0.24.8) — graph algorithms.

No vendor LLM SDK directly — everything LLM-driven goes through the
agent-core shim.

## 22. Tests

`node --test` runs every compiled `dist/__tests__/*.test.js`. Indexing
integration suites drive the real `buildKB` + `embedChunks` over temp git
repos with an OpenAI-compatible embedding stub and a real LanceDB table
(`kb-fixture.ts`): `index-integrity`, `embed-incremental`,
`cross-repo-graph`, `retriever-config`. Parsing / graph: `tree-sitter-parse`,
`ast-graph`, `chunker-boundaries`, `cross-repo-detector`. Plus storage
ports, vector index / recall, retrieval fusion, config / env overrides and
query classification suites.
