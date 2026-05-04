/**
 * test-review-runner — multi-persona parallel review for TestSpecs.
 *
 * Spawns the five test-review personas (test-architect, edge-case-hunter,
 * security-tester, perf-tester, flakiness-auditor) in parallel via
 * AgentManager. Each persona sees the TestSpec + TestCases + learning
 * calibration, emits a JSON block of structured findings, and the aggregate
 * is appended to the given TestRun via TestRunStore.appendFindings (which
 * handles dedup).
 *
 * Per-persona failures are isolated: one persona returning invalid output
 * does not abort the whole review. The runner always resolves with whatever
 * findings the remaining personas produced.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import type {
  TestSpec,
  TestCase,
  TestFinding,
  TestPersona,
  TestSeverity,
  TestCategory,
  Confidence,
} from './test-types.js';
import type { AgentManager, AgentState } from '@anvil/agent-core';
import type { TestRunStore } from './test-run-store.js';
import type { TestLearningsStore } from './test-learnings.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface ReviewRunnerOptions {
  agentManager: AgentManager;
  runStore: TestRunStore;
  learningsStore: TestLearningsStore;
  project: string;
  spec: TestSpec;
  cases: TestCase[];
  runId: string;
  personas?: TestPersona[];
  model?: string;
  cwd: string;
  onPersonaStart?: (persona: TestPersona, agentId: string) => void;
  onPersonaDone?: (persona: TestPersona, findings: TestFinding[], cost: number) => void;
  onError?: (persona: TestPersona, message: string) => void;
}

export interface ReviewRunnerResult {
  findings: TestFinding[];
  costByPersona: Record<TestPersona, number>;
  perPersonaFindings: Record<TestPersona, TestFinding[]>;
}

// ── Constants ────────────────────────────────────────────────────────────

const ALL_PERSONAS: TestPersona[] = [
  'test-architect',
  'edge-case-hunter',
  'security-tester',
  'perf-tester',
  'flakiness-auditor',
];

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/** Character cap for the full persona prompt (spec + cases + learnings + preamble). */
const MAX_PROMPT_CHARS = 60_000;

/** Character cap for the raw persona output. Beyond this, we keep only the last ```json ... ``` block. */
const MAX_OUTPUT_CHARS = 50_000;

/** Max behaviors to list in the shared context. Remainder shown as truncation note. */
const MAX_BEHAVIORS = 40;

/** Max lines of code per test case shown in the shared context. */
const MAX_CASE_LINES = 40;

/** Max findings to accept per persona — truncated by severity weight if exceeded. */
const MAX_FINDINGS_PER_PERSONA_HARD = 50;
const MAX_FINDINGS_PER_PERSONA_KEEP = 20;

const SEVERITY_WEIGHT: Record<TestSeverity, number> = {
  blocker: 5,
  error: 4,
  warn: 3,
  info: 2,
  nit: 1,
};

const VALID_SEVERITIES = new Set<TestSeverity>([
  'blocker', 'error', 'warn', 'info', 'nit',
]);

const VALID_CATEGORIES = new Set<TestCategory>([
  'coverage', 'edge-case', 'security', 'perf', 'flakiness', 'convention',
]);

const VALID_CONFIDENCES = new Set<Confidence>(['high', 'med', 'low']);

const DEFAULT_CATEGORY_BY_PERSONA: Record<TestPersona, TestCategory> = {
  'test-architect': 'coverage',
  'edge-case-hunter': 'edge-case',
  'security-tester': 'security',
  'perf-tester': 'perf',
  'flakiness-auditor': 'flakiness',
};

const PERSONA_ID_PREFIX: Record<TestPersona, string> = {
  'test-architect': 'ta',
  'edge-case-hunter': 'ec',
  'security-tester': 'sec',
  'perf-tester': 'perf',
  'flakiness-auditor': 'flk',
};

// ── Persona prompt loader (re-implemented from pipeline-runner) ─────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const personaPromptCache = new Map<string, string>();

/**
 * Load a persona prompt from disk. Mirrors pipeline-runner.ts's
 * loadPersonaPromptSync — checks user override, then several candidate
 * paths relative to __dirname (source tree + bundled CLI layouts).
 */
function loadPersonaPromptSync(personaName: string): string {
  if (personaPromptCache.has(personaName)) return personaPromptCache.get(personaName)!;

  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');

  const userPath = join(anvilHome, 'personas', `${personaName}.md`);
  if (existsSync(userPath)) {
    const content = readFileSync(userPath, 'utf-8');
    personaPromptCache.set(personaName, content);
    return content;
  }

  const bundledPaths = [
    join(__dirname, '..', '..', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', '..', 'src', 'personas', 'prompts', `${personaName}.md`),
  ];

  for (const p of bundledPaths) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      personaPromptCache.set(personaName, content);
      return content;
    }
  }

  console.warn(`[test-review-runner] Persona prompt not found for "${personaName}". Checked: ${bundledPaths.join(', ')}`);
  return '';
}

