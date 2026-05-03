# Observability — Langfuse Consolidation ADR

> **Status:** Draft. Supersedes decision **O4** of [`AGENT-OBSERVABILITY-ADR.md`](./AGENT-OBSERVABILITY-ADR.md). Companion deletion plan included in §5.
>
> **Date:** 2026-05-03

This ADR narrows the supported observability backend from "any OTLP HTTP target" to **Langfuse only**, and removes the in-tree Grafana/Tempo/Prometheus/Loki stack at `infra/observability/`.

---

## 1. Problem statement

The original observability ADR (decision **O4**) chose vendor-neutral OTLP HTTP and shipped a generic Grafana stack at `infra/observability/` (Tempo for traces, Prometheus for metrics, Loki for logs). That decision was correct for a generic backend service. It is wrong for an **agent product**.

The data this product produces is fundamentally agent-shaped:

- A run is a tree of LLM calls, each with prompt + completion text, token usage, cost, and a sub-tree of tool calls.
- Operators reading a trace want to answer: *which model did this turn use, what did it cost, what did it output, which tool did it call, and why did the chain-fallback fire*.
- Grafana renders these as flat key/value attributes. There is no LLM-aware UI, no prompt/completion side-by-side, no tool-call hierarchy, no cost rollup. The Anvil-Trace-Explorer dashboard at `infra/observability/grafana/dashboards/anvil-trace-explorer.json` is a workaround, not a fit.

Langfuse renders the data natively because its data model **is** the agent data model: traces → observations (LLM calls / tool calls / spans) → scores. The OTLP HTTP ingest endpoint at `/api/public/otel/v1/traces` accepts the spans agent-core already emits without code change.

Operating two backends — one for "real" agent data we look at, one for "infra" data we don't — is dead weight. The infra side has no SLO, no on-call, no operator. It exists because the original ADR played safe.

---

## 2. Locked decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| L1 | Supported backends | **Langfuse only** (cloud or self-hosted) | One UI matches the data model. |
| L2 | OTel SDK | **Keep** (`@opentelemetry/api` + `sdk-trace-*` + `exporter-trace-otlp-http`) | OTel-the-protocol is unchanged; we just remove OTel-the-Grafana-stack. |
| L3 | GenAI semantic conventions (`gen_ai.*`) | **Keep** (decision O2 unchanged) | Native render path in Langfuse. |
| L4 | Self-hosted dev stack | **Promote** `packages/agent-core/scripts/otel-stack.yaml` from "smoke-test toy" to canonical local dev stack at `infra/observability/docker-compose.yml` | One stack, one path. |
| L5 | Auto-detection target | Dashboard probe in `dashboard-server.ts:215` switches from `localhost:4318/v1/traces` → `localhost:3000/api/public/otel/v1/traces` | Same DX (zero-config local), new endpoint. |
| L6 | Cost / token / cache attributes (decisions O6, O7) | **Unchanged** — agent-core remains source of truth | Same instrumentation seam; no per-adapter edit. |
| L7 | Privacy posture (decision O5) | **Unchanged** — `ANVIL_OTEL_RECORD_CONTENT=1` opt-in for prompt/completion | Self-hosted Langfuse keeps content on-network. |
| L8 | Vendor SDK | **Still no Langfuse SDK in dependencies** | OTLP HTTP wire is the contract; we are not coupling to a Langfuse client library. Recipe in agent-core README §Telemetry stays the integration surface. |

### Decisions superseded

- **O4** ("Configurable exporters: Console + OTLP HTTP") is superseded by **L1+L2**. Console exporter remains for local debugging (`ANVIL_OTEL_CONSOLE=1`); OTLP HTTP target is now Langfuse-shaped.

### Decisions explicitly preserved

- **O1, O2, O3, O5, O6, O7, O8, O9, O12, O13, O14** all unchanged.
- **O10** (no in-tree prompt management) and **O11** (no eval framework) are reaffirmed — Langfuse offers both as features; we do not adopt them.

---

## 3. What we keep and what we lose

