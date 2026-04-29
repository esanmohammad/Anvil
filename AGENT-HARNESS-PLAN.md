# Plan: Agent harness — SKILL.md loader, MCP client at agent layer, headless entry

> **Status: Proposed.** Self-contained executable plan — does not require prior conversation context. **Depends on [`AGENT-CORE-EXTRACT-PLAN.md`](./AGENT-CORE-EXTRACT-PLAN.md) being shipped** (the `LanguageModel` + `agent/` machinery lives in `@anvil/agent-core`). Optionally precedes or follows [`AGENT-OBSERVABILITY-PLAN.md`](./AGENT-OBSERVABILITY-PLAN.md) — neither blocks the other.

---

## Goals (what "done" means)

This plan delivers three independent-but-related capabilities. All three land in `@anvil/agent-core` so they're consumable by cli, dashboard, future headless runners, and (eventually) external eval harnesses.

1. **Skill harness** — Anvil discovers and loads `SKILL.md`-formatted procedural-knowledge units from a configurable directory, surfaces them as system-prompt fragments + allowed-tools constraints, and applies them at agent-invocation time. Format is the **Anthropic-OpenAI open standard** (Dec 2025 onwards), so skills written for Anvil work in Claude Code, Codex CLI, ChatGPT GPTs, and reverse — zero vendor lock-in.

2. **MCP client at the agent layer** — Anvil's agent loop discovers MCP (Model Context Protocol) servers configured for a project, fetches their tool catalogs at boot, and merges those tools with built-in tools into a single registry passed to the LLM provider. **Tools are an agent-layer concern, not a provider-layer concern** — the agent knows about all tools available to it; the provider just calls whatever it's handed.

3. **Headless agent entry point** — `runAgent(task, workspace) → trajectory` exported from `@anvil/agent-core`. A clean signature so future eval harnesses (Inspect AI, SWE-bench runners, custom benchmark scripts) can wrap Anvil as an external agent without scraping cli logs or replicating pipeline orchestration. The trajectory format follows the Inspect AI external-agent contract.

---

## Cost-benefit context

### Why this matters for an "agent core"

The `LanguageModel` interface (Plan A) and observability layer (Plan B) get you a callable, observable LLM. That's necessary but not sufficient. An *agent* is "LLM + tools + procedural knowledge + a loop." Without:

- Skills, every prompt has to bake in domain knowledge inline (bloats context, blocks reuse)
- MCP at the agent layer, the agent can only use tools the cli pipeline knows about (not e.g. a project-specific Slack server, GitHub server, internal-API server)
- A headless entry, you can't measure the agent against benchmarks — every measurement requires a custom scaffolding

### Why open standards (no lock-in)

- **SKILL.md format**: Anthropic-defined Oct 2025; OpenAI Codex CLI adopted it Dec 2025. Both major vendors converge on the same schema. Writing a parser once works for both ecosystems.
  - Reference: <https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview>
  - GitHub: <https://github.com/anthropics/skills>
- **MCP** (Model Context Protocol): Anthropic-defined Nov 2024, adopted by OpenAI (ChatGPT + Agents SDK), Google (Gemini, ADK), Microsoft (VS Code, Copilot), AWS (Bedrock).
  - Spec: <https://modelcontextprotocol.io/specification/2025-11-25>
- **Inspect AI external-agent contract**: UK AISI, MIT-licensed, used by frontier labs as the external-agent eval framework. We don't depend on Inspect AI; we just keep our entry compatible with its expected shape.
  - Repo: <https://github.com/UKGovernmentBEIS/inspect_ai>

### Net hand-edited LOC

- ~800 LOC of new code (skills parser/loader, MCP client at agent layer, headless entry, trajectory formatter, tests)
- ~50 LOC of edits in cli (call the new APIs)

### Lock-in budget