// ── Shared context builder ──────────────────────────────────────────────

/**
 * Infer a markdown code-fence language from a framework/filepath.
 */
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

function truncateCode(code: string, maxLines: number): string {
  const lines = code.split('\n');
  if (lines.length <= maxLines) return code;
  return [...lines.slice(0, maxLines), `// ... (${lines.length - maxLines} more lines truncated)`].join('\n');
}

function buildSharedContext(
  project: string,
  spec: TestSpec,
  cases: TestCase[],
  learningsBlock: string,
): string {
  const parts: string[] = [];

  parts.push(`# Project\n${project}`);

  parts.push(
    `# Test spec\n` +
    `Slug: ${spec.slug}@v${spec.version}\n` +
    `Title: ${spec.title}\n` +
    `Runner: ${spec.conventions.runner}`,
  );

  // Behaviors
  const behaviors = spec.behaviors ?? [];
  const totalBehaviors = behaviors.length;
  const shownBehaviors = behaviors.slice(0, MAX_BEHAVIORS);
  parts.push(`## Behaviors (${totalBehaviors})`);
  const behaviorLines: string[] = [];
  for (const b of shownBehaviors) {
    const target = `${b.target?.file ?? '?'}:${b.target?.symbol ?? '?'}`;
    const priority = b.priority ?? 'normal';
    const confidence = b.ground?.confidence ?? 0;
    behaviorLines.push(
      `- [${b.kind}] ${b.intent} — target: ${target} (priority=${priority}, confidence=${confidence})`,
    );
  }
  if (totalBehaviors > MAX_BEHAVIORS) {
    behaviorLines.push(`- ... (${totalBehaviors - MAX_BEHAVIORS} more behaviors truncated)`);
  }
  parts.push(behaviorLines.join('\n'));

  // Generated test cases
  const totalCases = cases.length;
  parts.push(`## Generated test cases (${totalCases})`);
  const caseChunks: string[] = [];
  for (const c of cases) {
    const lang = inferLanguage(c.filePath, c.framework);
    const header = `### ${c.filePath} (${c.framework}, runtime=${c.runtime})`;
    const body = '```' + lang + '\n' + truncateCode(c.code ?? '', MAX_CASE_LINES) + '\n```';
    caseChunks.push(`${header}\n${body}`);
  }
  if (caseChunks.length) parts.push(caseChunks.join('\n\n'));

  if (learningsBlock && learningsBlock.trim()) {
    parts.push(`# Learnings for this project\n${learningsBlock.trim()}`);
  }

  parts.push(
    `# Your job\n` +
    `Review the spec and the generated test cases. Emit a JSON block following the exact contract at the end of your persona prompt. ` +
    `Do NOT modify any files. Do NOT make assumptions about code outside the snippets shown — use the KB via grep/read if needed but keep findings grounded in what's visible or verifiable.`,
  );

  return parts.join('\n\n');
}

/**
 * Truncate a context block so the *final* prompt (persona + context) fits
 * within MAX_PROMPT_CHARS. Truncation targets the cases section since
 * behaviors and learnings are typically smaller and more important.
 */
function fitContextToBudget(personaPrompt: string, context: string): string {
  const overhead = personaPrompt.length + 2; // two newline separator
  const budget = MAX_PROMPT_CHARS - overhead;
  if (budget <= 0) {
    // Persona prompt alone exceeds budget — keep a minimal context.
    return context.slice(0, Math.max(1000, Math.floor(MAX_PROMPT_CHARS * 0.1)));
  }
  if (context.length <= budget) return context;
  const note = '\n\n... (shared context truncated to fit prompt budget)';
  return context.slice(0, budget - note.length) + note;
}

// ── Output parsing ──────────────────────────────────────────────────────

interface RawFinding {
  severity?: unknown;
  category?: unknown;
  behaviorId?: unknown;
  caseId?: unknown;
  file?: unknown;
  line?: unknown;
  snippet?: unknown;
  description?: unknown;
  suggestedFix?: unknown;
  confidence?: unknown;
}

interface RawPayload {
  findings?: RawFinding[];
  summary?: string;
}

/**
 * Extract the final ```json ... ``` fenced block from a persona's output.
 * Returns null if no block is found.
 */
function extractJsonBlock(output: string): string | null {
  // Non-greedy scan for all ```json ... ``` blocks, pick the last one.
  const re = /```json\s*([\s\S]*?)```/gi;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    last = m[1];
  }
  if (last !== null) return last.trim();

  // Fallback: some models use a bare ``` fence with JSON content.
  const bare = /```\s*([\s\S]*?)```/gi;
  let lastBare: string | null = null;
  while ((m = bare.exec(output)) !== null) {
    const candidate = m[1].trim();
    if (candidate.startsWith('{') && candidate.endsWith('}')) lastBare = candidate;
  }
  return lastBare;
}

