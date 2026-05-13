/**
 * Per-stage tool permissions — what classes of tools each pipeline stage
 * is allowed to invoke. Read by the dashboard's pipeline-runner when it
 * builds the SpawnConfig and by `BuiltinToolExecutor` / `MergedToolExecutor`
 * when filtering their advertised schemas (the model never even learns
 * about denied tools).
 *
 * Builtin tool taxonomy (matches agent-core/src/tools/builtin.ts):
 *   - read   → read_file, grep, glob, list
 *   - write  → write_file, edit
 *   - exec   → bash
 *
 * MCP tools follow the `mcp__<server>__<tool>` Claude Code naming
 * convention. Stages can grant access via:
 *   - exact name:  `"mcp__github__create_issue"` (allows destructive too)
 *   - per-server glob: `"mcp__github__*"` (read-only / idempotent only —
 *     destructive tools are still hidden unless named explicitly)
 *
 * `STAGE_MCP_ALLOW` declares per-stage MCP allowances; `allowedToolsForStage`
 * merges them with the builtin set so a single allowedTools list flows
 * through to both executors.
 *
 * Per-stage rationale lives next to each entry — keep it explicit so
 * future loosening or tightening is a deliberate, traceable change.
 */

export type ToolClass = 'read' | 'write' | 'exec';

const ALL_TOOLS_BY_CLASS: Readonly<Record<ToolClass, readonly string[]>> = {
  read: ['read_file', 'grep', 'glob', 'list'],
  write: ['write_file', 'edit'],
  exec: ['bash'],
};

/**
 * Default permission set per pipeline stage. Stage names match
 * `STAGE_NAMES` in `cli/src/run/types.ts` plus the ad-hoc commands
 * (`fix`, `review`, `plan`, `research`, `fix-loop`).
 */
export const STAGE_TOOL_PERMISSIONS: Readonly<Record<string, readonly ToolClass[]>> = {
  // — Pipeline stages —
  // Q&A only — clarify is interactive, never mutates the workspace.
  clarify:                ['read'],
  // Analysis stages: read code, write artifacts via session not tools.
  requirements:           ['read'],
  // Per-repo analysis stage (replaces the legacy `project-requirements`).
  'repo-requirements':    ['read'],
  specs:                  ['read'],
  tasks:                  ['read'],
  // Implementation stages: full agentic — read/write/exec inside cwd.
  build:                  ['read', 'write', 'exec'],
  // Dashboard test-spec stage: writes test files; validate runs them.
  // Read + write only — tests should not need shell access at this stage.
  test:                   ['read', 'write'],
  validate:               ['read', 'write', 'exec'],
  ship:                   ['read', 'write', 'exec'],

  // — Ad-hoc commands —
  fix:                    ['read', 'write', 'exec'],
  // Inline auto-fix loop within validate stage; same scope as fix.
  'fix-loop':             ['read', 'write', 'exec'],
  // review and research are read-only by design — they investigate and
  // report back; they never mutate code.
  review:                 ['read'],
  research:               ['read'],
  plan:                   ['read'],
  // Reflection: distillation only — no tools, no workspace access.
  // Reads run trace from the prompt, emits JSON proposals.
  reflection:             [],
};

/**
 * Per-stage MCP tool allowances. Each entry is either an exact tool name
 * (`"mcp__github__create_issue"`) or a per-server glob
 * (`"mcp__filesystem__*"`). Stages NOT listed here get zero MCP access.
 * Configured cautiously by default — opt-in per stage as servers are
 * adopted, rather than blanket-allow.
 */
export const STAGE_MCP_ALLOW: Readonly<Record<string, readonly string[]>> = {
  // Read-only investigation stages may use any read-only MCP tool from
  // any server (destructive tools still need exact-name allowances).
  clarify:                ['mcp__*'],
  requirements:           ['mcp__*'],
  'repo-requirements':    ['mcp__*'],
  specs:                  ['mcp__*'],
  tasks:                  ['mcp__*'],
  // Implementation: full agentic access, including MCP filesystem +
  // search servers that may want write tools. Destructive tools still
  // require exact-name listing.
  build:                  ['mcp__*'],
  test:                   ['mcp__*'],
  validate:               ['mcp__*'],
  // Ship is where PR creation lives — explicit exact-name allowance
  // for the github MCP create-PR tool when adopted.
  ship:                   ['mcp__*'],
  // Ad-hoc commands inherit the lighter end of the spectrum by default.
  fix:                    ['mcp__*'],
  'fix-loop':             ['mcp__*'],
  review:                 ['mcp__*'],
  research:               ['mcp__*'],
  plan:                   ['mcp__*'],
  reflection:             [],
};

/**
 * Expand any `mcp__*` shortcut into per-server globs once the pool has
 * declared which servers exist. Until the pool reports its server set,
 * the literal `mcp__*` falls through as-is and `MergedToolExecutor`
 * treats it as a "no glob match" — which is fine since the executor
 * also accepts the literal name format.
 */
function expandMcpStar(entries: readonly string[], serverNames: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of entries) {
    if (entry === 'mcp__*') {
      for (const s of serverNames) out.push(`mcp__${s}__*`);
    } else {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Resolve the list of tool names allowed for a given stage. Unknown
 * stages fall back to read-only — fail-closed by default. When `mcpServers`
 * is provided, `mcp__*` shortcuts expand to per-server globs so the
 * executor's exact/glob matcher sees concrete entries.
 */
export function allowedToolsForStage(stage: string, mcpServers: readonly string[] = []): string[] {
  const classes = STAGE_TOOL_PERMISSIONS[stage] ?? ['read'];
  const tools = new Set<string>();
  for (const cls of classes) {
    for (const t of ALL_TOOLS_BY_CLASS[cls]) tools.add(t);
  }
  const mcp = STAGE_MCP_ALLOW[stage] ?? [];
  for (const entry of expandMcpStar(mcp, mcpServers)) {
    tools.add(entry);
  }
  return [...tools].sort();
}

/**
 * Resolve the permission classes for a given stage (e.g. for surfacing
 * a 🔒 read / 📝 write / ⚡ exec badge in the UI).
 */
export function permissionClassesForStage(stage: string): ToolClass[] {
  return [...(STAGE_TOOL_PERMISSIONS[stage] ?? ['read'])];
}
