// File naming convention detector — Section D.1

import { basename } from 'node:path';

export type NamingConvention = 'kebab-case' | 'camelCase' | 'PascalCase' | 'snake_case' | 'unknown';

export interface FileNamingResult {
  convention: NamingConvention;
  confidence: number;
  examples: string[];
  counts: Record<NamingConvention, number>;
}

function classifyName(name: string): NamingConvention {
  // Strip extension
  const base = name.replace(/\.[^.]+$/, '');
  if (!base) return 'unknown';

  if (/^[a-z][a-z0-9]*(-[a-z0-9]+)+$/.test(base)) return 'kebab-case';
  if (/^[a-z][a-zA-Z0-9]*$/.test(base) && /[A-Z]/.test(base)) return 'camelCase';
  if (/^[A-Z][a-zA-Z0-9]*$/.test(base)) return 'PascalCase';
  if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(base)) return 'snake_case';
  // Simple lowercase single word — could be anything; classify as kebab (most common)
  if (/^[a-z][a-z0-9]*$/.test(base)) return 'kebab-case';
  return 'unknown';
}

/**
 * Detect the dominant file naming convention from a list of file paths.
 */
export function detectFileNaming(files: string[]): FileNamingResult {
  const counts: Record<NamingConvention, number> = {
    'kebab-case': 0,
    'camelCase': 0,
    'PascalCase': 0,
    'snake_case': 0,
    'unknown': 0,
  };

  const examples: Record<NamingConvention, string[]> = {
    'kebab-case': [],
    'camelCase': [],
    'PascalCase': [],
    'snake_case': [],
    'unknown': [],
  };

  for (const file of files) {
    const name = basename(file);
    const conv = classifyName(name);
    counts[conv]++;
    if (examples[conv].length < 3) {
      examples[conv].push(name);
    }
  }

  // Find dominant convention
  let dominant: NamingConvention = 'unknown';
  let maxCount = 0;
  for (const [conv, count] of Object.entries(counts) as [NamingConvention, number][]) {
    if (conv !== 'unknown' && count > maxCount) {
      maxCount = count;
      dominant = conv;
    }
  }

  const total = files.length || 1;
  const confidence = Math.round((maxCount / total) * 100);

  return {
    convention: dominant,
    confidence,
    examples: examples[dominant],
    counts,
  };
}
