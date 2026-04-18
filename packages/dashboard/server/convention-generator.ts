/**
 * Convention generator — scans codebase for CI configs, test patterns,
 * and language conventions, then synthesizes convention rules.
 *
 * Self-contained in the dashboard server to avoid fragile cross-package
 * dynamic imports from @anvil-dev/cli.
 */

import { readFileSync, existsSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ── Types ────────────────────────────────────────────────────────────────

export interface ConventionRule {
  id: string;
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
  filePattern?: string;
  deny?: string;
  message: string;
  enabled: boolean;
}

interface CiConfig {
  provider: string;
  buildSteps: string[];
  testCommands: string[];
  deployTargets: string[];
  triggers: string[];
  filePath: string;
}

interface TestPattern {
  framework: string;
  testFileSuffix: string;
  testDirectory: string;
  totalTestFiles: number;
  hasSetupFile: boolean;
  usesSnapshot: boolean;
  usesMocking: boolean;
  avgTestsPerFile: number;
}

// ── CI Scanner ───────────────────────────────────────────────────────────

const CI_FILE_CANDIDATES = [
  { path: '.github/workflows', provider: 'github-actions' },
  { path: '.gitlab-ci.yml', provider: 'gitlab-ci' },
  { path: 'Jenkinsfile', provider: 'jenkins' },
  { path: '.circleci/config.yml', provider: 'circleci' },
];

function extractGitHubActionsInfo(content: string): Partial<CiConfig> {
  const buildSteps: string[] = [];
  const testCommands: string[] = [];
  const deployTargets: string[] = [];
  const triggers: string[] = [];

  const onMatch = content.match(/^on:\s*\n((?:\s+.+\n)*)/m);
  if (onMatch) {
    const triggerLines = onMatch[1].match(/^\s+(\w[\w-]*)/gm);
    if (triggerLines) triggers.push(...triggerLines.map(t => t.trim()));
  }

  const runMatches = content.matchAll(/run:\s*[|]?\s*\n?\s*(.+)/g);
  for (const match of runMatches) {
    const cmd = match[1].trim();
    if (/\b(build|compile|tsc)\b/i.test(cmd)) buildSteps.push(cmd);
    if (/\b(test|jest|mocha|pytest|go\s+test)\b/i.test(cmd)) testCommands.push(cmd);
    if (/\b(deploy|publish|release)\b/i.test(cmd)) deployTargets.push(cmd);
  }

  return { buildSteps, testCommands, deployTargets, triggers };
}

function extractGenericCiInfo(content: string): Partial<CiConfig> {
  const buildSteps: string[] = [];
  const testCommands: string[] = [];
  const deployTargets: string[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (/\b(npm\s+run\s+build|make\s+build|go\s+build|mvn\s+compile)\b/.test(trimmed)) buildSteps.push(trimmed);
    if (/\b(npm\s+test|go\s+test|pytest|jest|mocha|mvn\s+test)\b/.test(trimmed)) testCommands.push(trimmed);
    if (/\b(deploy|publish|release|push)\b/i.test(trimmed)) deployTargets.push(trimmed);
  }

  return { buildSteps, testCommands, deployTargets, triggers: [] };
}

function scanCiConfigs(repoPath: string): CiConfig[] {
  const configs: CiConfig[] = [];

  for (const candidate of CI_FILE_CANDIDATES) {
    const fullPath = join(repoPath, candidate.path);
    if (!existsSync(fullPath)) continue;

    if (candidate.provider === 'github-actions') {
      try {
        if (!statSync(fullPath).isDirectory()) continue;
        for (const file of readdirSync(fullPath) as string[]) {
          if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
          const filePath = join(fullPath, file);
          const content = readFileSync(filePath, 'utf-8');
          const info = extractGitHubActionsInfo(content);
          configs.push({
            provider: 'github-actions',
            buildSteps: info.buildSteps ?? [],
            testCommands: info.testCommands ?? [],
            deployTargets: info.deployTargets ?? [],
            triggers: info.triggers ?? [],
            filePath,
          });
        }
      } catch { /* skip */ }
    } else {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const info = extractGenericCiInfo(content);
        configs.push({
          provider: candidate.provider,
          buildSteps: info.buildSteps ?? [],
          testCommands: info.testCommands ?? [],
          deployTargets: info.deployTargets ?? [],
          triggers: info.triggers ?? [],
          filePath: fullPath,
        });
      } catch { /* skip */ }
    }
  }

  return configs;
}

// ── Test Scanner ─────────────────────────────────────────────────────────

const TEST_SUFFIXES = [
  '.test.ts', '.test.js', '.test.tsx', '.test.jsx',
  '.spec.ts', '.spec.js', '.spec.tsx', '.spec.jsx',
  '_test.go', '_test.py', 'Test.java',
];