function clampSeverity(value: unknown): TestSeverity {
  if (typeof value === 'string' && VALID_SEVERITIES.has(value as TestSeverity)) {
    return value as TestSeverity;
  }
  return 'info';
}

function clampCategory(value: unknown, fallback: TestCategory): TestCategory {
  if (typeof value === 'string' && VALID_CATEGORIES.has(value as TestCategory)) {
    return value as TestCategory;
  }
  return fallback;
}

function clampConfidence(value: unknown): Confidence {
  if (typeof value === 'string' && VALID_CONFIDENCES.has(value as Confidence)) {
    return value as Confidence;
  }
  return 'med';
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  // Models sometimes emit 0 as "not applicable" — preserve it; consumers treat it as-is.
  return value;
}

function stampSuggestedFix(value: unknown): TestFinding['suggestedFix'] {
  if (!value || typeof value !== 'object') return null;
  const obj = value as { diff?: unknown; rationale?: unknown; newBehaviorId?: unknown };
  const rationale = stringOrUndefined(obj.rationale);
  if (!rationale) return null;
  const out: { diff?: string; newBehaviorId?: string; rationale: string } = { rationale };
  const diff = stringOrUndefined(obj.diff);
  if (diff) out.diff = diff;
  const newBehaviorId = stringOrUndefined(obj.newBehaviorId);
  if (newBehaviorId) out.newBehaviorId = newBehaviorId;
  return out;
}

