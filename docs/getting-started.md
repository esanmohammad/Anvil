# Getting started with Anvil

A complete walkthrough from a fresh machine to your first shipped
feature. Plan on roughly 20 minutes for the first run, less once
you've done it once.

If you just want the marketing pitch, that's the [main README](../README.md).
This document is the practical setup guide.

---

## 1. Prerequisites

Anvil is a Node.js application that drives external CLIs and
optional local model runtimes. You'll need a subset of these
installed on your machine — **`anvil doctor` will tell you exactly
which ones are missing.**

### Required

| Tool | Why | Install |
|:---|:---|:---|
| **Node.js ≥ 18** | Runs the Anvil CLI and dashboard | [nodejs.org](https://nodejs.org/) or `brew install node` |
| **git** | Pipeline ships PRs against git repos | usually preinstalled; `brew install git` |
| **gh** (GitHub CLI) | Required to create PRs from the ship stage | [cli.github.com](https://cli.github.com/) — then `gh auth login` |

### Required for at least one provider

You need *one* of these, not all of them:

| Tool / key | What it powers |
|:---|:---|
| **`claude` CLI** + `ANTHROPIC_API_KEY` | Claude adapter (best-in-class reasoning) |
| **`OPENAI_API_KEY`** | GPT models |
| **`GOOGLE_API_KEY`** or **`GEMINI_API_KEY`** | Gemini + Google ADK |
| **`OPENROUTER_API_KEY`** | One key, hundreds of models |
| **`OPENCODE_API_KEY`** | OpenCode Zen subscription ($10/mo) — replaces local GPU |
| **Ollama** running on `localhost:11434` | Fully offline, your own GPU |

### Where to get provider keys

- **Anthropic (Claude)** — [console.anthropic.com](https://console.anthropic.com/) → Settings → API Keys
- **OpenAI** — [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
- **Google AI (Gemini)** — [aistudio.google.com/app/apikey](https://aistudio.google.com/app/apikey)
- **OpenRouter** — [openrouter.ai/keys](https://openrouter.ai/keys)
- **OpenCode Zen** — [opencode.ai/zen](https://opencode.ai/zen)
- **Ollama** — [ollama.com/download](https://ollama.com/download), then `ollama pull qwen3:14b` (or any model you want)

### Optional but useful

- **`claude` CLI** — `npm install -g @anthropic-ai/claude-code`
- **`gemini` CLI** — `npm install -g @google/gemini-cli`

---

## 2. Install Anvil

```sh
npm install -g @esankhan3/anvil-cli
```

Confirm:

```sh
anvil --version
```

You should see `0.1.0`.

---

## 3. Set up your provider keys

Anvil reads provider keys from three places, in order: `process.env`,
`~/.anvil/.env`, and `~/.anvil/auth.json`. The dashboard's Settings
UI writes to `~/.anvil/.env`.

For first-time setup, the easiest path is to copy the example file:

```sh
mkdir -p ~/.anvil
cp examples/anvil-home/.env.example ~/.anvil/.env
chmod 600 ~/.anvil/.env
```

Open `~/.anvil/.env` and fill in the provider keys you have. You
can leave the rest commented out — Anvil only uses what's set.

```sh
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
# OPENAI_API_KEY=...
# GOOGLE_API_KEY=...
# OPENROUTER_API_KEY=...
# OPENCODE_API_KEY=...
```

You can also set these in your shell profile (`~/.zshrc` /
`~/.bashrc`) — Anvil picks them up either way.

---

## 4. Initialize a project

`anvil init` is the one-time setup for each project you want
Anvil to work on. It scaffolds your `~/.anvil/` directory,
installs persona prompts, seeds `models.yaml`, and writes a
`factory.yaml` describing your repos.

```sh
cd /path/to/your/project
anvil init
```

You'll be asked:

| Prompt | What to enter |
|:---|:---|
| **Project name** | A slug, e.g. `my-app`. Defaults to your CWD's directory name. |
| **Title** | Human-readable name. Defaults to the slug. |
| **Workspace path** | Where your repos live on disk. Defaults to your CWD. |
| **Add a repository?** | `y` for each repo Anvil should manage. |
| **Repo name** | A slug for the repo, e.g. `web`, `api`. |
| **Path** | Path relative to the workspace, e.g. `./web`. |
| **GitHub org/repo** | Optional, e.g. `acme/web`. Lets Anvil clone for you and create PRs. |
| **Language** | `typescript` / `go` / `python` / `java` / `rust` / `other` — picks default build/test/lint commands. |
| **Build / Test / Lint / Format** | Override the defaults if needed. |
| **Domain description** | One-line context for agents. Optional but very helpful. |
| **Project invariants** | Rules agents must never violate (e.g. *"never store user passwords"*). Optional. |

What gets written:

```
~/.anvil/
├── .env                              ← your provider keys (you wrote this)
├── config.yaml                       ← Anvil-wide config
├── models.yaml                       ← model registry (seeded from template)
├── personas/                         ← 15 persona prompt files
└── projects/<your-project>/
    └── factory.yaml                  ← project config

<your-workspace>/
└── .factory/
    ├── config.yaml                   ← workspace marker
    └── factory.yaml -> ~/.anvil/projects/<your-project>/factory.yaml
```

After init runs, it auto-runs `anvil doctor` to verify everything
is wired up.

### Templates (skip the prompts)

If you'd rather start from a known-good config:

```sh
anvil init --list-templates
anvil init --template typescript-nextjs
```

Six bundled templates ship today: `typescript-nextjs`,
`go-microservices`, `python-fastapi`, `rust-axum`,
`monorepo-turborepo`, `django-celery`.

---

## 5. Verify your setup

```sh
anvil doctor
```

You should see something like:

```
  ✓ Node.js v20.19.0 (>= 18 required)
  ✓ git 2.x
  ✓ gh 2.x (authenticated)
  ✓ claude 2.x
  ✓ Anvil home ~/.anvil
  ✓ Projects 1 configured (my-app)
    ✓ my-app: 1/1 repos cloned
  ✓ LLM Providers 4/4 configured
    ✓ OpenAI: API key set
    ✓ Gemini: API key set
    ✓ OpenRouter: API key set
    ✓ Ollama: running on localhost:11434
  All checks passed
```

If anything fails, see [Troubleshooting](#troubleshooting) below.

### Optional: pre-pull Ollama models

If you set up Ollama and want to pre-pull every model `models.yaml`
references:

```sh
anvil doctor --bootstrap-models
```

This reads `~/.anvil/models.yaml`, finds every `provider: ollama`
entry, and runs `ollama pull <id>` sequentially for any that aren't
already on disk.

---

## 6. Open the dashboard

```sh
anvil dashboard
```

Anvil boots a single Node process that hosts both the React UI
and the WebSocket backend, then opens your browser to it
(default `http://localhost:5173`).

The dashboard is the canonical interface for running pipelines —
the CLI today only ships `init`, `doctor`, and `dashboard` itself.
Everything else (running features, reviewing PRs, browsing
memory, editing routing) lives in the UI.

---

## 7. Run your first feature

In the dashboard:

1. Click **New run** in the top-right.
2. Pick the project you just initialized.
3. Type a feature description. Start small:
   *"Add a /health endpoint that returns 200 OK with the current
   git SHA."*
4. Click **Start**.

What you'll see:

- The pipeline view shows nine stages running left-to-right.
- The output panel streams every agent's tool calls, file edits,
  and shell output as they happen.
- The cost ledger ticks up per call.
- When the build stage finishes, a plan appears; review it and
  approve.
- When the ship stage finishes, your PR URL appears in the run
  detail and in your repo's GitHub PRs tab.

If a stage fails, click **Resume** in the run detail to retry from
that stage with the failure context attached. If a model 429s,
the chain-walker burns it and falls through automatically.

---

## 8. Tune routing (optional, recommended)

The default `models.yaml` and `stage-policy.yaml` are reasonable
starts but you'll want to tune them for your wallet and workflow.

```sh
# Stage policy — which tier handles which stage
cp examples/anvil-home/stage-policy.yaml ~/.anvil/stage-policy.yaml
$EDITOR ~/.anvil/stage-policy.yaml

# Models — registry of per-tier model choices
$EDITOR ~/.anvil/models.yaml
```

The basic mental model:

- **Heavy analysis** — `requirements`, `repo-requirements`, `specs`,
  `tasks`, `review`, `plan` → premium tier
- **Doing work** — `clarify`, `build`, `test`, `validate`, `ship`,
  `fix` → local + cheap tier
- **Read-only / loops** — `research`, `fix-loop`, `reflection` →
  free tier *only* (cannot escalate)

See the [CLI README's example configuration section](../packages/cli/README.md#example-configuration)
for the full schema reference.

---

## 9. Multi-repo setup

Anvil is designed for projects that span multiple repos. To add
another repo to an existing project:

```sh
$EDITOR ~/.anvil/projects/<your-project>/factory.yaml
```

Add another entry under `repos:`:

```yaml
repos:
  - name: web
    path: ./web
    github: acme/web
    language: typescript
    commands:
      build: npm run build
      test: npm test

  - name: api                # <-- new
    path: ./api
    github: acme/api
    language: go
    commands:
      build: go build ./...
      test: go test ./...
```

If you've added GitHub repos that aren't cloned yet, the dashboard's
project page has a **Clone all** button. Or run `anvil doctor` again
— it'll report any missing clones.

---

## 10. Index your knowledge base (optional)

Anvil's pipeline can use a hybrid retrieval index over your
codebase to give agents better context. The dashboard auto-indexes
on first run; you can also kick it manually:

The dashboard shows indexing progress in the **Knowledge** tab.
Once indexed, retrieval is automatic — every agent prompt that
touches code includes the most relevant chunks plus 1-hop graph
context.

---

## 11. Observability (optional)

Telemetry is **off by default**. To turn it on, see the
[Observability section](../README.md#observability-opt-in) of the
main README — two env vars, one minute of work.

---

## Troubleshooting

### `anvil doctor` says a provider is "not set"
Check `~/.anvil/.env` exists, has the right env var name, and is
readable (`chmod 600`). Then re-run `doctor`. The dashboard reads
the same file on startup; restart it after changes.

### `anvil doctor` says `gh: not authenticated`
```sh
gh auth login
```
Choose GitHub.com, HTTPS, and authenticate via browser. Then
re-run `doctor`.

### `anvil doctor` says `claude: not found`
Install the Claude CLI:
```sh
npm install -g @anthropic-ai/claude-code
```

### Ollama models won't pull
Confirm Ollama is running: `curl http://localhost:11434/api/tags`.
If that fails, start Ollama: `ollama serve` (or open the macOS app).
Then retry `anvil doctor --bootstrap-models`.

### Dashboard port already in use
`anvil dashboard --port 5174` (or any free port).

### Pipeline fails at the ship stage
Usually a `gh` auth or permissions issue. Confirm:
```sh
gh auth status
gh repo view <your-org>/<your-repo>
```
You need write access to the repo to push branches and open PRs.

### A model keeps 429-ing
Anvil's chain-walker burns it for the rest of the run automatically.
If it happens *every* run, edit `~/.anvil/models.yaml` to reorder
or remove the failing entry. Models within a tier are tried in the
order they appear.

### "No factory.yaml found for project"
Either re-run `anvil init`, or check that the project name in your
dashboard matches a directory under `~/.anvil/projects/`.

### Memory or knowledge-base feels stale
Both are incremental. Memory ratifies on a sleeptime cadence. The
knowledge base re-indexes on a SHA diff — if you suspect drift,
delete `~/.anvil/knowledge-base/<project>/<repo>/index_meta.json`
and the next pipeline run will full-rebuild.

---

## Where to go next

- [Main README](../README.md) — the value pitch, full feature list,
  architecture diagram.
- [`packages/cli/README.md`](../packages/cli/README.md) — full CLI
  reference with example configurations.
- [`packages/dashboard/README.md`](../packages/dashboard/README.md) —
  what the dashboard server does and how it integrates.
- [`packages/agent-core/README.md`](../packages/agent-core/README.md) —
  the LLM stack underneath everything.
- [`examples/`](../examples/) — runnable starter configurations for
  TypeScript, Go, Python, monorepos, ML.

If you hit something this guide didn't cover, file an issue —
that's how this document gets better.
