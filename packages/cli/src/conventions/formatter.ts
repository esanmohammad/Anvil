// Convention formatter — Section D.6

import type { AggregatedConventions } from './aggregator.js';

/**
 * Format aggregated conventions as a Markdown document.
 */
export function formatConventions(conventions: AggregatedConventions): string {
  const lines: string[] = [];

  lines.push('# Coding Conventions');
  lines.push('');

  // Project-wide conventions
  lines.push('## Project-Wide Conventions');
  lines.push('');
  lines.push('These conventions are followed by 80%+ of repositories.');
  lines.push('');

  const sw = conventions.projectWide;

  if (sw.fileNaming) {
    lines.push('### File Naming');
    lines.push('');
    lines.push(`- **Convention:** ${sw.fileNaming.convention}`);
    lines.push(`- **Confidence:** ${sw.fileNaming.confidence}%`);
    if (sw.fileNaming.examples.length > 0) {
      lines.push(`- **Examples:** ${sw.fileNaming.examples.join(', ')}`);
    }
    lines.push('');
  }

  if (sw.imports) {
    lines.push('### Import Patterns');
    lines.push('');
    lines.push(`- **Style:** ${sw.imports.style}`);
    lines.push(`- **Barrel files:** ${sw.imports.hasBarrelFiles ? 'Yes' : 'No'}`);
    lines.push(`- **Import ordering:** ${sw.imports.hasImportOrdering ? 'Absolute before relative' : 'No consistent ordering'}`);
    lines.push('');
  }

  if (sw.tests) {
    lines.push('### Test Patterns');
    lines.push('');
    lines.push(`- **Suffix:** ${sw.tests.suffix}`);
    lines.push(`- **Location:** ${sw.tests.location}`);
    lines.push(`- **Style:** ${sw.tests.style}`);
    lines.push('');
  }

  if (sw.errorHandling) {
    lines.push('### Error Handling');
    lines.push('');
    lines.push(`- **Style:** ${sw.errorHandling.style}`);
    if (sw.errorHandling.examples.length > 0) {
      lines.push(`- **Examples:** ${sw.errorHandling.examples.join(', ')}`);
    }
    lines.push('');
  }

  if (!sw.fileNaming && !sw.imports && !sw.tests && !sw.errorHandling) {
    lines.push('No project-wide conventions detected (insufficient agreement across repos).');
    lines.push('');
  }

  // Per-repo conventions
  if (conventions.perRepo.length > 0) {
    lines.push('## Per-Repository Conventions');
    lines.push('');

    for (const repo of conventions.perRepo) {
      lines.push(`### ${repo.repoName}`);
      lines.push('');
      lines.push(`- **File naming:** ${repo.fileNaming.convention} (${repo.fileNaming.confidence}%)`);
      lines.push(`- **Imports:** ${repo.imports.style}`);
      lines.push(`- **Tests:** ${repo.tests.suffix} suffix, ${repo.tests.location} location, ${repo.tests.style} style`);
      lines.push(`- **Error handling:** ${repo.errorHandling.style}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}
