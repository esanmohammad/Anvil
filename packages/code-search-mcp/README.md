<div align="center">

<br/>

# Code Search MCP

**Multi-repo code intelligence via the Model Context Protocol**

Give any MCP client deep understanding of your codebase — semantic search,
dependency graphs, cross-repo analysis, and impact tracing.

<br/>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](../../LICENSE)
[![MCP](https://img.shields.io/badge/protocol-MCP%201.0-7C3AED?style=flat-square)](https://modelcontextprotocol.io)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?style=flat-square&logo=node.js&logoColor=white)]()
[![Docker](https://img.shields.io/badge/docker-ready-2496ED?style=flat-square&logo=docker&logoColor=white)]()

<br/>

[Quick Start](#quick-start) · [Tools](#tools) · [Deployment](#deployment) · [Configuration](#configuration)

</div>

---

## What is this?

Point it at a local directory or a GitHub organization. It discovers repos, parses code with tree-sitter, builds vector embeddings, constructs AST graphs, detects cross-repo dependencies — then exposes **12 tools** via MCP that your AI can call to search, navigate, and reason about your code.

Works with **Claude Desktop**, **Claude Code**, **Cursor**, and any MCP-compatible client.

**Two roles, clean separation:**

| Role | What it does | What it needs |
|:--|:--|:--|
| **Client** (default) | Connects to a remote server via MCP | URL + API key |
| **Server** | Hosts repos, indexes, serves tools | Repos, Docker, embedding API |

---

## Quick Start

### For users — connect to a server

The default mode is **remote proxy**. No repos, no index, no GPU needed on your machine.

```json
{
  "mcpServers": {
    "code-search": {
      "command": "code-search-mcp",
      "env": {
        "CODE_SEARCH_SERVER": "https://your-server:3100",
        "CODE_SEARCH_API_KEY": "your-api-key"
      }
    }
  }
}
```

That's it. Claude Desktop, Cursor, or any MCP client can now search your entire codebase.

### For infra — deploy the server

```bash
# Option 1: Docker (recommended)
cp .env.example .env    # configure embedding API key + auth keys
docker compose up

# Option 2: Direct
code-search-mcp --serve --port 3100 --auth api-key

# Option 3: Docker with local Ollama for free embeddings
docker compose --profile with-ollama up
```

### For development — local mode

Run everything on your machine (indexing + serving):

```bash
code-search-mcp --local /path/to/your/repos
code-search-mcp --local github:your-org --token ghp_xxx
```

---

## Tools

12 tools exposed via MCP:

### Search

| Tool | Description |
|:--|:--|
| `search_code` | Hybrid search — vector + BM25 + graph expansion + cross-encoder reranking |
| `search_semantic` | Vector-only semantic search for conceptual queries |
| `search_exact` | BM25 keyword search for exact names, error codes, paths |

### Graph & Analysis

| Tool | Description |
|:--|:--|
| `get_repo_graph` | AST knowledge graph — entities and relationships for a repo |
| `get_cross_repo_edges` | Connections between repos — shared deps, Kafka, HTTP, DB, gRPC |
| `find_callers` | All functions that call a given function across the codebase |
| `find_dependencies` | What a function depends on — calls, imports, types |
| `impact_analysis` | Trace what's affected if a file or entity changes |

### Profiles

| Tool | Description |
|:--|:--|
| `list_repos` | All indexed repos with role, domain, description |
| `get_repo_profile` | LLM-generated profile — role, tech stack, endpoints |

### Index

| Tool | Description |
|:--|:--|
| `index_status` | Chunk count, embedding provider, repos, last indexed |
| `reindex` | Trigger re-index (incremental — only changed files) |

---

## Deployment

### Docker

The Docker image bundles everything. Configure entirely via environment variables.

```yaml
# docker-compose.yml
services:
  code-search:
    build: .
    ports:
      - "3100:3100"
    volumes:
      - code-search-data:/data      # persistent index
      - ./repos:/repos:ro            # your repos (read-only)
    environment:
      CODE_SEARCH_TRANSPORT: streamable-http
      CODE_SEARCH_AUTH_MODE: api-key
      CODE_SEARCH_AUTH_API_KEYS: ${CODE_SEARCH_API_KEY}
      CODE_SEARCH_EMBEDDING_PROVIDER: codestral
      CODE_SEARCH_EMBEDDING_API_KEY: ${EMBEDDING_API_KEY}
```

**Volumes:**
- `/data` — LanceDB indices, graph files (persistent)
- `/repos` — mounted repositories (read-only)

**Health check:** `GET /health` returns index status, uptime, auth mode, active sessions.

### Authentication

| Mode | How it works |
|:--|:--|
| `none` (default for stdio) | No auth — process boundary is the security boundary |
| `api-key` | `Authorization: Bearer <key>` checked against allowlist |
| `jwt` | HS256 JWT verification with expiry + issuer validation |

Rate limiting: in-memory sliding window per identity (default 100 req/min).

---

## Embedding Providers

Use any embedding provider. Auto-detection tries them in order.

| Provider | Env var | Notes |
|:--|:--|:--|
| Ollama (local) | `OLLAMA_HOST` | Free, default `bge-m3` model |
| Mistral/Codestral | `MISTRAL_API_KEY` | `codestral-embed-2505` |
| OpenAI | `OPENAI_API_KEY` | `text-embedding-3-large` |
| Voyage AI | `VOYAGE_API_KEY` | `voyage-code-3` |
| Gemini | OAuth via `~/.gemini/` | `text-embedding-004` |
| **Any OpenAI-compatible** | `CODE_SEARCH_EMBEDDING_BASE_URL` | Bring your own provider |

### Bring Your Own Provider

Any service with an OpenAI-compatible `/v1/embeddings` endpoint:

```bash
CODE_SEARCH_EMBEDDING_PROVIDER=custom
CODE_SEARCH_EMBEDDING_BASE_URL=https://api.together.xyz
CODE_SEARCH_EMBEDDING_MODEL=togethercomputer/m2-bert-80M-8k-retrieval
CODE_SEARCH_EMBEDDING_API_KEY=your-key
```

Same for reranking — any LLM with a chat completions API:

```bash
CODE_SEARCH_RERANKER_PROVIDER=custom
CODE_SEARCH_RERANKER_BASE_URL=https://api.groq.com/openai
CODE_SEARCH_RERANKER_MODEL=llama-3.1-8b-instant
CODE_SEARCH_RERANKER_API_KEY=your-key
```

---

## Supported Languages

Tree-sitter AST parsing for 8 languages. All other text files indexed with BM25.

| Language | Extensions |
|:--|:--|
| TypeScript | `.ts`, `.tsx` |
| JavaScript | `.js`, `.jsx` |
| Go | `.go` |
| Python | `.py` |
| Rust | `.rs` |
| Java | `.java` |
| PHP | `.php` |
| C / C++ | `.c`, `.h`, `.cpp` |

---

## Cross-Repo Detection

14 automatic strategies:

| Strategy | Detects |
|:--|:--|
| npm dependencies | Shared packages, workspace refs |
| TypeScript types | Shared interfaces and type defs |
| HTTP routes | REST/GraphQL endpoint matching |
| Kafka topics | Producer-consumer relationships |
| gRPC services | Proto definitions and stubs |
| Database tables | Shared table access |
| Environment variables | Shared config, feature flags |
| Docker Compose | Service links, depends_on |
| Redis keys | Cache and pub/sub channels |
| S3 buckets | Shared storage patterns |
| Protobuf imports | Shared .proto references |
| Shared constants | Magic strings across repos |
| API schemas | OpenAPI/Swagger definitions |
| K8s services | Kubernetes service references |

---

## Configuration Reference

### Client environment variables

| Variable | Description |
|:--|:--|
| `CODE_SEARCH_SERVER` | Remote server URL (required for default mode) |
| `CODE_SEARCH_API_KEY` | API key for remote server |

### Server CLI flags

```
code-search-mcp --serve [options]

  --port <port>        HTTP port (default: 3100)
  --auth <mode>        none | api-key | jwt
  --transport <mode>   streamable-http | sse

code-search-mcp --local [source] [options]

  --project <name>     Project name (default: derived from source)
  --token <token>      GitHub token (or GITHUB_TOKEN env)
  --force              Force full re-index
```

### Server environment variables

| Variable | Description | Default |
|:--|:--|:--|
| `CODE_SEARCH_TRANSPORT` | Transport mode | `streamable-http` |
| `CODE_SEARCH_PORT` | HTTP port | `3100` |
| `CODE_SEARCH_HOST` | Bind address | `0.0.0.0` |
| `CODE_SEARCH_AUTH_MODE` | Auth mode | `none` |
| `CODE_SEARCH_AUTH_API_KEYS` | Comma-separated API keys | — |
| `CODE_SEARCH_AUTH_JWT_SECRET` | JWT signing secret | — |
| `CODE_SEARCH_EMBEDDING_PROVIDER` | `auto\|codestral\|openai\|voyage\|ollama\|custom` | `auto` |
| `CODE_SEARCH_EMBEDDING_API_KEY` | Unified embedding API key | — |
| `CODE_SEARCH_EMBEDDING_BASE_URL` | Custom embedding endpoint | — |
| `CODE_SEARCH_EMBEDDING_MODEL` | Custom embedding model | — |
| `CODE_SEARCH_RERANKER_PROVIDER` | `ollama\|cohere\|voyage\|custom\|none` | `ollama` |
| `CODE_SEARCH_RERANKER_BASE_URL` | Custom reranker endpoint | — |
| `CODE_SEARCH_RERANKER_MODEL` | Custom reranker model | — |
| `CODE_SEARCH_DATA_DIR` | Data directory override | — |
| `CODE_SEARCH_RATE_LIMIT_PER_MINUTE` | Rate limit per identity | `100` |

---

## Requirements

- **Node.js >= 20**
- One embedding provider: **Ollama** (free, local) or any API key above
- **Optional:** `gh` CLI for GitHub org cloning

```bash
# Recommended: Ollama for free local embeddings
brew install ollama && ollama pull bge-m3
```

---

## License

MIT

<div align="center">
<br/>

Built with [Model Context Protocol](https://modelcontextprotocol.io), [LanceDB](https://lancedb.com), [Tree-sitter](https://tree-sitter.github.io), and [Graphology](https://graphology.github.io)

</div>
