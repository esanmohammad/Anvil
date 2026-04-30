/**
 * replay-pipeline — orchestrates the bug-to-test replay flow.
 *
 * Given an ingested IncidentRecord + the repos it touched, this module runs
 * the full pipeline end-to-end:
 *
 *   normalize       — load the incident record
 *   locate-fix      — find the merge commit + its parent via gh / git log
 *   ground          — build a provisional Behavior and ground it on disk
 *   author          — spawn the `incident-replayer` persona to author a
 *                     regression TestCase (deterministic fallback on parse
 *                     failure), then persist via TestSpecStore / TestCaseStore
 *   verify-pre-fix  — checkout the parent commit in a worktree, run the test,
 *                     expect FAIL
 *   verify-post-fix — checkout the fix commit in the same worktree, run, expect
 *                     PASS (retries on failure via re-spawning the authorer)
 *   bind            — stamp the canonical repo file with a header + register
 *                     it in the bound-tests.json inline fallback
 *   record          — compute confidence/status, persist the ReplayAttempt,
 *                     record a bugsCaught entry in TestLearningsStore
 *
 * Every step is wrapped in try/catch so a single step failure degrades
 * confidence and appends a note — we never abort the replay once started.
 * Callers get progress via the `onStep` callback; broadcasting is left to the
 * caller.
 */

import { execSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import type { AgentManager } from '@anvil/agent-core';
import type { IncidentStore } from './incident-store.js';
import type { ReplayStore } from './replay-store.js';
import type { TestCaseStore } from './test-case-store.js';
import type { TestLearningsStore } from './test-learnings.js';
import type { TestSpecStore } from './test-spec-store.js';
import type {
  IncidentRecord,
  IncidentSeverity,
  ReplayAttempt,
  ReplayConfidence,
  ReplayStatus,
  ReplayStepResult,
} from './incident-types.js';
import type {
  Behavior,
  ConventionFingerprint,
  TestCase,
  TestSeverity,
  TestSpec,
} from './test-types.js';

import { fingerprintConventions } from './convention-fingerprinter.js';
import { emitTestCase } from './test-code-emitter.js';
import { executeTestRun } from './test-executor.js';
import { groundBehaviors } from './test-grounder.js';

// ── Public API ───────────────────────────────────────────────────────────

export type ReplayStep =
  | 'normalize'
  | 'locate-fix'
  | 'ground'
  | 'author'
  | 'verify-pre-fix'
  | 'verify-post-fix'
  | 'bind'
  | 'record';

export interface ReplayOptions {
  incidentStore: IncidentStore;
  replayStore: ReplayStore;
  specStore: TestSpecStore;
  caseStore: TestCaseStore;
  learningsStore: TestLearningsStore;
  agentManager: AgentManager;
  project: string;
  incidentId: string;
  specSlug?: string;
  /** Default `claude-sonnet-4-6`. */
  model?: string;
  repoLocalPaths: Record<string, string>;
  skipVerification?: boolean;
  /** How many times to re-spawn the authorer on post-fix FAIL. Default 2. */
  postFixRetries?: number;
  onStep?: (
    step: ReplayStep,
    state: { status: 'start' | 'done' | 'skipped' | 'failed'; detail?: string },
  ) => void;
}

export interface ReplayResult {
  attempt: ReplayAttempt;
  behavior: Behavior;
  testCase: TestCase;
  boundFilePath?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const personaPromptCache = new Map<string, string>();

/**
 * Load a persona prompt markdown file. Mirrors pipeline-runner's loader —
 * user overrides under `~/.anvil/personas/` first, then the bundled paths.
 * Returns '' when not found so callers can pass it through as `projectPrompt`
 * without failing.
 */
function loadPersonaPromptSync(personaName: string): string {
  const cached = personaPromptCache.get(personaName);
  if (cached !== undefined) return cached;

  const anvilHome =
    process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const userPath = join(anvilHome, 'personas', `${personaName}.md`);
  if (existsSync(userPath)) {
    const content = readFileSync(userPath, 'utf-8');
    personaPromptCache.set(personaName, content);
    return content;
  }

  const candidates = [
    join(__dirname, '..', '..', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', '..', '..', 'packages', 'cli', 'src', 'personas', 'prompts', `${personaName}.md`),
    join(__dirname, '..', '..', '..', 'src', 'personas', 'prompts', `${personaName}.md`),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      const content = readFileSync(p, 'utf-8');
      personaPromptCache.set(personaName, content);
      return content;
    }
  }

  personaPromptCache.set(personaName, '');
  return '';
}

/**
 * Thin execSync wrapper used for git / gh. 30s timeout, stdout trimmed,
 * stderr suppressed. Throws on non-zero exit — callers wrap with try/catch.
 */
function runGit(cwd: string, args: string[]): string {
  const out = execSync(`git ${args.map((a) => shellQuote(a)).join(' ')}`, {
    cwd,
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
  });
  return out.toString().trim();
}

function runGhPr(prNumber: string, ownerRepo: string): string {
  const out = execSync(
    `gh pr view ${shellQuote(prNumber)} --repo ${shellQuote(ownerRepo)} --json mergeCommit -q .mergeCommit.oid`,
    {
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    },
  );
  return out.toString().trim();
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_\-./=:@]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SECRET_KEY_RE = /authorization|cookie|token|secret|password|api[-_]?key/i;

/**
 * Walk an unknown payload recursively; any value whose key matches the
 * secret pattern is replaced with `[REDACTED]`. Arrays / nested objects are
 * descended into. Non-plain values (Date, Map, etc.) are returned as-is.
 */
export function redactSecrets(payload: unknown): unknown {
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) return payload.map((item) => redactSecrets(item));
  if (typeof payload === 'object') {
    const input = payload as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
      if (SECRET_KEY_RE.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactSecrets(value);
      }
    }
    return out;
  }
  return payload;
}