- **MCP TypeScript SDK** (`@modelcontextprotocol/sdk`) — already a dep of `code-search-mcp` for the server side; we add it to `agent-core` for the client side. Open-source MIT, multi-vendor governance. Acceptable.
- **No other new deps.** SKILL.md is plain markdown + YAML frontmatter; we parse with `yaml` (already in cli's dep tree) and a tiny frontmatter splitter.

---

## Current state assumed (snapshot at plan-execution time)

This plan assumes:

- `AGENT-CORE-EXTRACT-PLAN.md` shipped. `@anvil/agent-core` package exists with `LanguageModel` interface, all 7 adapters, registry, agent/ subprocess machinery, cost table.
- `AGENT-OBSERVABILITY-PLAN.md` is optional — telemetry is nice but not required for harness work.
- `code-search-mcp` is the Anvil mcp server (MCP server side already wired). Today it exposes `search`, `profile`, `graph`, `index-tools` to mcp clients (Claude Desktop, Cursor, etc.). **This plan does NOT modify that.** This plan adds the *client* side — Anvil's agent connects to OTHER MCP servers configured per project.
- No `.claude/skills/` directory exists in the repo.
- No headless entry `runAgent(...)` exists in agent-core.
- No MCP client code in `agent-core` (only mcp server code in `code-search-mcp`).

### Pre-flight reality check

```sh
test -d packages/agent-core || { echo "FAIL: agent-core not extracted; ship plan A first"; exit 1; }
test -f packages/agent-core/src/registry.ts || { echo "FAIL: registry.ts missing"; exit 1; }
grep -rln "@modelcontextprotocol/sdk" packages/agent-core 2>/dev/null && { echo "WARN: MCP client already imported in agent-core; reconcile"; }
test -d .claude/skills 2>/dev/null && echo "INFO: skills dir already exists; will be ingested"
npm -w @anvil/agent-core test  # baseline pass
```

---

## Decisions

| # | Decision | Choice | Rationale |
|---|---|---|---|
| H1 | Skill format | **Anthropic-OpenAI SKILL.md** (frontmatter `name`, `description`, optional `allowed-tools`, `disable-model-invocation`; markdown body) | Open standard adopted by both major vendors. Writing one parser ships skills usable in Claude Code, Codex CLI, ChatGPT GPTs, and reverse. |
| H2 | Skills directory | `.claude/skills/<skill-name>/SKILL.md` (default), configurable via `ANVIL_SKILLS_DIR` env or `factory.yaml` `skills.path` | `.claude/skills/` is the convention every consumer recognizes. |
| H3 | Skill discovery time | Eagerly scanned at agent-invocation start; cached per process | Filesystem read is cheap. No need for hot-reload in v1. |
| H4 | Skill activation logic | Description-as-router: skill descriptions are inserted into the system prompt; the model decides which to "load" by mentioning them; activation in v1 is "always include all skills under 32 KB combined" | Avoids inventing a custom selector before the model can ask for one. |
| H5 | MCP client SDK | **`@modelcontextprotocol/sdk`** (official Anthropic-published TypeScript SDK) | Open standard governance, multi-vendor; same SDK powers `code-search-mcp` server. |
| H6 | MCP server discovery | Reads `mcp.json` (or `.mcp/servers.json`) per project; supports `stdio` and `streamable-http` transports | Standard MCP config conventions; matches Claude Code's `mcp.json` shape. |
| H7 | Tool merge layer | Built-in tools + MCP-discovered tools merged in agent-core registry, then passed to provider as a single `ToolSchema[]` | Provider doesn't know about MCP; agent does. Clean seam. |
| H8 | Headless entry signature | `runAgent(task: AgentTask, workspace: WorkspaceConfig): Promise<AgentTrajectory>` | Inspect AI external-agent shape; `task` includes prompt + allowed tools, `trajectory` includes message log + final state + cost. |
| H9 | AgentTrajectory format | Inspect-AI-compatible: `messages: Message[]`, `model: string`, `usage`, `cost`, `tool_calls`, `final_answer`, `error?` | Lets Inspect AI ingest it as `inspect eval --solver external` without conversion. |
| H10 | Eval harness ownership | NOT in this plan. Only the headless entry is in scope. | Inspect AI itself stays an external optional dep. |
| H11 | Skill tests format | Unit tests on the parser + integration tests where a fixture skill is loaded and we assert it appears in the prompt | Standard. |
| H12 | Skill content security | Skills can't `require()` arbitrary code in v1 — pure markdown + scripts referenced by relative path; agent decides whether to invoke them | Avoids malicious-skill RCE. Phase 7 (security review) revisits before any wider distribution. |

---

## Phase 0 — Audit + decisions (no code change)

**Effort:** 0.5d.

### 0.1 Audit deliverables

`AGENT-HARNESS-ADR.md`. Contents:

1. The decisions table above.
2. Schema reference for `SKILL.md` frontmatter (verbatim from Anthropic spec at execution time):
   - Required: `name`, `description`
   - Optional: `allowed-tools` (array), `disable-model-invocation` (bool), `version` (string)
3. Schema reference for `mcp.json` (per Claude Code convention):
   ```json
   {
     "mcpServers": {
       "github": {
         "command": "npx",
         "args": ["-y", "@modelcontextprotocol/server-github"],
         "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${env:GITHUB_TOKEN}" }
       },
       "internal-api": {
         "url": "https://internal-mcp.company.com/mcp",
         "headers": { "Authorization": "Bearer ${env:INTERNAL_API_TOKEN}" }
       }
     }
   }
   ```
4. Decide where to look for `mcp.json` — project root? `<projectRoot>/.mcp/servers.json`? `factory.yaml#mcp`? Document the search order.
5. Decide on the `AgentTask` / `AgentTrajectory` schemas (sample below).

### 0.2 Acceptance

- [ ] ADR written
- [ ] Pre-flight reality check passes
- [ ] Schemas decided and documented

### 0.3 Rollback

N/A — doc-only.

---

## Phase 1 — Scaffold skill loader infrastructure

**Effort:** 0.5d.

### 1.1 Directory shape inside agent-core

```
packages/agent-core/src/skills/
├── index.ts              public exports
├── types.ts              Skill, SkillFrontmatter
├── parser.ts             SKILL.md parser (frontmatter + body)
├── loader.ts             scan dir, load all skills
└── activator.ts          decide which skills go into the prompt
```

### 1.2 `skills/types.ts`

```ts
export interface SkillFrontmatter {
  name: string;
  description: string;
  allowedTools?: string[];
  disableModelInvocation?: boolean;
  version?: string;
}

export interface Skill {
  /** filesystem path of the SKILL.md file */
  path: string;
  /** parsed frontmatter */
  frontmatter: SkillFrontmatter;
  /** markdown body (after frontmatter) */
  body: string;
  /** sibling files under the skill's directory (e.g. scripts, templates) */
  resources: string[];
}

export interface SkillLoadOptions {
  /** absolute path to the skills directory; defaults to `<workspace>/.claude/skills/` */
  dir?: string;
  /** maximum total size of skill markdown to inject; defaults to 32 KB */
  maxBytes?: number;
}
```

### 1.3 `skills/parser.ts`

Plain frontmatter splitter — no YAML library beyond what's already in tree:

```ts
import { parse as parseYaml } from 'yaml';

const FRONTMATTER_RE = /^---\n([\s\S]+?)\n---\n([\s\S]*)$/;

export function parseSkillMarkdown(raw: string): { frontmatter: SkillFrontmatter; body: string } {
  const m = FRONTMATTER_RE.exec(raw);
  if (!m) throw new Error('SKILL.md missing frontmatter (--- ... ---)');
  const fm = parseYaml(m[1]) as Partial<SkillFrontmatter>;
  if (!fm.name) throw new Error('SKILL.md frontmatter missing required `name`');
  if (!fm.description) throw new Error('SKILL.md frontmatter missing required `description`');
  return {
    frontmatter: {
      name: fm.name,
      description: fm.description,
      allowedTools: fm.allowedTools ?? fm['allowed-tools' as never] as string[] | undefined,
      disableModelInvocation: fm.disableModelInvocation ?? fm['disable-model-invocation' as never] as boolean | undefined,
      version: fm.version,
    },
    body: m[2].trim(),
  };
}
```

(Frontmatter keys may be kebab-case in spec; normalize to camelCase.)

### 1.4 `skills/loader.ts`

```ts
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseSkillMarkdown } from './parser.js';
import type { Skill, SkillLoadOptions } from './types.js';

export function loadSkills(opts: SkillLoadOptions): Skill[] {
  const dir = opts.dir!;
  if (!existsSync(dir)) return [];
  const out: Skill[] = [];
  for (const entry of readdirSync(dir)) {
    const skillDir = join(dir, entry);
    if (!statSync(skillDir).isDirectory()) continue;
    const skillFile = join(skillDir, 'SKILL.md');
    if (!existsSync(skillFile)) continue;
    try {
      const raw = readFileSync(skillFile, 'utf-8');
      const { frontmatter, body } = parseSkillMarkdown(raw);
      const resources = readdirSync(skillDir).filter((f) => f !== 'SKILL.md');
      out.push({ path: skillFile, frontmatter, body, resources });
    } catch (err) {
      process.stderr.write(`[anvil-skills] WARN: skipping ${skillFile}: ${(err as Error).message}\n`);
    }
  }
  return out;
}
```

### 1.5 `skills/activator.ts`

For v1, "activate all under the byte budget":

```ts
import type { Skill } from './types.js';

export interface ActivatedSkills {
  skills: Skill[];
  totalBytes: number;
  truncated: number;
}

export function activateSkills(skills: Skill[], maxBytes = 32 * 1024): ActivatedSkills {
  const sorted = [...skills].sort((a, b) => a.frontmatter.name.localeCompare(b.frontmatter.name));
  const out: Skill[] = [];
  let total = 0;
  let truncated = 0;
  for (const s of sorted) {
    const bytes = Buffer.byteLength(s.body, 'utf-8');
    if (total + bytes > maxBytes) { truncated++; continue; }
    out.push(s);
    total += bytes;
  }
  return { skills: out, totalBytes: total, truncated };
}
```

### 1.6 `skills/index.ts`

```ts
export type { Skill, SkillFrontmatter, SkillLoadOptions } from './types.js';
export { parseSkillMarkdown } from './parser.js';
export { loadSkills } from './loader.js';
export { activateSkills, type ActivatedSkills } from './activator.js';
```

### 1.7 Public barrel update

`packages/agent-core/src/index.ts`:

```ts
// ... existing exports ...
export * from './skills/index.js';
```

### 1.8 Validation

```sh
npm -w @anvil/agent-core run build
# Tests come in Phase 6; for now manual smoke:
mkdir -p /tmp/test-skills/.claude/skills/example
cat > /tmp/test-skills/.claude/skills/example/SKILL.md <<'EOF'
---
name: example
description: A test skill
allowed-tools: ['fs.read', 'shell.run']
---
# Example skill body
This is the procedural knowledge.
EOF
node -e "import('./packages/agent-core/dist/skills/index.js').then(s => { const sk = s.loadSkills({ dir: '/tmp/test-skills/.claude/skills' }); console.log(JSON.stringify(sk, null, 2)); });"
```

Expected output: array with one skill, frontmatter parsed, body present.

### 1.9 Acceptance

- [ ] `agent-core/src/skills/` exists with 5 files
- [ ] `loadSkills` correctly parses a sample SKILL.md
- [ ] Malformed SKILL.md is logged + skipped (not fatal)
- [ ] `activateSkills` respects byte budget

### 1.10 Rollback

Single-commit revert.

### 1.11 Risks

- **Frontmatter format edge cases:** YAML allows different quoting / multiline strings; Anvil's parser must handle both kebab-case and camelCase keys. Mitigation: test with the `anthropics/skills` repo's example skills (real-world fixtures).

---

## Phase 2 — SKILL.md → system prompt integration

**Effort:** 1d.

### 2.1 Where skills enter the prompt

Skills become a section appended to the LLM's system prompt:

```
<system prompt from caller>

## Available Skills

You have access to the following skills. Each skill provides procedural
knowledge for a specific task. Read the skill's instructions when its
description matches the user's request.

### example
A test skill

[skill body inlined here]

### another-skill
...
```

(Format follows Anthropic's spec; OpenAI Codex CLI uses the same shape.)

### 2.2 Add `skills/render.ts`

```ts
import type { ActivatedSkills } from './activator.js';

export function renderSkillsForPrompt(activated: ActivatedSkills): string {
  if (activated.skills.length === 0) return '';
  const sections = activated.skills.map((s) =>
    `### ${s.frontmatter.name}\n${s.frontmatter.description}\n\n${s.body}`,
  );
  return [
    '## Available Skills',
    '',
    'You have access to the following skills. Each skill provides procedural',
    'knowledge for a specific task. Read the skill\'s instructions when its',
    'description matches the user\'s request.',
    '',
    ...sections,
  ].join('\n');
}
```

### 2.3 Apply at agent invocation

In `agent-core/src/agent/agent-manager.ts` (or the equivalent invocation site that builds the system prompt), wire skill loading into the prompt-build path:

```ts
import { loadSkills, activateSkills, renderSkillsForPrompt } from '../skills/index.js';

