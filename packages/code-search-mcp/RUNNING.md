# Running code-search-mcp

A step-by-step guide, from a first local index to a shared team server.
Steps 1–5 take about ten minutes; the rest are optional.

1. [Install](#1-install)
2. [Choose an embedder](#2-choose-an-embedder)
3. [Index your code](#3-index-your-code)
4. [Search from the terminal](#4-search-from-the-terminal)
5. [Connect an MCP client](#5-connect-an-mcp-client)
6. [Keep the index fresh](#6-keep-the-index-fresh)
7. [Run a team server](#7-run-a-team-server)
8. [Run it in Docker](#8-run-it-in-docker)
9. [Stateless deployments (object storage)](#9-stateless-deployments-object-storage)
10. [Check, tune and troubleshoot](#10-check-tune-and-troubleshoot)
- [Configuration reference](#configuration-reference)

---

## 1. Install

You need **Node.js 20+** and **git**. For indexing a GitHub organization you
also need the [`gh` CLI](https://cli.github.com) (logged in) or a
`GITHUB_TOKEN`.

```sh
npm install -g @esankhan3/code-search-mcp
code-search --help
```

You get three commands from one install:

| Command | Role |
|---|---|
| `code-search` | CLI: `index`, `query`, `status`, `reset`, `serve`, `mcp`, `daemon` |
| `code-search-mcp` | MCP server: local stdio, HTTP team server, or remote proxy |
| `code-search-daemon` | Long-running indexer that watches files and re-indexes on change |

---

## 2. Choose an embedder

Chunks are embedded once at index time; queries are embedded at search time.
With the default `auto` provider, the first available option wins:

| Option | Setup |
|---|---|
| **Ollama (local, offline)** | `brew install ollama` (or see ollama.com), `ollama serve`, `ollama pull bge-m3` |
| **OpenAI** | `export OPENAI_API_KEY=…` |
| **Voyage** | `export VOYAGE_API_KEY=…` |
| **Mistral Codestral Embed** | `export MISTRAL_API_KEY=…` |
| **Any OpenAI-compatible server** | `export CODE_SEARCH_EMBEDDING_BASE_URL=http://host:port/v1` (plus `_MODEL`, `_DIMENSIONS`, `_API_KEY` as needed) |
| **Gemini** | `export GEMINI_API_KEY=…`, or a logged-in Gemini CLI |

To be explicit instead of relying on detection:

```sh
export CODE_SEARCH_EMBEDDING_PROVIDER=openai
export CODE_SEARCH_EMBEDDING_MODEL=text-embedding-3-small
export CODE_SEARCH_EMBEDDING_DIMENSIONS=1536
```

> **An index is tied to its embedder.** The provider, model and dimensions
> are recorded at index time, and searching with a different embedder fails
> with an error rather than returning nonsense. To switch embedders,
> `code-search reset --project <name>` and index again.

**Reranker (optional).** After fusion, the top results can be re-scored by a
cross-encoder. The default is Ollama with `qwen2.5-coder:7b`
(`ollama pull qwen2.5-coder:7b`); `cohere`, `voyage` and `openai-compatible`
also work. On a machine without it, turn it off. Search falls back to the
fused order either way.

```sh
export CODE_SEARCH_RERANKER_PROVIDER=none
```

---

## 3. Index your code

Point it at one repository or at a folder that contains many. Each git
repository underneath becomes a repo in the index.

```sh
code-search index ~/code --project acme
```

- **Project.** `--project` names the index. Without it the project is
  named after the folder (`code` here). Use the same name everywhere
  (CLI, MCP client, server) so they all share one index.
- **Re-runs are incremental.** Only repositories whose commit or
  uncommitted edits changed are re-processed, and only changed chunks are
  re-embedded. Add `--force` to rebuild from scratch.
- **Where indexes live.** `~/.anvil/knowledge-base/<project>/`. Change it
  with `CODE_SEARCH_DATA_DIR` or `--storage.data-dir`.

**A GitHub organization:** the MCP server can clone and refresh repositories
itself. The pattern is a glob over repository names and is optional.

```sh
gh auth login                       # or export GITHUB_TOKEN=…
code-search-mcp --local "github:my-org/api-*" --project acme
```

Clones go to `~/.code-search/<org>/`.

**What gets indexed:**
- TypeScript, TSX, JavaScript, Python, Go, Java, Rust and PHP, with
  AST-aware chunks and the code graph.
- Shell, YAML, Terraform/HCL, TOML, `Dockerfile`, `Makefile` and
  `Jenkinsfile`, indexed for search.
- `.gitignore` is respected, and `node_modules`, `dist`, `build`, `vendor`
  and similar directories are skipped. Add your own with
  `indexing.ignore_patterns`.

---

## 4. Search from the terminal

```sh
code-search query --project acme "where do we refresh OAuth tokens"
code-search query --project acme "TokenRefresher" --mode bm25 --top-k 5
code-search query --project acme "rate limit" --repo billing --repo gateway --format json
code-search status --project acme
```

| Flag | Meaning |
|---|---|
| `--mode hybrid` (default) | All retrieval tiers, fused, plus graph expansion |
| `--mode vector` | Semantic only |
| `--mode bm25` | Literal: identifiers, partial names, error strings; no embedder needed at query time |
| `--repo <name>` | Restrict to repositories (repeatable) |
| `--format text\|json\|jsonl` | Output format |
| `--top-k N` | Number of results |

`status` prints where the index lives, chunk and repository counts, the
embedder, the last index time and whether a daemon is running.

---

## 5. Connect an MCP client

**Claude Code:**

```sh
claude mcp add code-search -- code-search-mcp --local ~/code --project acme
```

**Claude Desktop** (`claude_desktop_config.json`) or **Cursor**
(`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "code-search": {
      "command": "code-search-mcp",
      "args": ["--local", "/Users/me/code", "--project", "acme"],
      "env": { "CODE_SEARCH_RERANKER_PROVIDER": "none" }
    }
  }
}
```

In this mode the server builds the index on first start if there isn't one,
then serves over stdio. Try asking your agent:

- *"Use code-search to find where webhook retries are scheduled."*
- *"Who calls `chargeCustomer`? Include other repositories."*
- *"What would break if I changed `packages/auth/session.ts`?"*

> Don't run a stdio server and a `code-search-daemon` on the same project at
> the same time. Each one writes the index.

---

## 6. Keep the index fresh

Pick one writer per project:

| Option | How | Best for |
|---|---|---|
| **Daemon** | `code-search-daemon --workspace ~/code` | A developer machine. It watches files, debounces bursts, and re-indexes after each burst. `code-search query` uses it automatically. |
| **Scheduled re-index** | `CODE_SEARCH_REINDEX_INTERVAL=30m` (or `1h`, `6h`) on a server | Team servers. Runs in the background and skips a tick if an index is already running. |
| **On demand** | `POST /index` on a server, or re-run `code-search index` | CI after merges, or manual refreshes |

The daemon names its project after the workspace folder and listens on
`<dataDir>/daemon/<project>.sock`. A second daemon for the same project
refuses to start.

---

## 7. Run a team server

One index, shared by everyone over Streamable HTTP:

```sh
export CODE_SEARCH_AUTH_API_KEYS="key-for-alice,key-for-bob"
export CODE_SEARCH_REINDEX_INTERVAL=30m
code-search-mcp --serve ~/code --project acme --auth api-key --port 3100
```

- **Startup.** The port is bound before the first index runs. `/health`
  answers immediately, and `/ready` returns 503 until the index can serve.
- **MCP endpoint.** `http://<host>:3100/mcp`, stateless: any request can go
  to any process.
- **Binding.** Without auth the server binds to `127.0.0.1` only. With auth
  it binds `0.0.0.0`.

**Connect clients directly over HTTP:**

```sh
claude mcp add --transport http code-search http://search.example.internal:3100/mcp \
  --header "Authorization: Bearer key-for-alice"
```

…or through the **remote proxy**, which works for any stdio-only client:

```json
{
  "mcpServers": {
    "code-search": {
      "command": "code-search-mcp",
      "args": ["--remote", "http://search.example.internal:3100"],
      "env": { "CODE_SEARCH_API_KEY": "key-for-alice" }
    }
  }
}
```

**Auth options:**

| Mode | Settings |
|---|---|
| `none` | Local use only; binds to `127.0.0.1` |
| `api-key` | `CODE_SEARCH_AUTH_API_KEYS` (comma-separated). Clients send `Authorization: Bearer <key>` |
| `jwt` | `CODE_SEARCH_AUTH_JWT_SECRET` (HS256), optional `CODE_SEARCH_AUTH_JWT_ISSUER`. `exp` is required; scopes come from the `scope` claim |

**Scale across cores:** `CODE_SEARCH_WORKERS=4` forks four HTTP workers on
the same port. The primary process does all indexing; workers only serve.
Status, readiness and rate limits are consistent across workers.

**Per-project access and quotas:** create
`<dataDir>/projects/acme/project.yaml`:

```yaml
scopes: [team-payments]        # JWT scope required ("*" = admin; API keys are admin)
quotas:
  max_queries_per_minute: 60   # per caller, sliding window, 429 + Retry-After
```

**Endpoints:**

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | MCP (Streamable HTTP) |
| `GET /health` | Liveness |
| `GET /ready` | 200 once the index can serve |
| `GET /status` | Indexing phase and recent history |
| `GET /version` | Version info |
| `GET /metrics` | Prometheus: queries, latency, errors, index age, chunks per repo, vector-index health |
| `GET /admin/api/status` | JSON status (auth required when auth is on) |
| `POST /index` | `{"path": "/repos", "force": false}` re-indexes the served project (409 if one is running) |

---

## 8. Run it in Docker

`Dockerfile.all-in-one` builds a self-contained image. It contains Node, the
published package, Ollama with `bge-m3` (embedder) and `qwen2.5-coder:7b`
(reranker) pre-pulled, and the `gh` CLI. Expect about 7 GB, mostly model
weights.

```sh
docker build -f Dockerfile.all-in-one -t code-search-mcp:all .

# Index and serve a folder of repositories
docker run --rm -it -p 4000:4000 \
  -e PROJECT_NAME=acme -e INDEX_TARGET=/repos \
  -v ~/code:/repos:ro \
  -v code-search-data:/data -v code-search-models:/var/lib/ollama \
  code-search-mcp:all

# Index a GitHub organization instead
docker run --rm -it -p 4000:4000 \
  -e PROJECT_NAME=acme -e INDEX_TARGET=github:my-org -e GITHUB_TOKEN \
  -v code-search-data:/data -v code-search-models:/var/lib/ollama \
  code-search-mcp:all
```

- **What to index.** `INDEX_TARGET` is a path, `github:<org>[/<pattern>]`,
  or `none` to serve an existing `/data` volume without indexing.
- **Endpoints.** The MCP endpoint is `http://localhost:4000/mcp`.
- **Auth.** The image starts with auth off. Set
  `CODE_SEARCH_AUTH_MODE=api-key` and `CODE_SEARCH_AUTH_API_KEYS` before
  exposing it beyond your machine.

---

## 9. Stateless deployments (object storage)

By default everything lives on local disk under the data directory. For
pods without persistent volumes, move the stores out:

| Store | Setting |
|---|---|
| Vectors and search indexes (LanceDB) | `CODE_SEARCH_STORAGE_VECTOR_URI=s3://bucket/prefix`, with `CODE_SEARCH_STORAGE_S3_ENDPOINT`, `CODE_SEARCH_STORAGE_S3_REGION` (any label works for MinIO) and `CODE_SEARCH_STORAGE_S3_ALLOW_HTTP=true` for plain-HTTP endpoints. Credentials come from `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`. Path-style addressing is used, as MinIO needs. |
| Chunks, graphs, profiles, metadata | `CODE_SEARCH_STORAGE_BLOB_BACKEND=mongo`, `CODE_SEARCH_STORAGE_MONGO_URI`, `CODE_SEARCH_STORAGE_MONGO_DB` |
| Local cache | `CODE_SEARCH_STORAGE_CACHE_DIR`, where readers pull the system graph (an `emptyDir` is fine). `CODE_SEARCH_STORAGE_CACHE_MAX_BYTES` bounds LanceDB's in-memory cache. |

Run **exactly one writer per project**: a server with
`CODE_SEARCH_REINDEX_INTERVAL`, or a scheduled `code-search index` job. Run
any number of read-only servers with `CODE_SEARCH_AUTO_INDEX=false`.
Readers notice a new index generation within about 30 seconds and reopen it.

---

## 10. Check, tune and troubleshoot

**See what it's actually using:**

```sh
code-search --print-config          # resolved config, secrets redacted
code-search status --project acme   # index location, counts, embedder, daemon
```

From an agent, the `index_status` tool reports chunks per repo, the
embedder, the last index time and vector-index health: unindexed rows and
the auto-calibrated IVF partitions probed per query.

**Common problems:**

| Symptom | Fix |
|---|---|
| `No embedding provider available` | Start Ollama and `ollama pull bge-m3`, or set an API key (step 2). |
| Error about an embedding provider, model or dimension mismatch | The index was built with another embedder. Use the original settings, or `code-search reset --project <name>` and re-index. |
| `Ollama reranker model … returned empty content` | Pull `qwen2.5-coder:7b`, choose another reranker, or set `CODE_SEARCH_RERANKER_PROVIDER=none`. |
| The CLI and the MCP client see different results | They're using different project names. Pass the same `--project` to both. |
| Exit status 2 at startup | An unknown flag or invalid value. The message names it. |
| `/ready` stays 503 | The first index is still running. Watch `GET /status` or the server log. |
| Slow natural-language queries under load on a very large index | Cap probes per query with `CODE_SEARCH_VECTOR_NPROBES` (e.g. 10–15% of the partition count shown by `index_status`). This trades a little recall for throughput. |

**Start over:** `code-search reset --project acme` deletes that project's
index. Nothing outside `<dataDir>/<project>` is touched.

---

## Configuration reference

Precedence, lowest to highest:
1. built-in defaults
2. `~/.code-search/config.yaml`
3. `<workspace>/.code-search.yaml`
4. `CODE_SEARCH_*` environment variables
5. CLI flags

Every setting is also a flag: `--<dotted.path> <value>`, e.g.
`--retrieval.max-chunks 12` or `--no-indexing.auto-index`.

### Embedding and reranking

| Variable (`CODE_SEARCH_…`) | Default | Purpose |
|---|---|---|
| `EMBEDDING_PROVIDER` | `auto` | `auto`, `ollama`, `openai`, `voyage`, `codestral`, `openai-compatible`, `gemini-oauth`, `custom` |
| `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | per provider / `1024` | Model and vector size |
| `EMBEDDING_API_KEY` / `EMBEDDING_BASE_URL` | none | Credentials and endpoint |
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama endpoint |
| `RERANKER_PROVIDER` | `ollama` | `ollama`, `cohere`, `voyage`, `openai-compatible`, `custom`, `none` |
| `RERANKER_MODEL` / `RERANKER_API_KEY` / `RERANKER_BASE_URL` | `qwen2.5-coder:7b` for Ollama | Reranker settings |

### Retrieval

| Variable (`CODE_SEARCH_…`) | Default | Purpose |
|---|---|---|
| `RETRIEVAL_MAX_CHUNKS` / `RETRIEVAL_MAX_TOKENS` | `8` / `12000` | Size of each answer |
| `VECTOR_NPROBES` | auto-calibrated | Fixed IVF partitions probed per query |
| `RRF_K` | `10` | Rank-fusion constant |

### Indexing and storage

| Variable (`CODE_SEARCH_…`) | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `~/.anvil/knowledge-base` | Index root |
| `AUTO_INDEX` | `true` | Build the index on server start if missing |
| `REINDEX_INTERVAL` | `0` (off) | `30m`, `1h`, `6h` |
| `INDEXING_DEBOUNCE_MS` | `500` | Daemon watcher debounce |
| `CHUNKING_MAX_TOKENS` | `500` | Chunk size cap |
| `INDEX_CONCURRENCY` | auto | Repositories processed in parallel |
| `VECTOR_RETRAIN_RATIO` | `1` | Retrain the vector index after this much growth (`0` = never) |
| `LANCE_RETENTION_HOURS` | `1` | How long superseded index versions are kept |
| `STORAGE_*` | local disk | See [step 9](#9-stateless-deployments-object-storage) |
| `GITHUB_TOKEN` | none | For `github:` sources |

### Server

| Variable (`CODE_SEARCH_…`) | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3100` / `127.0.0.1` | Bind address |
| `AUTH_MODE` | `none` | `none`, `api-key`, `jwt` |
| `AUTH_API_KEYS` | none | Comma-separated keys |
| `AUTH_JWT_SECRET` / `AUTH_JWT_ISSUER` | none / `code-search-mcp` | JWT validation |
| `RATE_LIMIT_PER_MINUTE` | `100` | Per caller, sliding window |
| `WORKERS` | `1` | HTTP worker processes (2–16) |
| `SERVER` / `API_KEY` | none | Remote-proxy target and key |

### LLM enrichment (optional)

| Variable (`CODE_SEARCH_…`) | Default | Purpose |
|---|---|---|
| `LLM_MODE` | `none` | `api` or `cli` turns on LLM-written repository profiles and service-mesh inference |
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` / `LLM_BASE_URL` | `anthropic` / `sonnet` | LLM settings |

### Observability

| Variable (`CODE_SEARCH_…`) | Default | Purpose |
|---|---|---|
| `STRUCTURED_LOGS` | `false` | One JSON object per log line |
| `TELEMETRY_RECORD_QUERIES` | `false` | Include query text in traces |
| `OTEL_ENDPOINT` / `OTEL_HEADERS` | none | OpenTelemetry export |
