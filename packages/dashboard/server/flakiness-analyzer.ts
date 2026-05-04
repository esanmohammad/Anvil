/**
 * flakiness-analyzer — examine quarantined flaky TestCases, surface likely
 * causes via regex heuristics, and (when signals fire) spawn a
 * `flakiness-auditor` agent to propose a concrete fix diff.
 *
 * Two-stage design:
 *   1. Cheap regex pass, per-case, pattern-matches the usual flaky signals
 *      (sleeps, real time, entropy, unmocked network, shared module state,
 *      env reads, hardcoded ports).
 *   2. For cases where anything fires, an agent is spawned with the case
 *      source + fired signals and asked to return a `{ rootCause,
 *      suggestedFix }` JSON block. Budget: max 5 agents in parallel.
 *
 * Per-case failures are isolated via onError — a single agent crash never
 * aborts the whole run. Findings are RETURNED to the caller; this module does
 * not persist them itself.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

import type {
  TestRun,
  TestCase,
  TestFinding,
  Confidence,
  TestSeverity,
} from './test-types.js';
import type { AgentManager, AgentState } from '@anvil/agent-core';
import type { TestLearningsStore } from './test-learnings.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface FlakinessAnalysisOptions {
  agentManager: AgentManager;
  learningsStore: TestLearningsStore;
  project: string;
  run: TestRun;
  cases: TestCase[];
  /** Repo local path for reading the test file content. */
  repoLocalPath: string;
  model?: string;                    // default 'claude-sonnet-4-6'
  cwd: string;
  onAnalyzeStart?: (caseId: string, agentId: string) => void;
  onAnalyzeDone?: (caseId: string, finding: TestFinding) => void;
  onError?: (caseId: string, message: string) => void;
}

