// Bug analysis prompt builder — Wave 9, Section A

export interface BugAnalysisInput {
  project: string;
  bugDescription: string;
  repos: string[];
  conventions?: string;
  recentMemories?: string[];
}

/**
 * Build a prompt for the analyst agent to analyze a bug report.
 * The prompt instructs the agent to identify root cause, affected files,
 * and suggest a fix approach.
 */
export function buildBugAnalysisPrompt(input: BugAnalysisInput): string {
  const lines: string[] = [];

  lines.push('# Bug Analysis Request');
  lines.push('');
  lines.push('## Project');
  lines.push(`Project: ${input.project}`);
  lines.push(`Repositories: ${input.repos.join(', ')}`);
  lines.push('');
  lines.push('## Bug Description');
  lines.push(input.bugDescription);
  lines.push('');

  if (input.conventions) {
    lines.push('## Coding Conventions');
    lines.push(input.conventions);
    lines.push('');
  }

  if (input.recentMemories && input.recentMemories.length > 0) {
    lines.push('## Relevant Past Fixes');
    for (const mem of input.recentMemories) {
      lines.push(`- ${mem}`);
    }
    lines.push('');
  }

  lines.push('## Instructions');
  lines.push('');
  lines.push('Analyze the bug and produce a structured report with:');
  lines.push('');
  lines.push('1. **Root Cause Analysis** — What is likely causing this bug?');
  lines.push('2. **Affected Files** — Which files need to be modified?');
  lines.push('3. **Fix Approach** — Step-by-step plan to fix the bug.');
  lines.push('4. **Test Plan** — How to verify the fix works.');
  lines.push('5. **Risk Assessment** — What could go wrong with this fix?');
  lines.push('');
  lines.push('Format the output as Markdown with the headers above.');

  return lines.join('\n');
}
