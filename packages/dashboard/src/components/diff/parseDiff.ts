/** Unified diff parser */

export interface DiffFile {
  oldPath: string;
  newPath: string;
  hunks: DiffHunk[];
  status: 'added' | 'deleted' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  header: string;
  lines: DiffLineData[];
}

export interface DiffLineData {
  type: 'add' | 'delete' | 'context';
  content: string;
  oldLineNumber?: number;
  newLineNumber?: number;
}

export function parseDiff(diffText: string): DiffFile[] {
  const files: DiffFile[] = [];
  const fileChunks = diffText.split(/^diff --git /gm).filter(Boolean);

  for (const chunk of fileChunks) {
    const lines = chunk.split('\n');
    const headerMatch = lines[0]?.match(/a\/(.+?) b\/(.+)/);
    if (!headerMatch) continue;

    const oldPath = headerMatch[1];
    const newPath = headerMatch[2];
    const hunks: DiffHunk[] = [];
    let additions = 0;
    let deletions = 0;
    let status: DiffFile['status'] = 'modified';

    // Detect status
    if (lines.some((l) => l.startsWith('new file'))) status = 'added';
    else if (lines.some((l) => l.startsWith('deleted file'))) status = 'deleted';
    else if (lines.some((l) => l.startsWith('rename from'))) status = 'renamed';

    let currentHunk: DiffHunk | null = null;
    let oldLine = 0;
    let newLine = 0;

    for (const line of lines) {
      const hunkMatch = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/);
      if (hunkMatch) {
        currentHunk = {
          oldStart: parseInt(hunkMatch[1]),
          oldCount: parseInt(hunkMatch[2] ?? '1'),
          newStart: parseInt(hunkMatch[3]),
          newCount: parseInt(hunkMatch[4] ?? '1'),
          header: hunkMatch[5]?.trim() ?? '',
          lines: [],
        };
        hunks.push(currentHunk);
        oldLine = currentHunk.oldStart;
        newLine = currentHunk.newStart;
        continue;
      }

      if (!currentHunk) continue;

      if (line.startsWith('+')) {
        currentHunk.lines.push({ type: 'add', content: line.slice(1), newLineNumber: newLine });
        newLine++;
        additions++;
      } else if (line.startsWith('-')) {
        currentHunk.lines.push({ type: 'delete', content: line.slice(1), oldLineNumber: oldLine });
        oldLine++;
        deletions++;
      } else if (line.startsWith(' ')) {
        currentHunk.lines.push({ type: 'context', content: line.slice(1), oldLineNumber: oldLine, newLineNumber: newLine });
        oldLine++;
        newLine++;
      }
    }

    files.push({ oldPath, newPath, hunks, status, additions, deletions });
  }

  return files;
}

export function getDiffStats(files: DiffFile[]): { totalAdditions: number; totalDeletions: number; filesChanged: number } {
  return {
    totalAdditions: files.reduce((sum, f) => sum + f.additions, 0),
    totalDeletions: files.reduce((sum, f) => sum + f.deletions, 0),
    filesChanged: files.length,
  };
}
