/**
 * test-author-runner — LLM-driven Test Author stage.
 *
 * Phase 1 (`test-code-emitter`) produces a deterministic scaffold for every
 * Behavior. This module replaces each scaffold with a real, runnable test by
 * spawning the `test-author` persona agent once per TestCase. Each agent
 * returns ONE fenced code block; we parse it, persist via `TestCaseStore`,
 * and leave the scaffold in place on parse failure.
 *
 * Concurrency is capped via a simple chunked-Promise.all semaphore. Agents
 * run with Write/Edit/NotebookEdit disallowed — they must embed the final
 * code in the output, we do the persistence. Prompt shape mirrors the
 * persona contract in `packages/cli/src/personas/prompts/test-author.md`.
 */

import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import type {
  Behavior,
  ConventionFingerprint,
  TestCase,
  TestSpec,
} from './test-types.js';
import type { AgentManager } from '@anvil/agent-core';
import type { TestCaseStore } from './test-case-store.js';
import type { TestLearningsStore } from './test-learnings.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface AuthorRunnerOptions {
  agentManager: AgentManager;
  caseStore: TestCaseStore;
  learningsStore: TestLearningsStore;
  project: string;
  spec: TestSpec;
  cases: TestCase[];
  repoLocalPaths: Record<string, string>;
  cwd: string;
  /** Default `claude-sonnet-4-6`. */
  model?: string;
  /** Concurrency cap on parallel test-author agents. Default 4. */
  concurrency?: number;
  /**
   * When true (default), only cases whose `code` still contains a scaffold
   * marker (`TODO` or `anvil-generated`) are polished; cases whose code has
   * already been hand-edited are left alone and surfaced in `skipped`.
   */
  onlyScaffolds?: boolean;
  onCaseStart?: (caseId: string, agentId: string) => void;
  onCaseDone?: (caseId: string, updated: TestCase, cost: number) => void;
  onError?: (caseId: string, message: string) => void;
}

export interface AuthorRunnerResult {
  polished: TestCase[];
  /** Cases bypassed: already-edited scaffolds, or behaviors we couldn't match. */
  skipped: TestCase[];
  failed: Array<{ caseId: string; reason: string }>;
  totalCost: number;
}

// ── Persona prompt loader ────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const personaPromptCache = new Map<string, string>();

/**
 * Load a persona prompt markdown file. Mirrors pipeline-runner's
 * `loadPersonaPromptSync` — first user overrides, then the bundled paths
 * under `packages/cli/src/personas/prompts/` or `cli/dist/personas/prompts/`.
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

// ── Helpers ──────────────────────────────────────────────────────────────

const SCAFFOLD_MARKERS = ['TODO', 'anvil-generated'];

function isScaffold(code: string): boolean {
  if (!code) return true;
  return SCAFFOLD_MARKERS.some((m) => code.includes(m));
}

function inferLang(filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case '.ts':
      return 'ts';
    case '.tsx':
      return 'tsx';
    case '.js':
    case '.mjs':
    case '.cjs':
      return 'js';
    case '.jsx':
      return 'jsx';
    case '.py':
      return 'python';
    case '.go':
      return 'go';
    case '.rs':
      return 'rust';
    case '.java':
      return 'java';
    case '.rb':
      return 'ruby';
    default:
      return '';
  }
}

/**
 * Locate `relPath` against the repo workspace roots. We try each provided
 * `repoLocalPaths` entry, the `cwd`, and finally the raw path itself. Returns
 * the resolved absolute path when the file exists, or `null` when no
 * candidate matches — callers must treat that as "no grounded snippet".
 */
