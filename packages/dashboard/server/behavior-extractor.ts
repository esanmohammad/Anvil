/**
 * behavior-extractor — derives Behaviors from a Plan or a unified diff.
 *
 * Pure, synchronous, side-effect-free. The output is a deterministic seed
 * for the downstream test-grounding + test-code-emitting stages.
 */

import type { Behavior, BehaviorKind, Priority } from './test-types.js';
import type { Plan, PlanRepoImpact } from './plan-store.js';

// ── ID generator (shared — stable ordering via index suffix) ─────────────

function makeId(index: number, base?: number): string {
  const ts = (base ?? Date.now()).toString(36);
  return `b-${ts}-${index}`;
}

// ── Heuristics ───────────────────────────────────────────────────────────

const HANDLER_RE = /(Handler|Controller|Route|Endpoint|Service|Middleware)/;

function inferKindForSymbol(
  symbol: string,
  plan: Plan,
): BehaviorKind {
  // contract > integration > unit
  const inContract = plan.contracts.some(
    (c) => c.name === symbol || c.producer === symbol || c.consumers.includes(symbol),
  );
  if (inContract) return 'contract';
  if (HANDLER_RE.test(symbol)) return 'integration';
  return 'unit';
}

function inferPriorityForSymbol(
  symbol: string,
  plan: Plan,
): Priority {
  const inContract = plan.contracts.some(
    (c) => c.name === symbol || c.producer === symbol || c.consumers.includes(symbol),
  );
  if (inContract) return 'critical';
  return 'normal';
}

/**
 * Best-effort pick of the target file from `PlanRepoImpact.files[]`:
 *   1. Prefer a file whose basename matches the symbol.
 *   2. Prefer a source file (not a test).
 *   3. Fall back to the first file.
 */
function pickTargetFile(repo: PlanRepoImpact, symbol: string): string {
  if (!repo.files.length) return '';
  const lowerSym = symbol.toLowerCase();
  const notTest = repo.files.filter((f) => !/[._-]test\.|[._-]spec\.|__tests__/.test(f.toLowerCase()));
  const candidates = notTest.length ? notTest : repo.files;
  const byName = candidates.find((f) => {
    const base = f.split('/').pop()?.toLowerCase() ?? '';
    return base.includes(lowerSym);
  });
  return byName ?? candidates[0] ?? '';
}

function severityAtLeastMed(sev: string): boolean {
  return sev === 'med' || sev === 'high';
}

// ── extractBehaviorsFromPlan ─────────────────────────────────────────────

export function extractBehaviorsFromPlan(
  plan: Plan,
  opts?: { maxPerRepo?: number },
): Behavior[] {
  const maxPerRepo = opts?.maxPerRepo ?? 20;
  const out: Behavior[] = [];
  const base = Date.now();
  let idx = 0;

  // 1. Per-repo symbol behaviors.
  for (const repo of plan.repos) {
    let perRepo = 0;
    for (const symbol of repo.symbols) {
      if (perRepo >= maxPerRepo) break;
      const kind = inferKindForSymbol(symbol, plan);
      const priority = inferPriorityForSymbol(symbol, plan);
      const file = pickTargetFile(repo, symbol);

      const intent = HANDLER_RE.test(symbol)
        ? `${symbol} handles requests within ${repo.name} scope`
        : `${symbol} conforms to ${repo.name} scope`;

      out.push({
        id: makeId(idx++, base),
        kind,
        intent,
        target: { file, symbol },
        preconditions: [],
        inputs: { description: `Representative inputs for ${symbol}` },
        expected: {
          description: `${symbol} behaves per ${repo.name} contract`,
          assertion: `${symbol} returns the expected value for valid input`,
        },
        priority,
        ground: { files: [], typesSeen: [], confidence: 0 },
      });
      perRepo++;
    }
  }

  // 2. One Behavior per contract.
  for (const contract of plan.contracts) {
    // Contracts are not repo-scoped; cap is per-repo, so skip the cap here.
    const producerRepo = plan.repos.find((r) => r.name === contract.producer);
    const targetFile = producerRepo ? pickTargetFile(producerRepo, contract.name) : '';
    out.push({
      id: makeId(idx++, base),
      kind: 'contract',
      intent: `${contract.kind.toUpperCase()} contract "${contract.name}" holds between ${contract.producer} and ${contract.consumers.join(', ') || '(no consumers)'}`,
      target: { file: targetFile, symbol: contract.name },
      preconditions: [],
      inputs: { description: `Contract inputs for ${contract.name}` },
      expected: {
        description: contract.description || `Contract ${contract.name} is honored`,
        assertion: `Producer ${contract.producer} emits payloads accepted by all consumers`,
      },
      priority: 'critical',
      ground: { files: [], typesSeen: [], confidence: 0 },
    });
  }

  // 3. One regression Behavior per risk with severity >= 'med'.
  for (const risk of plan.risks) {
    if (!severityAtLeastMed(risk.severity)) continue;
    out.push({
      id: makeId(idx++, base),
      kind: 'regression',
      intent: risk.title,
      target: { file: '', symbol: '' },
      preconditions: [],
      inputs: { description: `Reproduction inputs for: ${risk.title}` },
      expected: {
        description: risk.mitigation || `Regression for "${risk.title}" does not recur`,
        assertion: `System mitigates: ${risk.title}`,
      },
      priority: risk.severity === 'high' ? 'critical' : 'normal',
      ground: { files: [], typesSeen: [], confidence: 0 },
    });
  }

  return out;
}

// ── extractBehaviorsFromDiff ─────────────────────────────────────────────

const DIFF_ADDED_RE = /^\+(?!\+\+)\s*(?:export\s+)?(?:async\s+)?(?:function\s+|const\s+|let\s+|class\s+|def\s+|func\s+(?:\([^)]*\)\s+)?)(\w+)/;

export function extractBehaviorsFromDiff(
  diff: string,
  repoName: string,
  options?: { maxBehaviors?: number },
): Behavior[] {
  const maxBehaviors = options?.maxBehaviors ?? 12;
  const out: Behavior[] = [];
  const base = Date.now();
  const seen = new Set<string>();

  let currentFile = '';
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      // `+++ b/path/to/file.ts` — keep the path after `b/` when present.
      const raw = line.slice(4).trim();
      currentFile = raw.startsWith('b/') ? raw.slice(2) : raw;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('diff ') || line.startsWith('@@')) continue;

    const m = DIFF_ADDED_RE.exec(line);
    if (!m) continue;
    const symbol = m[1];
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);

    out.push({
      id: `b-${base.toString(36)}-${out.length}`,
      kind: 'unit',
      intent: `${symbol} behaves correctly after diff against ${repoName}`,
      target: { file: currentFile, symbol },
      preconditions: [],
      inputs: { description: `Representative inputs for ${symbol}` },
      expected: {
        description: `${symbol} returns the expected value for valid inputs`,
        assertion: `${symbol} returns the expected value for valid input`,
      },
      priority: 'normal',
      ground: { files: [], typesSeen: [], confidence: 0 },
    });
    if (out.length >= maxBehaviors) break;
  }

  return out;
}
