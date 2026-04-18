import { readFile } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFFHome } from '../home.js';
import type { PersonaName } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = join(__dirname, '..', 'personas', 'prompts');
const MAX_SIZE = 50 * 1024; // 50KB

const cache = new Map<string, string>();

export async function loadPersonaPrompt(name: PersonaName): Promise<string> {
  if (cache.has(name)) return cache.get(name)!;

  // Try user override first
  const userPath = join(getFFHome(), 'personas', `${name}.md`);
  if (existsSync(userPath)) {
    const size = statSync(userPath).size;
    if (size > MAX_SIZE) throw new Error(`Persona file ${name}.md exceeds 50KB limit`);
    if (size === 0) throw new Error(`Persona file ${name}.md is empty`);
    const content = await readFile(userPath, 'utf-8');
    cache.set(name, content);
    return content;
  }

  // Fallback to bundled
  const bundledPath = join(BUNDLED_DIR, `${name}.md`);
  if (!existsSync(bundledPath)) {
    throw new Error(`Persona prompt not found: ${name} (checked ${userPath} and ${bundledPath})`);
  }
  const content = await readFile(bundledPath, 'utf-8');
  cache.set(name, content);
  return content;
}

export function clearPersonaCache(): void {
  cache.clear();
}
