/**
 * Convention loaders — read what `extractConventions` produced from disk.
 *
 * Two surfaces:
 *  - `loadConventions(paths, project)` — markdown for prompt injection.
 *    Includes a global preamble at `<conventionsDir>/global.md` if present.
 *  - `loadRules(paths, project)` — structured ConventionRule[] for the
 *    review prepass. Reads the canonical `rules.json` first; falls back
 *    to legacy paths during the migration window.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ConventionPaths } from './paths.js';
import type { ConventionRule } from './rules/types.js';

const MAX_SIZE = 20 * 1024; // 20KB cap, mirrors the cli loader

export class ConventionFileTooLargeError extends Error {
  constructor(public readonly path: string, public readonly size: number) {
    super(`Convention file exceeds 20KB limit: ${path} (${size} bytes)`);
    this.name = 'ConventionFileTooLargeError';
  }
}

/**
 * Load convention markdown for a project.
 * Concatenates global.md (if present) with `<project>/conventions.md`.
 * Returns empty string when nothing exists. Throws if any file exceeds 20KB.
 */
export async function loadConventions(paths: ConventionPaths, project: string): Promise<string> {
  const parts: string[] = [];

  const globalPath = join(paths.conventionsDir, 'global.md');
  if (existsSync(globalPath)) {
    const size = statSync(globalPath).size;
    if (size > MAX_SIZE) throw new ConventionFileTooLargeError(globalPath, size);
    parts.push(readFileSync(globalPath, 'utf-8'));
  }

  const projectPath = join(paths.conventionsDir, project, 'conventions.md');
  if (existsSync(projectPath)) {
    const size = statSync(projectPath).size;
    if (size > MAX_SIZE) throw new ConventionFileTooLargeError(projectPath, size);
    parts.push(readFileSync(projectPath, 'utf-8'));
  }

  return parts.join('\n\n---\n\n');
}

/**
 * Load structured convention rules for a project. Returns [] when none exist.
 *
 * convention-core is the single source of truth — rules live at
 * `<conventionsDir>/<project>/rules.json`, written by `extractConventions`.
 * The legacy `<rulesDir>/<project>/generated.json` fallback was dropped:
 * it produced stale rules whenever `Regenerate` was clicked because the
 * dashboard's old `convention-generator.js` wrote that file separately.
 */
export function loadRules(paths: ConventionPaths, project: string): ConventionRule[] {
  const canonical = join(paths.conventionsDir, project, 'rules.json');
  if (!existsSync(canonical)) return [];
  try {
    const raw = JSON.parse(readFileSync(canonical, 'utf-8')) as { rules?: ConventionRule[] };
    return Array.isArray(raw.rules) ? raw.rules : [];
  } catch {
    return [];
  }
}
