# anvil

**Ship features, not prompts.**

`anvil` is the command line that turns "add a booking flow" into
shipped code, tested, reviewed, and PR'd — across every repo your
project touches. One CLI, one dashboard, one pipeline.

---

## The 30-second tour

```sh
# 1. Set up your project (interactive — answers a handful of questions)
anvil init

# 2. Verify everything is wired up (Node, git, gh, providers, repos)
anvil doctor

# 3. Open the dashboard and drive features end-to-end
anvil dashboard
```

The dashboard handles the rest: clarification, requirements,
implementation, validation, and shipping — across one or many
repos in the same project.

---

## What it does

### `anvil init`
Scaffolds a project in seconds. Drops a `factory.yaml` describing
your repos, languages, and build commands; installs the persona
prompts that drive each pipeline stage; bootstraps `~/.anvil/models.yaml`
so the agent stack is ready to go. Optionally clones repos from
GitHub for you. Run it once per project.

### `anvil doctor`
A pre-flight check for the entire stack — Node version, git, `gh`
auth, the Claude / Gemini CLIs, `~/.anvil/` layout, every repo
listed in your `factory.yaml`, and which LLM providers are
configured. Reads keys from `process.env`, `~/.anvil/.env`, and
`~/.anvil/auth.json` so you see the real picture, not just shell
state. Add `--bootstrap-models` to seed `models.yaml` and `ollama
pull` anything missing.

### `anvil dashboard`
The control plane. Boots a local HTTP + WebSocket server, opens
the dashboard UI, and orchestrates pipelines:

- **Clarify** ambiguous requests with targeted questions
- **Plan** the work — files touched, contracts crossed, risks called
  out, cost estimated
- **Build** per-repo with the right model for each stage, with
  built-in retries, fallbacks, and a circuit breaker on flaky
  providers
- **Validate** with project-defined checks; auto-fix on failure
- **Ship** with branch creation, commits, and a PR per repo —
  cross-linked when the work spans multiple repos

Plus: change diffs, activity log, knowledge-base graph view,
pipeline-policy editor, real-time cost ledger, settings UI for
provider keys.

---

## What ships in the box

- **Three commands** — `init`, `doctor`, `dashboard` — that's all
  you need today.
- **The dashboard, bundled** — a self-contained React + Vite
  frontend, served by the same process as the WebSocket backend.
  No extra installs.
- **15 persona prompts** — battle-tested system prompts for
  clarifier, architect, engineer, tester, reviewer, security
  tester, and more. Copied to `~/.anvil/personas/` on init; edit
  any of them to retune your team's defaults.
- **6 project templates** — TypeScript / Next.js, Go microservices,
  Python / FastAPI, Rust / Axum, Turborepo monorepo, Django + Celery.
  `anvil init --template <name>` for a non-interactive start.
- **Default model registry** — a `models.yaml` template with
  sensible per-tier choices (cheap, smart, agentic) ready to
  customize.

---

## Why a CLI + dashboard, not just a CLI?

Because pipelines are easier to *watch* than to *log*.

The CLI handles setup, health checks, and launch — fast, scriptable,
the right tool for one-shot work. The dashboard handles the live
pipeline — every spawned agent, every diff, every cost cent, every
PR — because that's a UI problem, not a stdout problem. Both share
the same engine. Switch between them freely.

---

## Configuration lives in two places

| What | Where |
|---|---|
| Project setup (repos, languages, commands) | `~/.anvil/projects/<name>/factory.yaml` |
| Per-workspace marker | `<workspace>/.factory/config.yaml` |
| Models and routing chains | `~/.anvil/models.yaml` |
| Stage policy (which models per stage) | bundled — override at `~/.anvil/stage-policy.yaml` |
| Provider API keys | `process.env`, `~/.anvil/.env`, or via the dashboard Settings UI |
| Persona prompts | `~/.anvil/personas/*.md` |

Everything except API keys is committable. Make Anvil yours.

---

## Example configuration

Real, runnable examples for every config file live in
[`examples/`](../../examples/) at the repo root.

### Project-level (`factory.yaml`)
- [`examples/typescript-monorepo/factory.yaml`](../../examples/typescript-monorepo/factory.yaml) — Next.js + Express in one repo
- [`examples/go-microservices/factory.yaml`](../../examples/go-microservices/factory.yaml) — multi-service Go workspace
- [`examples/python-ml/factory.yaml`](../../examples/python-ml/factory.yaml) — Python ML training + serving

### Global (`~/.anvil/`)
- [`examples/anvil-home/.env.example`](../../examples/anvil-home/.env.example) — provider keys + opt-in observability
- [`examples/anvil-home/models.yaml`](../../examples/anvil-home/models.yaml) — registry the resolver walks (local / cheap / premium tiers)
- [`examples/anvil-home/stage-policy.yaml`](../../examples/anvil-home/stage-policy.yaml) — which tier handles which stage

Quick bootstrap from the examples:

```sh
cp examples/anvil-home/.env.example      ~/.anvil/.env  && chmod 600 ~/.anvil/.env
cp examples/anvil-home/models.yaml       ~/.anvil/models.yaml
cp examples/anvil-home/stage-policy.yaml ~/.anvil/stage-policy.yaml
```

`models.yaml` is also seeded automatically by
`anvil init` (or `anvil doctor --bootstrap-models`).
`stage-policy.yaml` overrides are **full replacements**, not merges —
declare every stage you want supported. The resolver walks
`prefer` left-to-right and picks the first model in `models.yaml`
that matches the stage's `capability` and `complexity_max`.

---

## Built on `@anvil/*` packages

The CLI is the front door. The work happens in:

- **`@anvil/agent-core`** — eight provider adapters, router, cost,
  telemetry
- **`@anvil/core-pipeline`** — stage definitions, routing, task
  envelopes
- **`@anvil/knowledge-core`** — codebase indexing, retrieval, graph
- **`@anvil/memory-core`** — long-running project memory + sleeptime
  consolidation
- **`@anvil/convention-core`** — convention learner

Use the CLI for the full experience, or import the cores directly
if you're building your own front end.

---

## Status

MVP 2 — the dashboard is the canonical interface for running
pipelines. More CLI commands are on deck for direct scripting.

---

## Part of [Anvil](../../) — the AI development pipeline.