// inside the invocation builder:
const skills = loadSkills({ dir: resolveSkillsDir(workspace) });
const activated = activateSkills(skills);
const skillsBlock = renderSkillsForPrompt(activated);
const finalSystemPrompt = [originalSystemPrompt, skillsBlock].filter(Boolean).join('\n\n');
```

`resolveSkillsDir(workspace)` returns the appropriate path:

1. `process.env.ANVIL_SKILLS_DIR` if set
2. `<workspace>/.claude/skills/` if exists
3. `$HOME/.claude/skills/` (user-global) if exists
4. Otherwise undefined (no skills loaded)

### 2.4 Tools constraint

If a skill declares `allowed-tools: ['fs.read', 'shell.run']`, that constraint should be applied when the skill is "active". v1 simplification: union all `allowed-tools` from all activated skills with the caller's allowed-tools, take the intersection. Document the model: skills can constrain (subtract from caller's wide list) but not expand.

### 2.5 Validation

```sh
# Add a fixture skill
mkdir -p packages/agent-core/test-fixtures/skills/sample
cat > packages/agent-core/test-fixtures/skills/sample/SKILL.md <<'EOF'
---
name: sample
description: A sample skill for testing
---
Always greet the user before answering.
EOF

# Manual smoke (requires LLM call):
ANVIL_SKILLS_DIR=$(pwd)/packages/agent-core/test-fixtures/skills \
  ANVIL_OTEL_CONSOLE=1 \
  anvil run --project <fixture> --stage clarify
