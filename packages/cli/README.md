<div align="center">

# Anvil

**AI agents that ship features across multi-repo codebases**

[![npm](https://img.shields.io/npm/v/@esankhan3/anvil-cli?style=flat-square&color=8B5CF6)](https://www.npmjs.com/package/@esankhan3/anvil-cli)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A5%2020-339933?style=flat-square&logo=node.js&logoColor=white)]()

</div>

---

## Install

```bash
npm install -g @esankhan3/anvil-cli
```

The package ships the `anvil` CLI and the dashboard (React UI + Node server) as a single bundle — no extra install steps.

---

## Quick Start

```bash
anvil doctor       # verify Node, git, gh, Claude CLI, providers
anvil dashboard    # launch dashboard at http://localhost:5173
anvil init         # scaffold an anvil project
```

Open the dashboard, select your project, and describe what you want to build. Anvil clarifies, plans, codes, tests, and opens PRs across every repo in your project.

---

## Commands

| Command | Description |
|:--------|:------------|
| `anvil dashboard` | Launch the dashboard (HTTP + WebSocket server + static UI) |
| `anvil init` | Initialize an Anvil project in the current directory |
| `anvil doctor` | Check environment and provider setup |

Options for `anvil dashboard`:

- `-p, --port <port>` — port to serve on (default: `5173`)
- `--no-open` — don't auto-open the browser

---

## Requirements

- **Node.js ≥ 20**
- **git** and **gh** (GitHub CLI) — for PR creation
- **Claude CLI** (`npm i -g @anthropic-ai/claude-code`) — primary agent provider
- **Gemini CLI** (optional) — alternative provider

---

## How it works

An 8-stage pipeline driven by AI agents:

```
Clarify → Requirements → Repo Reqs → Specs → Tasks → Code → Test → Ship
```

- **AST-parsed knowledge graphs** across your repos
- **Cross-repo dependency detection** (npm, HTTP routes, Kafka topics, DB tables, shared types, and 10+ more signals)
- **Convention learning** — Anvil reads your existing code and matches its style
- **Cost-controlled model routing** — cheap models for drudgery, frontier models for hard steps

---

## Links

- **Repository**: https://github.com/esanmohammad/Anvil
- **Issues**: https://github.com/esanmohammad/Anvil/issues
- **Demo**: https://drive.google.com/file/d/1xsJWrYI5C6aaoE5_n4DbOTaFie1L2d7G/view

---

## License

MIT
