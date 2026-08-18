# `@anvil/knowledge-core` — Architecture

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

### 2.2 `CrossRepoEdge.edgeType` — 18 strategies

`shared-type` | `shared-dep` | `api-contract` | `event-schema` | `kafka` |
`http` | `grpc` | `database` | `env-var` | `npm-dep` | `workspace-dep` |
`workspace-import` | `llm-inferred` | `redis` | `s3` | `proto` |
`docker-compose` | `k8s-service` | `shared-constant`.

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
| `retrieval.reranker` | `'ollama'` |
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

Recursive directory walker. `SOURCE_EXTENSIONS = .ts, .tsx, .js, .jsx,
.py, .go, .rs, .java, .php`. `SKIP_DIRS = node_modules, dist, build,
.git, vendor, __pycache__, .next`.

`langFromExt(ext)` → language string. `extractImports(content, lang)` —
import path strings. `extractNamedImports` — `{ source, names[] }`.

### 4.2 `chunkRepo` / `chunkChangedFiles`

Per-language regex `BoundaryPattern[]` (TypeScript/JavaScript shown;
Python, Go, Rust, Java, PHP each have their own). Splits source at
function/class/method/interface/type boundaries; falls back to a
fixed-size block when no boundary fits.

`chunkChangedFiles(repo, name, project, cfg, gitDiff)` — uses
`gitDiff.added + gitDiff.modified` as the input set, preserves
unchanged file index entries.

Returns `{ chunks, fileIndex, deletedFiles, changedFiles }`.

## 5. Tree-sitter (`src/tree-sitter-parser.ts`)

`web-tree-sitter` WASM. Languages: TypeScript, JavaScript, TSX, Go,
Python, Rust, Java, PHP. Lazy-loaded via `initTreeSitter()`.

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

Filtered by `SOURCE_EXTS` (broader than chunker's set — adds yaml,
json, sql, graphql, proto, md, etc).

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

Also consumed by `@anvil/memory-core`'s drift detector — same canonical
form, same hash.

## 9. Embedders (`src/embedder.ts`)

| Class | Provider | Default model | Dim |
|---|---|---|---|
| `CodestralEmbedder` | Mistral | `codestral-embed-2505` | 1024 |
| `VoyageEmbedder` | Voyage AI | `voyage-code-3` | 1024 |
| `OpenAIEmbedder` | OpenAI | `text-embedding-3-large` | 1024 |
| `OllamaEmbedder` | Ollama | `nomic-embed-text` | 768 |
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
| `init()` | open or create `chunks` table; ensure FTS index |
| `upsertChunks(chunks)` | insert/replace (uses `id` PK) |
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

FTS index built on `contextualizedContent`.

## 11. Reranker (`src/reranker.ts`)

| Class | Default endpoint / model |
|---|---|
| `OllamaReranker` | `http://localhost:11434`, `qwen3:0.6b`, 30 s timeout |
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
| `mixed` | 0.45 | 0.35 | 0.2 |

Detection patterns: camelCase, snake_case, PascalCase, dotted paths,
file paths/extensions, hex codes, `ERR_*`, numeric error codes, HTTP
status, question words.

## 13. Query router (`src/query-router.ts`)

`createQueryRouter(project, embedder)` — embeds each `RepoProfile`'s
search-text representation, caches the result. `route(query)` embeds
the query, ranks repos by cosine similarity, decides `'all'` vs
`'filtered'` based on score distribution.

## 14. Hybrid retriever (`src/retriever.ts`)

```ts
new HybridRetriever(vectorStore, embedder, graph, config, reranker?, queryRouter?)
retriever.retrieve(query, { repos?, repoFilter?, maxChunks?, maxTokens?, mode? })
```

Supported modes: `'vector'` | `'bm25'` | `'vector+bm25'` |
`'vector+graph'` | `'vector+bm25+graph'` (default).

Pipeline (4 phases):

1. **Phase 1** — `Promise.all([vectorSearch(50), fullTextSearch(50)])`.
   Query embedding cached LRU-128, 10 min TTL.
2. **Phase 2** — RRF fusion with weights from `classifyQuery` (falls
   back to `config.hybridWeights`).
3. **Phase 3** — AST tripartite expansion: pick 5 diversified seeds
   (one per file), traverse outgoing (deps) + incoming (dependents) +
   sibling edges with confidence ≥ 0.7, fetch chunks via
   `getChunksByEntity`.
4. **Phase 4** — Cross-encoder rerank over top-15 RRF + AST candidates.
   Reranker failure → fall back to RRF order.

Final selection via `packWithinBudget(chunks, maxTokens, maxChunks)`.

`graphContext` from `graph.exportForPrompt(2000)` when `useGraph`.

## 15. AST graph builder (`src/ast-graph-builder.ts`)

6-phase build:

| Phase | What |
|---|---|
| 0 | Workspace package nodes |
| 1 | File walking + entity extraction (regex with tree-sitter override) |
| 2 | Import resolution (relative + module-path + workspace + named) |
| 3 | Type reference edges from entity bodies |
| 4 | Import-aware call disambiguation |
| 5 | Inheritance resolution |
| 6 | Package→file `contains` edges |

Per-edge `confidence` (0..1) used for weighted BFS in the retriever's
tripartite expansion.

`incrementalGraphUpdate(existingGraph, changedFiles, deletedFiles,
repoPath, opts)` — re-parses only changed files, drops nodes/edges
from deleted files, merges into the existing graph.

`generateGraphReport(repoName, graph)` — markdown quality report.

## 16. Project graph (`src/project-graph-builder-core.ts` + `project-graph-builder.ts`)

