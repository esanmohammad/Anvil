import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getFFHome } from '../home.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_DIR = join(__dirname, '..', 'personas', 'prompts');

export interface InstallResult {
  installed: string[];
  skipped: string[];
}

export async function installPersonas(force: boolean = false): Promise<InstallResult> {
  const targetDir = join(getFFHome(), 'personas');
  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true });
  }

  const result: InstallResult = { installed: [], skipped: [] };

  let files: string[];
  try {
    files = (await readdir(BUNDLED_DIR)).filter(f => f.endsWith('.md'));
  } catch {
    // Bundled dir may not exist in dev (source vs dist)
    // Try source path
    const srcDir = join(__dirname, 'prompts');
    try {
      files = (await readdir(srcDir)).filter(f => f.endsWith('.md'));
    } catch {
      return result;
    }
  }

  for (const file of files) {
    const targetPath = join(targetDir, file);

    if (!force && existsSync(targetPath)) {
      result.skipped.push(file);
      continue;
    }

    let content: string;
    try {
      content = await readFile(join(BUNDLED_DIR, file), 'utf-8');
    } catch {
      try {
        content = await readFile(join(__dirname, 'prompts', file), 'utf-8');
      } catch {
        continue;
      }
    }

    await writeFile(targetPath, content, 'utf-8');
    result.installed.push(file);
  }

  return result;
}
