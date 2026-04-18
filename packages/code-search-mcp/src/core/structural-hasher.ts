/**
 * WS-6: Structural Hashing for Deduplication
 *
 * Computes logic-based hashes of code entities so that functionally identical
 * code produces the same hash regardless of formatting, comments, or local
 * variable naming.
 *
 * Uses regex-based canonicalization (upgradable to Tree-sitter when WS-4 lands).
 */

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface StructuralHashResult {
  hash: string;           // hex SHA256 of canonical form
  canonicalSize: number;  // size of canonical form in chars
}

// ---------------------------------------------------------------------------
// Comment / string-literal patterns
// ---------------------------------------------------------------------------

// Matches string literals (single, double, template) so we can protect them
// from the comment-stripping pass.  Handles escaped quotes.
const STRING_LITERAL_RE =
  /(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;

const LINE_COMMENT_RE = /\/\/.*$/gm;
const HASH_COMMENT_RE = /#.*$/gm;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const PYTHON_DOCSTRING_RE = /"""[\s\S]*?"""|'''[\s\S]*?'''/g;

// Languages where `#` starts a line comment
const HASH_COMMENT_LANGS = new Set(['python', 'ruby', 'bash', 'shell', 'yaml']);

// Languages where `//` starts a line comment
const SLASH_COMMENT_LANGS = new Set([
  'typescript', 'javascript', 'tsx', 'jsx', 'go', 'rust', 'java',
  'c', 'cpp', 'csharp', 'swift', 'kotlin', 'scala', 'dart', 'php',
]);

// ---------------------------------------------------------------------------
// Step 1: Strip comments (preserve string literals)
// ---------------------------------------------------------------------------

/**
 * Replace string literals with placeholders, strip comments, then restore.
 * This prevents stripping `//` or `#` that appear inside string values.
 */
function stripComments(content: string, language: string): string {
  // Protect string literals
  const strings: string[] = [];
  let protected_ = content.replace(STRING_LITERAL_RE, (match) => {
    strings.push(match);
    return `__STR_${strings.length - 1}__`;
  });

  // Python docstrings (before block comments since they use triple-quotes)
  if (language === 'python') {
    protected_ = protected_.replace(PYTHON_DOCSTRING_RE, '');
  }

  // Block comments (/* ... */)
  if (SLASH_COMMENT_LANGS.has(language) || language === 'css') {
    protected_ = protected_.replace(BLOCK_COMMENT_RE, '');
  }

  // Line comments
  if (SLASH_COMMENT_LANGS.has(language)) {
    protected_ = protected_.replace(LINE_COMMENT_RE, '');
  }
  if (HASH_COMMENT_LANGS.has(language)) {
    protected_ = protected_.replace(HASH_COMMENT_RE, '');
  }

  // Restore string literals
  protected_ = protected_.replace(/__STR_(\d+)__/g, (_, idx) => strings[Number(idx)]);

  return protected_;
}

// ---------------------------------------------------------------------------
// Step 2: Normalize whitespace
// ---------------------------------------------------------------------------

function normalizeWhitespace(content: string): string {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)    // remove blank lines
    .map((line) => line.replace(/,\s*$/, ''))  // strip trailing commas
    .map((line) => line.replace(/\s+/g, ' '))  // collapse whitespace
    .join('\n');
}

// ---------------------------------------------------------------------------
// Step 3: Normalize local variable names
// ---------------------------------------------------------------------------

