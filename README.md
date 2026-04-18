<div align="center">

<br/>

<img src="https://img.shields.io/badge/anvil-v0.1.0-8B5CF6?style=for-the-badge&labelColor=1a1a2e" alt="Anvil v0.1.0" />

# Anvil

**Two products for AI-powered multi-repo development**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?style=flat-square&logo=node.js&logoColor=white)]()
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)]()
[![MCP](https://img.shields.io/badge/MCP-compatible-7C3AED?style=flat-square)](https://modelcontextprotocol.io)
[![Privacy](https://img.shields.io/badge/privacy-local--first-22c55e?style=flat-square)]()
[![Security](https://img.shields.io/badge/security-no--telemetry-22c55e?style=flat-square)]()

<br/>

| | **Anvil Pipeline** | **Code Search MCP** |
|:--|:--|:--|
| **What** | AI agents that ship features end-to-end | Code intelligence server for any MCP client |
| **For** | Teams building across multiple repos | Any developer or AI tool that needs codebase understanding |
| **How** | Dashboard drives an 8-stage pipeline from idea to PR | MCP server exposes search, graphs, and analysis tools |
| **Runs** | Locally on your machine | Locally (stdio) or deployed (Docker + HTTP) |

<br/>

[Anvil Pipeline](#anvil-pipeline) · [Code Search MCP](#code-search-mcp) · [Privacy](#privacy--security) · [Quick Start](#quick-start) · [Configuration](#configuration)

<br/>

</div>

---

## Privacy & Security

**Zero telemetry. Zero logging. Zero phone-home.**

Both products have no analytics, no crash reporters, no usage tracking, and no background network calls. There is no SaaS backend, no account system, and no data collection of any kind.

- **Fully local.** Dashboard, pipeline, knowledge graph, and all indexing run on your machine. Nothing is uploaded.
- **No cloud dependency.** Works offline with CLI providers. Knowledge graphs build from local AST parsing — no API calls needed.
- **You choose the LLM.** Your code only goes to the provider you explicitly select. Anvil never proxies, stores, or forwards your code.
- **Open source.** MIT licensed. Every line auditable. No obfuscated binaries.

---

# Anvil Pipeline

**Describe a feature. Anvil clarifies, plans, codes, tests, and opens PRs — across every repo in your project.**

Most AI coding tools see one file at a time. Your project spans five repos, three languages, a Kafka bus, and a shared Postgres cluster. Anvil gives AI agents full architectural awareness — AST-parsed, vector-indexed, cross-repo-aware — then drives a multi-stage pipeline from clarification to shipped pull requests.

## Quick Start

```bash
# 1. Install
git clone https://github.com/esanmohammad/Anvil.git && cd anvil
npm install && npm run build --workspaces

# 2. Check your setup
anvil doctor

# 3. Create a project
anvil init my-project ~/workspace/my-project

# 4. Launch the dashboard
anvil dashboard
```

Open `http://localhost:5173`, select your project, and describe what you want to build.

### Requirements

- **Node.js >= 20**
- **git** and **gh** (GitHub CLI) for PR creation
- **Claude CLI** (`npm i -g @anthropic-ai/claude-code`) — primary agent provider
- **Gemini CLI** (optional) — alternative agent provider

## How It Works

```
 You describe a feature
        |
        v
 +--------------------------------------------------------------+
 |                    Anvil Pipeline                              |
 |                                                                |
 |  1. Clarify      Ask questions to understand intent            |
 |  2. Requirements High-level plan across all repos              |
 |  3. Repo Reqs    Per-repo requirements breakdown               |
 |  4. Specs        Technical specifications per repo             |
 |  5. Tasks        Implementation task lists                     |
 |  6. Build        Write code (agents run in your repos)         |
 |  7. Validate     Build, lint, test -- fix until clean          |
 |  8. Ship         Commit, push, open PRs on GitHub              |
 |                                                                |
 |  Each stage: checkpointed . resumable . cost-tracked           |
 +--------------------------------------------------------------+
        |
        v
 Pull requests on your chosen branch
```

Every stage writes artifacts to `~/.anvil/features/<project>/<feature>/`. If the pipeline stops — budget hit, quota exhausted, machine sleeps, manual stop — it resumes from the exact point with full context.

## Dashboard

**Pipeline view** — Watch your feature progress through 8 stages with real-time agent output, per-stage costs, and live activity tracking.

**Branch selection** — Choose which branch to work from and PR against. Fetched from your git remote.

**Knowledge graph** — Interactive force-directed visualization of your codebase. Nodes are files, functions, classes. Edges show imports, calls, Kafka connections, HTTP dependencies. Clusters detected via Louvain community detection.

**PR board** — Track all pull requests created by Anvil across your repos.

**Pipeline recovery** — Stop anytime. Resume from exactly where you left off — even after a crash or dashboard restart. Failed/interrupted pipelines appear in Active Runs automatically.

**Budget controls** — Per-run and daily spend limits with browser notifications.

**Auth handling** — If your LLM provider auth expires mid-pipeline, the pipeline pauses, sends a browser notification, auto-opens re-login, and resumes once authenticated. No lost work.

## Pipeline Deep Dive

### Stage Details

**1. Clarify** — Two-phase interactive Q&A. The agent explores your codebase, identifies ambiguities, and generates targeted clarifying questions. You answer via the dashboard. The agent synthesizes answers into a `CLARIFICATION.md` artifact.

**2. Requirements** — High-level cross-repo plan: architectural overview, scope, success criteria, and dependency map between services.

**3. Repo Requirements** — Per-repo requirements with data flows, API changes, and inter-service dependencies.

**4. Specs** — Technical specifications per repo: API contracts, data schemas, configuration changes, migration plans.

**5. Tasks** — Granular implementation task lists per repo with file-level scope, dependencies, and execution order.

**6. Build** — Agents write code. Feature branches created in all affected repos. Parallel execution across independent repos.

**7. Validate** — Runs build, lint, and test commands. Automatic fix loop (up to 5 iterations) where the agent analyzes failures, patches code, and re-validates.

**8. Ship** — Commits, pushes feature branches, creates pull requests on GitHub via `gh` CLI with cross-linked PR bodies.

### Agent Personas

| Persona | Used In | Focus |
|:--|:--|:--|
| **Clarifier** | Clarify | Exploration, question generation |
| **Architect** | Requirements | High-level design, cross-repo planning |
| **Analyst** | Repo Requirements, Specs | Requirements breakdown, technical detail |
| **Engineer** | Tasks, Build | Implementation, code generation |
| **Tester** | Validate | Testing strategy, failure analysis |
| **Lead** | Ship | Orchestration, PR creation |

### Cost-Aware Model Routing

Anvil uses a **weight-class system** to select models per stage. The dashboard shows `$` / `$$` / `$$$` tiers:

| Tier | Clarify/Reqs | Specs/Tasks | Build | Validate/Ship |
|:--|:--|:--|:--|:--|
| **$ Fast** | lightweight | lightweight | mid-range | lightweight |
| **$$ Balanced** | lightweight | mid-range | mid-range | lightweight |
| **$$$ Thorough** | mid-range | top-tier | mid-range | mid-range |

Override per stage in `factory.yaml`:

```yaml
pipeline:
  models:
    clarify: claude-sonnet-4-6
    build: claude-sonnet-4-6
    specs: claude-opus-4-6
```

## Knowledge Base

The knowledge base gives agents architectural awareness of your codebase.

### AST-Based Knowledge Graph

For each repository:

1. **Parse** — extracts functions, classes, interfaces, types, imports, and their relationships
2. **Build graph** — produces `graph.json` with nodes (symbols) and edges (imports, calls, dependencies)
3. **Generate report** — creates `GRAPH_REPORT.md`, a low-token architectural overview injected into agent prompts

```
~/.anvil/knowledge-base/<project>/<repo>/
  +-- graph.json         # AST-extracted knowledge graph
  +-- GRAPH_REPORT.md    # Architectural overview for agent context
  +-- metadata.json      # Tracking (lastRefreshed, commitSha, stats)
```

Freshness tracked via git SHA — graph auto-refreshes when HEAD changes.

### Cross-Repo Detection

14 automatic detection strategies:

| Category | Strategies |
|:--|:--|
| **Dependencies** | npm workspace refs, import aliases, package.json dependencies |
| **Types** | Shared TypeScript interfaces, protobuf definitions |
| **Protocols** | HTTP routes, GraphQL schemas, gRPC services |
| **Messaging** | Kafka topics (producer/consumer), Redis channels |
| **Data** | Shared database tables, S3 buckets |
| **Infrastructure** | Docker Compose links, Kubernetes service refs, environment variables |
| **API Contracts** | OpenAPI/Swagger shared schemas |

## Memory

Two memory stores persist across pipeline runs and are injected into agent prompts:

| Store | Purpose |
|:--|:--|
| **Project memory** | Auto-learned outcomes (successes, failures, fix patterns) + human-curated knowledge |
| **User profile** | Preferences and communication style |

When a pipeline completes or fails, the auto-learner records what worked, what broke, and fix patterns — so future runs improve.

## Convention Learning

Anvil automatically extracts coding conventions and enforces them during code generation:

| Detector | What It Finds |
|:--|:--|
| **File naming** | `kebab-case.ts`, `PascalCase.tsx`, `snake_case.py` |
| **Test patterns** | Jest/Mocha/Go test conventions, file locations |
| **Import organization** | Grouping, ordering (stdlib -> external -> internal) |
| **Error handling** | Wrapping patterns, custom error types |

Rules graduate in severity as confidence increases: detected (info) -> validated (warning) -> enforced (error).

## Resilience & Recovery

| Scenario | What happens |
|:--|:--|
| You click Stop | State saved. Resume from same stage later. |
| Budget exceeded | Pipeline fails with clear error. Resume after budget reset. |
| Auth expires mid-pipeline | Auto-opens browser for re-login. Pipeline resumes after authentication. |
| Dashboard crashes | On restart, interrupted pipelines detected and shown in Active Runs. |
| Machine sleeps/reboots | Checkpoint file survives. Full config restored on resume. |

---

# Code Search MCP

**Multi-repo code intelligence via the [Model Context Protocol](https://modelcontextprotocol.io).**

A standalone MCP server that gives any MCP client — Claude Code, Claude Desktop, Cursor, or any other — deep understanding of your codebase. Use it independently or alongside the Anvil Pipeline.

Point it at a directory or a GitHub org. It discovers repos, parses code with tree-sitter, builds vector embeddings, constructs AST graphs, detects cross-repo dependencies — then exposes **11 tools** via MCP.

## Code Search Quick Start

### For developers — local mode

Run everything on your machine. Claude Code manages the server lifecycle automatically:

```bash
claude mcp add code-search -- npx @anvil-dev/code-search-mcp --local /path/to/repos
```

That's it. Claude now has `search_code`, `find_callers`, `impact_analysis`, etc.

### For developers — connect to a team server

```bash
claude mcp add code-search \
  -e CODE_SEARCH_SERVER=https://your-server:3100 \
  -e CODE_SEARCH_API_KEY=your-api-key \
  -- npx @anvil-dev/code-search-mcp
```

No repos, no index, no GPU needed locally.

**Claude Desktop / Cursor (JSON config):**

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

### For infra — deploy the server

```bash
# Docker (recommended)
docker compose up

# Or direct
code-search-mcp --serve --port 3100 --auth api-key
```

Index repos dynamically via the admin API (no restart needed):

```bash
curl -X POST http://localhost:3100/index \
  -H 'Content-Type: application/json' \
  -d '{"path": "/repos/my-service", "project": "my-project"}'
```

Set `CODE_SEARCH_REINDEX_INTERVAL=1h` for automatic scheduled reindexing.

## Tools

### Client tools (exposed via MCP)

| Tool | Description |
|:--|:--|
| `search_code` | Hybrid search — vector + BM25 + graph expansion + cross-encoder reranking |
| `search_semantic` | Vector-only semantic search for conceptual queries |
| `search_exact` | BM25 keyword search for exact names, error codes, paths |
| `get_repo_graph` | AST knowledge graph — entities and relationships for a repo |
| `get_cross_repo_edges` | Connections between repos — shared deps, Kafka, HTTP, DB, gRPC |
| `find_callers` | All functions that call a given function across the codebase |
| `find_dependencies` | What a function depends on — calls, imports, types |
| `impact_analysis` | Trace what's affected if a file or entity changes |
| `list_repos` | All indexed repos with role, domain, description |
| `get_repo_profile` | LLM-generated profile — role, tech stack, endpoints |
| `index_status` | Chunk count, embedding provider, repos, last indexed |

### Server admin API (not exposed to clients)

| Endpoint | Description |
|:--|:--|
| `POST /index` | Index repos at a given path. Body: `{"path": "...", "project": "...", "force": false}` |
| `GET /health` | Server status, active sessions, index readiness |
| `GET /status` | Live indexing progress — phase, percent, errors, event history |
| `CODE_SEARCH_REINDEX_INTERVAL` | Scheduled auto-reindex (e.g. `30m`, `1h`, `6h`). Default: disabled |

## Incremental Indexing

Reindexing is cost-optimized across 4 layers:

1. **Git SHA skip** — entire repos skipped if HEAD hasn't changed
2. **Git diff** — only changed/added/deleted files processed via git's Merkle DAG
3. **Content hash** — SHA-256 per file skips unchanged files even without git diff
4. **Embedding diff** — only new chunks are embedded; existing embeddings preserved in LanceDB

A typical reindex of 2 changed files across 1,000 embeds ~5 new chunks instead of re-embedding everything.

## Embedding Providers

| Provider | Env var | Notes |
|:--|:--|:--|
| Ollama (local) | `OLLAMA_HOST` | Free, default `bge-m3` model |
| Mistral/Codestral | `MISTRAL_API_KEY` | `codestral-embed-2505` |
| OpenAI | `OPENAI_API_KEY` | `text-embedding-3-large` |
| Voyage AI | `VOYAGE_API_KEY` | `voyage-code-3` |
| Gemini | OAuth via `~/.gemini/` | `text-embedding-004` |
| **Any OpenAI-compatible** | `CODE_SEARCH_EMBEDDING_BASE_URL` | Bring your own |

## Supported Languages

Tree-sitter AST parsing for 8 languages. All other text files indexed with BM25.

TypeScript, JavaScript, Go, Python, Rust, Java, PHP, C/C++.

See [`packages/code-search-mcp/README.md`](packages/code-search-mcp/README.md) for full deployment, authentication, and configuration docs.

---

# Shared Infrastructure

## Providers

| Provider | Status | Context | Tool Use |
|:--|:--|:--|:--|
| **Claude CLI** | Available | 200K tokens | Full (files, shell, tools) |
| **Gemini CLI** | Available | 1M tokens | Full (files, shell) |
| OpenAI API | MVP2 | 128K tokens | Chat only |
| Gemini API | MVP2 | 1M tokens | Chat only |
| OpenRouter | MVP2 | Varies | Chat only |
| Ollama | MVP2 | Varies | Chat only |

## Packages

| Package | Description |
|:--|:--|
| **`@anvil-dev/cli`** | CLI entry point — `anvil init`, `anvil doctor`, `anvil dashboard` |
| **`@anvil-dev/dashboard`** | React dashboard + Node.js server — pipeline orchestration, WebSocket streaming, agent management |
| **`@anvil-dev/code-search-mcp`** | Standalone MCP server for multi-repo code search |

## Configuration (Pipeline)

A single `factory.yaml` in `~/.anvil/projects/<name>/` configures the pipeline:

```yaml
version: 1
project: my-platform
title: My Platform
workspace: ~/workspace/my-platform

repos:
  - name: api-gateway
    path: ./api-gateway
    language: go
    github: myorg/api-gateway
    commands:
      build: make build
      test: make test

  - name: user-service
    path: ./user-service
    language: typescript
    github: myorg/user-service

domain:
  description: |
    B2B SaaS platform for team collaboration.
    Multi-tenant with workspace isolation.
  invariants:
    - Workspace data must never leak across tenants
    - All mutations require authentication

budget:
  max_per_run: 50
  max_per_day: 150
  alert_at: 40

pipeline:
  models:
    clarify: claude-sonnet-4-6
    build: claude-sonnet-4-6
```

> At minimum you need `project`, `workspace`, and a list of `repos`. Everything else is optional.

## CLI Commands

| Command | Description |
|:--|:--|
| `anvil init` | Scaffold a new project with `factory.yaml` |
| `anvil doctor` | Check Node.js, git, gh, and provider availability |
| `anvil dashboard` | Launch the web dashboard |

---

## Contributing

```bash
git clone https://github.com/esanmohammad/Anvil.git
cd anvil
npm install
npm run build --workspaces

# Dashboard dev mode
cd packages/dashboard && npm run dev

# Build MCP server
cd packages/code-search-mcp && node build.mjs
```

TypeScript throughout. No complex build tooling — just `tsc` and Vite. PRs welcome.

---

## License

MIT -- Copyright (c) 2024-2026 Esan Mohammad

<div align="center">
<br/>

Built with TypeScript, React, Tree-sitter, LanceDB, and Graphology.

[Issues](https://github.com/esanmohammad/Anvil/issues) · [Discussions](https://github.com/esanmohammad/Anvil/discussions)

</div>
