/**
 * Path guard — rejects any path argument that escapes the agent's
 * working directory. Symlink resolution happens before the comparison so
 * `cwd/link-to-/etc/passwd` can't slip past.
 *
 * SECURITY CRITICAL: every built-in tool that touches the filesystem
 * MUST go through `resolveSafe`. A bug here means the agent can read or
 * write arbitrary files on the host. Tests cover the known escape
 * vectors (`..`, absolute paths outside cwd, symlinks).
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';

export class PathEscapeError extends Error {
  constructor(public readonly attempted: string, public readonly workingDir: string) {
    super(`Path "${attempted}" escapes workingDir "${workingDir}".`);
    this.name = 'PathEscapeError';
  }
}

/**
 * Resolve `input` to an absolute, real path that is guaranteed to live
 * inside `workingDir` (or be `workingDir` itself). Throws PathEscapeError
 * otherwise. The path doesn't have to exist — for write_file/edit we
 * resolve the parent and append the leaf.
 */
export function resolveSafe(input: string, workingDir: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new PathEscapeError(String(input), workingDir);
  }
  const wd = canonicalize(workingDir);

  const candidate = isAbsolute(input) ? input : resolve(wd, input);
  // For non-existent paths, walk up until we find an existing ancestor
  // and canonicalize that, then re-attach the leaf segments.
  const real = canonicalizeExistingPrefix(candidate);

  if (real !== wd && !real.startsWith(wd + sep)) {
    throw new PathEscapeError(input, workingDir);
  }
  return real;
}

function canonicalize(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function canonicalizeExistingPrefix(p: string): string {
  const parts = p.split(sep);
  for (let i = parts.length; i > 0; i--) {
    const ancestor = parts.slice(0, i).join(sep) || sep;
    try {
      const real = realpathSync(ancestor);
      const tail = parts.slice(i).join(sep);
      return tail ? resolve(real, tail) : real;
    } catch {
      continue;
    }
  }
  return p;
}