// Declaration patterns per language family.
// Captures: (keyword)(name)(rest of line)
const VAR_DECL_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /\b(const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g,
  ],
  javascript: [
    /\b(const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g,
  ],
  tsx: [
    /\b(const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g,
  ],
  jsx: [
    /\b(const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/g,
  ],
  go: [
    /\b([a-zA-Z_][\w]*)\s*:=/g,
    /\bvar\s+([a-zA-Z_][\w]*)\b/g,
  ],
  python: [
    // Simple assignment (not augmented, not type-annotated attribute)
    /^(\s*)([a-zA-Z_][\w]*)\s*=/gm,
  ],
  rust: [
    /\blet\s+(?:mut\s+)?([a-zA-Z_][\w]*)\s*(?::|=)/g,
  ],
};

/**
 * Replace locally-declared variable names with positional tokens (v0, v1, ...).
 * Does NOT rename function parameters, exported names, type names, or imports.
 */
function normalizeLocalVariables(content: string, language: string): string {
  const langKey = language.toLowerCase();
  const patterns = VAR_DECL_PATTERNS[langKey];
  if (!patterns) return content;

  // Collect declared local names in order of appearance
  const localNames: string[] = [];
  for (const pattern of patterns) {
    // Reset lastIndex since we may re-use the regex
    const re = new RegExp(pattern.source, pattern.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      // For Go `:=`, group 1 is the name; for others, group 2 is the name
      const name = match[2] ?? match[1];
      if (name && !localNames.includes(name) && !isReservedIdentifier(name)) {
        localNames.push(name);
      }
    }
  }

  // Build replacement map: original name -> v0, v1, ...
  let result = content;
  for (let i = 0; i < localNames.length; i++) {
    const name = localNames[i];
    // Replace whole-word occurrences only (not inside other identifiers)
    const nameRe = new RegExp(`\\b${escapeRegex(name)}\\b`, 'g');
    result = result.replace(nameRe, `v${i}`);
  }

  return result;
}

/** Reserved keywords that should never be treated as local variables */
function isReservedIdentifier(name: string): boolean {
  const reserved = new Set([
    // JS/TS
    'true', 'false', 'null', 'undefined', 'this', 'super', 'return',
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
    'continue', 'throw', 'try', 'catch', 'finally', 'new', 'delete',
    'typeof', 'instanceof', 'void', 'in', 'of', 'async', 'await',
    'yield', 'import', 'export', 'default', 'from', 'as', 'class',
    'extends', 'implements', 'interface', 'type', 'enum', 'function',
    // Go
    'func', 'package', 'defer', 'go', 'select', 'chan', 'map', 'range',
    'struct', 'nil', 'err',
    // Python
    'def', 'lambda', 'self', 'cls', 'None', 'True', 'False', 'with',
    'pass', 'raise', 'except', 'global', 'nonlocal',
    // Rust
    'fn', 'pub', 'crate', 'mod', 'use', 'impl', 'trait', 'where',
    'Some', 'None', 'Ok', 'Err', 'Self',
  ]);
  return reserved.has(name);
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Step 4: Sort order-independent constructs
// ---------------------------------------------------------------------------

/**
 * Sort fields inside interface/type bodies, object literal keys,
 * enum variants, and import specifiers.
 *
 * Uses brace-matching to locate blocks, then sorts lines within them.
 */
function sortOrderIndependentBlocks(content: string, language: string): string {
  let result = content;

  // Sort import specifiers:  import { z, a, m } from '...'  →  import { a, m, z } from '...'
  result = result.replace(
    /import\s*\{([^}]+)\}\s*from/g,
    (_match, specifiers: string) => {
      const sorted = specifiers
        .split(',')
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0)
        .sort()
        .join(', ');
      return `import { ${sorted} } from`;
    },
  );

  // Sort interface/type/enum/object bodies if the language supports them.
  // We look for patterns like `interface X {`, `type X = {`, `enum X {`
  // and sort the lines between the braces.
  if (['typescript', 'javascript', 'tsx', 'jsx', 'go', 'rust'].includes(language)) {
    result = sortBracedBlocks(result, /\b(?:interface|type\s+\w+\s*=|enum)\s+\w+[^{]*\{/g);
  }

  return result;
}

/**
 * For each match of `blockStartRe`, find the matching `}` and sort the
 * interior lines alphabetically. Only sorts single-depth blocks (no nesting).
 */
function sortBracedBlocks(content: string, blockStartRe: RegExp): string {
  const re = new RegExp(blockStartRe.source, blockStartRe.flags);
  let result = content;
  let match: RegExpExecArray | null;

  // Process from back to front so indices stay valid after replacements
  const replacements: Array<{ start: number; end: number; replacement: string }> = [];

  while ((match = re.exec(result)) !== null) {
    const openBrace = result.indexOf('{', match.index + match[0].length - 1);
    if (openBrace === -1) continue;

    // Find matching close brace (depth-aware)
    let depth = 1;
    let pos = openBrace + 1;
    while (pos < result.length && depth > 0) {
      if (result[pos] === '{') depth++;
      else if (result[pos] === '}') depth--;
      pos++;
    }
    if (depth !== 0) continue;

    const closeBrace = pos - 1;
    const interior = result.slice(openBrace + 1, closeBrace);

    // Only sort simple single-line field blocks (no nested braces)
    if (interior.includes('{')) continue;

    const lines = interior
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length <= 1) continue;

    const sorted = lines.sort().join('\n');
    replacements.push({
      start: openBrace + 1,
      end: closeBrace,
      replacement: '\n' + sorted + '\n',
    });
  }

  // Apply replacements back-to-front
  for (const r of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main canonicalization pipeline
// ---------------------------------------------------------------------------

function canonicalize(content: string, language: string): string {
  let result = content;
  result = stripComments(result, language);
  result = normalizeWhitespace(result);
  result = normalizeLocalVariables(result, language);
  result = sortOrderIndependentBlocks(result, language);
  // Final whitespace pass after sorting
  result = normalizeWhitespace(result);
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a structural hash for a code entity.
 *
 * Pipeline:
 * 1. Strip comments (line comments, block comments, docstrings)
 * 2. Strip whitespace/formatting (normalize to single spaces, remove blank lines)
 * 3. Normalize local variable names to positional tokens
 * 4. Sort order-independent constructs (object keys, interface fields, enum variants)
 * 5. SHA256 hash the canonical string
 */
export function computeStructuralHash(
  content: string,
  language: string,
): StructuralHashResult {
  const canonical = canonicalize(content, language);
  const hash = createHash('sha256').update(canonical).digest('hex');
  return { hash, canonicalSize: canonical.length };
}

/**
 * Compute structural hashes for all chunks, returning a map of chunkId -> hash.
 * Also returns dedup groups (chunks that share the same structural hash).
 */
export function computeStructuralHashes(
  chunks: Array<{ id: string; content: string; language: string }>,
): {
  hashes: Map<string, string>;           // chunkId -> structuralHash
  dedupGroups: Map<string, string[]>;    // structuralHash -> [chunkId, ...]
  duplicateCount: number;                 // how many chunks are duplicates
  uniqueCount: number;
} {
  const hashes = new Map<string, string>();
  const dedupGroups = new Map<string, string[]>();

  for (const chunk of chunks) {
    const { hash } = computeStructuralHash(chunk.content, chunk.language);
    hashes.set(chunk.id, hash);

    const group = dedupGroups.get(hash);
    if (group) {
      group.push(chunk.id);
    } else {
      dedupGroups.set(hash, [chunk.id]);
    }
  }

  let duplicateCount = 0;
  for (const group of Array.from(dedupGroups.values())) {
    if (group.length > 1) {
      // All but the first are duplicates
      duplicateCount += group.length - 1;
    }
  }

  return {
    hashes,
    dedupGroups,
    duplicateCount,
    uniqueCount: chunks.length - duplicateCount,
  };
}

/** Rough token estimate: ~4 chars per token */
const CHARS_PER_TOKEN = 4;

/**
 * Given chunks with structural hashes, return only unique chunks.
 * For each dedup group, keep the first occurrence (by chunk ID sort order).
 * Returns the chunks that should be embedded + the chunks that are duplicates.
 */
export function deduplicateByStructure<
  T extends { id: string; content: string; language: string; structuralHash?: string },
>(
  chunks: T[],
): {
  unique: T[];
  duplicates: T[];
  savings: { chunks: number; estimatedTokens: number };
} {
  // Compute hashes for any chunks that don't already have one
  const hashMap = new Map<string, string>();
  for (const chunk of chunks) {
    const hash = chunk.structuralHash ?? computeStructuralHash(chunk.content, chunk.language).hash;
    hashMap.set(chunk.id, hash);
  }

  // Group by structural hash, keeping insertion order per group
  const groups = new Map<string, T[]>();
  for (const chunk of chunks) {
    const hash = hashMap.get(chunk.id)!;
    const group = groups.get(hash);
    if (group) {
      group.push(chunk);
    } else {
      groups.set(hash, [chunk]);
    }
  }

  const unique: T[] = [];
  const duplicates: T[] = [];
  let savedChars = 0;

  for (const group of Array.from(groups.values())) {
    // Sort by ID for deterministic selection of the "canonical" chunk
    const sorted = [...group].sort((a, b) => a.id.localeCompare(b.id));
    unique.push(sorted[0]);
    for (let i = 1; i < sorted.length; i++) {
      duplicates.push(sorted[i]);
      savedChars += sorted[i].content.length;
    }
  }

  return {
    unique,
    duplicates,
    savings: {
      chunks: duplicates.length,
      estimatedTokens: Math.round(savedChars / CHARS_PER_TOKEN),
    },
  };
}
