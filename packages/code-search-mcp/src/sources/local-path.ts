/**
 * Local path source — scan a directory for git repos.
 * Extracted from indexer.ts discoverRepos().
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', '.next', 'build', '__pycache__', '.venv', 'vendor', 'target']);

/**
 * Discover repos from a local directory path.
 * - If path IS a git repo → single repo
 * - If path CONTAINS git repos → multi-repo
 */
export function discoverLocalRepos(directoryPath: string): Array<{ name: string; path: string; language: string }> {
  if (!existsSync(directoryPath)) return [];

  const repos: Array<{ name: string; path: string; language: string }> = [];

  if (existsSync(join(directoryPath, '.git'))) {
    repos.push({
      name: basename(directoryPath),
      path: directoryPath,
      language: detectLanguage(directoryPath),
    });
    return repos;
  }

  try {
    for (const entry of readdirSync(directoryPath)) {
      if (entry.startsWith('.') || SKIP_DIRS.has(entry)) continue;
      const fullPath = join(directoryPath, entry);
      try { if (!statSync(fullPath).isDirectory()) continue; } catch { continue; }
      if (!existsSync(join(fullPath, '.git'))) continue;
      repos.push({ name: entry, path: fullPath, language: detectLanguage(fullPath) });
    }
  } catch { /* ignore */ }

  return repos;
}

function detectLanguage(repoPath: string): string {
  if (existsSync(join(repoPath, 'go.mod'))) return 'go';
  if (existsSync(join(repoPath, 'Cargo.toml'))) return 'rust';
  if (existsSync(join(repoPath, 'pom.xml')) || existsSync(join(repoPath, 'build.gradle'))) return 'java';
  if (existsSync(join(repoPath, 'composer.json'))) return 'php';
  if (existsSync(join(repoPath, 'pyproject.toml')) || existsSync(join(repoPath, 'setup.py'))) return 'python';
  if (existsSync(join(repoPath, 'package.json'))) {
    return existsSync(join(repoPath, 'tsconfig.json')) ? 'typescript' : 'javascript';
  }
  return 'unknown';
}