### Keep
- In-process OTel tracer (`packages/agent-core/src/telemetry/`) — every span, every attribute, every cost calculation.
- All 25 telemetry tests in `@anvil/agent-core`.
- The kill-switch (`ANVIL_OTEL_DISABLED=1`) and console mode (`ANVIL_OTEL_CONSOLE=1`).
- `ALLOWED_ENV_KEYS` in `dashboard-server.ts` — `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_RESOURCE_ATTRIBUTES`, `ANVIL_OTEL_*` stay writable from Settings.

### Lose (and why it's fine for this product)
| Signal | Where it lived | Why it's fine to drop |
|---|---|---|
| HTTP latency / error rate for the dashboard server | Tempo + Grafana | Dev tool. No SLO. Logs are sufficient. |
| SQLite query timing (checkpoint cache, memory-core) | Tempo | When it matters, it surfaces as a slow child span inside the agent trace anyway. |
| Process metrics (CPU, RSS, OOM) | Prometheus | `top` / `Activity Monitor` cover it. Not worth a TSDB. |
| Loki logs | Loki + Grafana | App logs are stderr; users already read them in the terminal or dashboard activity stream. |
| 3 Grafana dashboards (`anvil-trace-explorer`, `anvil-pipeline-overview`, `anvil-cache-effectiveness`) | `infra/observability/grafana/dashboards/` | Functionality is duplicated by Langfuse's native trace + cost views. |

### Rollback safety
The in-process tracer is unchanged. Any operator who needs Tempo/Jaeger/Datadog/Honeycomb instead of Langfuse points `OTEL_EXPORTER_OTLP_ENDPOINT` at their target. The wire format is OTLP HTTP; there is no Langfuse-specific code path to undo.

---

## 4. Port allocation (resolves a collision)

Langfuse defaults to port **3000**, which collides with several common dev tools (Next.js, Create React App, etc.). The current Anvil dashboard listens on a different port, so there is no in-repo collision today, but the smoke-test recipe in `otel-stack.yaml:41` exposes Langfuse on `:3000` host-side.

**Decision:** keep `3000:3000` for Langfuse. The dashboard never binds to 3000 (it picks `--port` or defaults elsewhere). External services that already use 3000 on the host can override via the docker-compose `LANGFUSE_PORT` env var documented in §5.3.

---

## 5. Deletion + migration plan

Five steps. Each is independently reviewable; PRs can land in order.

### 5.1 Promote `otel-stack.yaml` → `infra/observability/docker-compose.yml`

- Move `packages/agent-core/scripts/otel-stack.yaml` to `infra/observability/docker-compose.yml`. Update the doc-comment header to drop "smoke-test" framing.
- Add a `LANGFUSE_PORT` env-var-with-default to the `langfuse-server` ports binding (`${LANGFUSE_PORT:-3000}:3000`).
- Add a top-level `name: anvil-observability` (matches existing convention).
- Update `packages/agent-core/README.md`'s self-hosted Langfuse recipe to reference the new path. Drop the Tempo/Phoenix/Honeycomb/Datadog/Jaeger recipes — leave only Langfuse cloud + Langfuse self-hosted. Keep a one-paragraph "if you need a different OTLP backend" pointer at the bottom for advanced operators.

### 5.2 Update auto-detect target in dashboard

- `packages/dashboard/server/dashboard-server.ts:215` — change candidate from `http://localhost:4318` to `http://localhost:3000/api/public/otel/v1/traces`.
- Probe is HEAD with ~500 ms timeout; the change is one constant.
- Update the log line at line 230 to reference Langfuse, not "OTel collector".
- Update the docstring at `packages/dashboard/CLAUDE.md` §"OTel auto-detection" and the architecture description at `packages/dashboard/ARCHITECTURE.md:22`.

### 5.3 Delete the Grafana stack

Remove the entire `infra/observability/` directory tree as it stood **before** step 5.1, then re-add `docker-compose.yml` from step 5.1. Concretely, the deletions are:

