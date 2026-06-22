# code-search-mcp — Graph-Navigation Tools Plan

**Status:** Proposed
**Date:** 2026-06-22
**Owner:** code-search-mcp
**Scope:** `packages/code-search-mcp` (query layer only). No `knowledge-core` indexer changes in Phase 1–2.

---

## 1. Motivation

A capability comparison against `DeusData/codebase-memory-mcp` found that our
retrieval quality (RRF fusion + AST expansion + cross-encoder rerank) and our
multi-repo / deployable-service model are ahead, but our **graph-query surface
is behind**. Their differentiator is a cheap "walk the graph" loop for agents:
`trace_path`, `get_code_snippet`, `search_graph`, `detect_changes`,
dead-code, `get_architecture`.

The good news: **the building blocks for all of these already exist in
`@anvil/knowledge-core`** and on disk. These tools are *pure readers* of
artifacts the current indexer already writes. We are exposing capability, not
adding pipeline cost.

Today's tool surface (11): `search_code`, `search_semantic`, `search_exact`,
`get_repo_graph`, `get_cross_repo_edges`, `find_callers`, `find_dependencies`,
`impact_analysis`, `list_repos`, `get_repo_profile`, `index_status`.

After this plan (17): + `get_code_snippet`, `trace_path`, `get_architecture`,
`find_dead_code`, `search_graph`, `detect_changes` — plus a precision fix to
`find_callers` / `find_dependencies`.

---

## 2. Background — what these tools are and why they help

### 2.1 Searching vs. navigating

The server today answers two kinds of question:

- **"Where is this string?"** → `search_exact` (BM25 / grep-like).
- **"What's semantically near this?"** → `search_semantic` (vector).

Both return *starting points* — lists of places that look relevant. Neither
explains how things **connect**. The new tools answer a third kind:

> "Who calls this? What breaks if I change it? How does a request flow from the
> API handler to the database? Show me the actual code for `AuthService.login`."

That is **graph navigation**. The indexer already builds the graph — nodes are
functions/classes addressed as `repo::file::entity`, edges are relationships
(`calls`, `imports`, `inherits`, `http`, …), each with a `confidence` score.
These tools let an agent *walk* that graph instead of re-reading files.

### 2.2 Concepts used in this plan

| Term | Meaning |
|---|---|
| **Qualified name / node id** | A globally unique address for a symbol, e.g. `petshop::src/auth.ts::login`. No ambiguity between two `login`s in different files. |
| **Hop** | One step along an edge. `A calls B` is 1 hop; `A → B → C` is 2 hops. "Multi-hop" = follow a chain. |
| **BFS (breadth-first search)** | Standard graph traversal, outward level by level — used to trace call chains up to N hops. |
| **In-degree / out-degree** | How many edges point *at* a node vs. *out of* it. In-degree 0 → no callers → likely **dead code**. |
| **Confidence-scored edge** | Edges aren't certain (dynamic dispatch, etc.), so each has a 0–1 score. Tools follow only `confidence ≥ 0.7` edges to avoid garbage chains (same threshold as `retriever.ts:tripartiteExpand`). |

### 2.3 Why each tool is better than what an agent does today

| Tool | The question it answers | Why it beats search / file-reading |
|---|---|---|
| `get_code_snippet` | "Show me the source for `repo::file::login`." | Returns ~30 lines for one symbol instead of forcing the agent to read a 2,000-line file. The missing link that makes every other graph tool usable. |
| `trace_path` | "How does a request get from `handleRequest` to `db.query`?" | Multi-hop. Current `find_callers`/`find_dependencies` are **1 hop**; real flows are chains. One call vs. ~5 manual file reads stitched together. |
| `get_architecture` | "Give me the lay of the land." | Orients an agent *before* it digs, using the LLM-narrated profiles/project-graph we already produce. Richer than a purely structural overview. |
| `find_dead_code` | "What has zero callers?" | Free byproduct of the graph (`graph-metrics` already computes orphan entities). We just don't expose it. |
| `search_graph` | "List classes in `auth.ts` with >5 callers." | Ranks by **structural role** (degree), not text similarity — a question only a graph can answer. |
| `detect_changes` | "I changed these files — what's affected?" | Turns "edited 3 files" into "12 dependent call sites across 4 repos." A blast-radius / code-review tool. |
| precision fix | "Find callers of `get`." | Today substring-matches, so it also returns `getUser`, `getCache`… The fix resolves the exact symbol. Correctness — a silently-wrong answer is worse than none. |

