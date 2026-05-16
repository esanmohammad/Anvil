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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** Read workspace path from factory.yaml / project.yaml for a project. */
export function getWorkspaceFromConfig(project: string): string | null {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const candidates = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];
  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const wsMatch = raw.match(/^workspace:\s+(.+)$/m);
      if (wsMatch) {
        return wsMatch[1].replace(/^["']|["']$/g, '').trim().replace(/^~/, homedir());
      }
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * Parse the string content of a `semantic:fix-pattern` proposal back into
 * `error` (failure signal) and `fix` (resolution). Reflection's mapper
 * formats failures as `Failure: …\nRoot cause: …\nFix: …\nFile: …`.
 * If the content was already structured ({error,fix}), use that directly.
 */
export function parseFixPatternContent(content: unknown): { error: string; fix: string } {
  if (content && typeof content === 'object') {
    const c = content as { error?: unknown; fix?: unknown };
    if (typeof c.error === 'string' && typeof c.fix === 'string') {
      return { error: c.error, fix: c.fix };
    }
  }
  if (typeof content !== 'string') return { error: '', fix: '' };
  const failure = /Failure:\s*(.+)/.exec(content);
  const root = /Root cause:\s*(.+)/.exec(content);
  const fix = /Fix:\s*(.+)/.exec(content);
  const errorParts: string[] = [];
  if (failure) errorParts.push(failure[1].trim());
  if (root) errorParts.push(root[1].trim());
  return {
    error: errorParts.join(' — '),
    fix: fix ? fix[1].trim() : '',
  };
}
