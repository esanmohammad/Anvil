/**
 * test-types — shared type definitions for Anvil's test-generation feature.
 *
 * These are the contracts exchanged between the TestSpec generator, the
 * TestCase authors, the TestRun executor, and the per-project learner.
 *
 * The types here intentionally mirror the shape of PlanStore / ReviewStore
 * artifacts: versioned snapshots, persona-tagged findings, resolution audit
 * trail. Only the types live here — all persistence logic is in the
 * `*-store.ts` modules next door.
 */

// ── Enums ────────────────────────────────────────────────────────────────

export type BehaviorKind =
  | 'unit'
  | 'integration'
  | 'property'
  | 'contract'
  | 'regression'
  | 'e2e';

export type Priority = 'critical' | 'normal' | 'edge';
export type Confidence = 'high' | 'med' | 'low';

export type Runner =
  | 'vitest'
  | 'jest'
  | 'pytest'
  | 'go-test'
  | 'mocha'
  | 'unknown';

export type Runtime = 'node' | 'jsdom' | 'browser' | 'docker';

export type TestResolution = 'pending' | 'addressed' | 'dismissed' | 'wont-fix';
export type TestSeverity = 'blocker' | 'error' | 'warn' | 'info' | 'nit';
export type TestCategory =
  | 'coverage'
  | 'edge-case'
  | 'security'
  | 'perf'
  | 'flakiness'
  | 'convention';

export type TestPersona =
  | 'test-architect'
  | 'edge-case-hunter'
  | 'security-tester'
  | 'perf-tester'
  | 'flakiness-auditor';

// ── Behavior ─────────────────────────────────────────────────────────────

export interface Behavior {
  id: string;
  kind: BehaviorKind;
  intent: string;                                  // "Rejects tokens older than TTL"
  target: { file: string; symbol: string };        // KB-validated
  preconditions: string[];
  inputs: { description: string; samples?: unknown[]; generator?: string };
  expected: { description: string; assertion: string };
  priority: Priority;
  ground: { files: string[]; typesSeen: string[]; confidence: number };
  mutationTargets?: string[];                      // lines/branches to kill
  linkedFindingId?: string;                        // if derived from a review finding
  linkedIncidentId?: string;
}

// ── Convention fingerprint ───────────────────────────────────────────────

export interface ConventionFingerprint {
  runner: Runner;
  assertionStyle: 'expect' | 'assert' | 'should' | 'testing.T' | 'unknown';
  fileLayout: 'colocated' | '__tests__' | 'tests-root' | 'unknown';
  namingPattern: string;                           // e.g. "*.test.ts"
  setupPattern?: string;
  mockStyle?: 'vi.mock' | 'jest.mock' | 'sinon' | 'mocker' | 'none';
  fixtureStyle?: 'factories' | 'files' | 'inline';
  imports: Record<string, string>;
  examples: string[];                              // representative test file paths
}

// ── TestSpec ─────────────────────────────────────────────────────────────

export interface TestSpec {
  version: number;
  slug: string;
  project: string;
  title: string;
  source: {
    plan?: { slug: string; version: number };
    prUrl?: string;
    files: string[];
  };
  behaviors: Behavior[];
  conventions: ConventionFingerprint;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface TestSpecPointer {
  slug: string;
  title: string;
  currentVersion: number;
  updatedAt: string;
}

// ── TestCase ─────────────────────────────────────────────────────────────

export interface TestCase {
  id: string;
  behaviorId: string;
  specSlug: string;
  specVersion: number;
  framework: Runner;
  filePath: string;                                // relative to repo
  code: string;
  fixtures: Array<{ name: string; path?: string; inline?: string }>;
  mocks: Array<{ target: string; reason: string; style: string }>;
  runtime: Runtime;
  estimatedMs: number;
  createdAt: string;
}

// ── TestFinding ──────────────────────────────────────────────────────────

export interface TestFinding {
  id: string;
  severity: TestSeverity;
  category: TestCategory;
  persona?: TestPersona;
  behaviorId?: string;
  caseId?: string;
  file?: string;
  line?: number;
  snippet?: string;
  description: string;
  suggestedFix: { diff?: string; newBehaviorId?: string; rationale: string } | null;
  confidence: Confidence;
  resolution: TestResolution;
  createdAt: string;
}

// ── TestRun ──────────────────────────────────────────────────────────────

export interface TestRunResult {
  caseId: string;
  pass: boolean;
  durationMs: number;
  failure?: string;
  flakyScore?: number;
}

export interface TestRunCoverage {
  lines: number;
  branches: number;
  statements: number;
  delta?: { lines: number; branches: number };
}

export interface TestRunMutationScore {
  score: number;         // 0..1
  killed: number;
  total: number;
  byFile: Record<string, number>;
}

export interface TestRun {
  id: string;
  specSlug: string;
  specVersion: number;
  trigger: 'manual' | 'pipeline' | 'post-build' | 'pr';
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  results: TestRunResult[];
  coverage?: TestRunCoverage;
  mutationScore?: TestRunMutationScore;
  flakyQuarantined: string[];
  findings: TestFinding[];
  verdict: 'pass' | 'fail' | 'warn';
}

// ── TestLearnings ────────────────────────────────────────────────────────

export interface TestLearnings {
  projectSlug: string;
  flakyTests: Array<{ caseId: string; failureRate: number; lastSeen: string }>;
  falsePositives: Array<{
    behaviorId: string;
    reason: string;
    persona?: TestPersona;
    recordedAt: string;
  }>;
  bugsCaught: Array<{
    behaviorId: string;
    prUrl: string;
    severity: TestSeverity;
    recordedAt: string;
  }>;
  mutationScoreByFile: Record<string, number>;
  conventionDrift: Array<{ rule: string; violations: number }>;
  updatedAt: string;
}