```
infra/observability/
├── collector/
│   └── config.yaml            ← delete
├── grafana/
│   ├── dashboards/
│   │   ├── anvil-cache-effectiveness.json   ← delete
│   │   ├── anvil-pipeline-overview.json     ← delete
│   │   └── anvil-trace-explorer.json        ← delete
│   └── provisioning/
│       ├── dashboards/provider.yaml         ← delete
│       └── datasources/datasources.yaml     ← delete
├── loki/
│   └── loki.yaml              ← delete
├── prometheus/
│   └── prometheus.yml         ← delete
├── tempo/
│   └── tempo.yaml             ← delete
└── docker-compose.yml         ← delete (replaced by 5.1)
```

Plus the smoke scripts referenced from `.claude/settings.local.json:130–140` (`infra/observability/.smoke-agent-core.mjs`, `.smoke-metrics.mjs`, `.smoke-phase3.mjs`) — verify they still exist on disk; if so, delete them and prune the four matching `Bash(...)` permissions from `.claude/settings.local.json`.

### 5.4 Update prose docs

Search-and-replace the four references that still describe the Grafana stack:

| File | Line | Current | New |
|---|---|---|---|
| `docs/ARCHITECTURE.md` | 649 | "probes `localhost:4318/v1/traces`" | "probes `localhost:3000/api/public/otel/v1/traces`" |
| `docs/MODELS-SETUP.md` | 47 | `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` | `=http://localhost:3000/api/public/otel/v1/traces` |
| `packages/dashboard/README.md` | 227 | "probes `localhost:4318/v1/traces`" | same as above |
| `packages/dashboard/CLAUDE.md` | 150 | references "Grafana/Tempo/Prometheus stack at `infra/observability/`" | replace with "self-hosted Langfuse stack at `infra/observability/docker-compose.yml`" |

`packages/agent-core/README.md` is rewritten as part of step 5.1.

### 5.5 Append phase log to parent ADR

Add a §11 "Langfuse consolidation" amendment to `AGENT-OBSERVABILITY-ADR.md` referencing this file and noting **O4 is superseded**. Do not delete O4 from the table; mark it with a strikethrough and a pointer to this ADR. This preserves the historical decision trail.

---

## 6. Acceptance gates

| Gate | How to verify |
|---|---|
| Local zero-config still works | `docker compose -f infra/observability/docker-compose.yml up -d` → wait ~30s → start dashboard → run a trivial pipeline → spans visible in Langfuse Traces tab at `http://localhost:3000` |
| Auto-detect lights up | Dashboard log line says `[dashboard] Auto-detected Langfuse at localhost:3000 — telemetry on` (or equivalent) |
| Tests still pass | `npm -w @anvil/agent-core test` → 25/25; `npm -w @anvil-dev/dashboard run test:server` no regression |
| No dangling references | `grep -rn "tempo\|loki\|prometheus\|grafana" --include="*.md" --include="*.ts" --include="*.yaml" .` returns zero hits outside of git history / changelogs |
| Cost & token attrs render | Open any LLM-call observation in Langfuse → "Token usage" section shows input/output/cache breakdown; cost USD matches `cost.ts` table |

---

## 7. Out of scope

- Langfuse SDK adoption (decision **L8** — still no vendor SDK).
- Langfuse prompt management (O10 unchanged).
- Langfuse evals (O11 unchanged; Inspect AI remains the eval runner per `AGENT-HARNESS-PLAN.md`).
- Langfuse Cloud setup beyond the env-var recipe in agent-core README.
- Migration of historical Tempo trace data — there is none worth keeping; this is dev-only.

---

## 8. Open questions

None blocking. Two minor:
- **Langfuse 3.x → 4.x?** The compose stack pins `langfuse:3`. When 4 ships, the OTLP HTTP contract is documented as stable across major versions; revisit at that time.
- **CI smoke?** Live smoke against a real Langfuse instance (per parent ADR Phase 5 §5.3 deviation) remains operator-runnable, not CI-runnable. No change here.
