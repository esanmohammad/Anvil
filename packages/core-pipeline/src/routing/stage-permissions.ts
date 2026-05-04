/**
 * Per-stage tool permissions — what classes of tools each pipeline stage
 * is allowed to invoke. Read by the dashboard's pipeline-runner when it
 * builds the SpawnConfig and by `BuiltinToolExecutor` when filtering its
 * advertised schemas (the model never even learns about denied tools).
 *
 * Tool taxonomy (matches agent-core/src/tools/builtin.ts):
 *   - read   → read_file, grep, glob, list
 *   - write  → write_file, edit
 *   - exec   → bash
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
 * Resolve the list of tool names allowed for a given stage. Unknown
 * stages fall back to read-only — fail-closed by default.
 */
export function allowedToolsForStage(stage: string): string[] {
  const classes = STAGE_TOOL_PERMISSIONS[stage] ?? ['read'];
  const tools = new Set<string>();
  for (const cls of classes) {
    for (const t of ALL_TOOLS_BY_CLASS[cls]) tools.add(t);
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
