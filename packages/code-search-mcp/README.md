# @esankhan3/code-search-mcp

**Your whole codebase, in any MCP client.**

A Model Context Protocol server that wraps `@anvil/knowledge-core`
behind an MCP-compliant tool surface. Point Claude Code, Claude
Desktop, or Cursor at it and your agent gains hybrid search,
caller tracing, and impact analysis across every repo you've
indexed — local or remote.

---

## Why "code search" needs more than grep

MCP gave us a clean way to expose tools to LLM agents. What's
missing is a *good* tool to expose. `grep` over your repo answers
"where is this string." Vector search over your repo answers
"what's semantically near this." Neither answers "who calls this
function and which other repos depend on it."

**code-search-mcp gives agents the answer.** Same hybrid retriever
that powers Anvil's pipelines, exposed through MCP. Agents get
AST-aware chunks, cross-repo graph traversal, and a whole-project
view — without you writing a single tool.

```jsonc
// claude_desktop_config.json
{
  "mcpServers": {
    "code-search": {
      "command": "code-search-mcp",
      "args": ["--local", "/path/to/your/projects"]
    }
  }
}
```

That's the whole setup. Claude Desktop now knows your codebase.

---

## Three modes, one binary

### Remote proxy (default)
```sh
code-search-mcp                  # default — proxies to remote
code-search-mcp --remote URL
```
Spawns a stdio MCP server that forwards to a remote HTTP server.
Zero local setup, zero local index — perfect for hosted
deployments where the index lives in the cloud and dev machines
stay light. Auth via `CODE_SEARCH_API_KEY`.

### Local
```sh
code-search-mcp --local /path/to/repos
code-search-mcp --local github:my-org/my-pattern
```
Discovers every repo under a path (or clones a GitHub org), builds
the knowledge base, and serves over stdio. Works fully offline if
your embedder + reranker are local (Ollama).

### Serve
```sh
code-search-mcp --serve --port 4000 --auth api-key
```
Boots an HTTP server (Streamable HTTP transport, SSE optional)
with `/mcp`, `/health`, `/status`, and an admin `POST /index`. Use
this to host one index for a whole team — every dev points their
client at the same URL.

---

## Tool surface

Eleven tools across four categories. Every one of them maps to a
function in `@anvil/knowledge-core` — you're getting the same
retrieval pipeline that powers the Anvil dashboard.

### Search
| Tool | What it does |
|---|---|
| `search_code` | Hybrid retrieval — vector + BM25 + graph + rerank |
| `search_semantic` | Vector-only (paraphrases, intent) |
| `search_exact` | BM25-only (identifiers, error codes) |

### Graph
| Tool | What it does |
|---|---|
| `get_repo_graph` | Single-repo AST graph |
| `get_cross_repo_edges` | Inter-repo edges (Kafka, HTTP, gRPC, shared types, …) |
| `find_callers` | Who calls this function |
| `find_dependencies` | What this function calls |
| `impact_analysis` | What breaks if this changes |

### Profiles
| Tool | What it does |
|---|---|
| `list_repos` | All indexed repos with profiles |
| `get_repo_profile` | Single repo's tech stack, structure, key entry points |

### Index
| Tool | What it does |
|---|---|
| `index_status` | Last indexed SHA, chunk count, embedding provider |

Plus four MCP resources via `code-search://`:
`repos`, `system-graph`, `repo/{name}/profile`, `repo/{name}/graph`.

---

## What makes the search good

This isn't a thin wrapper. The retrieval pipeline runs:

1. **Vector ⫽ BM25 in parallel** — semantic + lexical recall.
2. **Reciprocal Rank Fusion** — combine without one dominating.
3. **AST tripartite expansion** — pull in callers, callees, type
   refs via the project graph.
4. **Cross-encoder rerank** — Qwen3-Reranker by default; Cohere /
   Voyage / OpenAI-compatible swappable.

A query classifier picks adaptive weights — identifier queries
lean BM25, natural-language leans vector, error codes lean both.
You don't tune anything; the retriever does it per query.

---

## Multi-repo by design

Unlike single-repo code-search MCPs, this one is built for the
real world: a team has *many* repos, and the interesting
questions cross them. Where does this Kafka topic get consumed?
Which services depend on this proto? What service-mesh edges
exist between web and api?

Fourteen cross-repo edge strategies cover shared types, Kafka,
HTTP, gRPC, databases, env vars, npm/workspace deps, k8s,
docker-compose, proto, Redis, S3, and shared constants. Plus an
LLM-inferred semantic edge layer. `find_callers` works *across
repos*. So does `impact_analysis`.