### 2.4 Why this matters specifically for AI agents

An agent has a finite context window and pays latency + tokens for everything
it reads. The expensive way to understand code is to read files; the cheap way
is to ask the graph a precise question and get back exactly the node, chain, or
snippet needed.

- **Token economics** — `get_code_snippet` returns one function, not a file.
- **Fewer round-trips** — `trace_path` answers in one call what would be 5
  reads plus manual stitching.
- **Higher accuracy** — exact qualified-name resolution + confidence-filtered
  edges beat substring guesses and "read and hope."

And these are new *answers*, not new *cost*: the intelligence already sits in
`system_graph_v2.json` and `graph.json` — it just has no door to walk through.

---

## 3. Guiding principle — query-layer only, forward-compatible

Every tool in Phase 1–2 **reads existing on-disk artifacts**. None changes the
write path or the artifact schema. Therefore a KB built by the *current*
version is fully compatible with the new tools.

**No reindex. No re-embed. Not even AST-graph recreation. Build + redeploy.**

See §10 for the full deployment guarantee.

---

## 4. Artifacts read (proof of zero schema change)

| Artifact | Written by | Consumed by new tool |
|---|---|---|
| `<KB>/<project>/lancedb/` | `embedChunks` | `get_code_snippet` (via `vectorStore.getChunksByEntity`) |
| `<KB>/<project>/system_graph_v2.json` | `buildKB` | `trace_path`, `search_graph`, precision fix |
| `<KB>/<project>/<repo>/graph.json` | `buildKB` | `find_dead_code`, `detect_changes`, `search_graph` (repo-scoped) |
| `<KB>/<project>/PROJECT_SUMMARY.md`, `PROJECT_GRAPH.json` | `buildProjectGraph` (LLM, optional) | `get_architecture` |
| `<KB>/<project>/<repo>/profile.json` | `profileProject` (LLM, optional) | `get_architecture` |
| `<repo>/.git` (live) | — | `detect_changes` (git diff at query time) |

Node id convention (already produced today): `repo::filePath::entity`
(module nodes: `repo::filePath`). Edges carry `attributes.type` /
`attributes.relation` and `attributes.confidence`.

---

## 5. Phase 1 — Tier 1 tools (high value, low effort)

All implemented in `src/tools/graph.ts` (existing `registerGraphTools()` +
`handleGraphTool(name, args, ctx)` pattern), except `get_code_snippet` which
fits naturally in `src/tools/search.ts` (it touches the vector store).

### 5.1 `get_code_snippet` — fetch source by qualified name

> **The single biggest UX gap.** Today an agent can list graph nodes but
> cannot pull the source for one.

- **Input:**
  ```jsonc
  { "id": "repo::path/to/file.ts::funcName",   // either this…
    "repo": "string", "file": "string", "entity": "string" } // …or these
  ```
- **Reads:** `getRetriever(project).vectorStore.getChunksByEntity([...])` —
  this method already exists and is used at `retriever.ts:176`. Supports
  3-part (`repo::file::entity`) and 2-part (`repo::file`) lookups.
- **Implementation:** parse `id` into `{ repoName, filePath, entityName }`
  (same split logic as `retriever.ts:166-174`), call `getChunksByEntity`,
  format the chunk's `content` with a `repo/file:startLine` header + language
  fence. Fallback: if the store returns nothing, read `chunks.json` and match
  on `entityName`/`filePath` (keeps it working before/without embeddings).
- **Output:** markdown source block (or "no snippet found for `<id>`").
- **Guards:** requires an index on disk; degrades to `chunks.json` fallback.

### 5.2 `trace_path` — multi-hop call-chain BFS

> Today `find_callers`/`find_dependencies` are **1 hop**. This generalizes to
> N hops and optional shortest-path between two symbols.

- **Input:**
  ```jsonc
  { "from": "funcName | repo::file::entity",
    "to": "funcName | qualified id (optional)",
    "repo": "string (optional)",
    "direction": "callees | callers | both (default callees)",
    "maxDepth": 4 }
  ```
- **Reads:** `system_graph_v2.json` (nodes + edges).
- **Implementation (inline BFS over the edge list — matches existing
  `graph.ts` style, no new dep):**
  1. Resolve `from` (and `to`) to node keys using the **precise resolver**
     from §5.5 (exact `repo::file::entity`, then exact label, then substring
     only if `fuzzy:true`).
  2. Build adjacency once: `out[src].push(tgt)` / `in[tgt].push(src)` from
     `edges`, skipping `attributes.type === 'contains'` and edges with
     `confidence < 0.7` (same thresholds as `retriever.ts:tripartiteExpand`).
  3. BFS to `maxDepth`. If `to` is set → return the shortest path(s); else →
     return the reachable tree, capped (e.g. 50 nodes).
