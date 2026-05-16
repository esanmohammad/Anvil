/**
 * Workspace / fix-pattern shared helpers (Phase 3 round-9 extraction
 * from `dashboard-server.ts`).
 *
 *   - `getWorkspaceFromConfig(project)` — resolve the workspace path
 *     for a project from `factory.yaml` / `project.yaml`. Returns
 *     null when neither file exists or the workspace key is missing.
 *   - `parseFixPatternContent(content)` — parse a `semantic:fix-pattern`
 *     proposal's content back into `{ error, fix }`. Handles both the
 *     structured `{error,fix}` object and the legacy free-form
 *     `Failure: …\nRoot cause: …\nFix: …` block.
 */
/** Read workspace path from factory.yaml / project.yaml for a project. */
export declare function getWorkspaceFromConfig(project: string): string | null;
/**
 * Parse the string content of a `semantic:fix-pattern` proposal back into
 * `error` (failure signal) and `fix` (resolution). Reflection's mapper
 * formats failures as `Failure: …\nRoot cause: …\nFix: …\nFile: …`.
 * If the content was already structured ({error,fix}), use that directly.
 */
export declare function parseFixPatternContent(content: unknown): {
    error: string;
    fix: string;
};
//# sourceMappingURL=workspace.d.ts.map