# Expect: span attributes show 'gen_ai.prompt' contains "## Available Skills"
# (only with ANVIL_OTEL_RECORD_CONTENT=1)
```

### 2.6 Acceptance

- [ ] Skills directory resolution follows the search order in §2.3
- [ ] Skills appear in the system prompt at the documented location
- [ ] `allowed-tools` constraint intersection enforced
- [ ] Total skill bytes capped per `activateSkills` budget

### 2.7 Rollback

Single-commit revert. Without skill loading, agent-core falls back to today's behavior (raw caller-provided system prompt).

### 2.8 Risks

- **Token bloat:** poorly authored skills can swell the system prompt. Mitigation: byte budget; logging of total skill bytes used.
- **Prompt-injection via malicious skill:** a third-party skill could include "ignore prior instructions". Mitigation: in v1, skills are *only* loaded from project / user dirs (not pulled from the network). Phase 7 hardens this if needed.
- **Skill-tool mismatch:** a skill claims it needs `fs.write` but caller hasn't allowed it. Today's behavior: model tries the tool, fails, retries. Acceptable for v1; surface in dashboard later.

---

## Phase 3 — MCP client at agent layer

**Effort:** 1.5d.

### 3.1 Add MCP SDK dependency

`packages/agent-core/package.json`:

```json
{
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.29.0",
    ...
  }
}
```

(Pin to the version current at execution time. Already a dep of `code-search-mcp` server side, so the lockfile already has it.)

### 3.2 New module: `agent-core/src/mcp/`

```
src/mcp/
├── index.ts              public exports
├── types.ts              McpServerConfig, McpClient
├── config-loader.ts      reads mcp.json
├── client.ts             wraps SDK Client; lifecycle
└── tool-merger.ts        merges MCP tools into the agent's tool registry
```

### 3.3 `mcp/types.ts`

```ts
export interface McpServerConfig {
  name: string;
  /** stdio: spawn `command args[]`. http: POST to `url`. */
  transport: 'stdio' | 'streamable-http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServersFile {
  mcpServers: Record<string, Omit<McpServerConfig, 'name'>>;
}
```

### 3.4 `mcp/config-loader.ts`

Search order for `mcp.json`:

1. `process.env.ANVIL_MCP_CONFIG` (full path)
2. `<workspace>/mcp.json`
3. `<workspace>/.mcp/servers.json`
4. `<workspace>/.claude/mcp.json` (Claude Code convention)
5. `$HOME/.claude/mcp.json` (user-global)

Implementation reads the first existing file, parses JSON, expands `${env:NAME}` substitutions in `env`/`headers` values.

### 3.5 `mcp/client.ts`

Wraps the official SDK's `Client`:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig } from './types.js';
import type { ToolSchema } from '../types.js';

export class McpAgentClient {
  private client: Client;
  private connected = false;
  constructor(public readonly config: McpServerConfig) {
    this.client = new Client({ name: 'anvil-agent', version: '0.0.1' }, { capabilities: {} });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const transport = this.config.transport === 'stdio'
      ? new StdioClientTransport({ command: this.config.command!, args: this.config.args ?? [], env: this.config.env })
      : new StreamableHTTPClientTransport(new URL(this.config.url!), { requestInit: { headers: this.config.headers } });
    await this.client.connect(transport);
    this.connected = true;
  }

  async listTools(): Promise<ToolSchema[]> {
    if (!this.connected) await this.connect();
    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: `${this.config.name}/${t.name}`,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.connected) await this.connect();
    const stripped = toolName.startsWith(`${this.config.name}/`) ? toolName.slice(this.config.name.length + 1) : toolName;
    const result = await this.client.callTool({ name: stripped, arguments: args });
    return result;
  }

  async close(): Promise<void> {
    if (this.connected) await this.client.close();
    this.connected = false;
  }
}
```

