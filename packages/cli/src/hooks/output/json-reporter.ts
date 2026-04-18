// Section J — JSON Reporter
import type { FormatResult } from '../format/runner.js';
import type { LintResult } from '../lint/runner.js';
import type { ConventionViolation } from '../convention/types.js';
import type { CheckResult } from '../commands/check.js';

export interface JsonReport {
  passed: boolean;
  format: FormatResult[];
  lint: LintResult[];
  conventions: ConventionViolation[];
  timestamp: string;
}

export class JsonReporter {
  format(result: CheckResult): string {
    const report: JsonReport = {
      passed: result.passed,
      format: result.formatResults,
      lint: result.lintResults,
      conventions: result.conventionViolations,
      timestamp: new Date().toISOString(),
    };
    return JSON.stringify(report, null, 2);
  }

  formatPartial(key: string, data: unknown): string {
    return JSON.stringify({ [key]: data }, null, 2);
  }
}