function newFindingId(persona: TestPersona): string {
  const prefix = PERSONA_ID_PREFIX[persona];
  return `tf-${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
}

function stampFinding(raw: RawFinding, persona: TestPersona): TestFinding {
  const defaultCategory = DEFAULT_CATEGORY_BY_PERSONA[persona];
  const finding: TestFinding = {
    id: newFindingId(persona),
    severity: clampSeverity(raw.severity),
    category: clampCategory(raw.category, defaultCategory),
    persona,
    description: typeof raw.description === 'string' ? raw.description : '',
    suggestedFix: stampSuggestedFix(raw.suggestedFix),
    confidence: clampConfidence(raw.confidence),
    resolution: 'pending',
    createdAt: new Date().toISOString(),
  };

  const behaviorId = stringOrUndefined(raw.behaviorId);
  if (behaviorId) finding.behaviorId = behaviorId;
  const caseId = stringOrUndefined(raw.caseId);
  if (caseId) finding.caseId = caseId;
  const file = stringOrUndefined(raw.file);
  if (file) finding.file = file;
  const line = numberOrUndefined(raw.line);
  if (line !== undefined) finding.line = line;
  const snippet = stringOrUndefined(raw.snippet);
  if (snippet) finding.snippet = snippet;

  return finding;
}

/**
 * Parse a persona output into an array of stamped TestFinding objects.
 * Returns a tuple of [findings, errorMessage]. When parsing fails,
 * findings is [] and errorMessage describes the failure.
 */
function parsePersonaOutput(
  output: string,
  persona: TestPersona,
): { findings: TestFinding[]; error: string | null } {
  // If output is huge, keep only the last JSON block for parsing.
  let source = output;
  if (source.length > MAX_OUTPUT_CHARS) {
    const block = extractJsonBlock(source);
    source = block ?? source.slice(-MAX_OUTPUT_CHARS);
  }

  const jsonText = extractJsonBlock(source);
  if (!jsonText) {
    return { findings: [], error: 'No ```json block found in persona output' };
  }

  let parsed: RawPayload;
  try {
    parsed = JSON.parse(jsonText) as RawPayload;
  } catch (err) {
    return {
      findings: [],
      error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const rawFindings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  let stamped = rawFindings.map((r) => stampFinding(r, persona));

  // Cap findings: if > 50, keep top 20 by severity weight.
  if (stamped.length > MAX_FINDINGS_PER_PERSONA_HARD) {
    stamped = [...stamped]
      .sort((a, b) => (SEVERITY_WEIGHT[b.severity] ?? 0) - (SEVERITY_WEIGHT[a.severity] ?? 0))
      .slice(0, MAX_FINDINGS_PER_PERSONA_KEEP);
  }

  return { findings: stamped, error: null };
}

// ── Agent waiter ────────────────────────────────────────────────────────

/**
 * Resolve when the given agent reaches a terminal state.
 * Polls AgentManager rather than subscribing to events — matches the
 * pattern used by pipeline-runner.waitForAgent.
 */
function waitForAgent(
  agentManager: AgentManager,
  agentId: string,
): Promise<{ agent: AgentState }> {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const current = agentManager.getAgent(agentId);
      if (!current) return reject(new Error(`Agent ${agentId} disappeared`));
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

// ── Per-persona runner ──────────────────────────────────────────────────

async function runSinglePersona(
  persona: TestPersona,
  opts: ReviewRunnerOptions,
  sharedContext: string,
  model: string,
): Promise<{ persona: TestPersona; findings: TestFinding[]; cost: number }> {
  const personaPrompt = loadPersonaPromptSync(persona);
  if (!personaPrompt) {
    const msg = `Persona prompt not found on disk for "${persona}"`;
    opts.onError?.(persona, msg);
    return { persona, findings: [], cost: 0 };
  }

  const fittedContext = fitContextToBudget(personaPrompt, sharedContext);
  const prompt = `${personaPrompt}\n\n${fittedContext}`;

  let agentState: AgentState;
  try {
    agentState = opts.agentManager.spawn({
      name: `${persona}-${opts.project}-${opts.spec.slug}`,
      persona,
      project: opts.project,
      stage: `test-review:${persona}`,
      prompt,
      model,
      cwd: opts.cwd,
      permissionMode: 'bypassPermissions',
      disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
    });
  } catch (err) {
    const msg = `Spawn failed for "${persona}": ${err instanceof Error ? err.message : String(err)}`;
    opts.onError?.(persona, msg);
    return { persona, findings: [], cost: 0 };
  }

  opts.onPersonaStart?.(persona, agentState.id);

  let finalAgent: AgentState;
  try {
    const res = await waitForAgent(opts.agentManager, agentState.id);
    finalAgent = res.agent;
  } catch (err) {
    const msg = `Persona "${persona}" agent failed: ${err instanceof Error ? err.message : String(err)}`;
    opts.onError?.(persona, msg);
    return { persona, findings: [], cost: 0 };
  }

  const cost = finalAgent.cost.totalUsd;
  const output = finalAgent.output ?? '';

  const { findings, error } = parsePersonaOutput(output, persona);
  if (error) {
    opts.onError?.(persona, `Persona "${persona}" output parse issue — ${error}`);
  }

  opts.onPersonaDone?.(persona, findings, cost);
  return { persona, findings, cost };
}

// ── Public runner ───────────────────────────────────────────────────────

/**
 * Run the multi-persona test review. Spawns all personas in parallel,
 * aggregates their findings, and appends the aggregate to the given run
 * via `runStore.appendFindings(project, spec.slug, runId, ...)`.
 *
 * Per-persona failures are isolated — a single persona's crash never
 * aborts the whole review.
 */
export async function runMultiPersonaReview(opts: ReviewRunnerOptions): Promise<ReviewRunnerResult> {
  const personas = opts.personas && opts.personas.length ? opts.personas : ALL_PERSONAS;
  const model = opts.model ?? DEFAULT_MODEL;

  let learningsBlock = '';
  try {
    learningsBlock = opts.learningsStore.formatForPrompt(opts.project) ?? '';
  } catch (err) {
    console.warn(`[test-review-runner] learningsStore.formatForPrompt failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sharedContext = buildSharedContext(opts.project, opts.spec, opts.cases, learningsBlock);

  // Run all personas in parallel; per-persona rejections are caught inside
  // runSinglePersona so we use Promise.all safely here.
  const settled = await Promise.all(
    personas.map((persona) =>
      runSinglePersona(persona, opts, sharedContext, model).catch((err) => {
        // Defence-in-depth: anything that slipped past runSinglePersona's
        // internal handlers lands here. Never let it break the whole review.
        const msg = `Persona "${persona}" unexpected failure: ${err instanceof Error ? err.message : String(err)}`;
        opts.onError?.(persona, msg);
        return { persona, findings: [] as TestFinding[], cost: 0 };
      }),
    ),
  );

  // Build per-persona maps with default zero values for personas that ran.
  const costByPersona = {} as Record<TestPersona, number>;
  const perPersonaFindings = {} as Record<TestPersona, TestFinding[]>;
  for (const p of personas) {
    costByPersona[p] = 0;
    perPersonaFindings[p] = [];
  }

  const aggregate: TestFinding[] = [];
  for (const r of settled) {
    costByPersona[r.persona] = r.cost;
    perPersonaFindings[r.persona] = r.findings;
    aggregate.push(...r.findings);
  }

  // Append once at the end — the store handles dedup.
  if (aggregate.length) {
    try {
      opts.runStore.appendFindings(opts.project, opts.spec.slug, opts.runId, aggregate);
    } catch (err) {
      console.warn(
        `[test-review-runner] appendFindings failed for run ${opts.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    findings: aggregate,
    costByPersona,
    perPersonaFindings,
  };
}