const TEST_DIRS = ['__tests__', 'tests', 'test', 'spec'];

function listTestFiles(dir: string, maxDepth = 5): string[] {
  if (maxDepth <= 0 || !existsSync(dir)) return [];
  const results: string[] = [];
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...listTestFiles(fullPath, maxDepth - 1));
      } else if (TEST_SUFFIXES.some(s => entry.name.endsWith(s))) {
        results.push(fullPath);
      }
    }
  } catch { /* skip */ }
  return results;
}

function scanTestPatterns(repoPath: string): TestPattern {
  const testFiles = listTestFiles(repoPath);
  if (testFiles.length === 0) {
    return { framework: 'unknown', testFileSuffix: '', testDirectory: '', totalTestFiles: 0, hasSetupFile: false, usesSnapshot: false, usesMocking: false, avgTestsPerFile: 0 };
  }

  const suffixCounts = new Map<string, number>();
  for (const file of testFiles) {
    for (const suffix of TEST_SUFFIXES) {
      if (file.endsWith(suffix)) { suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1); break; }
    }
  }
  const dominantSuffix = [...suffixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

  let testDirectory = '';
  for (const dir of TEST_DIRS) {
    if (existsSync(join(repoPath, dir))) { testDirectory = dir; break; }
  }

  let framework = 'unknown';
  let usesSnapshot = false;
  let usesMocking = false;
  let totalTests = 0;
  const sampled = testFiles.slice(0, 20);

  for (const file of sampled) {
    try {
      const content = readFileSync(file, 'utf-8');
      if (/from\s+['"]@jest|jest\.fn|describe\(|it\(.*expect\(/.test(content)) framework = 'jest';
      else if (/from\s+['"]mocha|describe\(.*function/.test(content)) framework = 'mocha';
      else if (/^def\s+test_|^class\s+Test|import\s+pytest/m.test(content)) framework = 'pytest';
      else if (/func\s+Test\w+\(t\s+\*testing\.T\)/.test(content)) framework = 'go-test';
      else if (/@Test|import\s+org\.junit/.test(content)) framework = 'junit';

      if (/toMatchSnapshot|toMatchInlineSnapshot/.test(content)) usesSnapshot = true;
      if (/jest\.fn|jest\.mock|sinon|mock\(|patch\(|@Mock/.test(content)) usesMocking = true;

      const itCount = content.match(/\bit\s*\(/g)?.length ?? 0;
      const testCount = content.match(/\btest\s*\(/g)?.length ?? 0;
      const funcTestCount = content.match(/func\s+Test\w+/g)?.length ?? 0;
      const defTestCount = content.match(/def\s+test_\w+/g)?.length ?? 0;
      totalTests += itCount + testCount + funcTestCount + defTestCount;
    } catch { /* skip */ }
  }

  const setupFiles = ['jest.config.js', 'jest.config.ts', 'jest.setup.ts', 'jest.setup.js', 'setup.py', 'conftest.py', '.mocharc.yml'];

  return {
    framework,
    testFileSuffix: dominantSuffix,
    testDirectory,
    totalTestFiles: testFiles.length,
    hasSetupFile: setupFiles.some(f => existsSync(join(repoPath, f))),
    usesSnapshot,
    usesMocking,
    avgTestsPerFile: sampled.length > 0 ? Math.round(totalTests / sampled.length) : 0,
  };
}

// ── Rule Generator ───────────────────────────────────────────────────────

function generateRulesFromPatterns(ciConfigs: CiConfig[], testPatterns: TestPattern[], language: string): ConventionRule[] {
  const rules: ConventionRule[] = [];
  let idx = 0;

  // From test patterns
  if (testPatterns.length > 0) {
    const tp = testPatterns[0];
    if (tp.testFileSuffix) {
      rules.push({
        id: `gen-test-suffix-${idx++}`, name: 'Test file suffix convention',
        description: `Test files should use ${tp.testFileSuffix} suffix`,
        severity: 'warning', filePattern: '*.{ts,js,tsx,jsx}',
        message: `Test files should use the ${tp.testFileSuffix} suffix to match project conventions.`,
        enabled: true,
      });
    }
    if (tp.usesMocking) {
      rules.push({
        id: `gen-mock-pattern-${idx++}`, name: 'Mocking pattern',
        description: 'Tests use mocking — ensure mocks are properly cleaned up',
        severity: 'info', filePattern: tp.testFileSuffix || '*.test.ts',
        message: 'Test uses mocking. Ensure afterEach/afterAll cleanup is present.',
        enabled: true,
      });
    }
    if (tp.framework !== 'unknown') {
      rules.push({
        id: `gen-test-framework-${idx++}`, name: `Test framework: ${tp.framework}`,
        description: `Project uses ${tp.framework} with ${tp.totalTestFiles} test files (~${tp.avgTestsPerFile} tests/file)`,
        severity: 'info', filePattern: tp.testFileSuffix || '*',
        message: `Follow ${tp.framework} conventions when writing tests.`,
        enabled: true,
      });
    }
  }

  // From CI configs
  for (const ci of ciConfigs) {
    if (ci.testCommands.length > 0) {
      rules.push({
        id: `gen-ci-test-${idx++}`, name: 'CI test command',
        description: `CI runs tests via: ${ci.testCommands[0]}`,
        severity: 'info', filePattern: '*',
        message: `Ensure tests pass with: ${ci.testCommands[0]}`,
        enabled: true,
      });
    }
    if (ci.buildSteps.length > 0) {
      rules.push({
        id: `gen-ci-build-${idx++}`, name: 'CI build command',
        description: `CI builds via: ${ci.buildSteps[0]}`,
        severity: 'info', filePattern: '*',
        message: `Ensure build passes with: ${ci.buildSteps[0]}`,
        enabled: true,
      });
    }
  }

  // Language-specific defaults
  if (language === 'typescript' || language === 'javascript') {
    rules.push({
      id: `gen-no-any-${idx++}`, name: 'Avoid any type',
      description: 'Prefer explicit types over any',
      severity: 'warning', filePattern: '*.{ts,tsx}',
      deny: ':\\s*any\\b',
      message: 'Avoid using `any` type — prefer explicit types.',
      enabled: true,
    });
  }

  if (language === 'go') {
    rules.push({
      id: `gen-error-handling-${idx++}`, name: 'Check error returns',
      description: 'Go functions should check error returns',
      severity: 'error', filePattern: '*.go',
      deny: '_\\s*=\\s*\\w+\\([^)]*\\)',
      message: 'Do not discard error returns. Handle or explicitly ignore with a comment.',
      enabled: true,
    });
  }

  return rules;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Generate conventions for a project by scanning its workspace repos.
 * Scans CI configs and test patterns, then generates rules.
 */
export function generateConventions(workspace: string, repoNames: string[]): ConventionRule[] {
  const allCiConfigs: CiConfig[] = [];
  const allTestPatterns: TestPattern[] = [];
  const languages = new Set<string>();

  // Scan each repo (or workspace root if no repos)
  const scanPaths = repoNames.length > 0
    ? repoNames.map(r => join(workspace, r))
    : [workspace];

  for (const repoPath of scanPaths) {
    if (!existsSync(repoPath)) continue;

    try { allCiConfigs.push(...scanCiConfigs(repoPath)); } catch { /* best effort */ }
    try { allTestPatterns.push(scanTestPatterns(repoPath)); } catch { /* best effort */ }

    // Detect language from files
    try {
      if (existsSync(join(repoPath, 'go.mod'))) languages.add('go');
      if (existsSync(join(repoPath, 'tsconfig.json'))) languages.add('typescript');
      if (existsSync(join(repoPath, 'package.json'))) languages.add('typescript');
      if (existsSync(join(repoPath, 'setup.py')) || existsSync(join(repoPath, 'pyproject.toml'))) languages.add('python');
      if (existsSync(join(repoPath, 'Cargo.toml'))) languages.add('rust');
      if (existsSync(join(repoPath, 'pom.xml'))) languages.add('java');
    } catch { /* best effort */ }
  }

  // Generate rules for each detected language
  const allRules: ConventionRule[] = [];
  const detectedLanguages = languages.size > 0 ? [...languages] : ['typescript'];

  for (const lang of detectedLanguages) {
    allRules.push(...generateRulesFromPatterns(allCiConfigs, allTestPatterns, lang));
  }

  // Deduplicate by rule name
  const seen = new Set<string>();
  return allRules.filter(r => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}

/**
 * Save generated rules to disk.
 */
export function saveConventionRules(anvilHome: string, project: string, rules: ConventionRule[]): void {
  const rulesDir = join(anvilHome, 'conventions', 'rules', project);
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, 'generated.json'), JSON.stringify({ rules }, null, 2), 'utf-8');
}

/**
 * Load previously generated convention rules from disk.
 */
export function loadConventionRules(anvilHome: string, project: string): ConventionRule[] {
  const rulesFile = join(anvilHome, 'conventions', 'rules', project, 'generated.json');
  if (!existsSync(rulesFile)) return [];
  try {
    const data = JSON.parse(readFileSync(rulesFile, 'utf-8'));
    return data.rules ?? [];
  } catch {
    return [];
  }
}
