import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getFFHome } from '../home.js';

const MAX_SIZE = 20 * 1024; // 20KB

export async function loadConventions(project: string): Promise<string> {
  const parts: string[] = [];

  // Global conventions first
  const globalPath = join(getFFHome(), 'conventions', 'global.md');
  if (existsSync(globalPath)) {
    const size = statSync(globalPath).size;
    if (size > MAX_SIZE) throw new Error(`Global conventions file exceeds 20KB limit`);
    parts.push(await readFile(globalPath, 'utf-8'));
  }

  // Project-specific conventions
  const projectPath = join(getFFHome(), 'conventions', project, 'conventions.md');
  if (existsSync(projectPath)) {
    const size = statSync(projectPath).size;
    if (size > MAX_SIZE) throw new Error(`Project conventions file exceeds 20KB limit`);
    parts.push(await readFile(projectPath, 'utf-8'));
  }

  return parts.join('\n\n---\n\n');
}
