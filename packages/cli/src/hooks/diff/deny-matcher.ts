// Section D — Deny Pattern Matcher
import type { DiffLine } from './extractor.js';
import type { DenyPattern } from '../convention/types.js';

export interface DenyMatch {
  pattern: DenyPattern;
  line: DiffLine;
  matchedText: string;
}

/**
 * Match deny patterns against diff lines (only added lines).
 */
export function matchDenyPatterns(
  lines: DiffLine[],
  patterns: DenyPattern[],
): DenyMatch[] {
  const matches: DenyMatch[] = [];

  const addedLines = lines.filter((l) => l.type === 'add');

  for (const line of addedLines) {
    for (const pattern of patterns) {
      const regex = new RegExp(pattern.pattern, pattern.flags ?? 'g');
      const match = regex.exec(line.content);
      if (match) {
        matches.push({
          pattern,
          line,
          matchedText: match[0],
        });
      }
    }
  }

  return matches;
}
