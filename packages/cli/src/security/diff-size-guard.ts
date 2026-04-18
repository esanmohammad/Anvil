/**
 * DiffSizeGuard — count diff lines, warn/block at thresholds.
 */

export interface DiffSizeResult {
  totalLines: number;
  additions: number;
  deletions: number;
  level: 'ok' | 'warning' | 'blocked';
  message: string;
}

export interface DiffSizeConfig {
  /** Warn threshold (number of diff lines). Default 500. */
  warnThreshold: number;
  /** Block threshold (number of diff lines). Default 2000. */
  blockThreshold: number;
}

const DEFAULT_CONFIG: DiffSizeConfig = {
  warnThreshold: 500,
  blockThreshold: 2000,
};

export class DiffSizeGuard {
  private config: DiffSizeConfig;

  constructor(config?: Partial<DiffSizeConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Analyze a unified diff string. */
  analyze(diff: string): DiffSizeResult {
    const lines = diff.split('\n');
    let additions = 0;
    let deletions = 0;

    for (const line of lines) {
      if (line.startsWith('+') && !line.startsWith('+++')) {
        additions++;
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        deletions++;
      }
    }

    const totalLines = additions + deletions;
    let level: DiffSizeResult['level'] = 'ok';
    let message = `${totalLines} diff lines (${additions} additions, ${deletions} deletions)`;

    if (totalLines >= this.config.blockThreshold) {
      level = 'blocked';
      message = `Diff too large: ${totalLines} lines exceeds block threshold of ${this.config.blockThreshold}`;
    } else if (totalLines >= this.config.warnThreshold) {
      level = 'warning';
      message = `Large diff: ${totalLines} lines exceeds warn threshold of ${this.config.warnThreshold}`;
    }

    return { totalLines, additions, deletions, level, message };
  }

  /** Quick check returning true if the diff should be blocked. */
  shouldBlock(diff: string): boolean {
    return this.analyze(diff).level === 'blocked';
  }
}
