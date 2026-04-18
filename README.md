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

<br/>

[Dashboard](#dashboard) · [Quick Start](#quick-start) · [Code Search MCP](#code-search-mcp) · [Configuration](#configuration)

<br/>

</div>

---

## Why Anvil?

Most AI coding tools see one file at a time. Your system spans five repos, three languages, a Kafka bus, and a shared Postgres cluster. When you say *"add webhook retry with exponential backoff,"* the AI needs to know that the API gateway produces events, the worker service consumes them, and the retry table lives in a database owned by a third service.

**Anvil gives AI agents full architectural awareness.** It builds a knowledge graph of your codebase — AST-parsed, vector-indexed, cross-repo-aware — then drives a multi-stage pipeline from clarification to shipped pull requests. Everything streams to a real-time dashboard where you steer, approve, and ship.

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
git clone https://github.com/anvil-dev/anvil.git && cd anvil
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
 │  8. Ship         Commit, push, open PRs                  │
 │                                                          │
 │  Each stage: checkpointed · resumable · cost-tracked     │
 └──────────────────────────────────────────────────────────┘
        │
        ▼
 Pull requests on your chosen branch
```

Every stage writes artifacts to `~/.anvil/features/<project>/<feature>/`. If the pipeline stops — budget hit, quota exhausted, machine sleeps, manual stop — it resumes from the exact point with full context.

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

## Pipeline Recovery

Anvil checkpoints pipeline state to disk on every stage transition.

| Scenario | What happens |
|:--|:--|
| You click Stop | State saved. Resume from same stage later. |
| Budget exceeded | Pipeline fails with clear error. Resume after budget reset. |
| API quota exhausted | Stage fails. Resume retries the failed stage. |
| Dashboard crashes | On restart, interrupted pipelines detected automatically. Resume with one click. |
| Machine sleeps/reboots | Checkpoint file survives. Full config (model, branch, repos) restored. |

Checkpoints live at `~/.anvil/features/<project>/<slug>/pipeline-state.json` and include full stage status, per-repo progress, costs, model config, and base branch.

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
| Knowledge graph visualization | Yes | Yes |
| Context budget management | Yes | Yes |
| Budget controls + alerts | Yes | Yes |
| Convention generation | Yes | Yes |
| Memory (persisted, injected) | Yes | Yes |
| API providers (OpenAI, etc.) | — | Yes |
| Custom pipeline stages | — | Yes |
| CLI pipeline commands | — | Yes |
| Slack/webhook notifications | — | Yes |
| Team workspaces | — | Yes |

---

## Contributing

```bash
git clone https://github.com/anvil-dev/anvil.git
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

MIT

<div align="center">
<br/>

Built with TypeScript, React, Tree-sitter, LanceDB, and Graphology.

[Issues](https://github.com/anvil-dev/anvil/issues) · [Discussions](https://github.com/anvil-dev/anvil/discussions)

</div>