function resolveGroundedFile(
  relPath: string,
  repoLocalPaths: Record<string, string>,
  cwd: string,
): string | null {
  if (!relPath) return null;
  if (isAbsolute(relPath) && existsSync(relPath)) return relPath;

  const roots = [
    cwd,
    ...Object.values(repoLocalPaths).filter((v): v is string => Boolean(v)),
  ];
  for (const root of roots) {
    const candidate = resolve(root, relPath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function readGroundedSnippet(
  behavior: Behavior,
  repoLocalPaths: Record<string, string>,
  cwd: string,
  maxLines = 120,
): { snippet: string; lang: string; path: string | null } {
  const firstFile = behavior.ground.files[0] ?? behavior.target.file ?? '';
  const lang = inferLang(firstFile);
  const resolved = resolveGroundedFile(firstFile, repoLocalPaths, cwd);
  if (!resolved) {
    return { snippet: '(target file not found on disk)', lang, path: null };
  }
  try {
    const raw = readFileSync(resolved, 'utf-8');
    const lines = raw.split(/\r?\n/);
    const truncated = lines.slice(0, maxLines).join('\n');
    const suffix = lines.length > maxLines ? `\n// … (${lines.length - maxLines} more lines truncated)` : '';
    return { snippet: truncated + suffix, lang, path: resolved };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { snippet: `(failed to read ${firstFile}: ${msg})`, lang, path: resolved };
  }
}

function formatConventionFingerprint(conv: ConventionFingerprint): string {
  const imports = JSON.stringify(conv.imports ?? {});
  return [
    `Runner: ${conv.runner}`,
    `Assertion style: ${conv.assertionStyle}`,
    `File layout: ${conv.fileLayout}`,
    `Mock style: ${conv.mockStyle ?? 'none'}`,
    `Common imports: ${imports}`,
  ].join('\n');
}

function formatBehavior(behavior: Behavior): string {
  const preconditions = behavior.preconditions.length
    ? behavior.preconditions.join('; ')
    : '(none)';
  const groundFiles = behavior.ground.files.length
    ? behavior.ground.files.join(', ')
    : '(none)';
  const typesSeen = behavior.ground.typesSeen.length
    ? behavior.ground.typesSeen.join(', ')
    : '(none)';
  return [
    `Kind: ${behavior.kind}  Priority: ${behavior.priority}`,
    `Intent: ${behavior.intent}`,
    `Target: ${behavior.target.file}:${behavior.target.symbol}`,
    `Preconditions: ${preconditions}`,
    `Inputs: ${behavior.inputs.description}`,
    `Expected: ${behavior.expected.description}`,
    `Assertion: ${behavior.expected.assertion}`,
    `Grounded files: ${groundFiles}`,
    `Types observed: ${typesSeen}`,
  ].join('\n');
}

function buildPrompt(
  project: string,
  spec: TestSpec,
  behavior: Behavior,
  tc: TestCase,
  repoLocalPaths: Record<string, string>,
  cwd: string,
  learningsBlock: string,
): string {
  const caseLang = inferLang(tc.filePath) || 'ts';
  const grounded = readGroundedSnippet(behavior, repoLocalPaths, cwd, 120);
  const groundedBlock =
    '```' + (grounded.lang || '') + '\n' + grounded.snippet + '\n```';
  const scaffoldBlock =
    '```' + caseLang + '\n' + tc.code + '\n```';

  const learningsSection = learningsBlock.trim().length
    ? learningsBlock
    : '(no calibration signal yet)';

  return [
    `# Project`,
    project,
    ``,
    `# TestSpec`,
    `Slug: ${spec.slug}  Version: ${spec.version}`,
    `Title: ${spec.title}`,
    ``,
    `# Convention fingerprint`,
    formatConventionFingerprint(spec.conventions),
    ``,
    `# Behavior`,
    formatBehavior(behavior),
    ``,
    `# Target file (first 120 lines)`,
    groundedBlock,
    ``,
    `# Current scaffold (regenerate this)`,
    `Target test path: ${tc.filePath}`,
    scaffoldBlock,
    ``,
    `# Learnings calibration`,
    learningsSection,
    ``,
    `# Your job`,
    `Return ONE fenced code block containing the full replacement test file.`,
    `Put the file path as a comment on the first line of the block (use the`,
    `appropriate comment syntax for the language). Do not explain. Do not`,
    `write files. Use real imports from the target file. Match the convention`,
    `fingerprint exactly. Ground every assertion in the behavior.`,
  ].join('\n');
}

// ── Output parsing ───────────────────────────────────────────────────────

/**
 * Extract the largest fenced code block from the agent's output. We try,
 * in order:
 *   1. A full ```lang\n...\n``` block (greedy, captures inner block).
 *   2. An unlabelled ```\n...\n``` block.
 *   3. As a last resort, the entire output if it *looks* like code (no
 *      prose markers).
 * Returns `null` when nothing plausible can be extracted.
 */
export function extractCodeBlock(output: string): string | null {
  if (!output) return null;

  // Primary: fenced block with a language tag. Use a non-greedy match and
  // prefer the longest match overall to avoid grabbing a tiny inline block.
  const fenceRe = /```([a-zA-Z0-9_+\-]*)\s*\n([\s\S]*?)\n?```/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(output)) !== null) {
    if (m[2] && m[2].trim().length > 0) matches.push(m[2]);
  }
  if (matches.length > 0) {
    // Pick the largest block — scaffolds should be the single substantive
    // block in the output, but agents sometimes emit a short "summary" block
    // alongside it.
    matches.sort((a, b) => b.length - a.length);
    return matches[0];
  }

  // Fallback: a single trailing fenced block without a closing ```.
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

// ── Concurrency helper ───────────────────────────────────────────────────

/** Run async tasks with a max in-flight count. Preserves input order. */
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const capped = Math.max(1, Math.floor(limit));
  let cursor = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      results[idx] = await fn(items[idx], idx);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(capped, items.length); i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

// ── Agent completion helper ──────────────────────────────────────────────

function waitForAgent(
  agentManager: AgentManager,
  agentId: string,
): Promise<{ output: string; cost: number; error?: string }> {
  return new Promise((resolve) => {
    const poll = () => {
      const current = agentManager.getAgent(agentId);
      if (!current) {
        resolve({ output: '', cost: 0, error: 'Agent disappeared' });
        return;
      }
      if (current.status === 'done') {
        resolve({ output: current.output, cost: current.cost.totalUsd });
      } else if (current.status === 'error' || current.status === 'killed') {
        resolve({
          output: current.output,
          cost: current.cost.totalUsd,
          error: current.error ?? `Agent ${current.status}`,
        });
      } else {
        setTimeout(poll, 500);
      }
    };
    poll();
  });
}

// ── Runner ───────────────────────────────────────────────────────────────

export async function runTestAuthor(
  opts: AuthorRunnerOptions,
): Promise<AuthorRunnerResult> {
  const {
    agentManager,
    caseStore,
    learningsStore,
    project,
    spec,
    cases,
    repoLocalPaths,
    cwd,
    model = 'claude-sonnet-4-6',
    concurrency = 4,
    onlyScaffolds = true,
    onCaseStart,
    onCaseDone,
    onError,
  } = opts;

  const behaviorById = new Map<string, Behavior>();
  for (const b of spec.behaviors) behaviorById.set(b.id, b);

  const learningsBlock = learningsStore.formatForPrompt(project);
  const systemPrompt = loadPersonaPromptSync('test-author');

  const polished: TestCase[] = [];
  const skipped: TestCase[] = [];
  const failed: Array<{ caseId: string; reason: string }> = [];
  let totalCost = 0;

  // First pass: partition scaffolds vs. already-edited vs. unmatched.
  type WorkItem = { tc: TestCase; behavior: Behavior };
  const workItems: WorkItem[] = [];
  for (const tc of cases) {
    const behavior = behaviorById.get(tc.behaviorId);
    if (!behavior) {
      skipped.push(tc);
      continue;
    }
    if (onlyScaffolds && !isScaffold(tc.code)) {
      skipped.push(tc);
      continue;
    }
    workItems.push({ tc, behavior });
  }

  if (workItems.length === 0) {
    return { polished, skipped, failed, totalCost };
  }

  await runWithConcurrency(workItems, concurrency, async ({ tc, behavior }) => {
    const prompt = buildPrompt(
      project,
      spec,
      behavior,
      tc,
      repoLocalPaths,
      cwd,
      learningsBlock,
    );

    // Spawn — Write/Edit/NotebookEdit disallowed so the agent must embed
    // the replacement code in its output, which we persist via caseStore.
    const agent = agentManager.spawn({
      name: `test-author-${tc.id}`,
      persona: 'test-author',
      project,
      stage: `test-author:${tc.id}`,
      prompt,
      model,
      cwd,
      projectPrompt: systemPrompt || undefined,
      permissionMode: 'bypassPermissions',
      disallowedTools: ['Write', 'Edit', 'NotebookEdit'],
    });

    try {
      onCaseStart?.(tc.id, agent.id);
    } catch { /* ignore listener errors */ }

    const result = await waitForAgent(agentManager, agent.id);
    totalCost += result.cost;

    if (result.error) {
      const reason = `agent error: ${result.error}`;
      failed.push({ caseId: tc.id, reason });
      try { onError?.(tc.id, reason); } catch { /* noop */ }
      return;
    }

    const code = extractCodeBlock(result.output);
    if (!code) {
      const reason = 'could not parse fenced code block from agent output';
      failed.push({ caseId: tc.id, reason });
      try { onError?.(tc.id, reason); } catch { /* noop */ }
      return;
    }

    const updated = caseStore.updateCase(
      project,
      spec.slug,
      spec.version,
      tc.id,
      { code },
    );

    if (!updated) {
      const reason = 'caseStore.updateCase returned null (case not found)';
      failed.push({ caseId: tc.id, reason });
      try { onError?.(tc.id, reason); } catch { /* noop */ }
      return;
    }

    polished.push(updated);
    try { onCaseDone?.(tc.id, updated, result.cost); } catch { /* noop */ }
  });

  return { polished, skipped, failed, totalCost };
}
