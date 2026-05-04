// Test pattern detector — Section D.3

import { basename, dirname } from 'node:path';

export type TestSuffix = '.test' | '.spec' | 'mixed';
export type TestLocation = '__tests__' | 'colocated' | 'separate' | 'mixed';
export type TestStyle = 'describe-it' | 'test' | 'mixed';

export interface TestPatternResult {
  suffix: TestSuffix;
  location: TestLocation;
  style: TestStyle;
  confidence: number;
  testFileCount: number;
}

/**
 * Detect test patterns from test files and their contents.
 */
export function detectTestPatterns(
  testFiles: string[],
  contents: string[],
): TestPatternResult {
  let testSuffixCount = 0;
  let specSuffixCount = 0;
  let testsDir = 0;
  let colocated = 0;
  let describeItCount = 0;
  let plainTestCount = 0;

  for (let i = 0; i < testFiles.length; i++) {
    const file = testFiles[i];
    const name = basename(file);
    const dir = dirname(file);

    // Suffix detection
    if (name.includes('.test.')) testSuffixCount++;
    else if (name.includes('.spec.')) specSuffixCount++;

    // Location detection
    if (dir.includes('__tests__')) testsDir++;
    else colocated++;

    // Style detection
    const content = contents[i] ?? '';
    if (/\bdescribe\s*\(/.test(content) && /\bit\s*\(/.test(content)) {
      describeItCount++;
    }
    if (/\btest\s*\(/.test(content)) {
      plainTestCount++;
    }
  }

  const total = testFiles.length || 1;

  let suffix: TestSuffix = 'mixed';
  if (testSuffixCount / total > 0.7) suffix = '.test';
  else if (specSuffixCount / total > 0.7) suffix = '.spec';

  let location: TestLocation = 'mixed';
  if (testsDir / total > 0.7) location = '__tests__';
  else if (colocated / total > 0.7) location = 'colocated';

  let style: TestStyle = 'mixed';
  if (describeItCount / total > 0.7) style = 'describe-it';
  else if (plainTestCount / total > 0.7 && describeItCount === 0) style = 'test';

  const confidence = Math.round(
    (Math.max(testSuffixCount, specSuffixCount) / total) * 100,
  );

  return {
    suffix,
    location,
    style,
    confidence,
    testFileCount: testFiles.length,
  };
}