- **Output:** path lines `A → B → C (calls)`; or "no path within `<maxDepth>`".
- **Caveat:** dynamic dispatch / interface calls may break a real chain
  (state this in the description).

### 5.3 `get_architecture` — project overview

> We have *richer* material than codebase-memory here (LLM-narrated), just no
> single tool.

- **Input:** `{ "repo": "string (optional)" }`
- **Reads:** `loadProjectSummary(project)`, `loadProjectGraph(project)`,
  `loadAllProfiles(project)` — all already exported from knowledge-core.
  With `repo` → also `loadProfile(project, repo)`.
- **Implementation:** assemble `architectureSummary` + `repoRoles` +
  `keyFlows` from `PROJECT_GRAPH.json`; append the repo list with roles/domains
  from profiles.
- **Output:** markdown overview.
- **Degradation ladder:** project graph present → full narrative; only
  profiles present → repo roles list; neither → list repos from
  `list_repos`/`discoverRepos` and note "run profiling for a richer
  architecture view." **Never errors on a missing optional artifact.**

### 5.4 `find_dead_code` — zero-caller entities

- **Input:** `{ "repo": "string", "limit": 50 }`
- **Reads:** `<repo>/graph.json`. Optionally reuse
  `graph-metrics.ts:generateGraphQualityReport` (already computes
  `orphanEntities`).
- **Implementation:** entity nodes (`type` ∈ function/method/class) whose
  in-degree (excluding `contains`) is 0. Exclude exported entry points where
  detectable (heuristic).
- **Output:** list of `entity (file)` candidates.
- **Caveat:** heuristic — exported API, reflection, DI, and dynamic dispatch
  cause false positives. State this in the description.

### 5.5 Precision fix — `find_callers` / `find_dependencies`

> Current code substring-matches labels (`graph.ts:139`
> `label.includes(funcName)`), so `"get"` matches `getUser`, `getCache`, …

- **Change:** add a shared `resolveEntityNodes(nodes, { name, repo, fuzzy })`
  helper in `graph.ts`:
  - prefer `label === name` **or** `key` endsWith `::name`;
  - only fall back to substring when `fuzzy: true` (new optional arg,
    default `false`).
- Use this resolver in `find_callers`, `find_dependencies`, `trace_path`,
  `impact_analysis`, and `get_code_snippet` so resolution is consistent.

---

## 6. Phase 2 — Tier 2 tools (high value, medium effort)

### 6.1 `search_graph` — structural query

- **Input:**
  ```jsonc
  { "name": "regex/substring (optional)",
    "type": "function | class | interface | … (optional)",
    "file": "path pattern (optional)",
    "repo": "string (optional)",
    "minDegree": 0, "limit": 50 }
  ```
- **Reads:** `system_graph_v2.json` (or `<repo>/graph.json` when `repo` set).
- **Implementation:** filter nodes by the predicates; compute degree from the
  edge list; sort by degree desc; return top `limit`.
- **Output:** `node (type, file, degree)` rows.

### 6.2 `detect_changes` — git diff → affected symbols

> Pairs with the existing `impact_analysis`. We already do git-diff for
> *incremental indexing*; this exposes it as a *query*.

- **Input:** `{ "repo": "string", "baseSha": "string (optional)", "limit": 50 }`
- **Reads:** `getAllChanges(repoPath, baseSha)` from `git-diff.ts`
  (`{ added, modified, deleted, renamed, fallbackToFull }`) + `<repo>/graph.json`.
- **Implementation:** map changed files → entity nodes in those files →
  incoming edges (dependents). Reuse the dependents logic from
  `impact_analysis` (`graph.ts:165-205`).
- **Output:** changed files + affected entities + dependent repos.
- **Guard:** needs a local repo path — only available in `local`/`serve`
  modes where `ctx.directoryPath` is set. Returns a clear message in `remote`
  mode.

---

## 7. Phase 3 — optional follow-ups (separate PRs)

These **do** touch the indexer / boot path — ship separately, each with its
own risk review.

### 7.1 Offline "lite" mode (no embedder)