---

## Server features

### Auth, three flavors
`none` (local-only, default 127.0.0.1 binding), `api-key`
(`Authorization: Bearer ...`, timing-safe compare), `jwt` (HS256,
signature + `exp` + `iss` validated). Public binding without auth
logs a warning, because that's what should happen.

### Rate limiting
In-memory sliding 1-minute window keyed by identity subject. Tune
per-deployment.

### Auto-reindex
`CODE_SEARCH_REINDEX_INTERVAL=30m` (or `1h`, `6h`, `0` to disable)
runs an incremental re-index in the background. Skips itself if a
manual index is already running. The timer is `unref`'d so it
doesn't keep the process alive.

### Status tracking
Every index call lands in a 50-entry FIFO history with start
timestamp, success / error, last duration. Available at
`GET /status`.

### Streamable HTTP sessions
Per-session `StreamableHTTPServerTransport`, max 100 concurrent
sessions, 30 min TTL. The remote proxy captures `mcp-session-id`
for continuity. SSE transport available as a fallback.

### Admin index endpoint
`POST /index` with `{ project, dirPath?, opts? }` triggers a
fresh index. Gated against concurrent runs. Auth-required when
auth is on.

---

## How it fits with the rest of Anvil

```
                    ┌─────────────────────────┐
                    │   MCP client            │
                    │   (Claude Code,         │
                    │    Claude Desktop,      │
                    │    Cursor, …)           │
                    └────────────┬────────────┘
                                 │ stdio / HTTP
                                 ▼
                    ┌─────────────────────────┐
                    │   code-search-mcp       │
                    │   (this package)        │
                    │   tools + resources     │
                    └────────────┬────────────┘
                                 │ wraps
                                 ▼
                    ┌─────────────────────────┐
                    │   @anvil/knowledge-core │
                    │   AST chunks +          │
                    │   project graph +       │
                    │   hybrid retriever      │
                    └────────────┬────────────┘
                                 │ on disk
                                 ▼
                    ~/.anvil/knowledge-base/<project>/
```

Three different fronts, one knowledge stack:

- **The CLI** indexes via `anvil index` and retrieves during
  pipelines.
- **The dashboard** browses the project graph and surfaces
  retrieval results in pipeline UI.
- **code-search-mcp** exposes the same retriever to any MCP
  client.

If you've already indexed a project with `anvil index`, this
server picks it up — same `~/.anvil/knowledge-base/` path, same
LanceDB store, same graph files.

---

## Configuration

Everything is `CODE_SEARCH_*` env vars, single source of truth in
`src/core/env-config.ts`:

| Var | What it does |
|---|---|
| `CODE_SEARCH_SERVER` | Remote URL (proxy mode) |
| `CODE_SEARCH_API_KEY` | API key for proxy or serve modes |
| `CODE_SEARCH_DATA_DIR` | Override `~/.anvil/knowledge-base` |
| `CODE_SEARCH_REINDEX_INTERVAL` | `30m` / `1h` / `6h` / `0` |
| `EMBEDDING_PROVIDER` | `auto` / `voyage` / `openai` / `ollama` / … |
| `EMBEDDING_API_KEY` | Bridged to provider-specific var |
| `RERANKER_PROVIDER` | `ollama` / `cohere` / `voyage` / `none` |
| `OLLAMA_HOST` | Default `http://localhost:11434` |

---

## Philosophy

**Multi-repo or nothing.** Real codebases span repos. Code search
that doesn't is a toy.

**No vendor LLM SDK.** Anything LLM-driven (repo profiling,
semantic edges) routes through `@anvil/agent-core`'s single-shot —
the same router, retries, and cost ledger as the rest of Anvil.

**Three modes, one binary.** Remote proxy for hosted, local for
solo, serve for teams. The dispatcher is `src/index.ts:argv`.

**Stateless sessions.** HTTP sessions are in-memory by design.
Restart drops them; clients re-init on first request. No persistent
session store to maintain.

**Security defaults that don't bite.** Default bind is `127.0.0.1`
when auth is `none`. API keys compared timing-safe. JWT
signature + exp + iss validated. Public binding without auth
logs a warning instead of pretending it's fine.

---

## Status

Stable. The retrieval and graph layers move with
`@anvil/knowledge-core`; the MCP surface is locked. New tools
land additively.

---

## Part of [Anvil](../../) — the AI development pipeline.
