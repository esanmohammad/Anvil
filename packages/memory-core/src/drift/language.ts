/**
 * File-extension → tree-sitter language label. Used by the drift
 * detector when computing the structural hash of an on-disk file
 * referenced by `Memory.codeBinding.filePath`.
 *
 * Mirrors the labels `@anvil/knowledge-core/structural-hasher.ts`
 * already understands; `'unknown'` is a valid input for that hasher
 * (it falls back to whitespace-only normalization), so the helper is
 * safe to use on extensions we haven't enumerated.
 */

import { extname } from 'node:path';

const EXTENSION_MAP: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.cts': 'typescript',
  '.mts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.cjs': 'javascript',
  '.mjs': 'javascript',
  '.go': 'go',
  '.py': 'python',
  '.rb': 'ruby',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.php': 'php',
  '.cs': 'csharp',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
};

export function detectLanguageFromPath(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  return EXTENSION_MAP[ext] ?? 'unknown';
}
