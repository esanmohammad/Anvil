<div align="center">

<br/>

<img src="https://img.shields.io/badge/anvil-v0.1.0-8B5CF6?style=for-the-badge&labelColor=1a1a2e" alt="Anvil v0.1.0" />

# Anvil

**Ship features across multi-repo codebases with AI agents**

Describe what you want. Anvil clarifies, plans, codes, tests, and opens PRs — across every repo in your project.

<br/>

[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?style=flat-square&logo=node.js&logoColor=white)]()
[![TypeScript](https://img.shields.io/badge/typescript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)]()
[![MCP](https://img.shields.io/badge/MCP-compatible-7C3AED?style=flat-square)](https://modelcontextprotocol.io)
[![Privacy](https://img.shields.io/badge/privacy-local--first-22c55e?style=flat-square)]()
[![Security](https://img.shields.io/badge/security-no--telemetry-22c55e?style=flat-square)]()

<br/>

[Privacy & Security](#privacy--security) · [Dashboard](#dashboard) · [Quick Start](#quick-start) · [Pipeline](#pipeline-deep-dive) · [Knowledge Base](#knowledge-base) · [Memory](#memory) · [Conventions](#convention-learning) · [Code Search MCP](#code-search-mcp) · [Configuration](#configuration)

<br/>

</div>

---

## Why Anvil?

Most AI coding tools see one file at a time. Your project spans five repos, three languages, a Kafka bus, and a shared Postgres cluster. When you say *"add webhook retry with exponential backoff,"* the AI needs to know that the API gateway produces events, the worker service consumes them, and the retry table lives in a database owned by a third service.

**Anvil gives AI agents full architectural awareness.** It builds a knowledge graph of your codebase — AST-parsed, vector-indexed, cross-repo-aware — then drives a multi-stage pipeline from clarification to shipped pull requests. Everything streams to a real-time dashboard where you steer, approve, and ship.

---

## Privacy & Security

Anvil is built **local-first**. Your code never leaves your machine unless you explicitly choose a cloud LLM provider.

**Your code stays yours.**

- **No telemetry.** Anvil collects zero usage data, analytics, or crash reports. No phone-home.
- **No cloud dependency.** The dashboard, knowledge graph, and pipeline all run locally. No SaaS backend, no account required.
- **Local-first knowledge base.** AST parsing, graph building, and convention detection happen entirely on your machine. Code is never uploaded for indexing.
- **CLI providers keep code local.** Claude CLI and Gemini CLI run on your device — your code is processed by the provider's client, not uploaded to a third-party indexing service.
- **API keys stay on disk.** Provider credentials are stored in `~/.anvil/` and never leave your environment. No key management service, no proxy.
- **You control the LLM.** Choose which provider sees your code. Use CLI providers for fully local processing, or API providers when you're comfortable with their data policies. Anvil never routes code through its own servers.
- **Open source.** Every line of Anvil is auditable. MIT licensed. No obfuscated binaries, no proprietary backends.
- **Air-gapped capable.** With CLI providers installed locally, Anvil works without any internet connection. Knowledge graphs build from local AST parsing — no API calls needed.

> Anvil is a developer tool, not a platform. It runs where your code runs — on your machine, in your terminal, under your control.

---

## Dashboard

The Anvil dashboard is the primary interface for MVP1. Everything runs through it.

**Pipeline view** — Watch your feature progress through 8 stages (Clarify, Requirements, Repo Requirements, Specs, Tasks, Build, Validate, Ship) with real-time agent output, per-stage costs, and live activity tracking.

**Branch selection** — Choose which branch to work from and PR against. Fetched from your git remote.

**Knowledge graph** — Interactive force-directed visualization of your codebase. Nodes are files, functions, classes. Edges show imports, calls, Kafka connections, HTTP dependencies. Clusters detected via Louvain community detection.

**PR board** — Track all pull requests created by Anvil across your repos.

**Pipeline recovery** — Stop anytime. Resume from exactly where you left off — even after a crash. All state checkpointed to `~/.anvil/`.

**Budget controls** — Per-run and daily spend limits with browser notifications.

---

## Quick Start

```bash
# 1. Install dependencies
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

---

## How It Works

```
 You describe a feature
        │
        ▼
 ┌──────────────────────────────────────────────────────────┐
 │                    Anvil Pipeline                         │
 │                                                          │
 │  1. Clarify      Ask questions to understand intent      │
 │  2. Requirements High-level plan across all repos        │
 │  3. Repo Reqs    Per-repo requirements breakdown         │
 │  4. Specs        Technical specifications per repo       │
 │  5. Tasks        Implementation task lists               │
 │  6. Build        Write code (agents run in your repos)   │
 │  7. Validate     Build, lint, test — fix until clean     │
 │  8. Ship         Commit, push, open PRs on GitHub         │
 │                                                          │
 │  Each stage: checkpointed · resumable · cost-tracked     │
 └──────────────────────────────────────────────────────────┘
        │
        ▼
 Pull requests on your chosen branch
```

Every stage writes artifacts to `~/.anvil/features/<project>/<feature>/`. If the pipeline stops — budget hit, quota exhausted, machine sleeps, manual stop — it resumes from the exact point with full context.

---

## Pipeline Deep Dive

The pipeline is the core engine of Anvil. Each of the 8 stages has distinct behavior, produces specific artifacts, and can be individually resumed.

### Stage Details

**1. Clarify** — Two-phase interactive Q&A. The agent explores your codebase, identifies ambiguities in your feature request, and generates targeted clarifying questions. You answer via the dashboard. The agent synthesizes answers into a `CLARIFICATION.md` artifact with full context.

**2. Requirements** — Produces a high-level cross-repo plan: architectural overview, scope across repositories, success criteria, and dependency map between services.

**3. Repo Requirements** — Breaks the plan into per-repo requirements. Each repo gets its own requirement document with data flows, API changes, and inter-service dependencies.

**4. Specs** — Generates technical specifications per repo: API contracts, data schemas, configuration changes, and migration plans.

**5. Tasks** — Creates granular implementation task lists per repo with file-level scope, dependencies between tasks, and execution order.

**6. Build** — Agents write code. Feature branches are created in all affected repos. Each task is executed by an agent with full knowledge graph context. Changes are committed with Anvil tracking metadata.

**7. Validate** — Runs build, lint, and test commands. Checks domain invariants (e.g., "no data leaks across tenants"). Detects regressions by comparing before/after test results. Enters an automatic fix loop (up to 5 iterations) where the agent analyzes failures, patches code, and re-validates.

**8. Ship** — Commits changes, pushes feature branches, and creates pull requests on GitHub via `gh` CLI with cross-linked PR bodies across repos.

### Agent Personas

Each stage uses a specialized agent persona with tailored system prompts:

| Persona | Used In | Focus |
|:--|:--|:--|
| **Clarifier** | Clarify | Exploration, question generation |
| **Architect** | Requirements | High-level design, cross-repo planning |
| **Analyst** | Repo Requirements, Specs | Requirements breakdown, technical detail |
| **Engineer** | Tasks, Build | Implementation, code generation |
| **Tester** | Validate | Testing strategy, failure analysis |
| **Lead** | Ship | Orchestration, PR creation |

### Cost-Aware Model Routing

Anvil uses a **weight-class system** to select models per stage. Instead of hardcoding model IDs, each stage is assigned a weight class (`fast`, `balanced`, or `powerful`) and the actual model is resolved at runtime from the provider registry. When providers release new models, only the registry needs updating.

**Tier selector** — The dashboard shows `$` / `$$` / `$$$` buttons next to the model dropdown. Selecting a tier overrides the single-model selection with per-stage routing:

| Tier | Clarify/Reqs | Specs/Tasks | Build | Validate/Ship |
|:--|:--|:--|:--|:--|
| **$ Fast** | lightweight | lightweight | mid-range | lightweight |
| **$$ Balanced** | lightweight | mid-range | mid-range | lightweight |
| **$$$ Thorough** | mid-range | top-tier | mid-range | mid-range |

The resolver maps weight classes to the best available agentic model (prefers CLI providers with tool use). If no model matches the exact weight class, it falls back to adjacent tiers.

Override per stage in `factory.yaml` (takes priority over tier routing):

```yaml
pipeline:
  models:
    clarify: claude-sonnet-4-6
    build: claude-sonnet-4-6
    specs: claude-opus-4-6
```

### Parallel Execution

During the Build stage, Anvil runs agents in parallel across repos when tasks have no cross-repo dependencies. Independent repo tasks execute concurrently while dependent tasks respect ordering constraints.

---

## Knowledge Base

The knowledge base gives agents architectural awareness of your codebase. The core product uses AST-based graph analysis; the standalone [Code Search MCP](#code-search-mcp) adds vector embeddings and hybrid search on top.

### AST-Based Knowledge Graph (Core)

The dashboard builds a per-repo knowledge graph using a built-in TypeScript AST graph builder. For each repository:

1. **Parse** — extracts functions, classes, interfaces, types, imports, and their relationships
2. **Build graph** — produces `graph.json` with nodes (symbols) and edges (imports, calls, dependencies)
3. **Generate report** — creates `GRAPH_REPORT.md`, a low-token architectural overview injected into agent prompts

Storage layout:
```
~/.anvil/knowledge-base/<project>/<repo>/
  ├── graph.json         # AST-extracted knowledge graph
  ├── GRAPH_REPORT.md    # Architectural overview for agent context
  └── metadata.json      # Tracking (lastRefreshed, commitSha, stats)
```

The knowledge base tracks freshness via git SHA comparison. When a repo's HEAD changes, the graph is automatically refreshed.

### Cross-Repo Detection

Anvil automatically discovers how your repos connect via 14 detection strategies:

| Category | Strategies |
|:--|:--|
| **Dependencies** | npm workspace refs, import aliases, package.json dependencies |
| **Types** | Shared TypeScript interfaces, protobuf definitions |
| **Protocols** | HTTP routes, GraphQL schemas, gRPC services |
| **Messaging** | Kafka topics (producer/consumer), Redis channels |
| **Data** | Shared database tables, S3 buckets |
| **Infrastructure** | Docker Compose links, Kubernetes service refs, environment variables |
| **API Contracts** | OpenAPI/Swagger shared schemas |

These edges appear in the knowledge graph and inform agents about cross-service impact when making changes.

### Knowledge Graph Visualization

The dashboard renders the knowledge graph as an interactive force-directed graph (powered by Graphology):

- **Nodes** — files, functions, classes, interfaces
- **Edges** — imports, function calls, Kafka connections, HTTP dependencies, database access
- **Clusters** — detected via Louvain community detection algorithm
- **Interaction** — zoom, pan, click to inspect, filter by repo/language/type

### Vector Embeddings & Hybrid Search (Code Search MCP)

The standalone [Code Search MCP](#code-search-mcp) server extends the knowledge base with deeper code intelligence. These features are **not part of the core dashboard pipeline** — they run as a separate MCP server that any MCP client can connect to.

| Feature | What It Does |
|:--|:--|
| **Vector embeddings** | Code chunks embedded via Codestral, Voyage AI, OpenAI, Ollama, or Gemini; stored in LanceDB |
| **Hybrid search** | Combines vector similarity + BM25 keyword search + graph expansion, then cross-encoder reranking |
| **Repo profiling** | LLM-generated role/domain/stack/endpoint analysis per repo |
| **Impact analysis** | Trace what's affected by a change across repos |

See the [Code Search MCP](#code-search-mcp) section for setup and usage.

---

## Memory

Anvil maintains two complementary memory systems that persist across pipeline runs. Memories are injected into agent prompts so the system learns from past outcomes.

### Two Memory Stores

| Store | Location | Format | Purpose |
|:--|:--|:--|:--|
| **Dashboard memory** | `~/.anvil/memories/{project}/MEMORY.md` | Markdown (section-delimited) | Human-curated project knowledge + auto-learned outcomes |
| **Dashboard user profile** | `~/.anvil/memories/{project}/USER.md` | Markdown (section-delimited) | User preferences and communication style |

### Auto-Learning

When a pipeline completes or fails, the learner automatically records:

- **Success memories** — which stages ran, repos involved, total cost, model used
- **Failure memories** — which stage failed, error details, repo-level breakdowns
- **Fix-pattern memories** — when the validate stage required fix loop iterations before passing

```
Pipeline completes/fails
        │
        ▼
Auto-learner fires:
  ├── learnFromSuccess() → records what worked
  ├── learnFromFailure() → records what broke and where
  └── learnFromFixLoop() → records validation fix patterns
        │
        ▼
Entries saved to MEMORY.md (per-project, deduplicated)
        │
        ▼
Future pipeline runs:
  Agent prompt ← formatForPrompt() injects relevant memories
```

### Memory Injection

Both stores are injected into every agent prompt via `buildProjectPrompt()`:

```
═══════════════════════════════════════════════
SYSTEM MEMORY [62% — 2,480/4,000 chars]
═══════════════════════════════════════════════
[success] Feature: "add webhook retry"
Repos: api-gateway, worker-service
Stages completed: clarify → requirements → ... → ship
Total cost: $12.40
§
[failure] Feature: "migrate auth to OAuth2"
Failed at stage: validate
Error: type-check failed in user-service...
```

### Manual Memory Management

The dashboard supports manual memory editing via WebSocket commands:

- **Add** — insert new project knowledge or user preferences
- **Replace** — update an existing memory entry (substring match)
- **Remove** — delete a memory entry
- **View** — see all memories in the MemoryList component

Character limits keep memory focused: 4,000 chars for project memory, 2,000 chars for user profile. Deduplication prevents the same entry from appearing twice.

---

## Convention Learning

Anvil automatically extracts coding conventions from your codebase and enforces them during code generation. This ensures AI-generated code matches your project's existing style.

### Pattern Detection

Built-in detectors scan your codebase for:

| Detector | What It Finds |
|:--|:--|
| **File naming** | `kebab-case.ts`, `PascalCase.tsx`, `snake_case.py`, etc. |
| **Test patterns** | Jest/Mocha/Go test conventions, test file locations, naming formats |
| **Import organization** | Import grouping, ordering (stdlib → external → internal) |
| **Error handling** | Error wrapping patterns, custom error types, error propagation style |

### Convention Rules Engine

Detected patterns become YAML-based rules:

```yaml
- id: file-naming-kebab
  description: TypeScript files use kebab-case
  language: typescript
  severity: warning
  pattern:
    type: deny
    regex: '[A-Z]'
    scope: filename
    exclude: ['*.test.ts', '*.spec.ts']
```

Rules support:
- **Regex-based** deny/require patterns
- **Severity levels** — error, warning, info
- **Per-language defaults** — Go, TypeScript, Kafka, etc.
- **File/directory scoping** with excludes

### Rule Promotion

Rules graduate in severity as confidence increases:

```
Detected pattern (info) → Validated across codebase (warning) → Consistently enforced (error)
```

This prevents false positives from being treated as hard errors before sufficient evidence is gathered.

### CI & Test Scanning

Anvil scans CI configuration and test suites to learn:

- Build commands and their order
- Lint rules and type-check gates
- Test runners and coverage thresholds
- Pre-commit hooks and quality gates

These are injected into the Validate stage so agents run the correct commands.

---

## Stats & Observability

Anvil tracks detailed metrics across every pipeline run for cost control, performance analysis, and debugging.

### Cost Tracking

Every agent call is metered:

| Metric | Scope | Where |
|:--|:--|:--|
| **Input tokens** | Per call, per stage, per run | Dashboard + checkpoint |
| **Output tokens** | Per call, per stage, per run | Dashboard + checkpoint |
| **USD cost** | Per call, per stage, per run | Dashboard + checkpoint |
| **Cumulative spend** | Per run, per day | Budget controller |

Budget controls with configurable limits:

```yaml
budget:
  max_per_run: 50     # Stop pipeline if a single run exceeds $50
  max_per_day: 150    # Daily cap across all runs
  alert_at: 40        # Browser notification at $40
```

### Context Budget Management

Each provider has different context limits. Anvil tracks token usage per provider and:

- Warns when prompts approach the context window
- Truncates intelligently (preserves recent + high-relevance context)
- Routes to larger-context providers when needed

### Latency Tracking

Tracked per stage and per agent call:

- Stage wall-clock duration
- Agent response latency (time to first token, total generation time)
- Queue wait time for parallel tasks

### Structured Logging

All pipeline events are logged with structured context:

```json
{
  "level": "info",
  "stage": "build",
  "repo": "api-gateway",
  "task": "add-retry-handler",
  "event": "agent_completed",
  "duration_ms": 45200,
  "tokens": { "input": 12500, "output": 3400 },
  "cost_usd": 0.042
}
```

### Run Timeline

The dashboard shows a visual timeline of each run:

- Stage transitions with timestamps
- Agent activity windows
- Cost accumulation curve
- Error/retry events
- Checkpoint markers

### Escalation Logging

When the pipeline encounters repeated failures, the escalation engine logs:

- Failure count and pattern
- Attempted fixes and their outcomes
- Escalation decision (retry, skip, or escalate to human)
- Root cause analysis from the agent

---

## Resilience & Recovery

Anvil is designed to survive failures gracefully at every level.

### Pipeline Checkpointing

State is checkpointed to disk on every stage transition:

| Scenario | What happens |
|:--|:--|
| You click Stop | State saved. Resume from same stage later. |
| Budget exceeded | Pipeline fails with clear error. Resume after budget reset. |
| API quota exhausted | Stage fails. Resume retries the failed stage. |
| Dashboard crashes | On restart, interrupted pipelines detected automatically. Resume with one click. |
| Machine sleeps/reboots | Checkpoint file survives. Full config (model, branch, repos) restored. |

Checkpoints live at `~/.anvil/features/<project>/<slug>/pipeline-state.json` and include full stage status, per-repo progress, costs, model config, and base branch.

### Resilience Handlers

| Handler | What It Does |
|:--|:--|
| **Crash recovery** | Detects incomplete checkpoints, restores last consistent state |
| **Rate-limit backoff** | Exponential retry with jitter when providers throttle requests |
| **Disk space guard** | Checks available disk before writing large artifacts |
| **GitHub API buffering** | Queues PR creation requests to avoid GitHub rate limits |
| **Context overflow** | Detects when prompts exceed provider limits, truncates or re-routes |
| **Checkpoint integrity** | Validates checkpoint files on load, repairs corruption |

### Escalation Chain

When a stage fails repeatedly:

1. **Retry** — Re-run the failed operation (up to 3 attempts)
2. **Fix loop** — Agent analyzes the failure, patches code, retries (up to 5 cycles)
3. **Escalate** — Surface the failure to the dashboard with full context for human decision

---

## Configuration

A single `factory.yaml` in `~/.anvil/projects/<name>/` configures everything.

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
    description: Edge gateway — auth, rate limiting, routing
    commands:
      build: make build
      test: make test

  - name: user-service
    path: ./user-service
    language: typescript
    github: myorg/user-service

  - name: web-app
    path: ./web-app
    language: typescript
    github: myorg/web-app

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
  setup:                               # Pre-flight commands per repo
    - npm ci
  verify:                              # Lint/type gates for Validate stage
    - npm run lint
    - tsc --noEmit
  test:                                # Test suite commands
    - npm test
  models:                              # Per-stage model overrides
    clarify: claude-sonnet-4-6
    build: claude-sonnet-4-6
connects:                              # Manual service dependency hints
  - from: api-gateway
    to: user-service
    protocol: http
    port: 3000
  - from: api-gateway
    to: postgres
    protocol: tcp
    port: 5432
```

> At minimum you need `project`, `workspace`, and a list of `repos`. Everything else is optional.

---

## Providers

MVP1 supports CLI agent providers. API providers (OpenAI, Gemini API, OpenRouter) are coming in MVP2.

| Provider | Status | Context | Tool Use |
|:--|:--|:--|:--|
| **Claude CLI** | Available | 200K tokens | Full (files, shell, tools) |
| **Gemini CLI** | Available | 1M tokens | Full (files, shell) |
| OpenAI API | MVP2 | 128K tokens | Chat only |
| Gemini API | MVP2 | 1M tokens | Chat only |
| OpenRouter | MVP2 | Varies | Chat only |
| Ollama | MVP2 | Varies | Chat only |

Anvil automatically routes to the right provider based on your model selection and manages context budgets per provider — truncating intelligently when prompts approach token limits.

---

## Packages

This is a monorepo with three packages:

| Package | Description |
|:--|:--|
| **`@anvil-dev/cli`** | CLI entry point — `anvil init`, `anvil doctor`, `anvil dashboard` |
| **`@anvil-dev/dashboard`** | React dashboard + Node.js server — pipeline orchestration, WebSocket streaming, agent management |
| **`@anvil-dev/code-search-mcp`** | Standalone MCP server for multi-repo code search (see [below](#code-search-mcp)) |

---

## Code Search MCP

A standalone [Model Context Protocol](https://modelcontextprotocol.io) server that gives any MCP client (Claude Desktop, Cursor, etc.) deep code intelligence across multiple repositories. Use it independently or alongside the Anvil dashboard.

**Two modes:**

| Mode | For whom | What's needed locally |
|:--|:--|:--|
| **Remote** (default) | End users | Just a URL + API key |
| **Server** | Infra team | Repos, embeddings, Docker |

### For end users — connect to a deployed server

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

No repos, no index, no GPU needed locally. All infrastructure lives on the server.

### For infra — deploy the server

```bash
# Docker
docker compose up

# Or serve directly
code-search-mcp --serve --port 3100 --auth api-key
```

12 tools available: hybrid search, semantic search, exact search, dependency graphs, cross-repo edges, callers, impact analysis, repo profiles, and index management.

See [`packages/code-search-mcp/README.md`](packages/code-search-mcp/README.md) for full deployment and configuration docs.

---

## CLI Commands

MVP1 has three active commands. All others redirect to the dashboard.

| Command | Description |
|:--|:--|
| `anvil init` | Scaffold a new project with `factory.yaml` |
| `anvil doctor` | Check Node.js, git, gh, and provider availability |
| `anvil dashboard` | Launch the web dashboard |

Full CLI pipeline commands are coming in a future release.

---

## MVP1 vs MVP2

| Feature | MVP1 | MVP2 |
|:--|:--|:--|
| Dashboard pipeline (8 stages) | Yes | Yes |
| Claude CLI + Gemini CLI agents | Yes | Yes |
| Branch selection + PR creation | Yes | Yes |
| Pipeline checkpoint + recovery | Yes | Yes |
| Knowledge graph (AST + vectors + cross-repo) | Yes | Yes |
| Hybrid search (vector + BM25 + graph) | Yes | Yes |
| Cross-repo edge detection (14 strategies) | Yes | Yes |
| Repo profiling | Yes | Yes |
| Context budget management | Yes | Yes |
| Budget controls + cost tracking | Yes | Yes |
| Convention detection + rule engine | Yes | Yes |
| Memory (persisted, injected, influence-tracked) | Yes | Yes |
| Cost-aware model routing (3 tiers) | Yes | Yes |
| Resilience handlers (crash, rate-limit, overflow) | Yes | Yes |
| Sandbox deploy + smoke testing | — | Yes |
| Validation fix loops | Yes | Yes |
| Structured logging + run timeline | Yes | Yes |
| API providers (OpenAI, etc.) | — | Yes |
| Custom pipeline stages | — | Yes |
| CLI pipeline commands | — | Yes |
| Slack/webhook notifications | — | Yes |
| Team workspaces | — | Yes |

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
