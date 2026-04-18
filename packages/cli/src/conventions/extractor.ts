// Convention extractor — Section D.7

import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { getFFDirs } from '../home.js';
import { detectFileNaming } from './detectors/file-naming.js';
import { detectImportPatterns } from './detectors/import-patterns.js';
import { detectTestPatterns } from './detectors/test-patterns.js';
import { detectErrorHandling } from './detectors/error-handling.js';
import { aggregateConventions } from './aggregator.js';
import type { RepoConventions } from './aggregator.js';
import { formatConventions } from './formatter.js';

/**
 * Recursively list files in a directory with an extension filter.
 */
function listFiles(dir: string, extensions: string[], maxDepth: number = 5): string[] {
  if (maxDepth <= 0 || !existsSync(dir)) return [];

  const result: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(...listFiles(fullPath, extensions, maxDepth - 1));
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        result.push(fullPath);
      }
    }
  } catch {
    // Skip inaccessible directories
  }
  return result;
}

function safeReadFile(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

/**
 * Extract conventions from a project's repos.
 * Orchestrates all detectors, aggregates, formats, writes output.
 */
export function extractConventions(
  project: string,
  repoPaths: string[],
): string {
  const repoConventions: RepoConventions[] = [];

  for (const repoPath of repoPaths) {
    if (!existsSync(repoPath)) continue;

    const repoName = repoPath.split('/').pop() ?? repoPath;
    const sourceExts = ['.ts', '.js', '.tsx', '.jsx', '.go', '.py'];
    const testExts = ['.test.ts', '.test.js', '.spec.ts', '.spec.js', '_test.go'];

    const allFiles = listFiles(repoPath, sourceExts);
    const testFiles = allFiles.filter((f) =>
      testExts.some((ext) => f.endsWith(ext)),
    );
    const sourceFiles = allFiles.filter(
      (f) => !testExts.some((ext) => f.endsWith(ext)),
    );

    const fileNaming = detectFileNaming(allFiles);
    const imports = detectImportPatterns(
      sourceFiles.slice(0, 100).map((p) => ({ path: p, content: safeReadFile(p) })),
    );
    const testContents = testFiles.slice(0, 50).map((f) => safeReadFile(f));
    const tests = detectTestPatterns(testFiles.slice(0, 50), testContents);
    const errorHandling = detectErrorHandling(
      sourceFiles.slice(0, 100).map((f) => safeReadFile(f)),
    );

    repoConventions.push({
      repoName,
      fileNaming,
      imports,
      tests,
      errorHandling,
    });
  }

  const aggregated = aggregateConventions(repoConventions);
  const markdown = formatConventions(aggregated);

  // Write to conventions dir
  const dirs = getFFDirs();
  const conventionsDir = join(dirs.conventions, project);
  if (!existsSync(conventionsDir)) {
    mkdirSync(conventionsDir, { recursive: true });
  }
  const outputPath = join(conventionsDir, 'conventions.md');
  writeFileSync(outputPath, markdown, 'utf-8');

  return markdown;
}
