# Browser + Web Tools — User Guide

Anvil agents can now read live docs, follow links, and drive a real
browser. This guide walks through enabling the surface, configuring the
backends, and reviewing the per-tool spend.

> **Status:** shipped through Phase H10. Tier 1 is fully wired by
> default; Tier 2 needs `playwright`; Tier 3 needs Docker.

---

## Three tiers

| Tier | Tools | Cost | Risk | Enabled by |
|---|---|---:|---|---|
| 1 — Web | `web_search`, `web_fetch` | ~$0.001–$0.01 / call | Low | env var with a search API key |
| 2 — Indexed Browser | `browser_navigate`, `browser_click`, `browser_input`, `browser_scroll`, `browser_search_page`, `browser_extract`, `browser_screenshot`, `browser_console_messages`, `browser_network_requests`, `browser_evaluate`, `browser_attach_context`, `browser_new_tab`, `browser_close_tab`, `browser_tabs`, `browser_done` | ~$0.015 / action | Medium | `npm install playwright` + `npx playwright install chromium` |
| 3 — Pixel Browser | `computer_use` | ~$0.045+ / action | High (vision tokens; pixel-injection) | Docker + opt-in via `pipeline-policy.overlay.json: tools.browsePixel.enabled = true` |

---

## Per-stage gating

The default per-stage allow-list lives in
`packages/core-pipeline/src/tools/web-tool-registry.ts:STAGE_WEB_PERMISSIONS`:

| Stage | Network | Browse-Headless | Browse-Eval | Browse-Pixel |
|---|---|---|---|---|
| clarify | ✓ | ✗ | ✗ | ✗ |
| requirements | ✓ | ✗ | ✗ | ✗ |
| repo-requirements | ✓ | ✗ | ✗ | ✗ |
| specs | ✓ | ✗ | ✗ | ✗ |
| tasks | ✓ | ✗ | ✗ | ✗ |
| plan | ✓ | ✗ | ✗ | ✗ |
| **build** | **✗** | ✗ | ✗ | ✗ |
| test | ✓ | ✓ | ✗ | ✗ |
| validate | ✓ | ✓ | ✓ | ✓ |
| **ship** | **✗** | ✗ | ✗ | ✗ |
| review | ✓ | ✗ | ✗ | ✗ |
| research | ✓ | ✗ | ✗ | ✗ |

`build` and `ship` are intentionally network-blocked. They mutate the
workspace + git state; live network access amplifies the blast radius
of a prompt-injection attack. If a build step needs upstream docs, the
`plan` stage pulls them ahead and threads them through `ctx.shared`.

---

## Configuration

### Tier 1 — search backends

Set ONE of these env vars in `~/.anvil/.env` or in the dashboard's
**Settings → Environment** panel:

- `BRAVE_SEARCH_API_KEY` (default; cheapest)
- `TAVILY_API_KEY` (free tier, AI-native)
- `EXA_API_KEY` (best semantic ranking)
- `SERPAPI_API_KEY`

Auto-detection picks the first one set in the order above.

### Tier 1 — fetch + summarizer

`web_fetch` runs each page through a cheap-tier summarizer so the main
agent never sees raw HTML. The summarizer is provider-agnostic:

```yaml
# ~/.anvil/stage-policy.yaml
stages:
  web-summarizer:
    capability: reasoning
    complexity: S
    prefer: [local, cheap]
  browser-extractor:
    capability: reasoning
    complexity: S
    prefer: [local, cheap]
```

When these stages aren't in your `stage-policy.yaml`, Anvil falls back
to the `research` stage's chain (also FREE-tier), so existing configs
keep working out of the box.

### Tier 2 — Playwright

```sh
npm install -w @anvil-dev/dashboard playwright
npx playwright install chromium
```

Restart the dashboard. The bridge auto-detects Playwright on first
`browser_navigate` call.

### Tier 3 — Docker computer-use

Default-disabled. Opt in per project:

```jsonc
// ~/.anvil/projects/<slug>/pipeline-policy.overlay.json
{
  "tools": {
    "browsePixel": { "enabled": true }
  }
}
```

The runtime requires Docker + a vision-capable model (Claude Opus 4.5+,
Sonnet 4.6+, GPT-4o CUA, Gemini 2.5 Computer Use).

### Per-project overlay

Tighten or loosen the defaults in
`~/.anvil/projects/<slug>/pipeline-policy.overlay.json`:

