/**
 * review-scope-matcher — pure functions that decide which reviewer personas
 * should run on which files, using the scope table in `review-persona-scopes`.
 */

import { PERSONA_SCOPES, listPersonaIds } from './review-persona-scopes.js';
import type { PersonaScope } from './review-persona-scopes.js';

export interface ScopedFile {
  path: string;
  contents: string;
}

// ── Glob compiler ────────────────────────────────────────────────────────

/**
 * Compile a glob string into a RegExp.
 * Supports: `**` (any path segments), `*` (any non-slash chars), `?` (one
 * non-slash char), and `{a,b,c}` brace alternation. Paths are matched with
 * forward slashes; leading `./` is stripped from inputs before matching.
 */
function compileGlob(glob: string): RegExp {
  let i = 0;
  let out = '';
  while (i < glob.length) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches across slashes.
        out += '.*';
        i += 2;
        // swallow a following slash so `**/foo` works as `(.*/)?foo`.
        if (glob[i] === '/') i += 1;
      } else {
        out += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      out += '[^/]';
      i += 1;
    } else if (ch === '{') {
      const end = glob.indexOf('}', i);
      if (end === -1) {
        out += '\\{';
        i += 1;
        continue;
      }
      const options = glob.slice(i + 1, end).split(',').map(escapeRegex);
      out += `(?:${options.join('|')})`;
      i = end + 1;
    } else if (/[.+^$()|\\]/.test(ch)) {
      out += '\\' + ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return new RegExp('^' + out + '$');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalisePath(p: string): string {
  let path = p.replace(/\\/g, '/');
  if (path.startsWith('./')) path = path.slice(2);
  return path;
}

// Small compile cache so hot paths don't re-parse identical globs.
const globCache = new Map<string, RegExp>();
function getGlobRegex(glob: string): RegExp {
  let re = globCache.get(glob);
  if (!re) {
    re = compileGlob(glob);
    globCache.set(glob, re);
  }
  return re;
}

// ── Scope predicates ─────────────────────────────────────────────────────

function pathMatches(scope: PersonaScope, filePath: string): boolean {
  if (!scope.pathPatterns || scope.pathPatterns.length === 0) return true;
  const normal = normalisePath(filePath);
  for (const pattern of scope.pathPatterns) {
    if (getGlobRegex(pattern).test(normal)) return true;
  }
  return false;
}

function contentMatches(scope: PersonaScope, contents: string | undefined): boolean {
  if (!scope.contentSniffs || scope.contentSniffs.length === 0) return true;
  if (contents === undefined) return false;
  for (const rx of scope.contentSniffs) {
    if (rx.test(contents)) return true;
  }
  return false;
}

// ── Public API ───────────────────────────────────────────────────────────

export function matches(personaId: string, filePath: string, fileContents?: string): boolean {
  const scope = PERSONA_SCOPES[personaId];
  if (!scope) return false;
  return pathMatches(scope, filePath) && contentMatches(scope, fileContents);
}

export function filterFilesForPersona(
  personaId: string,
  files: ScopedFile[],
): ScopedFile[] {
  return files.filter((f) => matches(personaId, f.path, f.contents));
}

export function routeFilesToPersonas(
  files: ScopedFile[],
  personaIds?: string[],
): Record<string, ScopedFile[]> {
  const ids = personaIds && personaIds.length > 0 ? personaIds : listPersonaIds();
  const out: Record<string, ScopedFile[]> = {};
  for (const id of ids) {
    out[id] = filterFilesForPersona(id, files);
  }
  return out;
}
