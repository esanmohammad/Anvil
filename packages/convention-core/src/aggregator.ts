// Convention aggregator — Section D.5

import type { FileNamingResult } from './detectors/file-naming.js';
import type { ImportPatternResult } from './detectors/import-patterns.js';
import type { TestPatternResult } from './detectors/test-patterns.js';
import type { ErrorHandlingResult } from './detectors/error-handling.js';

export interface RepoConventions {
  repoName: string;
  fileNaming: FileNamingResult;
  imports: ImportPatternResult;
  tests: TestPatternResult;
  errorHandling: ErrorHandlingResult;
}

export interface AggregatedConventions {
  /** Conventions with 80%+ agreement across repos */
  projectWide: {
    fileNaming?: FileNamingResult;
    imports?: ImportPatternResult;
    tests?: TestPatternResult;
    errorHandling?: ErrorHandlingResult;
  };
  /** Per-repo conventions */
  perRepo: RepoConventions[];
}

/**
 * Aggregate conventions across repos.
 * Conventions present in 80%+ of repos become project-wide.
 */
export function aggregateConventions(repos: RepoConventions[]): AggregatedConventions {
  const total = repos.length;
  if (total === 0) {
    return { projectWide: {}, perRepo: [] };
  }

  const threshold = 0.8;

  // File naming: check if 80%+ agree on the same convention
  const namingCounts = new Map<string, number>();
  for (const repo of repos) {
    const conv = repo.fileNaming.convention;
    namingCounts.set(conv, (namingCounts.get(conv) ?? 0) + 1);
  }

  let projectFileNaming: FileNamingResult | undefined;
  for (const [conv, count] of namingCounts) {
    if (count / total >= threshold && conv !== 'unknown') {
      const representative = repos.find((r) => r.fileNaming.convention === conv);
      projectFileNaming = representative?.fileNaming;
    }
  }

  // Import style: check if 80%+ agree
  const importCounts = new Map<string, number>();
  for (const repo of repos) {
    importCounts.set(repo.imports.style, (importCounts.get(repo.imports.style) ?? 0) + 1);
  }

  let systemImports: ImportPatternResult | undefined;
  for (const [style, count] of importCounts) {
    if (count / total >= threshold && style !== 'mixed') {
      const representative = repos.find((r) => r.imports.style === style);
      systemImports = representative?.imports;
    }
  }

  // Test patterns: check suffix agreement
  const testSuffixCounts = new Map<string, number>();
  for (const repo of repos) {
    testSuffixCounts.set(repo.tests.suffix, (testSuffixCounts.get(repo.tests.suffix) ?? 0) + 1);
  }

  let systemTests: TestPatternResult | undefined;
  for (const [suffix, count] of testSuffixCounts) {
    if (count / total >= threshold && suffix !== 'mixed') {
      const representative = repos.find((r) => r.tests.suffix === suffix);
      systemTests = representative?.tests;
    }
  }

  // Error handling: check style agreement
  const errorCounts = new Map<string, number>();
  for (const repo of repos) {
    errorCounts.set(repo.errorHandling.style, (errorCounts.get(repo.errorHandling.style) ?? 0) + 1);
  }

  let systemErrorHandling: ErrorHandlingResult | undefined;
  for (const [style, count] of errorCounts) {
    if (count / total >= threshold && style !== 'mixed') {
      const representative = repos.find((r) => r.errorHandling.style === style);
      systemErrorHandling = representative?.errorHandling;
    }
  }

  return {
    projectWide: {
      fileNaming: projectFileNaming,
      imports: systemImports,
      tests: systemTests,
      errorHandling: systemErrorHandling,
    },
    perRepo: repos,
  };
}
