<div align="center">

<br />

<picture>
  <img alt="Anvil" src="https://img.shields.io/badge/A%20N%20V%20I%20L-1a1a1a?style=for-the-badge&labelColor=1a1a1a&color=1a1a1a" height="80" />
</picture>

<br /><br />

# The provider-agnostic AI development pipeline

<h3>
  <i>Use your own keys. Mix providers per stage. Pay per token, not per seat.</i>
</h3>

<p>
  Anvil ships features end-to-end — clarify, plan, build, review, PR —<br />
  across every repo in your project, on whatever model is cheapest for each stage.<br />
  <b>No vendor lock-in. No markup. No hosted plan.</b>
</p>

<br />

<p>
  <a href="docs/getting-started.md"><img src="https://img.shields.io/badge/-Get%20started-2563eb?style=for-the-badge&logo=rocket&logoColor=white" alt="Get started"></a>
  <a href="#what-you-can-do-with-anvil"><img src="https://img.shields.io/badge/-Features-1f2937?style=for-the-badge" alt="Features"></a>
  <a href="#observability-opt-in"><img src="https://img.shields.io/badge/-Observability-1f2937?style=for-the-badge" alt="Observability"></a>
  <a href="examples/"><img src="https://img.shields.io/badge/-Examples-1f2937?style=for-the-badge" alt="Examples"></a>
  <a href="https://drive.google.com/file/d/1IHTQiLEQ4tulpdbUzI2iD5dmy82jBK-m/view?usp=sharing"><img src="https://img.shields.io/badge/-Demo-ef4444?style=for-the-badge&logo=googledrive&logoColor=white" alt="Demo"></a>
</p>

<p>
  <img src="https://img.shields.io/badge/version-0.1.0-3b82f6.svg" alt="Version 0.1.0" />
  <img src="https://img.shields.io/badge/license-MIT-3b82f6.svg" alt="MIT" />
  <img src="https://img.shields.io/badge/node-%E2%89%A518-339933.svg" alt="Node 18+" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178c6.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/providers-8-a855f7.svg" alt="8 providers" />
  <img src="https://img.shields.io/badge/local%20models-Ollama%20%2B%20OpenCode-22c55e.svg" alt="Local models" />
  <img src="https://img.shields.io/badge/MVP%202-active-f97316.svg" alt="MVP 2 active" />
</p>

<br />

