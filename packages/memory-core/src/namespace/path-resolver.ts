/**
 * Namespace-aware filesystem layout for memory-core (Phase 4 — plan §4.2.4).
 *
 * Layout under a memory root (typically `~/.anvil/memory/`):
 *
 *   global/                                 -> {scope: 'global'}
 *   user/<userId>/                          -> {scope: 'user',    userId}
 *   project/<projectId>/                    -> {scope: 'project', projectId}
 *   repo/<projectId>/<repoId>/              -> {scope: 'repo',    projectId, repoId}
 *
 * Legacy data is preserved by treating any non-scope-prefixed sibling
 * directory as `{scope: 'project', projectId: <dir name>}` — the
 * `interpretLegacyDir` helper is what the migration importer (Phase 13)
 * will use; for now it's also what the cli's namespace shim consults so
 * existing `~/.anvil/memory/<project>/` data keeps loading transparently.
 */

import type { MemoryNamespace } from '../types.js';

const SCOPE_PREFIXES = new Set(['global', 'user', 'project', 'repo']);

function sanitizeSegment(name: string): string {
  return name
    .replace(/\.\./g, '')
    .replace(/[\\:*?"<>|/]/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/^\.+/, '')
    .slice(0, 128);
}

export function namespaceToRelativePath(ns: MemoryNamespace): string {
  switch (ns.scope) {
    case 'global':
      return 'global';
    case 'user': {
      if (!ns.userId) throw new Error("namespace scope 'user' requires userId");
      return `user/${sanitizeSegment(ns.userId)}`;
    }
    case 'project': {
      if (!ns.projectId) throw new Error("namespace scope 'project' requires projectId");
      return `project/${sanitizeSegment(ns.projectId)}`;
    }
    case 'repo': {
      if (!ns.projectId) throw new Error("namespace scope 'repo' requires projectId");
      if (!ns.repoId) throw new Error("namespace scope 'repo' requires repoId");
      return `repo/${sanitizeSegment(ns.projectId)}/${sanitizeSegment(ns.repoId)}`;
    }
  }
}

/**
 * Inverse of `namespaceToRelativePath` for paths that follow the v2 layout.
 * Returns `null` when the path doesn't start with a recognized scope prefix
 * (use `interpretLegacyDir` for legacy `<project>/` directories).
 */
export function pathToNamespace(relativePath: string): MemoryNamespace | null {
  const parts = relativePath.split(/[\\/]+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  const head = parts[0];
  if (!SCOPE_PREFIXES.has(head)) return null;

  switch (head) {
    case 'global':
      return { scope: 'global' };
    case 'user':
      return parts[1] ? { scope: 'user', userId: parts[1] } : null;
    case 'project':
      return parts[1] ? { scope: 'project', projectId: parts[1] } : null;
    case 'repo':
      return parts[1] && parts[2]
        ? { scope: 'repo', projectId: parts[1], repoId: parts[2] }
        : null;
    default:
      return null;
  }
}

/**
 * Map a legacy `~/.anvil/memory/<dir>/` directory to a namespace. Mirrors the
 * cli's existing convention where any non-`global` sibling is a project.
 */
export function interpretLegacyDir(dirName: string): MemoryNamespace {
  if (dirName === 'global' || dirName === '_global') return { scope: 'global' };
  if (SCOPE_PREFIXES.has(dirName)) {
    // Caller passed a v2 scope prefix — honor it; userId/projectId/repoId
    // are not derivable from the prefix alone, so fall back to the global scope.
    return { scope: 'global' };
  }
  return { scope: 'project', projectId: sanitizeSegment(dirName) };
}

export function namespacesEqual(a: MemoryNamespace, b: MemoryNamespace): boolean {
  return (
    a.scope === b.scope &&
    (a.projectId ?? null) === (b.projectId ?? null) &&
    (a.repoId ?? null) === (b.repoId ?? null) &&
    (a.userId ?? null) === (b.userId ?? null)
  );
}

/**
 * Stable string key for a namespace — useful for de-duplication.
 * Format: `<scope>:<projectId|->:<repoId|->:<userId|->`
 */
export function namespaceKey(ns: MemoryNamespace): string {
  return `${ns.scope}:${ns.projectId ?? '-'}:${ns.repoId ?? '-'}:${ns.userId ?? '-'}`;
}