`ProjectGraphBuilder` — `graphology` directed multi-graph. Lazy-loads
`graphology` + `graphology-communities-louvain` (`ensureGraphology`).

Methods: `addRepoGraph(name, graphJson)` (namespaces nodes as
`<repo>::<id>`), `addCrossRepoEdges(edges)`, `detectCommunities()`
(Louvain), `exportJson()`, `exportForPrompt(maxChars)`, `getGraph()`.

`buildProjectGraph(project, opts)` — LLM-driven: assembles factory.yaml
+ per-repo graph reports + cross-repo edges → single LLM call →
`ProjectGraph` written to `PROJECT_GRAPH.json` + `PROJECT_SUMMARY.md`
under the knowledge-base dir.

`loadProjectGraph` / `loadProjectSummary` / `getProjectGraphStatus` /
`estimateProjectGraphCost` — read-side helpers.

## 17. Cross-repo + semantic edges

`detectCrossRepoEdges(repos, workspaceMaps?)`
(`src/cross-repo-detector.ts`) — runs every detector strategy and
unions the results. Each strategy walks files with a predicate
matcher (`walkFiles(dir, match, maxFiles=5000)`) and emits typed
`CrossRepoEdge` rows.

`detectSemanticEdges(...)` (`src/semantic-edge-detector.ts`) — LLM-inferred
edges, fills gaps the deterministic strategies miss.

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

12 steps:

1. SHA-based skip check (`getRepoSha` + `index_meta.json`).
2. LLM repo profiling (skipped if `isLlmAvailable() === false`).
3. Chunk repos: incremental via `chunkChangedFiles` if `git diff`
   succeeds + non-fallback + non-empty; else `chunkRepo`.
4. Structural dedup via `deduplicateByStructure`.
5. Workspace detection.
6. AST graphs: `incrementalGraphUpdate` if possible; else `buildAstGraph`.
   Write `<repo>/graph.json` + `GRAPH_REPORT.md`.
7. Cross-repo edges (14 strategies): `correlateCrossRepoEdges` over per-repo `signals.json` bundles persisted at index time (extracted in the worker while the tree exists).
8. LLM service mesh inference.
9. Louvain community detection.
10. Save `system_graph_v2.json`.
11. Save `chunks.json` + `deleted_files.json`.
12. Per-repo `index_meta.json` writes.

### 19.2 `KnowledgeIndexer.embedChunks(project, config, opts?)`

1. Load `chunks.json`.
2. Open `VectorStore` at `<basePath>/lancedb`.
3. Diff against existing chunk IDs → `newChunks`.
4. Read `deleted_files.json` → `deleteFileChunks` per repo.
5. Embed in batches: `batchSize = 10` for Ollama, `50` otherwise. Delay
   `50` ms / `100` ms between batches.
6. `addChunks(embeddedChunks)`.
7. Update each repo's `index_meta.json` (`embeddingProvider`,
   `lastIndexedAt`).

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
reranker + graph + queryRouter → return `HybridRetriever`.

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
    ├── file-walker.ts                     ← walkDir + langFromExt + import extraction
    ├── git-diff.ts                        ← getAllChanges + helpers
    ├── tree-sitter-parser.ts              ← WASM AST parsing
    ├── structural-hasher.ts               ← canonical hash for dedup + drift
    ├── workspace-detector.ts              ← manifest registry
    │
    ├── ast-graph-builder.ts               ← per-repo 6-phase graph
    ├── cross-repo-detector.ts             ← 14 strategies
    ├── semantic-edge-detector.ts          ← LLM-inferred edges
    ├── graph-metrics.ts                   ← quality reports
    ├── graph-query.ts                     ← traversal helpers
    ├── project-graph-builder-core.ts      ← ProjectGraphBuilder class
    ├── project-graph-builder.ts           ← LLM-powered builder + re-export
    │
    ├── embedder.ts                        ← 6 providers + factory + auto
    ├── vector-store.ts                    ← LanceDB wrapper
    ├── reranker.ts                        ← 4 providers + factory
    ├── query-classifier.ts                ← classifyQuery
    ├── query-router.ts                    ← QueryRouter
    ├── retriever.ts                       ← HybridRetriever (4-phase)
    │
    ├── repo-profiler.ts                   ← profileProject + caching
    ├── service-mesh-inferrer.ts           ← Phase A + Phase B
    ├── rag-evaluator.ts                   ← answer + judge
    │
    ├── indexer.ts                         ← KnowledgeIndexer + path facades
    │
    └── __tests__/
        ├── chunker.test.ts
        ├── query-classifier.test.ts
        ├── retriever-defaults.test.ts
        └── structural-hasher.test.ts
```

## 21. Runtime dependencies

From `package.json`:

- `@anvil/agent-core` — LLM runner shim (`claude-runner.ts`).
- `@lancedb/lancedb` (0.27.2) — vector store.
- `web-tree-sitter` (0.26.8) + `tree-sitter-wasms` (0.1.13) — AST parsing.
- `graphology` (0.26.0) + `-communities-louvain` (2.0.2) +
  `-metrics` (2.4.0) + `-types` (0.24.8) — graph algorithms.

No vendor LLM SDK directly — everything LLM-driven goes through the
agent-core shim.

## 22. Tests

`node --test` runs every compiled `dist/__tests__/*.test.js`:

| Test | Covers |
|---|---|
| `chunker.test.ts` | boundary extraction, language coverage, fallback chunking |
| `query-classifier.test.ts` | identifier/path/error-code/NL detection + weights |
| `retriever-defaults.test.ts` | DEFAULT_CONFIG retrieval shape |
| `structural-hasher.test.ts` | comment stripping, identifier normalization, dedup |