### 3.6 `mcp/tool-merger.ts`

Given a list of `McpAgentClient`s + a list of built-in tools, produce a merged `ToolSchema[]` with namespaced names (`<server>/<tool>`):

```ts
export async function buildAgentToolset(
  builtIn: ToolSchema[],
  mcpClients: McpAgentClient[],
): Promise<{ tools: ToolSchema[]; mcpDispatch: Map<string, McpAgentClient> }> {
  const tools: ToolSchema[] = [...builtIn];
  const mcpDispatch = new Map<string, McpAgentClient>();
  for (const client of mcpClients) {
    const mcpTools = await client.listTools();
    for (const t of mcpTools) {
      tools.push(t);
      mcpDispatch.set(t.name, client);
    }
  }
  return { tools, mcpDispatch };
}
```

When the agent's tool-call dispatch sees a `<server>/<tool>` name, it routes to the MCP client. Otherwise, dispatches built-in.

### 3.7 Integration with agent-manager

In `agent-core/src/agent/agent-manager.ts`:

1. At agent-invocation start: `const mcpServers = loadMcpServers(workspace);`
2. `const mcpClients = mcpServers.map(c => new McpAgentClient(c));`
3. `const { tools, mcpDispatch } = await buildAgentToolset(builtInTools, mcpClients);`
4. Pass `tools` to `LanguageModel.invokeStream({ ..., tools })`.
5. When the stream emits a `tool-call` event, check `mcpDispatch.has(toolName)`; if so, call via MCP client; otherwise route to built-in.
6. At agent-invocation end: `await Promise.all(mcpClients.map(c => c.close()));`

### 3.8 Validation

```sh
# Add a sample mcp.json to a fixture project
cat > /tmp/test-mcp/mcp.json <<'EOF'
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/test-mcp"]
    }
  }
}
EOF

# Manual smoke: agent invocation should list MCP tools
cd /tmp/test-mcp && anvil run --project <fixture> --stage build
# Expect: log shows 'mcp.tools.discovered count=N'
```

### 3.9 Acceptance

- [ ] `mcp.json` discovered via the search-order from §3.4
- [ ] `${env:VAR}` expansion works in env/headers
- [ ] MCP server tools merge into the agent's toolset with namespaced names
- [ ] Tool calls route correctly: built-in → built-in dispatch, MCP → MCP client
- [ ] All MCP clients close cleanly when the agent invocation ends (no leaked subprocesses)

### 3.10 Rollback

