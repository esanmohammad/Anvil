// Section D — Diff Extractor

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: 'add' | 'remove' | 'context';
  content: string;
  newLineNumber?: number;
  oldLineNumber?: number;
}

export interface FileDiff {
  filePath: string;
  hunks: DiffHunk[];
}

/**
 * Parse a unified diff output string for a single file.
 */
export function getFileDiff(diffOutput: string, filePath: string): FileDiff | null {
  const hunks: DiffHunk[] = [];
  const lines = diffOutput.split('\n');

  let inFile = false;
  let currentHunk: DiffHunk | null = null;
  let newLine = 0;
  let oldLine = 0;

  for (const line of lines) {
    // Detect file header
    if (line.startsWith('+++ b/') || line.startsWith('+++ ')) {
      const path = line.replace('+++ b/', '').replace('+++ ', '').trim();
      inFile = path === filePath || path.endsWith(filePath);
      continue;
    }

    if (line.startsWith('--- ')) {
      continue;
    }

    if (line.startsWith('diff --git')) {
      // New file diff — check if it matches
      const match = line.match(/diff --git a\/.+ b\/(.+)/);
      if (match) {
        inFile = match[1] === filePath || match[1].endsWith(filePath);
      }
      currentHunk = null;
      continue;
    }

    if (!inFile) continue;

    // Hunk header
    const hunkMatch = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
    if (hunkMatch) {
      currentHunk = {
        oldStart: parseInt(hunkMatch[1], 10),
        oldCount: parseInt(hunkMatch[2] ?? '1', 10),
        newStart: parseInt(hunkMatch[3], 10),
        newCount: parseInt(hunkMatch[4] ?? '1', 10),
        lines: [],
      };
      hunks.push(currentHunk);
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith('+')) {
      currentHunk.lines.push({
        type: 'add',
        content: line.slice(1),
        newLineNumber: newLine,
      });
      newLine++;
    } else if (line.startsWith('-')) {
      currentHunk.lines.push({
        type: 'remove',
        content: line.slice(1),
        oldLineNumber: oldLine,
      });
      oldLine++;
    } else if (line.startsWith(' ')) {
      currentHunk.lines.push({
        type: 'context',
        content: line.slice(1),
        newLineNumber: newLine,
        oldLineNumber: oldLine,
      });
      newLine++;
      oldLine++;
    }
  }

  if (hunks.length === 0) return null;
  return { filePath, hunks };
}