[![Anvil pipeline builder showcase](./assets/AI_Pipeline_Builder_Showcase.gif)](https://drive.google.com/file/d/1IHTQiLEQ4tulpdbUzI2iD5dmy82jBK-m/view?usp=sharing)

<sub><i>Dashboard preview &mdash; pipeline orchestration, live agent activity, knowledge graph, cost ledger.<br />
<b><a href="https://drive.google.com/file/d/1IHTQiLEQ4tulpdbUzI2iD5dmy82jBK-m/view?usp=sharing">Click the gif to watch the full demo</a></b></i></sub>

<br /><br />

</div>

---

<div align="center">

### **Plan on Claude. Build on Ollama. Review on GPT. Ship on a local model.**
### One pipeline. Eight providers. Whatever's cheapest for each stage.

</div>

---

## Why teams pick Anvil

<table>
<tr>
<td width="50%" valign="top">

#### Mix providers within a single pipeline
Routing is per-stage, not per-run. A single feature can flow through
three different providers without you lifting a finger. The pipeline
doesn't care which one ran which step.

</td>
<td width="50%" valign="top">

#### Cheap by design
Routing-by-stage means premium models only show up where premium
models actually matter. Read-only research and tight fix loops stay
on the free tier — *always*. Live cost ledger per call.

</td>
</tr>
<tr>
<td width="50%" valign="top">

#### No vendor SDK lock-in
Every HTTP adapter is hand-rolled `fetch()`. No `@anthropic-ai/sdk`,
no `openai` package, no LangChain, no Vercel AI SDK. Drop a model —
your code keeps compiling.

</td>
<td width="50%" valign="top">

#### Bring your own keys, or don't
Ollama works fully offline. OpenCode's $10/mo Zen subscription
replaces the entire local tier — no GPU required. Cloud is for the
few stages that warrant it.

</td>
</tr>
</table>

---

## Quick start

```sh
# 1. Install
npm install -g @esankhan3/anvil-cli

# 2. Set up a project (interactive — answers a handful of questions)
anvil init

# 3. Open the dashboard and ship
anvil dashboard
```

That's the whole onboarding. `anvil init` creates `~/.anvil/`,
seeds `models.yaml`, scaffolds your project's `factory.yaml`, and
runs a health check. `anvil dashboard` boots the WebSocket
control plane and opens the UI.

> **First time?** The full walk-through — prerequisites, where to
> get provider keys, what `anvil init` will ask you, troubleshooting
> — lives in [`docs/getting-started.md`](docs/getting-started.md).

---

## Provider-agnostic by design

Eight providers ship in the box. One config file picks them per
stage. Each adapter speaks the same streaming format, the same
`UpstreamError` retry shape, the same per-call cost calculation.

<div align="center">

| Provider | Tier slot | Best for |
|:---|:---:|:---|
| **OpenCode** (Zen) | `local` | Hosted open-coding models, $10/mo flat — replaces GPU-heavy Ollama |
| **Ollama** | `local` | Fully offline, your own GPU, embeddings + reranking |
| **Claude** (CLI) | `cheap` / `premium` | Best-in-class reasoning, native tool use |
| **OpenAI** | `cheap` / `premium` | GPT-5, o-series reasoning |
| **Gemini** | `cheap` / `premium` | Long context, Gemini 2.5 Pro |
| **OpenRouter** | any | Single key, hundreds of models |
| **Google ADK** | `premium` | When you need ADK's runner semantics |
| **Gemini CLI** | utility | Subprocess fallback |

</div>

### One run, three providers, fourteen cents

Routing is per-stage, not per-run. The same feature can flow
through three providers without you lifting a finger:

```
  clarify     →  Ollama / OpenCode   local           ~ $0.00
  plan        →  Claude Sonnet       deep analysis   ~ $0.05
  build       →  Ollama / OpenCode   local           ~ $0.00
  test        →  Ollama / OpenCode   local           ~ $0.00
  validate    →  Claude Haiku        cheap + fast    ~ $0.01
  review      →  Claude Sonnet       judgment-heavy  ~ $0.08
  ship        →  Ollama / OpenCode   local           ~ $0.00
                                                  ──────────
                                                    ~ $0.14
```

It's just YAML in `~/.anvil/stage-policy.yaml`. Premium models only
appear where premium models actually matter. **Read-only research
and the fix-retry loop are locked to free tier — they cannot
escalate, by design.** A typical run with Ollama or OpenCode burns
single-digit dollars on cloud calls.

### Auto-failover when a provider misbehaves

If a model 429s, 5xx's, hits a quota wall, or fails its liveness probe
mid-run, Anvil's chain-walker **burns it for the rest of the run** and
falls through to the next entry in the same tier — same provider or
different, your call. The pipeline doesn't pause, doesn't surface a
stack trace at the user, and doesn't double-charge by retrying the same
broken model. Every fallback hop emits a routing event so you can see
exactly which model was skipped and why.

```
clarify   →  adk:gemini-2.5-flash   ❌  (provider liveness fail)
          ↪  opencode/kimi-k2.6     ✅  (next in chain, same tier)
build     →  opencode/qwen3.5-plus  ❌  (429 — Alibaba upstream)
          ↪  opencode/glm-5.1       ✅  (model burned for run, fallback proceeds)
```

Two layers of detection: a **proactive** liveness probe at run start
(Ollama `/api/tags`, env-var presence for cloud) and a **reactive**
duck-typed `UpstreamError` check on every adapter call. Configurable
per-run cap on retry attempts in `models.yaml` (`walker.max_attempts`).

### One GPU, many models — exclusive slot serialization

Big local models can't all share a single GPU at the same time.
If your `clarify` and `build` stages both want a heavy Ollama
model, naive concurrency ends in an OOM. Anvil's
`exclusive_slot: true` flag puts those models behind a
**process-local FIFO queue** so only one exclusive model is ever
GPU-resident at a time.

The queue does the dance for you:

- **Hard eviction on switch.** Going from model A → model B
  explicitly tells Ollama to release A's weights, then polls until
  the GPU has actually freed them before letting B load. No GPU
  briefly holding both.
- **Intruder detection.** An out-of-band Ollama session on the host
  (e.g. you ran `ollama run` in another terminal) gets evicted
  before the next exclusive load — so two big models can't sneak
  in side by side.
- **Embeddings + rerankers bypass.** They're small enough to
  co-reside, so they never touch the queue.
- **Same-model calls are free.** Consecutive calls to the same id
  skip the eviction step entirely. A stage fanning out across repos
  pays the model-load cost once.

Mark a model exclusive in `~/.anvil/models.yaml`:

```yaml
- id: ollama/qwen2.5-coder:14b
  provider: ollama
  tier: local
  vram_gb: 9
  exclusive_slot: true        # mandatory for any VRAM-heavy local
```

Lets you mix multiple big local models on the same machine without
manual sequencing or OOM kills, regardless of how much VRAM you
actually have.

### Cost ledger, live

Every adapter call attaches a real `gen_ai.usage.cost` attribute
computed from a vendored LiteLLM pricing snapshot. The dashboard
shows you per-call, per-stage, per-run spend in real time. The
OpenTelemetry export carries the same numbers if you want them in
Langfuse, Tempo, or Honeycomb.

**No estimates. No surprises.**

---

## What you can do with Anvil

<table>
<tr>
<td width="33%" valign="top">

### Pipeline
Nine-stage feature pipeline — clarify, plan, build, test, validate,
ship — fanned out across every repo in your project. Per-stage
tool permissions, validate-fix retry loops, chain-fallback across
models when a provider 429s.

</td>
<td width="33%" valign="top">

### Plan
Generates a structured markdown plan before any code is written.
Files touched, contracts crossed, risks flagged, cost estimated.
Plan validators catch missing tests, missing rollback strategies,
wrong stage routing. The agent can't skip planning.

</td>
<td width="33%" valign="top">

### PR Review
Multi-pass automated review with evidence gates, incident binding,
KB context, scope matching, dismissal filtering, and a verifier
that runs the produced tests. Posts inline comments + a summary
to GitHub.

</td>
</tr>
<tr>
<td width="33%" valign="top">

### Memory
Long-term project memory with five types — working, episodic,
semantic, procedural, profile. Auto-learners propose; a sleeptime
ratifier decides. Code-fact drift detection keeps memories honest
when the underlying file changes.

</td>
<td width="33%" valign="top">

### Project
Multi-repo first. One `factory.yaml` describes your repos,
languages, build commands, and cross-repo connections. Ships
with templates for TypeScript, Go, Python, Rust, monorepos, and
Django + Celery.

</td>
<td width="33%" valign="top">

### Knowledge Base
AST-aware chunking via tree-sitter, hybrid retrieval (vector +
BM25 + graph + rerank), project graph with 14 cross-repo edge
strategies. Same engine the dashboard uses also exposed as an MCP
server for any client.

</td>
</tr>
<tr>
<td width="33%" valign="top">

### Settings
Provider keys, model registry, stage policy, OTel endpoint — all
editable in the dashboard UI. Writes to `~/.anvil/.env` with a
strict allowlist; no env-var injection.

</td>
<td width="33%" valign="top">

### Convention
Extracts your codebase's real conventions — naming, imports,
tests, error handling — formats them as living docs, and promotes
recurring violations into hard rules. The agent stops making the
same mistake twice.

</td>
<td width="33%" valign="top">

### History
Every run, replayable. Diffs, PR URLs, reviewer verdicts, cost
breakdown, model fallbacks taken. Resume any failed run from the
failed stage; rollback any shipped run with one click.

</td>
</tr>
<tr>
<td width="33%" valign="top">

### Research
Read-only investigation — *"what does this service do?"* or
*"why does this fail?"* — that never escalates to premium models.
Stays free-tier no matter what, because read-only shouldn't cost
more.

</td>
<td width="33%" valign="top">

### Bug Fix
Targeted fix workflow with a tight retry loop. Locked to local +
cheap tier so a failing test doesn't burn premium tokens trying
the same thing five times.

</td>
<td width="33%" valign="top">

### Observability
OpenTelemetry spans with GenAI semantic conventions. Plug in
Langfuse, Tempo, Honeycomb, or anything OTLP-compatible. Off by
default. Privacy-safe prompt redaction. Real per-call cost ledger.

</td>
</tr>
<tr>
<td width="33%" valign="top">

### Auto-failover
Provider goes down, hits a quota wall, or fails its liveness probe?
The chain-walker burns the model for the rest of the run and walks
to the next entry in the same tier — proactive (liveness probe at
run start) plus reactive (`UpstreamError` duck-typing on every call).
No paused runs, no double charges.

</td>
<td width="33%" valign="top">

### Resume + rollback
Every run is checkpointed per stage. Resume from the failing stage
without re-running the cheap stages before it. Roll back any shipped
run with one click — branch + PR delete, restored workspace, audit
log preserved.

</td>
<td width="33%" valign="top">

### MCP server
Anvil's knowledge-base retriever ships as a standalone MCP server.
Use it from Claude Code, Claude Desktop, Cursor, or any MCP client —
same hybrid retrieval (vector + BM25 + graph + rerank), same project
graph, no dashboard required.

</td>
</tr>
</table>

---

## Observability (opt-in)

Telemetry is **off by default**. When you turn it on, every adapter
call emits an OpenTelemetry span with GenAI semantic conventions —
prompt + completion tokens, cost, latency, model, provider, error
class. Plug in any OTLP-compatible backend.

### Two switches, one env var each

```sh
# 1. Export to a real OTLP collector — Langfuse, Tempo, Honeycomb, …
echo 'OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel/v1/traces' >> ~/.anvil/.env
echo 'OTEL_SERVICE_NAME=anvil-dashboard' >> ~/.anvil/.env

# 2. Or dump spans to stderr — useful for debugging without a collector
echo 'ANVIL_OTEL_CONSOLE=1' >> ~/.anvil/.env
```

Restart the dashboard and traces start flowing.

### Privacy + noise controls

| Variable | Default | What it does |
|:---|:---:|:---|
| `ANVIL_OTEL_DISABLED` | unset | Hard kill-switch — set to `1` to disable everything |
| `ANVIL_OTEL_RECORD_CONTENT` | `0` | Set `1` to include prompt + completion text on spans (truncated to 8 KB per attribute) |
| `OTEL_LOG_LEVEL` | `NONE` | Set to `ERROR` / `INFO` / `DEBUG` to surface SDK errors when debugging |
| `ANVIL_OTEL_BATCH` | unset | Set `1` to batch span exports (lower IO, slightly delayed arrival) |

By default, spans carry **structure but not content** — model, cost,
latency, error class, all attached. Prompts and completions stay on
disk only.

### Quick local stack: Langfuse

Anvil ships a tuned Langfuse compose file at
[`infra/observability/`](infra/observability/) — Langfuse 3.x +
Postgres + ClickHouse + Redis + MinIO, pre-wired for the OTLP HTTP
endpoint Anvil exports to. No external clone needed:

```sh
# Spin up the bundled stack on http://localhost:3000
docker compose -f infra/observability/docker-compose.yml up -d

# In ~/.anvil/.env (use the keys you create in the Langfuse UI)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:3000/api/public/otel/v1/traces
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer pk-lf-...
OTEL_SERVICE_NAME=anvil-dashboard
```

Anvil's dashboard auto-detects the local Langfuse on port 3000 — if
it's running and you haven't set `OTEL_EXPORTER_OTLP_ENDPOINT`
yourself, the dashboard wires it up automatically. Tear down with
`docker compose -f infra/observability/docker-compose.yml down -v`.

### What you'll see

- One **`anvil.agent.session`** parent span per pipeline stage,
  linking every adapter call and resume into a single trace.
- A **`gen_ai.invoke`** child span per LLM call, with
  `gen_ai.system`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`,
  `gen_ai.usage.output_tokens`, and a real **`gen_ai.usage.cost`**
  in USD.
- **`gen_ai.tool.<name>`** child spans for every tool call the agent
  makes, closed when the matching `tool_result` arrives.
- A **routing-decision** attribute group (`anvil.routing.*`) on the
  invoke span so you can see why a particular model was picked, and
  which models got burned mid-run.

The OTLP export carries the same numbers the dashboard's cost panel
shows. One source of truth.

---

## How it all fits together

Anvil is a TypeScript monorepo. Each package owns one concern; the
dashboard ties them together.

```
                         ┌────────────────────────┐
                         │     anvil dashboard    │  the control plane
                         │   (React + WebSocket)  │
                         └────────────┬───────────┘
                                      │ orchestrates
                                      ▼
                  ┌───────────────────────────────────────┐
                  │         pipeline-runner               │
                  │  9-stage walker · per-repo fan-out    │
                  │  validate-fix loop · chain-fallback   │
                  └───┬──────┬──────┬──────────┬──────┬───┘
                      │      │      │          │      │
                      ▼      ▼      ▼          ▼      ▼
                  ┌──────┐ ┌────┐ ┌──────┐ ┌──────┐ ┌──────────┐
                  │agent-│ │core│ │knwldg│ │memory│ │convention│
                  │ core │ │pipe│ │ core │ │ core │ │  -core   │
                  └──┬───┘ └─┬──┘ └───┬──┘ └───┬──┘ └────┬─────┘
                     │       │        │        │         │
                     ▼       ▼        ▼        ▼         ▼
                       ~/.anvil/  · models.yaml · stage-policy.yaml
                                  · runs/<id>/  · features/<slug>/
                                  · knowledge-base/<project>/
                                  · memories/  · conventions/
```

Three different fronts ride on the same engine:

- **`anvil` CLI** — `init`, `doctor`, `dashboard` (the front door)
- **Dashboard** — full pipeline control with live agent activity
- **`code-search-mcp`** — same retriever exposed over MCP, usable
  from Claude Code, Claude Desktop, Cursor, or any MCP client

### Per-package deep dives

| Package | What it owns |
|:---|:---|
| [`@esankhan3/anvil-cli`](packages/cli/) | CLI entry point + bundled dashboard |
| [`@anvil-dev/dashboard`](packages/dashboard/) | React UI + WebSocket pipeline orchestrator (private — bundled into the CLI tarball) |
| [`@esankhan3/anvil-agent-core`](packages/agent-core/) | 8 LLM adapters, router, cost, OTel |
| [`@esankhan3/anvil-core-pipeline`](packages/core-pipeline/) | Typed `Step<I,O>` graph + EventBus + hooks |
| [`@esankhan3/anvil-knowledge-core`](packages/knowledge-core/) | AST chunks, graph, hybrid retrieval |
| [`@esankhan3/anvil-memory-core`](packages/memory-core/) | Five-type memory, bi-temporal, drift detection |
| [`@esankhan3/anvil-convention-core`](packages/convention-core/) | Convention extractor + promotion ledger |
| [`@esankhan3/code-search-mcp`](packages/code-search-mcp/) | MCP server wrapping `knowledge-core` |

---

## Configuration

Three files run the show, all in `~/.anvil/`:

| File | What it does |
|:---|:---|
| `.env` | Provider keys + observability switches |
| `models.yaml` | The model registry — local, cheap, premium tiers |
| `stage-policy.yaml` | Which tier handles which pipeline stage |

Working examples live in [`examples/anvil-home/`](examples/anvil-home/).
Bootstrap with:

```sh
cp examples/anvil-home/.env.example      ~/.anvil/.env  && chmod 600 ~/.anvil/.env
cp examples/anvil-home/models.yaml       ~/.anvil/models.yaml
cp examples/anvil-home/stage-policy.yaml ~/.anvil/stage-policy.yaml
```

`anvil init` does the equivalent for `models.yaml` automatically.

---

## Project setup examples

Three opinionated starters in [`examples/`](examples/):

- **[TypeScript monorepo](examples/typescript-monorepo/)** — Next.js
  storefront + Express API, Postgres, Redis
- **[Go microservices](examples/go-microservices/)** — multi-service
  Go workspace
- **[Python ML](examples/python-ml/)** — training + serving split

Copy a `factory.yaml`, adjust paths, and `anvil init` against your
own workspace.

---

## Built with

We rely on the best of the open ecosystem:

[`tree-sitter`](https://tree-sitter.github.io/) ·
[`LanceDB`](https://lancedb.com/) ·
[`graphology`](https://graphology.github.io/) ·
[`OpenTelemetry`](https://opentelemetry.io/) ·
[`Model Context Protocol`](https://modelcontextprotocol.io/) ·
[`React`](https://react.dev/) ·
[`Vite`](https://vitejs.dev/) ·
[`commander`](https://github.com/tj/commander.js)

---

## Status

<table>
<tr>
<td valign="top" width="50%">

**MVP 2 — Active**

The dashboard is the canonical interface. The CLI ships
`init`, `doctor`, `dashboard` today; more direct-scripting
commands are on deck.

</td>
<td valign="top" width="50%">

**Stable**

Pipeline orchestration · multi-provider routing · knowledge
indexing · memory ratification · convention extraction ·
PR review · OpenTelemetry · dashboard UI.

</td>
</tr>
</table>

**In flight:** durable execution · richer plan validators · deeper
RAG-eval · additional MCP tools.

---

## Releasing (maintainers)

Anvil ships as **six public npm packages** under the `@esankhan3` scope.
The CLI is the front door; the five `anvil-*` cores are real registry
deps, not bundled. End users only ever `npm install` the CLI — npm
resolves the rest.

### Publish order matters

Cross-deps form a graph; later packages depend on earlier ones, so
publish in this order. If a step fails, fix it and re-run from that
step — earlier successful publishes are immutable on npm.

```sh
# 0. confirm auth + clean build
npm whoami                                    # should print: esankhan3
npm install                                   # relink workspaces
npm run build                                 # builds every package

# 1. publish in dependency order
npm publish -w @esankhan3/anvil-agent-core      --access public
npm publish -w @esankhan3/anvil-knowledge-core  --access public
npm publish -w @esankhan3/anvil-memory-core     --access public
npm publish -w @esankhan3/anvil-convention-core --access public
npm publish -w @esankhan3/anvil-core-pipeline   --access public
npm publish -w @esankhan3/anvil-cli             --access public

# 2. tag the release (triggers .github/workflows/release.yml → GitHub Release)
git tag v0.1.0
git push origin v0.1.0
```

### Bumping versions

Every package shares one version line — bump all six together. Update
the `version` field in each `packages/*/package.json` and any
cross-dep range in `dependencies` that needs to widen, then re-run
the publish chain above.

### Verify the published install

```sh
TMP=$(mktemp -d) && cd "$TMP" && npm init -y >/dev/null
npm install @esankhan3/anvil-cli@latest
node node_modules/.bin/anvil --version        # should print the new version
```

This installs the CLI from the registry plus all five core deps —
exactly what an end user gets.

### Why six packages, not one bundle?

Workspace symlinks make `anvil-loc` (the local dev binary) work
without any of these being on npm. End-user installs don't have
symlinks — npm has to resolve every dep against the registry. So
each `@esankhan3/anvil-*` core has to exist as a real published
package. The dashboard (`@anvil-dev/dashboard`) is the one
exception: it stays private and is **bundled** into the CLI tarball
via `packages/cli/scripts/bundle-dashboard.mjs`.

---

<div align="center">

## License

[MIT](LICENSE) — bring it to your team, fork it, ship it.

<br />

<sub><b>No hosted plan. No telemetry sent to us.<br />
Your code, your keys, your budget. That's the deal.</b></sub>

<br /><br />

<sub>Built for engineers who want their AI tools to <b>respect their stack and their wallet</b>.</sub>

</div>