Closes codebase-memory's biggest UX advantage (works with zero setup).
- Detect that no embedder is resolvable at boot; instead of hard-blocking,
  build a **BM25-only** index (`buildKBFromPath` without `embedFromPath`) and
  let `search_code` degrade to `bm25` mode.
- `search_semantic` returns a clear "no embedder configured" message.
- **Touches:** `server.ts:autoIndex`, `search.ts` mode selection, possibly a
  `--no-embed` flag. **Still no re-embed of existing KBs.**

### 7.2 More tree-sitter languages

`tree-sitter-wasms` ships ~25+ grammars; we use 8. Add C/C++/C#/Ruby/Kotlin/
Scala via `GRAMMAR_MAP` (`tree-sitter-parser.ts`) + `langFromExt`
(`file-walker.ts`).
- **This is the only item that needs an AST-graph rebuild** for repos in the
  newly-supported languages — fast, local, no network, **and never triggers
  re-embedding** (chunk IDs stable unless the chunker changes).

### Explicitly out of scope
- `query_graph` (full Cypher) — `search_graph` + `trace_path` cover ~80%;
  revisit only on user demand.
- `manage_adr` — belongs in `memory-core`, not here.
- `ingest_traces`, 3D viz — low priority (dashboard package already exists).
- C rewrite — would forfeit serve/remote/daemon/multi-tenant. No.

---

## 8. Wiring

For each new tool, in `src/server.ts:createMcpServerInstance`:
1. `allTools.push(...registerGraphTools())` already spreads the array — just
   add the descriptors in `registerGraphTools()`.
2. The dispatch `if` chain already routes to `handleGraphTool` /
   `handleSearchTool`; extend the `name` allow-list arrays in each handler.

No new handler files needed (`get_code_snippet` → `search.ts`, the rest →
`graph.ts`).

---

## 9. Tests

Add `src/__tests__/graph-tools.test.ts` (knowledge-core stays untouched, so
tests live here):
- Fixture `system_graph_v2.json` + a `graph.json` under a temp KB dir
  (`CODE_SEARCH_DATA_DIR`).
- Assert: `trace_path` finds a known 3-hop chain and respects `maxDepth`;
  precision fix does **not** match `get` against `getUser`; `find_dead_code`
  flags a zero-in-degree entity; `search_graph` filters by type + minDegree;
  `get_architecture` degrades cleanly when `PROJECT_GRAPH.json` is absent.
- `get_code_snippet`: unit-test the id-parse + `chunks.json` fallback path
  (avoid requiring a live LanceDB in CI).

Run: `node --test packages/code-search-mcp/dist/__tests__/*.test.js`.

---

## 10. Deployment — no-reindex guarantee

| Change | Reindex? | Re-embed? | AST rebuild? | Action |
|---|---|---|---|---|
| Phase 1 (Tier 1 tools + precision fix) | No | No | No | `npm run build` + redeploy |
| Phase 2 (`search_graph`, `detect_changes`) | No | No | No | build + redeploy |
| Phase 3.1 (offline lite mode) | No (new KBs only) | No | No | build + redeploy |
| Phase 3.2 (new languages) | No | **No** | **Yes**, affected repos only | incremental `buildKB` (fast, local) |

The expensive `lancedb/` embeddings are rebuilt **only** on
`reset`/`--force`, an embedding-provider swap (guarded by the
`index_meta.json` `embeddingProvider` hard-error in `getRetriever`), or a
chunk-boundary change. None of those is in scope for Phase 1–2.

---

## 11. Docs to update

- `packages/code-search-mcp/ARCHITECTURE.md` §7.2 — graph tool table.
- `packages/code-search-mcp/CLAUDE.md` — "Tools (4 categories, 11 tools)"
  → 17; add the new tools to the Graph/Search bullets and "Adding a new tool".
- `README.md` — tool list / capabilities table.

---

## 12. Sequencing & estimate

1. **PR 1 (Phase 1)** — `get_code_snippet`, `trace_path`, `get_architecture`,
   `find_dead_code`, precision fix, tests, docs. ~1 day.
2. **PR 2 (Phase 2)** — `search_graph`, `detect_changes`. ~half day.
3. **PR 3 (Phase 3.1)** — offline lite mode (own risk review). ~1 day.
4. **PR 4 (Phase 3.2)** — language expansion (needs AST rebuild note in
   release). ~half day.

Recommended first move: **PR 1** — it delivers the "navigate the graph
cheaply" loop that is codebase-memory's real differentiator, using code that
already exists, with zero index migration.