Single-commit revert. Without MCP integration, agent only sees built-in tools (today's behavior).

### 3.11 Risks

- **MCP server lifecycle:** `stdio` transport spawns a subprocess per server; slow startup + close overhead. Mitigation: connection pool keyed by `(workspace, server name)` if startup overhead bites.
- **Tool name collisions:** if two MCP servers each expose a `read_file` tool. Mitigation: namespace prefix (`filesystem/read_file`, `github/read_file`) prevents collisions.
- **Transport failures:** an MCP server crashes mid-session. Mitigation: client surfaces a tool-call error event; agent treats as a tool failure (model can retry or skip).
- **Auth surface:** `${env:GITHUB_TOKEN}` substitution puts secrets in MCP env. Document that only env-var indirection is supported, never inline tokens.

---

## Phase 4 — Headless agent entry point

**Effort:** 1d.

### 4.1 New module: `agent-core/src/headless/`

```
src/headless/
├── index.ts              public: runAgent
├── types.ts              AgentTask, AgentTrajectory, WorkspaceConfig
└── runner.ts             implementation
```

### 4.2 `headless/types.ts`

Shape compatible with Inspect AI external-agent runner:

```ts
export interface WorkspaceConfig {
  /** absolute path to the project workspace (where mcp.json + .claude/skills/ live) */
  rootDir: string;
  /** factory.yaml path; optional override */
  factoryYamlPath?: string;
  /** extra env vars for subprocess adapters */
  env?: Record<string, string>;
}

export interface AgentTask {
  /** human-readable task statement */
  prompt: string;
  /** optional system-prompt prefix (before skill block) */
  systemPrompt?: string;
  /** allowed built-in tools (intersected with skill constraints, MCP tools auto-added) */
  allowedTools?: string[];
  /** model identifier ('claude-sonnet-4-6', 'gpt-4o', 'gemini-2.5-pro', etc.) */
  model: string;
  /** provider hint: anthropic-cli | anthropic-api | openai-api | ... */
  provider?: string;
  /** max tokens per response */
  maxTokens?: number;
  /** temperature */
  temperature?: number;
  /** optional task ID for trace correlation */
  taskId?: string;
}

/**
 * Inspect-AI-compatible trajectory. Each Message includes role, content (text or tool calls).
 * `tool_calls` is the flat list across all assistant turns.
 * `usage` and `cost` are aggregated across all LLM calls in the run.
 */
export interface AgentTrajectory {
  messages: Array<{
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;             // tool name for role=tool
    toolCallId?: string;       // for role=tool
  }>;
  toolCalls: Array<{
    callId: string;
    name: string;
    arguments: Record<string, unknown>;
    result?: unknown;
    error?: string;
    durationMs: number;
  }>;
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  costUsd: number;
  finalAnswer: string;
  finishReason: 'end' | 'tool-use' | 'length' | 'error';
  error?: string;
  durationMs: number;
}
```

### 4.3 `headless/runner.ts`

The implementation glues together:

- Skill loading (Phase 1–2)
- MCP client (Phase 3)
- Built-in tool registry
- LanguageModel invocation
- Tool-call loop until `finishReason !== 'tool-use'`
- Aggregation into trajectory

```ts
import { ProviderRegistry } from '../registry.js';
import { loadSkills, activateSkills, renderSkillsForPrompt } from '../skills/index.js';
import { loadMcpServers, McpAgentClient, buildAgentToolset } from '../mcp/index.js';
import type { AgentTask, AgentTrajectory, WorkspaceConfig } from './types.js';

const MAX_TOOL_LOOP_ITERATIONS = 25;

export async function runAgent(task: AgentTask, workspace: WorkspaceConfig): Promise<AgentTrajectory> {
  const startTime = Date.now();
  // Resolve provider + model
  const providerName = task.provider ?? 'anthropic-api';
  const model = ProviderRegistry.getInstance().get(providerName as never);
  if (!model) throw new Error(`Unknown provider: ${providerName}`);

  // Skills
  const skills = loadSkills({ dir: resolveSkillsDir(workspace) });
  const activated = activateSkills(skills);
  const skillsBlock = renderSkillsForPrompt(activated);

  // MCP
  const mcpServers = loadMcpServers(workspace);
  const mcpClients = mcpServers.map((c) => new McpAgentClient(c));

  try {
    const builtIn = getBuiltInTools(task.allowedTools ?? []);
    const { tools, mcpDispatch } = await buildAgentToolset(builtIn, mcpClients);

    // System prompt
    const systemPrompt = [task.systemPrompt, skillsBlock].filter(Boolean).join('\n\n');

    // Tool-call loop
    const messages: AgentTrajectory['messages'] = [];
    const toolCalls: AgentTrajectory['toolCalls'] = [];
    let totalUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let totalCost = 0;
    let finalAnswer = '';
    let finishReason: AgentTrajectory['finishReason'] = 'end';

    messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: task.prompt });

    for (let i = 0; i < MAX_TOOL_LOOP_ITERATIONS; i++) {
      const result = await model.invoke({
        model: task.model,
        messages: messages as never,
        tools,
        maxTokens: task.maxTokens,
        temperature: task.temperature,
      });

      totalUsage.inputTokens += result.usage.inputTokens;
      totalUsage.outputTokens += result.usage.outputTokens;
      totalUsage.cacheReadTokens! += result.usage.cacheReadTokens ?? 0;
      totalUsage.cacheWriteTokens! += result.usage.cacheWriteTokens ?? 0;
      totalCost += result.costUsd;

      messages.push({ role: 'assistant', content: result.text });

      if (result.toolCalls.length === 0) {
        finalAnswer = result.text;
        finishReason = 'end';
        break;
      }

      // Dispatch tool calls
      finishReason = 'tool-use';
      for (const call of result.toolCalls) {
        const callStart = Date.now();
        let toolResult: unknown;
        let toolError: string | undefined;
        try {
          if (mcpDispatch.has(call.name)) {
            toolResult = await mcpDispatch.get(call.name)!.callTool(call.name, call.arguments);
          } else {
            toolResult = await dispatchBuiltInTool(call.name, call.arguments, workspace);
          }
        } catch (err) {
          toolError = (err as Error).message;
        }
        const durationMs = Date.now() - callStart;
        toolCalls.push({ callId: call.id, name: call.name, arguments: call.arguments, result: toolResult, error: toolError, durationMs });
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify(toolError ? { error: toolError } : toolResult),
        });
      }
    }

    return {
      messages,
      toolCalls,
      model: task.model,
      usage: totalUsage,
      costUsd: totalCost,
      finalAnswer,
      finishReason,
      durationMs: Date.now() - startTime,
    };
  } finally {
    await Promise.all(mcpClients.map((c) => c.close().catch(() => {})));
  }
}

function getBuiltInTools(allowed: string[]): ToolSchema[] { /* return a filtered list */ return []; }
function dispatchBuiltInTool(name: string, args: any, workspace: WorkspaceConfig): Promise<unknown> { /* impl */ return Promise.resolve({}); }
function resolveSkillsDir(workspace: WorkspaceConfig): string | undefined { /* impl matching §2.3 */ return undefined; }
```

### 4.4 Public exports

`agent-core/src/index.ts`:

```ts
export * from './headless/index.js';
```

### 4.5 Validation

```sh
npm -w @anvil/agent-core run build

# Manual smoke (requires LLM env):
node -e "
import('./packages/agent-core/dist/index.js').then(async (api) => {
  const t = await api.runAgent({
    prompt: 'List the files in the workspace.',
    model: 'claude-sonnet-4-6',
    provider: 'anthropic-cli',
    allowedTools: ['fs.read'],
  }, { rootDir: '/tmp' });
  console.log(JSON.stringify(t, null, 2));
});
"
```

### 4.6 Acceptance

- [ ] `runAgent(task, workspace)` returns an `AgentTrajectory`
- [ ] Trajectory includes message log, tool calls, usage, cost
- [ ] Tool-call loop terminates either on `finalAnswer` or `MAX_TOOL_LOOP_ITERATIONS`
- [ ] MCP clients close cleanly even on error path

### 4.7 Rollback

Single-commit revert. The function isn't called from cli yet (cli has its own entry point); reverting is harmless.

### 4.8 Risks

- **Tool-call loop runaway:** `MAX_TOOL_LOOP_ITERATIONS` hard cap is the safeguard. Consider also a wall-clock timeout (e.g., 10 minutes per `runAgent` call).
- **Built-in tool dispatch:** placeholder `dispatchBuiltInTool` needs a real implementation. If cli already has one in `pipeline/`, hoist it into agent-core/src/tools/.
- **Trajectory size:** for long-running agents, message log grows unbounded. v1 acceptable for benchmarks; future revision should support compaction.

---

## Phase 5 — cli wires up `runAgent` (optional)

**Effort:** 0.5d.

### 5.1 Why optional

cli already has its own pipeline orchestration (`packages/cli/src/pipeline/orchestrator.ts`). The cli pipeline uses agent-core's `LanguageModel` directly for stages. The `runAgent` entry is for *external* consumers (Inspect AI evals, custom benchmark scripts). cli doesn't need to call it.

### 5.2 But — for consistency

Optionally, refactor cli's pipeline to go through `runAgent` for one specific use case: a "free-form task" stage where the user supplies a prompt without a pre-defined factory.yaml stage. This becomes a useful demo.

### 5.3 Validation

```sh
anvil run --task "Refactor the auth module" --workspace .
# under the hood: cli builds an AgentTask, calls runAgent, prints trajectory.finalAnswer
```

### 5.4 Acceptance

- [ ] (optional) cli has a `--task` flag that invokes `runAgent`
- [ ] Output is human-readable (final answer + tool call summary)

### 5.5 Risks

- **Scope creep.** This phase is optional. Skip if Phase 1–4 take longer than estimated.

---

## Phase 6 — Tests + Inspect AI smoke

**Effort:** 1d.

### 6.1 Test surface

- **Skill parser unit tests:** valid SKILL.md, missing frontmatter, kebab-case keys, multiline description.
- **Skill loader integration tests:** scan a fixture dir, parse, activate within budget.
- **Render tests:** verify the prompt block formatting.
- **MCP config-loader tests:** test the search order and `${env:VAR}` substitution.
- **MCP client tests:** mock the SDK transport, verify list+call routing.
- **Tool-merger tests:** namespacing collisions, empty MCP list, multiple servers.
- **Headless runAgent integration test:** with a mocked `LanguageModel` (returns a fixture `InvokeResult`), assert trajectory shape.

### 6.2 Test layout

```
packages/agent-core/src/__tests__/
├── skills.parser.test.ts
├── skills.loader.test.ts
├── skills.activator.test.ts
├── mcp.config-loader.test.ts
├── mcp.tool-merger.test.ts
├── headless.runner.test.ts
└── fixtures/
    ├── skills/
    │   ├── valid-skill/SKILL.md
    │   ├── missing-name/SKILL.md
    │   └── kebab-case/SKILL.md
    └── mcp/
        ├── valid-mcp.json
        └── env-substitution.json
```

### 6.3 Inspect AI smoke (optional, manual)

Document a recipe in `packages/agent-core/README.md`:

```sh
pip install inspect-ai
mkdir my-eval && cd my-eval
cat > task.py <<'EOF'
from inspect_ai import task, Task
from inspect_ai.dataset import Sample
from inspect_ai.solver import generate
from inspect_ai.model import get_model
@task
def my_task():
    return Task(
        dataset=[Sample(input="What is 2+2?")],
        solver=generate(),
        model=get_model("anvil/runAgent", base_url="..."),
    )
EOF
inspect eval my_task.py
```

(Specific Inspect AI integration syntax depends on its version. The point is: the entry is *callable*; details fall to the eval framework.)

### 6.4 Validation

```sh
npm -w @anvil/agent-core test         # all new tests pass
npm -w @anvil/knowledge-core test     # 71+ baseline preserved
```

### 6.5 Acceptance

- [ ] All Phase 1–4 functionality covered by unit + integration tests
- [ ] Inspect AI smoke recipe documented (manual test, not CI)
- [ ] No regression in existing test counts

### 6.6 Rollback

Per-test-file revert.

---

## Cross-cutting: validation strategy

After each phase:

1. `npm install` (catches dep conflicts).
2. `npm -w @anvil/agent-core run build && npm -w @anvil/agent-core test`.
3. `npm -w @esankhan3/anvil-cli run build && npm -w @esankhan3/anvil-cli test`.
4. mcp + dashboard tests don't regress.
5. **Manual fixture smoke** (Phases 2+): with a sample `.claude/skills/` directory, confirm the skill block appears in the system prompt (via `ANVIL_OTEL_RECORD_CONTENT=1` if Plan B is also shipped).
6. **MCP smoke** (Phase 3+): with a public MCP server (e.g. `@modelcontextprotocol/server-filesystem` over stdio), confirm tools merge into the agent's toolset.

---

## Cross-cutting: order rationale

| # | Phase | Why this order |
|---|---|---|
| 0 | Audit | Lock the schemas before any code. |
| 1 | Skill loader scaffold | Pure read-only, no LLM dependency. Fastest validate. |
| 2 | Skill prompt integration | Now the loader plugs into agent-core's invocation flow. |
| 3 | MCP client | New external dep + new transport handling. Hardest of the three. |
| 4 | Headless entry | Glues skills + MCP + built-in tools + LanguageModel into one callable. |
| 5 | (optional) cli wire-up | Demo for external users. Skip if behind schedule. |
| 6 | Tests | Last to ensure coverage of the integrated surface. |

---

## Summary table

| Phase | Effort | LOC moved | LOC written | Risk |
|---|---|---|---|---|
| 0 — Audit | 0.5d | 0 | ~80 (ADR) | low |
| 1 — Skill loader | 0.5d | 0 | ~200 | low |
| 2 — Skill prompt integration | 1d | 0 | ~150 | medium |
| 3 — MCP client | 1.5d | 0 | ~400 | medium-high |
| 4 — Headless entry | 1d | 0 | ~300 | medium |
| 5 — cli wire-up (optional) | 0.5d | 0 | ~100 | low |
| 6 — Tests | 1d | 0 | ~400 | low |
| **Total** | **~5.5d** | **0** | **~1,630** | — |

Plus 30% risk premium → realistic calendar **~7 days for solo eng**, or **~6–8 conversation turns** if executed phase-by-phase.

---

## Failure modes to watch

1. **SKILL.md schema drift:** Anthropic might revise the format. Mitigation: parser is forgiving — unknown fields preserved, only `name` + `description` required. Update the schema doc as the spec evolves.
2. **MCP transport quirks:** stdio MCP servers may require specific env or cwd; streamable-http servers may have auth header conventions that drift. Mitigation: keep the SDK upgraded; pin a known-good version; provide clear error messages from the transport adapter.
3. **Tool-call loop infinite:** `MAX_TOOL_LOOP_ITERATIONS = 25` cap is the safety net. Add wall-clock timeout too if runs ever exceed expected duration.
4. **Skill prompt-injection:** a malicious skill in a third-party repo / dev-shared dotfiles. Mitigation: skills load only from project / user dirs in v1; document discovery scope clearly; future iteration could add a manifest signature.
5. **MCP server resource leak:** spawned subprocesses linger if an exception is thrown mid-loop. Mitigation: `try/finally` around the loop closes all clients; add SIGINT handler that closes all open MCP transports.
6. **Trajectory unbounded growth:** long-running agents accumulate huge message logs. Mitigation: v1 tolerates; revisit with compaction ("memory") in a future plan.
7. **Inspect AI integration version drift:** Inspect AI's external-agent contract is well-documented but evolving. Mitigation: keep `runAgent`'s signature stable + document the trajectory format as Anvil-owned (compatible-with-Inspect-AI, not derived-from). If their contract diverges, write an adapter, not a refactor.

---

## Glossary

- **SKILL.md:** procedural-knowledge document with YAML frontmatter (`name`, `description`, optional `allowed-tools`, etc.) and a markdown body. Defined by Anthropic Oct 2025; open standard since Dec 2025 (OpenAI Codex CLI adopted it).
- **MCP (Model Context Protocol):** open protocol for connecting LLMs to external tools/resources. Spec: <https://modelcontextprotocol.io/>.
- **Tool registry:** the collection of `ToolSchema[]` passed to a `LanguageModel`. Built-in tools + MCP-discovered tools merge here at agent-invocation time.
- **Headless agent:** `runAgent(task, workspace) → trajectory`. Used by external eval harnesses (Inspect AI, SWE-bench runners). Not used by cli's interactive pipeline.
- **Trajectory:** the full record of an agent run — messages, tool calls, usage, cost, final answer. Compatible with Inspect AI's external-agent runner.
- **Skill activation:** the algorithm deciding which skills go into the prompt. v1 = "all of them under the byte budget"; future versions can use a description-based router.
- **Anvil-built-in tools:** filesystem, shell, search-tools (already exposed via `@anvil/code-search-mcp` for human use). Future versions may expose more in the `runAgent` toolset.

---

## Appendix — Why MCP at the agent layer (not provider layer)

A common implementation mistake: register MCP tools with the provider (e.g., as part of an Anthropic SDK call setup). This means:

- Each provider implementation has its own MCP wiring (fragmented)
- Switching providers loses MCP access until re-wired
- The provider knows about MCP (it shouldn't — providers are dumb HTTP clients)

The right place for MCP is **the agent**:

- Agent merges built-in tools + MCP tools into a single registry
- Agent passes that registry to whichever provider it's using
- Agent dispatches tool calls back to the right backend (built-in vs MCP server)

This is the pattern Cline / Roo Code / Continue.dev all use. Anvil should adopt it.

## Appendix — `mcp.json` schema reference

```json
{
  "mcpServers": {
    "<server-name>": {
      "command": "<binary>",
      "args": ["arg1", "arg2"],
      "env": { "VAR_NAME": "value or ${env:UPSTREAM}" }
    },
    "<another>": {
      "url": "https://endpoint/mcp",
      "headers": { "Authorization": "Bearer ${env:TOKEN}" }
    }
  }
}
```

Stdio entries use `command` + `args` + `env`. Streamable-HTTP entries use `url` + `headers`. `${env:NAME}` substitution is expanded at agent-invocation time. No other directives in v1.
