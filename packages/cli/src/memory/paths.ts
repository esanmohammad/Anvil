// Memory path resolution — Section A.3

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { getFFDirs } from '../home.js';

/**
 * Sanitize a project name for use as a directory name.
 * Removes dangerous characters, replaces spaces with hyphens.
 */
function sanitizeSystemName(name: string): string {
  return name
    .replace(/\.\./g, '')
    .replace(/[\/\\:*?"<>|]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/^\.+/, '')
    .slice(0, 128);
}

/**
 * Expand ~ in paths to user's home directory.
 */
function expandTilde(p: string): string {
  if (p.startsWith('~')) {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve the memory storage path for a given project (or global).
 * Creates the directory if it doesn't exist.
 */
export function resolveMemoryPath(project?: string): string {
  const dirs = getFFDirs();
  let memPath: string;

  if (project) {
    const safeName = sanitizeSystemName(project);
    memPath = join(dirs.memory, safeName);
  } else {
    memPath = dirs.memoryGlobal;
  }

  memPath = expandTilde(memPath);

  if (!existsSync(memPath)) {
    mkdirSync(memPath, { recursive: true });
  }

  return memPath;
}