export interface FlakinessAnalysisResult {
  findings: TestFinding[];
  heuristicSignals: Array<{
    caseId: string;
    signals: string[];
  }>;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Max concurrent agents — regardless of how many flaky cases we have. */
const MAX_PARALLEL_AGENTS = 5;

/** Cap source code we embed in the agent prompt (defensive against huge files). */
const MAX_CODE_CHARS_IN_PROMPT = 20_000;

// ── Heuristic regex bank ─────────────────────────────────────────────────
//
// Each pattern is compiled ONCE at module scope (per constraint). The
// `allowOnlyIfAbsent` fields let us gate a pattern as "fired" only when a
// corresponding defuser pattern is *not* present in the same source — e.g.
// "reads Date.now() *without* useFakeTimers/freezegun stub".
//
// Patterns use the `g` flag so a single `.test()` + reset cycle works. We
// always reset `lastIndex` before calling `.test()` to stay safe across
// repeated invocations.

interface Heuristic {
  signal: string;
  fire: RegExp;
  /** If set, the heuristic is suppressed when ANY of these match in the same source. */
  suppressIfPresent?: RegExp[];
}

const RE_SLEEP = /setTimeout\(|\bsleep\(|Thread\.sleep\(/g;

const RE_REAL_TIME = /Date\.now\(\)|new Date\(\)|time\.time\(\)/g;
const RE_TIME_STUB = [
  /vi\.useFakeTimers\(/g,
  /jest\.useFakeTimers\(/g,
  /sinon\.useFakeTimers\(/g,
  /freeze(_?)time|freezegun/gi,
  /MockDate\./g,
];

const RE_ENTROPY = /Math\.random\(\)|\buuid\(\)|randomUUID\(\)/g;
const RE_SEED = [
  /seedrandom\(/g,
  /\.seed\(/g,
  /Math\.random\s*=/g, // explicit override
];

const RE_NETWORK = /\bfetch\(|\baxios\(|http\.request\b/g;
const RE_NETWORK_MOCK = [
  /\bnock\b/g,
  /\bmsw\b/g,
  /\bmock\b/gi,      // broad — any `mock` token in the file is enough to suppress
  /vi\.mock\(/g,
  /jest\.mock\(/g,
];

/**
 * Shared module-level `let`/`var` that's mutated in `beforeEach`.
 * The multiline RE finds `let foo` (or var) at top-level, then a beforeEach
 * block that references `foo`. Keeps it cheap with a bounded lookahead.
 */
const RE_SHARED_MUTATED = /^[ \t]*(?:let|var)\s+([a-zA-Z_$][\w$]*)\b[\s\S]{0,2000}?beforeEach\s*\(\s*(?:async\s*)?\(\s*\)\s*=>\s*\{[\s\S]{0,500}?\b\1\b/m;

const RE_ENV = /process\.env\./g;
const RE_ENV_SETUP = [
  /beforeEach[\s\S]{0,600}?process\.env\./g,
  /beforeAll[\s\S]{0,600}?process\.env\./g,
  /\.stubEnv\(/g,
];

const RE_HARDCODED_PORT = /\.listen\(\s*\d{2,5}\s*[,)]/g;

/**
 * Heuristic list. Order matters for reproducibility of the "signals" array
 * in the finding description.
 */
const HEURISTICS: Heuristic[] = [
  { signal: 'uses sleep/setTimeout (timing dependent)', fire: RE_SLEEP },
  { signal: 'reads real time without stub', fire: RE_REAL_TIME, suppressIfPresent: RE_TIME_STUB },
  { signal: 'uses entropy without seed', fire: RE_ENTROPY, suppressIfPresent: RE_SEED },
  { signal: 'network call without mock', fire: RE_NETWORK, suppressIfPresent: RE_NETWORK_MOCK },
  { signal: 'shared module state mutated in beforeEach', fire: RE_SHARED_MUTATED },
  { signal: 'env-sensitive', fire: RE_ENV, suppressIfPresent: RE_ENV_SETUP },
  { signal: 'port collision risk', fire: RE_HARDCODED_PORT },
];

function testPattern(re: RegExp, source: string): boolean {
  re.lastIndex = 0;
  return re.test(source);
}

function runHeuristics(source: string): string[] {
  const signals: string[] = [];
  for (const h of HEURISTICS) {
    if (!testPattern(h.fire, source)) continue;
    if (h.suppressIfPresent?.some((s) => testPattern(s, source))) continue;
    signals.push(h.signal);
  }
  return signals;
}

// ── Finding builder ──────────────────────────────────────────────────────

function confidenceFromSignalCount(n: number): Confidence {
  if (n >= 2) return 'high';
  if (n === 1) return 'med';
  return 'low';
}

function severityFromSignalCount(n: number): TestSeverity {
  return n > 2 ? 'error' : 'warn';
}

function newFindingId(): string {
  return `tf-flake-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function buildHeuristicFinding(testCase: TestCase, signals: string[]): TestFinding {
  const finding: TestFinding = {
    id: newFindingId(),
    severity: severityFromSignalCount(signals.length),
    category: 'flakiness',
    persona: 'flakiness-auditor',
    description: signals.join('; '),
    suggestedFix: null,
    confidence: confidenceFromSignalCount(signals.length),
    resolution: 'pending',
    createdAt: new Date().toISOString(),
  };
  if (testCase.behaviorId) finding.behaviorId = testCase.behaviorId;
  if (testCase.id) finding.caseId = testCase.id;
  if (testCase.filePath) finding.file = testCase.filePath;
  return finding;
}

// ── Source loader ────────────────────────────────────────────────────────

/**
 * Load the source for a test case. Prefer disk (true current state) and fall
 * back to the in-memory `case.code` if the file is missing or unreadable.
 */
function loadSource(testCase: TestCase, repoLocalPath: string): string {
  const abs = join(repoLocalPath, testCase.filePath);
  if (existsSync(abs)) {
    try {
      return readFileSync(abs, 'utf-8');
    } catch {
      // fallthrough to in-memory
    }
  }
  return testCase.code ?? '';
}

// ── Agent prompt ─────────────────────────────────────────────────────────

function inferLanguage(filePath: string, framework: string): string {
  if (framework === 'pytest') return 'python';
  if (framework === 'go-test') return 'go';
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.ts')) return 'ts';
  if (filePath.endsWith('.jsx')) return 'jsx';
  if (filePath.endsWith('.js')) return 'js';
  if (filePath.endsWith('.py')) return 'python';
  if (filePath.endsWith('.go')) return 'go';
  return '';
}

function truncateCodeForPrompt(code: string): string {
  if (code.length <= MAX_CODE_CHARS_IN_PROMPT) return code;
  return code.slice(0, MAX_CODE_CHARS_IN_PROMPT) + '\n// ... (truncated for prompt budget)';
}

function buildAgentPrompt(
  testCase: TestCase,
  code: string,
  signals: string[],
  learningsBlock: string,
): string {
  const lang = inferLanguage(testCase.filePath, testCase.framework);
  const head = learningsBlock.trim() ? `${learningsBlock.trim()}\n\n` : '';
  return (
    head +
    `Case: ${testCase.filePath}\n` +
    `Code:\n` +
    '```' + lang + '\n' +
    truncateCodeForPrompt(code) + '\n' +
    '```\n' +
    `Heuristic signals: ${signals.join('; ')}\n` +
    `\n` +
    `Diagnose the root cause and propose a concrete fix as a unified diff that stubs time / seeds RNG / mocks network / isolates state / uses ports from 0. ` +
    `Return a JSON block with shape { "rootCause": string, "suggestedFix": { diff: string, rationale: string } }.`
  );
}

// ── Agent response parser ────────────────────────────────────────────────

// Shape echoed back by the flakiness-auditor when it follows instructions.
// `any` is allowed locally per constraint — we defensively re-validate fields
// before using them.
interface RawAgentPayload {
  rootCause?: unknown;
  suggestedFix?: {
    diff?: unknown;
    rationale?: unknown;
  } | null;
}

function extractJsonBlock(output: string): string | null {
  const re = /```json\s*([\s\S]*?)```/gi;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    last = m[1];
  }
  if (last !== null) return last.trim();

  // Tolerant fallback: bare ``` fence wrapping `{ ... }`.
  const bare = /```\s*([\s\S]*?)```/gi;
  let lastBare: string | null = null;
  while ((m = bare.exec(output)) !== null) {
    const candidate = m[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) lastBare = candidate;
  }
  if (lastBare) return lastBare;

  // Last-ditch: find the final `{ ... }` substring.
  const first = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (first !== -1 && lastBrace > first) {
    const candidate = output.slice(first, lastBrace + 1).trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) return candidate;
  }
  return null;
}

interface ParsedAgentResult {
  rootCause: string | null;
  diff: string | null;
  rationale: string | null;
}

function parseAgentOutput(output: string): ParsedAgentResult | null {
  const jsonText = extractJsonBlock(output);
  if (!jsonText) return null;

  let parsed: RawAgentPayload;
  try {
    parsed = JSON.parse(jsonText) as RawAgentPayload;
  } catch {
    return null;
  }

  const rootCause = typeof parsed.rootCause === 'string' ? parsed.rootCause : null;
  const fix = parsed.suggestedFix && typeof parsed.suggestedFix === 'object' ? parsed.suggestedFix : null;
  const diff = fix && typeof fix.diff === 'string' ? fix.diff : null;
  const rationale = fix && typeof fix.rationale === 'string' ? fix.rationale : null;

  return { rootCause, diff, rationale };
}

// ── Agent waiter ─────────────────────────────────────────────────────────

/**
 * Resolve when the given agent reaches a terminal state. Mirrors
 * test-review-runner.waitForAgent — same polling cadence (500ms).
 */
function waitForAgent(
  agentManager: AgentManager,
  agentId: string,
): Promise<{ agent: AgentState }> {
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const current = agentManager.getAgent(agentId);
      if (!current) {
        reject(new Error(`Agent ${agentId} disappeared`));
        return;
      }
      if (current.status === 'done') {
        resolve({ agent: current });
      } else if (current.status === 'error' || current.status === 'killed') {
        reject(new Error(current.error ?? `Agent ${agentId} failed`));
      } else {
        setTimeout(tick, 500);
      }
    };
    tick();
  });
}

// ── Per-case worker ──────────────────────────────────────────────────────

interface CaseWorkItem {
  testCase: TestCase;
  signals: string[];
  code: string;
  finding: TestFinding;
}

/**
 * Spawn a single flakiness-auditor agent for one case, wait for it, and
 * merge its `rootCause` + `suggestedFix` into the existing heuristic finding.
 *
 * Never throws — any failure is logged via `opts.onError` and the heuristic
 * finding is returned untouched.
 */
async function enrichCaseWithAgent(
  item: CaseWorkItem,
  opts: FlakinessAnalysisOptions,
  learningsBlock: string,
  model: string,
): Promise<TestFinding> {
  const caseId = item.testCase.id;
  const prompt = buildAgentPrompt(item.testCase, item.code, item.signals, learningsBlock);

  let agentState: AgentState;
  try {
    agentState = opts.agentManager.spawn({
      name: `flakiness-auditor-${opts.project}-${caseId}`,
      persona: 'flakiness-auditor',
      project: opts.project,
      stage: `flakiness-analyze:${caseId}`,
      prompt,
      model,
      cwd: opts.cwd,
      permissionMode: 'bypassPermissions',
      disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
    });
  } catch (err) {
    opts.onError?.(
      caseId,
      `Spawn failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return item.finding;
  }

  opts.onAnalyzeStart?.(caseId, agentState.id);

  let finalAgent: AgentState;
  try {
    const res = await waitForAgent(opts.agentManager, agentState.id);
    finalAgent = res.agent;
  } catch (err) {
    opts.onError?.(
      caseId,
      `Agent wait failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return item.finding;
  }

  const output = finalAgent.output ?? '';
  const parsed = parseAgentOutput(output);
  if (!parsed || (!parsed.diff && !parsed.rationale && !parsed.rootCause)) {
    opts.onError?.(caseId, 'Agent output did not contain a usable JSON block');
    return item.finding;
  }

  // Compose the rationale preferring agent content, but always keeping the
  // heuristic signals visible so reviewers can see what fired.
  const rationaleParts: string[] = [];
  if (parsed.rootCause) rationaleParts.push(`Root cause: ${parsed.rootCause}`);
  if (parsed.rationale) rationaleParts.push(parsed.rationale);
  rationaleParts.push(`Heuristic signals: ${item.signals.join('; ')}`);
  const rationale = rationaleParts.join('\n\n');

  const merged: TestFinding = {
    ...item.finding,
    confidence: 'high',
    suggestedFix: {
      rationale,
      ...(parsed.diff ? { diff: parsed.diff } : {}),
    },
  };
  return merged;
}

// ── Concurrency gate ─────────────────────────────────────────────────────

/**
 * Run `items` through `worker` with at most `limit` in flight at any time.
 * Result array preserves input order.
 */
async function runWithLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  async function pump(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx]);
    }
  }

  const workers: Promise<void>[] = [];
  const n = Math.min(limit, items.length);
  for (let i = 0; i < n; i++) workers.push(pump());
  await Promise.all(workers);
  return results;
}

// ── Public entry ─────────────────────────────────────────────────────────

/**
 * Analyze the flaky-quarantined cases in a TestRun. For each case:
 *   1. Run regex heuristics against the source.
 *   2. If any signal fires, emit a heuristic TestFinding AND spawn a
 *      flakiness-auditor agent for a root-cause + fix diff.
 *   3. Merge the agent's output into the finding when it parses.
 *
 * Returns all findings + the per-case heuristic signal list (useful for UI).
 * Never persists — the caller appends findings via TestRunStore.
 */
export async function analyzeFlakiness(
  opts: FlakinessAnalysisOptions,
): Promise<FlakinessAnalysisResult> {
  const model = opts.model ?? DEFAULT_MODEL;
  const quarantined = new Set(opts.run.flakyQuarantined ?? []);
  const flakyCases = opts.cases.filter((c) => quarantined.has(c.id));

  const heuristicSignals: Array<{ caseId: string; signals: string[] }> = [];
  const workItems: CaseWorkItem[] = [];
  const findings: TestFinding[] = [];

  // Stage 1 — heuristics.
  for (const testCase of flakyCases) {
    let code = '';
    try {
      code = loadSource(testCase, opts.repoLocalPath);
    } catch (err) {
      opts.onError?.(
        testCase.id,
        `Source load failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    let signals: string[];
    try {
      signals = runHeuristics(code);
    } catch (err) {
      opts.onError?.(
        testCase.id,
        `Heuristic scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      continue;
    }

    heuristicSignals.push({ caseId: testCase.id, signals });

    if (signals.length === 0) continue;

    const finding = buildHeuristicFinding(testCase, signals);
    workItems.push({ testCase, signals, code, finding });
  }

  // Stage 2 — agent enrichment. Learnings calibration prepended to every prompt.
  let learningsBlock = '';
  try {
    learningsBlock = opts.learningsStore.formatForPrompt(opts.project) ?? '';
  } catch (err) {
    // Non-fatal: proceed without calibration.
    console.warn(
      `[flakiness-analyzer] learningsStore.formatForPrompt failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const enriched = await runWithLimit(workItems, MAX_PARALLEL_AGENTS, async (item) => {
    // enrichCaseWithAgent already swallows per-case failures and returns the
    // heuristic finding as fallback. Defence-in-depth: still guard here.
    try {
      const out = await enrichCaseWithAgent(item, opts, learningsBlock, model);
      opts.onAnalyzeDone?.(item.testCase.id, out);
      return out;
    } catch (err) {
      opts.onError?.(
        item.testCase.id,
        `Unexpected enrich failure: ${err instanceof Error ? err.message : String(err)}`,
      );
      return item.finding;
    }
  });

  findings.push(...enriched);

  return { findings, heuristicSignals };
}
