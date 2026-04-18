// Test scanner — Wave 9, Section E
// Analyzes test files to extract test patterns

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

export interface TestPattern {
  framework: 'jest' | 'mocha' | 'pytest' | 'go-test' | 'junit' | 'unknown';
  testFileSuffix: string; // e.g., '.test.ts', '.spec.ts', '_test.go'
  testDirectory: string; // e.g., '__tests__', 'tests', 'test'
  totalTestFiles: number;
  hasSetupFile: boolean;
  usesSnapshot: boolean;
  usesMocking: boolean;
  avgTestsPerFile: number;
}

const TEST_SUFFIXES = [
  '.test.ts', '.test.js', '.test.tsx', '.test.jsx',
  '.spec.ts', '.spec.js', '.spec.tsx', '.spec.jsx',
  '_test.go', '_test.py',
  'Test.java',
];

const TEST_DIRS = ['__tests__', 'tests', 'test', 'spec'];

function listTestFiles(dir: string, maxDepth: number = 5): string[] {
  if (maxDepth <= 0 || !existsSync(dir)) return [];

  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listTestFiles(fullPath, maxDepth - 1));
      } else {
        const isTest = TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix));
        if (isTest) results.push(fullPath);
      }
    }
  } catch {
    // Skip inaccessible
  }
  return results;
}

function detectFramework(content: string): TestPattern['framework'] {
  if (/from\s+['"]@jest|jest\.fn|describe\(|it\(.*expect\(/.test(content)) return 'jest';
  if (/from\s+['"]mocha|describe\(.*function/.test(content)) return 'mocha';
  if (/^def\s+test_|^class\s+Test|import\s+pytest/m.test(content)) return 'pytest';
  if (/func\s+Test\w+\(t\s+\*testing\.T\)/.test(content)) return 'go-test';
  if (/@Test|import\s+org\.junit/.test(content)) return 'junit';
  return 'unknown';
}

function countTests(content: string): number {
  const itMatches = content.match(/\bit\s*\(/g);
  const testMatches = content.match(/\btest\s*\(/g);
  const funcTestMatches = content.match(/func\s+Test\w+/g);
  const defTestMatches = content.match(/def\s+test_\w+/g);
  return (itMatches?.length ?? 0) + (testMatches?.length ?? 0) +
         (funcTestMatches?.length ?? 0) + (defTestMatches?.length ?? 0);
}

/**
 * Scan a repo to extract test patterns.
 */
export function scanTestPatterns(repoPath: string): TestPattern {
  const testFiles = listTestFiles(repoPath);

  if (testFiles.length === 0) {
    return {
      framework: 'unknown',
      testFileSuffix: '',
      testDirectory: '',
      totalTestFiles: 0,
      hasSetupFile: false,
      usesSnapshot: false,
      usesMocking: false,
      avgTestsPerFile: 0,
    };
  }

  // Detect suffix from majority
  const suffixCounts = new Map<string, number>();
  for (const file of testFiles) {
    for (const suffix of TEST_SUFFIXES) {
      if (file.endsWith(suffix)) {
        suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
        break;
      }
    }
  }
  const dominantSuffix = [...suffixCounts.entries()]
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  // Detect test directory
  let testDirectory = '';
  for (const dir of TEST_DIRS) {
    if (existsSync(join(repoPath, dir))) {
      testDirectory = dir;
      break;
    }
  }

  // Analyze content of first 20 test files
  let framework: TestPattern['framework'] = 'unknown';
  let usesSnapshot = false;
  let usesMocking = false;
  let totalTests = 0;
  const sampled = testFiles.slice(0, 20);

  for (const file of sampled) {
    try {
      const content = readFileSync(file, 'utf-8');
      const detected = detectFramework(content);
      if (detected !== 'unknown') framework = detected;
      if (/toMatchSnapshot|toMatchInlineSnapshot/.test(content)) usesSnapshot = true;
      if (/jest\.fn|jest\.mock|sinon|mock\(|patch\(|@Mock/.test(content)) usesMocking = true;
      totalTests += countTests(content);
    } catch {
      // Skip unreadable files
    }
  }

  const avgTestsPerFile = sampled.length > 0 ? Math.round(totalTests / sampled.length) : 0;

  // Check for setup files
  const setupFiles = [
    'jest.config.js', 'jest.config.ts', 'jest.setup.ts', 'jest.setup.js',
    'setup.py', 'conftest.py', '.mocharc.yml',
  ];
  const hasSetupFile = setupFiles.some((f) => existsSync(join(repoPath, f)));

  return {
    framework,
    testFileSuffix: dominantSuffix,
    testDirectory,
    totalTestFiles: testFiles.length,
    hasSetupFile,
    usesSnapshot,
    usesMocking,
    avgTestsPerFile,
  };
}
