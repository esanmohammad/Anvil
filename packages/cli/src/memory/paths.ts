// Memory path resolution — Section A.3
// Phase 4: namespace-aware path resolver layered on top of the legacy
// project-or-global path resolver.

import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { getFFDirs } from '../home.js';
import {
  namespaceToRelativePath,
  type MemoryNamespace,
} from '@anvil/memory-core';

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

/**
 * Phase 4: resolve the directory for a `MemoryNamespace` tuple under
 * `~/.anvil/memory/`. Mirrors `resolveMemoryPath` but follows the v2
 * layout: global / user/<id> / project/<id> / repo/<projectId>/<repoId>.
 *
 * Falls back to the legacy `~/.anvil/memory/<project>/` directory when
 * the project namespace points at an existing legacy directory — so
 * existing data keeps loading without a migration.
 */
export function resolveNamespacePath(ns: MemoryNamespace): string {
  const dirs = getFFDirs();
  const v2Path = expandTilde(join(dirs.memory, namespaceToRelativePath(ns)));

  // Backwards compatibility: if no v2 directory exists yet but a legacy
  // `~/.anvil/memory/<projectId>/` does, return the legacy path so
  // existing data is not stranded. The migration importer (Phase 13)
  // will move it forward.
  if (ns.scope === 'project' && ns.projectId && !existsSync(v2Path)) {
    const legacy = expandTilde(
      join(dirs.memory, sanitizeSystemName(ns.projectId)),
    );
    if (existsSync(legacy)) return legacy;
  }
  if (ns.scope === 'global' && !existsSync(v2Path)) {
    if (existsSync(dirs.memoryGlobal)) return dirs.memoryGlobal;
  }

  if (!existsSync(v2Path)) mkdirSync(v2Path, { recursive: true });
  return v2Path;
}