```jsonc
{
  "tools": {
    "network": {
      "stages": ["clarify", "plan"],
      "allowedDomains": ["*.docs.example.com", "github.com/*"]
    },
    "browseHeadless": {
      "stages": ["validate"],
      "contexts": ["docs-portal"]
    },
    "browsePixel": { "enabled": false }
  },
  "cost": {
    "tools": {
      "perRunUsd": 1.0,
      "perStageUsd": 0.25,
      "perToolPerCallUsd": 0.10
    }
  }
}
```

---

## Named contexts (auth)

Some doc sites require login. Save a persistent cookie jar once:

```sh
anvil browser login docs-portal https://docs.example.com/login
```

The CLI launches a headed Chromium; you sign in; close the window. The
storage state is saved to
`~/.anvil/browser/contexts/<projectSlug>/docs-portal/`.

To allow the agent to use it:

```jsonc
// pipeline-policy.overlay.json
{
  "tools": { "browseHeadless": { "contexts": ["docs-portal"] } }
}
```

The agent can then call `browser_attach_context({name: "docs-portal"})`
inside an active browse loop.

List saved contexts:

```sh
anvil browser list -p <project-slug>
```

---

## Defenses (the §H stack)

7-layer paranoia, on by default:

1. **Cheap-tier summarizer pre-filter** — `web_fetch` never gives the
   main agent raw HTML.
2. **Allowed-domain enforcement** — per-project + per-stage allow-list,
   resolution order: deny > stage > project > policy default.
3. **DOM serializer command-stripping** — Tier 2 strips `<script>`,
   inline event handlers; replaces `[INST]…[/INST]` /
   `<system>…</system>` / "ignore prior instructions" patterns with
   `[STRIPPED-INJECTION-CANDIDATE]`.
4. **Tool-call rate limits** — `browser_click` 1/sec, `browser_screenshot`
   6/min per session; `web_fetch` 15-min cache by `(url, prompt)`.
5. **No-progress detector** — 3 actions without changing
   `(url, viewportHash, lastInteractionType)` annotates the next state
   with `[__anvilBrowseStalled]` so the agent can `browser_done`.
6. **Critical-action confirmation** — `browser_evaluate`,
   `browser_attach_context`, all `computer_use` actions go through a
   confirm gate. Set `ANVIL_AUTOCONFIRM_BROWSE=1` to bypass in CI.
7. **Session lease + timeouts** — 15-min soft timeout per browser
   session; expired sessions are swept on a periodic interval.

---

## Cost + replay

Every web/browser action is recorded as a `ctx.effect(...)` event.
On crash recovery (G1 takeover) the recorded answer / DOM state
returns instantly; the network call doesn't fire again.

> **Caveat — browser session continuity on resume.** Auto-takeover
> replays the durable log, but the Playwright child process from the
> original run is gone. Cookies set via `browser_navigate` within the
> run are lost on resume. Recorded *answers* still surface (so the
> agent sees the same DOM state it saw before the crash), but if the
> agent re-issues a `browser_navigate` after the resume cursor, the
> new session starts unauthenticated. Use a named context
> (`anvil browser login`) when persistent auth is required.

The dashboard's **Run history → Durable execution log** tab shows:

- Filter chips: `all / steps / effects / signals / web / browser / computer`.
- Per-tool cost panel — aggregates spend by namespace.
- Inline summaries: search query, fetch URL, click index, computer action type.

`originalCostUsd` + `replayed: true` are surfaced on resumed runs so
the cost ledger stays honest.

---

## CLI reference

```sh
# Save a browser context
anvil browser login <name> <url> [--project <slug>]

# List saved contexts for a project
anvil browser list [--project <slug>]
```

Tier 1 + Tier 2 tools are agent-only — no direct CLI invocation. Use
the dashboard's **Run history → Durable execution log** to inspect
what the agent did.

---

## Troubleshooting

**`web_search backend not configured`** — set one of the search API
env vars (Brave / Tavily / Exa / SerpAPI).

**`web_fetch: summarizer is not wired`** — the dashboard wires this
automatically. If you see this in tests, pass
`createWebToolBridge({ summarizerInvoker: ... })`.

**`playwright is not installed`** — run `npm install -w
@anvil-dev/dashboard playwright && npx playwright install chromium`.

**`browser context "X" not in project allow-list`** — add the context
name to `tools.browseHeadless.contexts` in
`pipeline-policy.overlay.json`.

**`Tier 3 pixel-browser requires Docker`** — install Docker, then opt
in via `tools.browsePixel.enabled = true` in the overlay.