/** Best-effort worktree removal. Never throws. */
function cleanupWorktree(tmpDir: string, repoPath: string): void {
  try {
    execSync(`git worktree remove -f ${shellQuote(tmpDir)}`, {
      cwd: repoPath,
      timeout: 30_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    /* worktree may already be gone; swallow */
  }
}

/** Parse `https://github.com/owner/repo/pull/123` into its parts. */
function parsePrUrl(url: string): { owner: string; repo: string; number: string } | null {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    // ['owner', 'repo', 'pull', '123']
    if (parts.length < 4) return null;
    if (parts[2] !== 'pull' && parts[2] !== 'pulls') return null;
    const number = parts[3];
    if (!/^\d+$/.test(number)) return null;
    return { owner: parts[0], repo: parts[1], number };
  } catch {
    return null;
  }
}

/** ISO timestamp arithmetic — add hours, never throws. */
function addHoursIso(iso: string, hours: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  d.setUTCHours(d.getUTCHours() + hours);
  return d.toISOString();
}

/**
 * Wait for an agent to finish by polling getAgent every 500ms — mirrors
 * test-author-runner. Returns output + cost + optional error.
 */
function waitForAgent(
  agentManager: AgentManager,
  agentId: string,
): Promise<{ output: string; cost: number; error?: string }> {
  return new Promise((resolvePromise) => {
    const poll = (): void => {
      const current = agentManager.getAgent(agentId);
      if (!current) {
        resolvePromise({ output: '', cost: 0, error: 'Agent disappeared' });
        return;
      }
      if (current.status === 'done') {
        resolvePromise({ output: current.output, cost: current.cost.totalUsd });
        return;
      }
      if (current.status === 'error' || current.status === 'killed') {
        resolvePromise({
          output: current.output,
          cost: current.cost.totalUsd,
          error: current.error ?? `Agent ${current.status}`,
        });
        return;
      }
      setTimeout(poll, 500);
    };
    poll();
  });
}

/** Extract the largest fenced code block from agent output. */
function extractCodeBlock(output: string): string | null {
  if (!output) return null;
  const fenceRe = /```([a-zA-Z0-9_+\-]*)\s*\n([\s\S]*?)\n?```/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(output)) !== null) {
    if (m[2] && m[2].trim().length > 0) matches.push(m[2]);
  }
  if (matches.length > 0) {
    matches.sort((a, b) => b.length - a.length);
    return matches[0];
  }
  const openFence = output.indexOf('```');
  if (openFence !== -1) {
    const after = output.slice(openFence + 3);
    const nl = after.indexOf('\n');
    if (nl !== -1) {
      const tail = after.slice(nl + 1).trimEnd();
      if (tail.length > 0 && !tail.startsWith('```')) {
        return tail.replace(/```$/, '').trimEnd();
      }
    }
  }
  return null;
}

/** Guess a single-line comment prefix for the test file's language. */
function commentPrefixFor(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.py' || ext === '.rb') return '#';
  if (ext === '.go' || ext === '.ts' || ext === '.tsx' || ext === '.js'
      || ext === '.jsx' || ext === '.mjs' || ext === '.cjs' || ext === '.java'
      || ext === '.kt' || ext === '.rs' || ext === '.php') return '//';
  return '//';
}

function atomicWriteFileSync(filePath: string, data: string): void {
  const tmp = filePath + '.tmp';
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

/**
 * Map an IncidentSeverity into a TestSeverity for learnings.recordBugCaught.
 * p1 → blocker, p2 → error, p3 → warn, p4 → info, unknown → warn.
 */
function severityForLearnings(sev: IncidentSeverity): TestSeverity {
  switch (sev) {
    case 'p1': return 'blocker';
    case 'p2': return 'error';
    case 'p3': return 'warn';
    case 'p4': return 'info';
    default: return 'warn';
  }
}

function emitStep(
  onStep: ReplayOptions['onStep'],
  step: ReplayStep,
  status: 'start' | 'done' | 'skipped' | 'failed',
  detail?: string,
): void {
  if (!onStep) return;
  try {
    onStep(step, detail !== undefined ? { status, detail } : { status });
  } catch {
    /* listener errors never disrupt the pipeline */
  }
}

// ── Pipeline stages ──────────────────────────────────────────────────────

interface LocateFixResult {
  fixCommit?: string;
  parentCommit?: string;
  repoPath?: string;
  note?: string;
}

/**
 * Locate the fix + parent commit. Strategy (first hit wins):
 *   1. PR URL → `gh pr view --json mergeCommit`
 *   2. For each repo: `git log --grep="${incidentId}" --grep="${externalId}" --all`
 *   3. For each repo: `git log --since --until --format` on failingSymbol.file
 */
function locateFix(
  incident: IncidentRecord,
  repoLocalPaths: Record<string, string>,
): LocateFixResult {
  const entries = Object.entries(repoLocalPaths);

  // 1. PR URL.
  if (incident.linkedPrUrl) {
    const parsed = parsePrUrl(incident.linkedPrUrl);
    if (parsed) {
      try {
        const commit = runGhPr(parsed.number, `${parsed.owner}/${parsed.repo}`);
        if (commit) {
          // Try each repo to find the one that owns this commit; parent is HEAD^.
          for (const [, repoPath] of entries) {
            try {
              const parent = runGit(repoPath, ['rev-parse', `${commit}^`]);
              if (parent) {
                return { fixCommit: commit, parentCommit: parent, repoPath };
              }
            } catch {
              /* try the next repo */
            }
          }
          // We know the commit but can't pin it to a repo — still return it.
          return { fixCommit: commit };
        }
      } catch (err) {
        // gh unavailable / PR not mergeable — fall through to git log.
        const msg = err instanceof Error ? err.message : String(err);
        // eslint-disable-next-line no-console
        console.warn(`[replay-pipeline] gh pr view failed: ${msg}`);
      }
    }
  }

  // 2. Grep commit messages.
  for (const [, repoPath] of entries) {
    try {
      const args = [
        'log', '--all', '-n', '3', '--format=%H',
        '--grep', incident.id,
      ];
      if (incident.externalId) {
        args.push('--grep', incident.externalId);
      }
      const out = runGit(repoPath, args);
      const commit = out.split(/\r?\n/).find((line) => /^[0-9a-f]{7,40}$/.test(line));
      if (commit) {
        const parent = (() => {
          try { return runGit(repoPath, ['rev-parse', `${commit}^`]); } catch { return undefined; }
        })();
        const result: LocateFixResult = { fixCommit: commit, repoPath };
        if (parent) result.parentCommit = parent;
        return result;
      }
    } catch {
      /* try the next repo */
    }
  }

  // 3. Window by occurredAt + failingSymbol.file.
  if (incident.failingSymbol?.file) {
    const since = incident.occurredAt;
    const until = addHoursIso(incident.occurredAt, 48);
    for (const [, repoPath] of entries) {
      try {
        const args = [
          'log',
          `--since=${since}`,
          `--until=${until}`,
          '--format=%H',
          '--',
          incident.failingSymbol.file,
        ];
        const out = runGit(repoPath, args);
        const commit = out.split(/\r?\n/).find((line) => /^[0-9a-f]{7,40}$/.test(line));
        if (commit) {
          const parent = (() => {
            try { return runGit(repoPath, ['rev-parse', `${commit}^`]); } catch { return undefined; }
          })();
          const result: LocateFixResult = { fixCommit: commit, repoPath };
          if (parent) result.parentCommit = parent;
          return result;
        }
      } catch {
        /* try the next repo */
      }
    }
  }

  return { note: 'fix commit not located' };
}

/**
 * Build a provisional regression Behavior from the incident, then ground it
 * against the provided repos. Mutates behavior.ground in place via groundBehaviors.
 */
async function buildAndGround(
  incident: IncidentRecord,
  repoLocalPaths: Record<string, string>,
): Promise<Behavior> {
  const behavior: Behavior = {
    id: `beh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'regression',
    intent: `Guards against ${incident.title}`,
    target: {
      file: incident.failingSymbol?.file ?? '',
      symbol: incident.failingSymbol?.function ?? '',
    },
    preconditions: [],
    inputs: {
      description: incident.requestPayload !== undefined
        ? 'Replay of the original request payload that triggered the incident.'
        : `Repro inputs inferred from: ${incident.summary.slice(0, 200)}`,
    },
    expected: {
      description: `The regression seen in "${incident.title}" must not occur.`,
      assertion: incident.stackTrace
        ? 'No exception thrown and the response matches the post-fix contract.'
        : 'Behavior matches the post-fix contract described in the incident.',
    },
    priority: 'critical',
    ground: { files: [], typesSeen: [], confidence: 0 },
    linkedIncidentId: incident.id,
  };

  try {
    await groundBehaviors([behavior], repoLocalPaths);
  } catch {
    // Grounding is best-effort; leave ground at confidence 0.
  }

  return behavior;
}

/**
 * Build the authoring prompt for the `incident-replayer` persona. We include:
 *   - the incident title / severity / summary / stack
 *   - a REDACTED request payload when available
 *   - the grounded behavior
 *   - the project's convention fingerprint
 *   - the deterministic scaffold (so the agent has a starting point)
 */
function buildAuthorPrompt(
  project: string,
  incident: IncidentRecord,
  behavior: Behavior,
  scaffold: TestCase,
  conventions: ConventionFingerprint,
  extraContext?: string,
): string {
  const redactedPayload = incident.requestPayload !== undefined
    ? JSON.stringify(redactSecrets(incident.requestPayload), null, 2)
    : '(none)';

  const stackBlock = incident.stackTrace
    ? '```\n' + incident.stackTrace.slice(0, 4_000) + '\n```'
    : '(no stack trace captured)';

  const scaffoldLang = extname(scaffold.filePath).replace('.', '') || 'ts';
  const scaffoldBlock = '```' + scaffoldLang + '\n' + scaffold.code + '\n```';

  const extra = extraContext && extraContext.trim().length
    ? `\n\n# Extra context from previous failed attempt\n${extraContext}\n`
    : '';

  return [
    `# Project`,
    project,
    ``,
    `# Incident`,
    `- id: ${incident.id}`,
    `- source: ${incident.source}`,
    `- severity: ${incident.severity}`,
    `- url: ${incident.url}`,
    `- title: ${incident.title}`,
    `- occurredAt: ${incident.occurredAt}`,
    ``,
    `## Summary`,
    incident.summary,
    ``,
    `## Stack trace`,
    stackBlock,
    ``,
    `## Redacted request payload`,
    '```json',
    redactedPayload,
    '```',
    ``,
    `# Behavior to cover`,
    `- Kind: ${behavior.kind} / ${behavior.priority}`,
    `- Intent: ${behavior.intent}`,
    `- Target: ${behavior.target.file}:${behavior.target.symbol}`,
    `- Grounded files: ${behavior.ground.files.join(', ') || '(none)'}`,
    `- Expected: ${behavior.expected.description}`,
    ``,
    `# Convention fingerprint`,
    `- Runner: ${conventions.runner}`,
    `- Assertion style: ${conventions.assertionStyle}`,
    `- File layout: ${conventions.fileLayout}`,
    `- Mock style: ${conventions.mockStyle ?? 'none'}`,
    `- Common imports: ${JSON.stringify(conventions.imports ?? {})}`,
    ``,
    `# Deterministic scaffold (regenerate this)`,
    `Target test path: ${scaffold.filePath}`,
    scaffoldBlock,
    extra,
    ``,
    `# Your job`,
    `Return ONE fenced code block containing the full regression test file.`,
    `Reproduce the incident's failure mode; the test MUST fail against the`,
    `parent commit and pass against the fix. Use real imports from the target,`,
    `match the convention fingerprint, and keep the assertion tied to the`,
    `grounded behavior. Do not write files. Do not explain.`,
  ].join('\n');
}

/**
 * Spawn the authorer, parse the fenced block, fall back to the scaffold on
 * parse failure. Returns `{ code, usedFallback }`.
 */
async function spawnAuthorer(
  agentManager: AgentManager,
  project: string,
  incident: IncidentRecord,
  behavior: Behavior,
  scaffold: TestCase,
  conventions: ConventionFingerprint,
  model: string,
  cwd: string,
  systemPrompt: string,
  extraContext?: string,
): Promise<{ code: string; usedFallback: boolean; cost: number; error?: string }> {
  const prompt = buildAuthorPrompt(project, incident, behavior, scaffold, conventions, extraContext);

  const agent = agentManager.spawn({
    name: `incident-replayer-${incident.id}`,
    persona: 'incident-replayer',
    project,
    stage: `replay-author:${incident.id}`,
    prompt,
    model,
    cwd,
    projectPrompt: systemPrompt || undefined,
    permissionMode: 'bypassPermissions',
    disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
  });

  const result = await waitForAgent(agentManager, agent.id);

  if (result.error) {
    return { code: scaffold.code, usedFallback: true, cost: result.cost, error: result.error };
  }

  const code = extractCodeBlock(result.output);
  if (!code) {
    return { code: scaffold.code, usedFallback: true, cost: result.cost };
  }

  return { code, usedFallback: false, cost: result.cost };
}

// ── Worktree helpers ─────────────────────────────────────────────────────

interface WorktreeHandle {
  tmpDir: string;
  repoPath: string;
  createdAt: number;
}

/** Create a worktree at `<repo>` pinned to `commit`. Throws on failure. */
function createWorktree(repoPath: string, commit: string, attemptId: string): WorktreeHandle {
  const tmpRoot = join('/tmp', `anvil-replay-${attemptId}`);
  // Each commit gets its own subdir so we can checkout a different commit
  // later without conflicting on the same path.
  const tmpDir = join(tmpRoot, commit.slice(0, 12));
  mkdirSync(tmpRoot, { recursive: true });
  // `git worktree add -f <tmp> <commit>` works from an existing git repo.
  execSync(
    `git worktree add -f ${shellQuote(tmpDir)} ${shellQuote(commit)}`,
    { cwd: repoPath, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return { tmpDir, repoPath, createdAt: Date.now() };
}

/**
 * Copy the authored test file from the main repo tree into the worktree at
 * its canonical relative path. Source content comes from the TestCase (not
 * disk) so the verification uses the freshly-authored code even before the
 * bind step writes to the repo.
 */
function placeTestFileInWorktree(handle: WorktreeHandle, relPath: string, code: string): string {
  const target = join(handle.tmpDir, relPath);
  atomicWriteFileSync(target, code);
  return target;
}

// ── bound-tests registry (inline fallback) ───────────────────────────────

interface BoundTestEntry {
  filePath: string;
  incidentId: string;
  replayId: string;
  addedAt: string;
}

/**
 * Append-or-register a bound-test entry. The canonical `bound-tests.ts`
 * module is a parallel work stream, so we persist to a JSON array at
 * `~/.anvil/incidents/<project>/bound-tests.json` with an atomic write.
 * Entries are deduplicated on filePath — re-binding the same file replaces
 * the prior entry (preserving the latest replayId).
 */
function appendBoundTestEntryInline(
  project: string,
  entry: BoundTestEntry,
  anvilHome?: string,
): string {
  const home = anvilHome ?? process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
  const dir = join(home, 'incidents', project);
  mkdirSync(dir, { recursive: true });
  const registryPath = join(dir, 'bound-tests.json');

  let existing: BoundTestEntry[] = [];
  if (existsSync(registryPath)) {
    try {
      const raw = readFileSync(registryPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) existing = parsed as BoundTestEntry[];
    } catch {
      existing = [];
    }
  }

  const filtered = existing.filter((e) => e.filePath !== entry.filePath);
  filtered.push(entry);
  atomicWriteFileSync(registryPath, JSON.stringify(filtered, null, 2));
  return registryPath;
}

// ── Entry point ──────────────────────────────────────────────────────────

export async function runReplayPipeline(opts: ReplayOptions): Promise<ReplayResult> {
  const {
    incidentStore,
    replayStore,
    specStore,
    caseStore,
    learningsStore,
    agentManager,
    project,
    incidentId,
    specSlug,
    model = 'claude-sonnet-4-6',
    repoLocalPaths,
    postFixRetries = 2,
    onStep,
  } = opts;

  let skipVerification = opts.skipVerification === true;

  // ── normalize ──────────────────────────────────────────────────────────
  emitStep(onStep, 'normalize', 'start');
  const incident = incidentStore.read(project, incidentId);
  if (!incident) {
    emitStep(onStep, 'normalize', 'failed', `incident ${incidentId} not found`);
    throw new Error(`Incident not found: ${project}/${incidentId}`);
  }
  emitStep(onStep, 'normalize', 'done');

  // ── locate-fix ─────────────────────────────────────────────────────────
  emitStep(onStep, 'locate-fix', 'start');
  const notes: string[] = [];
  let fixCommit: string | undefined = incident.fixCommit;
  let parentCommit: string | undefined = incident.parentCommit;
  let preferredRepoPath: string | undefined;

  try {
    const located = locateFix(incident, repoLocalPaths);
    if (located.fixCommit && !fixCommit) fixCommit = located.fixCommit;
    if (located.parentCommit && !parentCommit) parentCommit = located.parentCommit;
    if (located.repoPath) preferredRepoPath = located.repoPath;
    if (located.note) {
      notes.push(located.note);
      skipVerification = true;
      emitStep(onStep, 'locate-fix', 'skipped', located.note);
    } else {
      emitStep(onStep, 'locate-fix', 'done',
        `fix=${fixCommit?.slice(0, 12) ?? 'unknown'} parent=${parentCommit?.slice(0, 12) ?? 'unknown'}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`locate-fix failed: ${msg}`);
    skipVerification = true;
    emitStep(onStep, 'locate-fix', 'failed', msg);
  }

  if (!fixCommit || !parentCommit) {
    // Degrade — can't verify without both endpoints.
    if (!skipVerification) {
      notes.push('missing fix or parent commit; skipping verification');
      skipVerification = true;
    }
  }

  // ── ground ─────────────────────────────────────────────────────────────
  emitStep(onStep, 'ground', 'start');
  let behavior: Behavior;
  try {
    behavior = await buildAndGround(incident, repoLocalPaths);
    emitStep(onStep, 'ground', 'done', `confidence=${behavior.ground.confidence}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`ground failed: ${msg}`);
    // Build a fallback behavior with zero confidence so the rest can run.
    behavior = {
      id: `beh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'regression',
      intent: `Guards against ${incident.title}`,
      target: {
        file: incident.failingSymbol?.file ?? '',
        symbol: incident.failingSymbol?.function ?? '',
      },
      preconditions: [],
      inputs: { description: 'Repro inputs from incident (grounding unavailable).' },
      expected: {
        description: `The regression seen in "${incident.title}" must not occur.`,
        assertion: 'Behavior matches the post-fix contract described in the incident.',
      },
      priority: 'critical',
      ground: { files: [], typesSeen: [], confidence: 0 },
      linkedIncidentId: incident.id,
    };
    emitStep(onStep, 'ground', 'failed', msg);
  }

  // ── author ─────────────────────────────────────────────────────────────
  emitStep(onStep, 'author', 'start');

  // Target repo: prefer the one locate-fix pinned; else the first repo that
  // grounded the behavior; else the first entry.
  const repoEntries = Object.entries(repoLocalPaths);
  let authorRepoPath: string = preferredRepoPath ?? '';
  if (!authorRepoPath) {
    if (behavior.ground.files.length > 0) {
      const first = behavior.ground.files[0];
      for (const [, p] of repoEntries) {
        if (first.startsWith(p)) { authorRepoPath = p; break; }
      }
    }
  }
  if (!authorRepoPath && repoEntries.length > 0) {
    authorRepoPath = repoEntries[0][1];
  }

  let conventions: ConventionFingerprint;
  try {
    conventions = await fingerprintConventions(authorRepoPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`fingerprint failed: ${msg}`);
    conventions = {
      runner: 'unknown',
      assertionStyle: 'unknown',
      fileLayout: 'unknown',
      namingPattern: '',
      imports: {},
      examples: [],
    };
  }

  // Deterministic scaffold (also used as fallback on authorer parse failure).
  let scaffoldCase: TestCase;
  try {
    scaffoldCase = emitTestCase(behavior, conventions, {
      specSlug: specSlug ?? 'incident-pending',
      specVersion: 1,
      projectSlug: project,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`scaffold emit failed: ${msg}`);
    // Build a minimal placeholder so the pipeline can keep going.
    scaffoldCase = {
      id: `tc-${Date.now().toString(36)}`,
      behaviorId: behavior.id,
      specSlug: specSlug ?? 'incident-pending',
      specVersion: 1,
      framework: conventions.runner,
      filePath: `regression-${incident.id}.test.ts`,
      code: `// Scaffold emit failed: ${msg}\n`,
      fixtures: [],
      mocks: [],
      runtime: 'node',
      estimatedMs: 50,
      createdAt: new Date().toISOString(),
    };
  }

  const systemPrompt = loadPersonaPromptSync('incident-replayer');

  let authoredCode = scaffoldCase.code;
  let authorFallback = false;
  try {
    const authorOutcome = await spawnAuthorer(
      agentManager,
      project,
      incident,
      behavior,
      scaffoldCase,
      conventions,
      model,
      authorRepoPath || process.cwd(),
      systemPrompt,
    );
    authoredCode = authorOutcome.code;
    authorFallback = authorOutcome.usedFallback;
    if (authorOutcome.error) {
      notes.push(`authorer error: ${authorOutcome.error}`);
    }
    if (authorFallback) {
      notes.push('authorer fell back to deterministic scaffold');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`author stage failed: ${msg}`);
    authorFallback = true;
  }

  // Persist spec + case.
  let spec: TestSpec;
  try {
    if (specSlug) {
      const existing = specStore.readCurrent(project, specSlug);
      if (!existing) throw new Error(`spec ${specSlug} not found`);
      spec = specStore.bumpVersion(project, specSlug, {
        behaviors: [...existing.behaviors, behavior],
        conventions,
      });
    } else {
      spec = specStore.createSpec(project, `Incident ${incident.id}`, model, {
        title: `Incident ${incident.id}`,
        behaviors: [behavior],
        conventions,
        source: {
          files: behavior.ground.files,
          ...(incident.linkedPrUrl ? { prUrl: incident.linkedPrUrl } : {}),
        },
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`spec persist failed: ${msg}`);
    emitStep(onStep, 'author', 'failed', msg);
    throw err;
  }

  // Rebuild the TestCase now that we know the real spec slug / version.
  const finalTestCase: TestCase = {
    ...scaffoldCase,
    specSlug: spec.slug,
    specVersion: spec.version,
    code: authoredCode,
  };

  try {
    const existingCases = caseStore.readCases(project, spec.slug, spec.version);
    caseStore.writeCases(project, spec.slug, spec.version, [...existingCases, finalTestCase]);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`case persist failed: ${msg}`);
  }

  emitStep(onStep, 'author', 'done',
    authorFallback ? 'used deterministic scaffold' : 'authored via incident-replayer');

  // Up-front ReplayStore.create so crashes after this point are resumable.
  let attempt = replayStore.create(
    project,
    incidentId,
    spec.slug,
    spec.version,
    behavior.id,
    finalTestCase.id,
  );
  attempt = replayStore.update(project, attempt.id, { notes: [...notes] }) ?? attempt;

  // ── verify-pre-fix ─────────────────────────────────────────────────────
  let preFixResult: ReplayStepResult | undefined;
  let postFixResult: ReplayStepResult | undefined;
  let worktreeHandle: WorktreeHandle | null = null;
  const verifyRepoPath = authorRepoPath;

  if (skipVerification) {
    emitStep(onStep, 'verify-pre-fix', 'skipped', 'skipVerification=true');
  } else if (!verifyRepoPath) {
    skipVerification = true;
    notes.push('no repo path available for verification');
    emitStep(onStep, 'verify-pre-fix', 'skipped', 'no repo path');
  } else if (!parentCommit || !fixCommit) {
    skipVerification = true;
    emitStep(onStep, 'verify-pre-fix', 'skipped', 'missing commits');
  } else {
    emitStep(onStep, 'verify-pre-fix', 'start');
    try {
      worktreeHandle = createWorktree(verifyRepoPath, parentCommit, attempt.id);
      placeTestFileInWorktree(worktreeHandle, finalTestCase.filePath, finalTestCase.code);
      const started = Date.now();
      const exec = await executeTestRun({
        project,
        repoLocalPath: worktreeHandle.tmpDir,
        runner: conventions.runner,
        cases: [finalTestCase],
        timeoutMs: 120_000,
        flakinessRerunCount: 0,
      });
      const passed = exec.verdict === 'pass';
      const firstFailure = exec.results.find((r) => !r.pass);
      preFixResult = {
        commit: parentCommit,
        pass: passed,
        durationMs: Date.now() - started,
        ...(firstFailure?.failure ? { failure: firstFailure.failure } : {}),
      };
      if (passed) {
        notes.push('pre-fix unexpectedly passed');
        emitStep(onStep, 'verify-pre-fix', 'done', 'PASS (unexpected)');
      } else {
        emitStep(onStep, 'verify-pre-fix', 'done', 'FAIL (expected)');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      notes.push(`verify-pre-fix failed: ${msg}`);
      preFixResult = {
        commit: parentCommit ?? 'unknown',
        pass: false,
        durationMs: 0,
        failure: msg,
      };
      emitStep(onStep, 'verify-pre-fix', 'failed', msg);
    }
    attempt = replayStore.update(project, attempt.id, {
      notes: [...notes],
      ...(preFixResult ? { preFixResult } : {}),
    }) ?? attempt;
  }

  // ── verify-post-fix ────────────────────────────────────────────────────
  try {
    if (skipVerification) {
      emitStep(onStep, 'verify-post-fix', 'skipped', 'skipVerification=true');
    } else if (!worktreeHandle || !fixCommit) {
      emitStep(onStep, 'verify-post-fix', 'skipped', 'no worktree or fix commit');
    } else {
      emitStep(onStep, 'verify-post-fix', 'start');
      let attemptIndex = 0;
      let currentCode = finalTestCase.code;
      let success = false;
      let lastFailure: string | undefined;
      let lastDuration = 0;

      while (attemptIndex <= postFixRetries) {
        try {
          // Checkout the fix commit in the same worktree so we reuse its build output.
          execSync(`git checkout ${shellQuote(fixCommit)}`, {
            cwd: worktreeHandle.tmpDir,
            timeout: 30_000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastFailure = `checkout failed: ${msg}`;
          break;
        }
        // Re-place the test file (checkout may have clobbered our write).
        placeTestFileInWorktree(worktreeHandle, finalTestCase.filePath, currentCode);

        const started = Date.now();
        let exec;
        try {
          exec = await executeTestRun({
            project,
            repoLocalPath: worktreeHandle.tmpDir,
            runner: conventions.runner,
            cases: [{ ...finalTestCase, code: currentCode }],
            timeoutMs: 120_000,
            flakinessRerunCount: 0,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          lastFailure = `executor threw: ${msg}`;
          lastDuration = Date.now() - started;
          break;
        }
        lastDuration = Date.now() - started;
        const passed = exec.verdict === 'pass';
        const firstFailure = exec.results.find((r) => !r.pass);
        lastFailure = firstFailure?.failure;

        if (passed) {
          success = true;
          // Replace authoredCode with what we actually ran so bind writes the same thing.
          break;
        }

        attemptIndex++;
        if (attemptIndex > postFixRetries) break;

        notes.push(`post-fix retry ${attemptIndex}/${postFixRetries}`);
        try {
          const retryOutcome = await spawnAuthorer(
            agentManager,
            project,
            incident,
            behavior,
            { ...finalTestCase, code: currentCode },
            conventions,
            model,
            authorRepoPath || process.cwd(),
            systemPrompt,
            `Post-fix run FAILED. Failure message:\n${lastFailure ?? '(none)'}`,
          );
          if (!retryOutcome.usedFallback) {
            currentCode = retryOutcome.code;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          notes.push(`author retry ${attemptIndex} failed: ${msg}`);
          break;
        }
      }

      postFixResult = {
        commit: fixCommit,
        pass: success,
        durationMs: lastDuration,
        ...(success ? {} : { failure: lastFailure ?? 'post-fix verification failed' }),
      };
      // Persist the final authored code we actually verified.
      finalTestCase.code = currentCode;

      if (success) {
        emitStep(onStep, 'verify-post-fix', 'done', 'PASS');
      } else {
        notes.push('post-fix verification did not pass after retries');
        emitStep(onStep, 'verify-post-fix', 'failed', lastFailure ?? 'retries exhausted');
      }
    }
  } finally {
    if (worktreeHandle) {
      cleanupWorktree(worktreeHandle.tmpDir, worktreeHandle.repoPath);
      worktreeHandle = null;
    }
  }

  attempt = replayStore.update(project, attempt.id, {
    notes: [...notes],
    ...(postFixResult ? { postFixResult } : {}),
  }) ?? attempt;

  // Re-write the case with the possibly-updated code from retries.
  try {
    caseStore.updateCase(project, spec.slug, spec.version, finalTestCase.id, {
      code: finalTestCase.code,
    });
  } catch { /* non-fatal */ }

  // ── bind ───────────────────────────────────────────────────────────────
  emitStep(onStep, 'bind', 'start');
  let boundFilePath: string | undefined;
  try {
    const prefix = commentPrefixFor(finalTestCase.filePath);
    const preFixPassStr = preFixResult ? (preFixResult.pass ? 'pass' : 'fail') : 'skipped';
    const postFixPassStr = postFixResult ? (postFixResult.pass ? 'pass' : 'fail') : 'skipped';
    const header = [
      `${prefix} anvil-regression — DO NOT DELETE without override`,
      `${prefix} incident: ${incident.url}`,
      `${prefix} replay-id: ${attempt.id}`,
      `${prefix} pre-fix: ${parentCommit ?? 'unknown'} (verified ${preFixPassStr})`,
      `${prefix} post-fix: ${fixCommit ?? 'unknown'} (verified ${postFixPassStr})`,
      '',
    ].join('\n');

    const stamped = header + finalTestCase.code;

    // Write to the canonical repo path (not the worktree).
    if (authorRepoPath) {
      const canonical = isAbsolute(finalTestCase.filePath)
        ? finalTestCase.filePath
        : resolve(authorRepoPath, finalTestCase.filePath);
      atomicWriteFileSync(canonical, stamped);
      boundFilePath = finalTestCase.filePath;

      // Inline bound-tests registry append.
      try {
        appendBoundTestEntryInline(project, {
          filePath: finalTestCase.filePath,
          incidentId: incident.id,
          replayId: attempt.id,
          addedAt: new Date().toISOString(),
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        notes.push(`bound-tests registry update failed: ${msg}`);
      }

      // Persist the stamped code back to the TestCase too — consumers
      // shouldn't see a divergence between repo and store.
      try {
        caseStore.updateCase(project, spec.slug, spec.version, finalTestCase.id, {
          code: stamped,
        });
        finalTestCase.code = stamped;
      } catch { /* non-fatal */ }

      emitStep(onStep, 'bind', 'done', finalTestCase.filePath);
    } else {
      notes.push('bind skipped: no repo path');
      emitStep(onStep, 'bind', 'skipped', 'no repo path');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    notes.push(`bind failed: ${msg}`);
    emitStep(onStep, 'bind', 'failed', msg);
  }

  // ── record ─────────────────────────────────────────────────────────────
  emitStep(onStep, 'record', 'start');

  const grounded = behavior.ground.confidence > 0;
  const preExpectedFail = preFixResult ? !preFixResult.pass : false;
  const postExpectedPass = postFixResult ? postFixResult.pass : false;
  const preUnexpectedPass = preFixResult ? preFixResult.pass : false;

  let confidence: ReplayConfidence;
  let status: ReplayStatus;

  if (preUnexpectedPass && postFixResult && !postFixResult.pass) {
    status = 'unreproducible';
    confidence = 'low';
  } else if (!skipVerification && grounded && preExpectedFail && postExpectedPass) {
    status = 'confirmed';
    confidence = 'high';
  } else if (skipVerification || (preExpectedFail && postFixResult && !postFixResult.pass)
             || (grounded && (preExpectedFail || postExpectedPass))) {
    status = skipVerification ? 'low-confidence' : 'low-confidence';
    confidence = 'med';
  } else {
    status = 'low-confidence';
    confidence = 'low';
  }

  const updatePayload: Partial<ReplayAttempt> = {
    status,
    confidence,
    notes: [...notes],
    completedAt: new Date().toISOString(),
    ...(preFixResult ? { preFixResult } : {}),
    ...(postFixResult ? { postFixResult } : {}),
    ...(boundFilePath ? { boundTestFile: boundFilePath } : {}),
  };

  attempt = replayStore.update(project, attempt.id, updatePayload) ?? attempt;

  try {
    learningsStore.recordBugCaught(
      project,
      behavior.id,
      incident.url,
      severityForLearnings(incident.severity),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Append as a note but don't fail the pipeline.
    try {
      attempt = replayStore.update(project, attempt.id, {
        notes: [...attempt.notes, `learnings.recordBugCaught failed: ${msg}`],
      }) ?? attempt;
    } catch { /* noop */ }
  }

  emitStep(onStep, 'record', 'done', `${status} / ${confidence}`);

  const out: ReplayResult = { attempt, behavior, testCase: finalTestCase };
  if (boundFilePath !== undefined) out.boundFilePath = boundFilePath;
  // Suppress unused-import warnings on `copyFileSync`; worktree test-file
  // placement goes through `placeTestFileInWorktree` (atomic write) but we
  // keep copyFileSync available for future consumers that need to hardlink
  // fixtures.
  void copyFileSync;
  return out;
}
