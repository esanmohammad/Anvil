/**
 * GarbageDetector — detects degenerate agent output patterns.
 */

export interface GarbageReport {
  isGarbage: boolean;
  issues: GarbageIssue[];
}

export interface GarbageIssue {
  type: 'repeated-lines' | 'repeated-tool' | 'empty-response' | 'non-utf8';
  description: string;
  severity: 'warning' | 'error';
}

export interface GarbageDetectorConfig {
  /** Threshold for identical consecutive lines. Default 10. */
  repeatedLineThreshold: number;
  /** Threshold for same tool invocation count. Default 5. */
  repeatedToolThreshold: number;
}

const DEFAULT_CONFIG: GarbageDetectorConfig = {
  repeatedLineThreshold: 10,
  repeatedToolThreshold: 5,
};

export class GarbageDetector {
  private config: GarbageDetectorConfig;

  constructor(config?: Partial<GarbageDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Analyze output for garbage patterns. */
  analyze(output: string, toolCalls?: string[]): GarbageReport {
    const issues: GarbageIssue[] = [];

    // Check for empty response
    if (!output || output.trim().length === 0) {
      issues.push({
        type: 'empty-response',
        description: 'Agent produced empty output',
        severity: 'error',
      });
    }

    // Check for repeated consecutive lines
    if (output) {
      const repeatedCount = this.countMaxConsecutiveRepeats(output);
      if (repeatedCount >= this.config.repeatedLineThreshold) {
        issues.push({
          type: 'repeated-lines',
          description: `Found ${repeatedCount} identical consecutive lines`,
          severity: 'error',
        });
      }
    }

    // Check for repeated tool calls
    if (toolCalls && toolCalls.length > 0) {
      const maxToolRepeat = this.countMaxToolRepeats(toolCalls);
      if (maxToolRepeat.count >= this.config.repeatedToolThreshold) {
        issues.push({
          type: 'repeated-tool',
          description: `Tool "${maxToolRepeat.tool}" invoked ${maxToolRepeat.count} times consecutively`,
          severity: 'warning',
        });
      }
    }

    // Check for non-UTF8 / binary content
    if (output && this.hasNonUtf8(output)) {
      issues.push({
        type: 'non-utf8',
        description: 'Output contains non-UTF8 or binary characters',
        severity: 'warning',
      });
    }

    return {
      isGarbage: issues.some((i) => i.severity === 'error'),
      issues,
    };
  }

  private countMaxConsecutiveRepeats(output: string): number {
    const lines = output.split('\n');
    let maxRepeat = 1;
    let currentRepeat = 1;

    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === lines[i - 1] && lines[i].trim().length > 0) {
        currentRepeat++;
        maxRepeat = Math.max(maxRepeat, currentRepeat);
      } else {
        currentRepeat = 1;
      }
    }

    return maxRepeat;
  }

  private countMaxToolRepeats(toolCalls: string[]): { tool: string; count: number } {
    let maxTool = '';
    let maxCount = 0;
    let currentTool = '';
    let currentCount = 0;

    for (const tool of toolCalls) {
      if (tool === currentTool) {
        currentCount++;
      } else {
        currentTool = tool;
        currentCount = 1;
      }
      if (currentCount > maxCount) {
        maxCount = currentCount;
        maxTool = currentTool;
      }
    }

    return { tool: maxTool, count: maxCount };
  }

  private hasNonUtf8(output: string): boolean {
    // Check for common binary / non-printable characters (excluding normal whitespace)
    // eslint-disable-next-line no-control-regex
    return /[\x00-\x08\x0E-\x1F\x7F]/.test(output);
  }
}
