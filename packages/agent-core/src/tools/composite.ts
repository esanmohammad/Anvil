/**
 * Composite tool executor — dispatches `execute()` calls to the first
 * sub-executor whose `listSchemas()` advertises the tool name. Schemas
 * are flattened across every sub-executor for `listSchemas()`.
 *
 * Use case: H1+ web/browser tools live in their own executor (network +
 * Playwright lifecycle distinct from FS ops). The dashboard composes
 * `[BuiltinToolExecutor, WebToolExecutor]` so the agent sees one
 * unified tool surface.
 */

import type { ToolCall, ToolSchema } from '../types.js';
import type { ExecCtx, ToolExecutor, ToolResult } from './types.js';

export class CompositeToolExecutor implements ToolExecutor {
  private readonly executors: readonly ToolExecutor[];

  constructor(executors: readonly ToolExecutor[]) {
    this.executors = executors.filter(Boolean);
  }

  listSchemas(): ToolSchema[] {
    const seen = new Set<string>();
    const out: ToolSchema[] = [];
    for (const ex of this.executors) {
      for (const s of ex.listSchemas()) {
        if (seen.has(s.name)) continue;
        seen.add(s.name);
        out.push(s);
      }
    }
    return out;
  }

  async execute(call: ToolCall, ctx: ExecCtx): Promise<ToolResult> {
    for (const ex of this.executors) {
      const owns = ex.listSchemas().some((s) => s.name === call.name);
      if (owns) return ex.execute(call, ctx);
    }
    return { isError: true, content: `Unknown tool "${call.name}".` };
  }
}
