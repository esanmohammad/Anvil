/**
 * behavior-extractor — derives Behaviors from a Plan v2 or a unified diff.
 *
 * Pure, synchronous, side-effect-free. The output is a deterministic
 * seed for the downstream test-grounding + test-code-emitting stages.
 *
 * Plan v2: reads structured `repos[].mustTouch`, `repos[].symbols`,
 * `contracts[]` (with kind-specific display names), `risks[]`. Phase F
 * promotes a parallel path that consumes `plan.tests` TestCaseSpec[]
 * directly when present — see `extractBehaviorsFromTestSpecs` below.
 */

import type { Behavior, BehaviorKind, Priority } from './test-types.js';
import type { Plan, PlanRepoImpact } from './plan-store.js';
import {
  planContractDisplayName,
  planContractDescription,
  planContractConsumers,
  planRepoTouchedPaths,
  type SymbolClaim,
} from '@esankhan3/anvil-core-pipeline';

// ── ID generator (shared — stable ordering via index suffix) ─────────────

function makeId(index: number, base?: number): string {
  const ts = (base ?? Date.now()).toString(36);
  return `b-${ts}-${index}`;
}

// ── Heuristics ───────────────────────────────────────────────────────────

const HANDLER_RE = /(Handler|Controller|Route|Endpoint|Service|Middleware)/;

function inferKindForSymbol(symbol: string, plan: Plan): BehaviorKind {
  const inContract = plan.contracts.some((c) => {
    const display = planContractDisplayName(c).toLowerCase();
    return display.includes(symbol.toLowerCase())
      || c.producer === symbol
      || planContractConsumers(c).includes(symbol);
  });
  if (inContract) return 'contract';
  if (HANDLER_RE.test(symbol)) return 'integration';
  return 'unit';
}

function inferPriorityForSymbol(symbol: string, plan: Plan): Priority {
  const inContract = plan.contracts.some((c) => {
    const display = planContractDisplayName(c).toLowerCase();
    return display.includes(symbol.toLowerCase())
      || c.producer === symbol
      || planContractConsumers(c).includes(symbol);
  });
  if (inContract) return 'critical';
  return 'normal';
}

/**
 * Best-effort target file pick:
 *   1. Use the SymbolClaim's declared file when present.
 *   2. Else find a repo file whose basename matches the symbol.
 *   3. Else fall back to the first non-test file in the repo.
 */
function pickTargetFile(repo: PlanRepoImpact, sym: SymbolClaim): string {
  if (sym.file) return sym.file;
  const allFiles = planRepoTouchedPaths(repo);
  if (!allFiles.length) return '';
  const lowerName = sym.name.toLowerCase();
  const notTest = allFiles.filter((f) => !/[._-]test\.|[._-]spec\.|__tests__/.test(f.toLowerCase()));
  const candidates = notTest.length ? notTest : allFiles;
  const byName = candidates.find((f) => {
    const base = f.split('/').pop()?.toLowerCase() ?? '';
    return base.includes(lowerName);
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
    for (const sym of repo.symbols) {
      if (perRepo >= maxPerRepo) break;
      const kind = inferKindForSymbol(sym.name, plan);
      const priority = inferPriorityForSymbol(sym.name, plan);
      const file = pickTargetFile(repo, sym);

      const intent = HANDLER_RE.test(sym.name)
        ? `${sym.name} handles requests within ${repo.name} scope`
        : `${sym.name} conforms to ${repo.name} scope`;

      out.push({
        id: makeId(idx++, base),
        kind,
        intent,
        target: { file, symbol: sym.name },
        preconditions: [],
        inputs: { description: `Representative inputs for ${sym.name}` },
        expected: {
          description: `${sym.name} behaves per ${repo.name} contract`,
          assertion: `${sym.name} returns the expected value for valid input`,
        },
        priority,
        ground: { files: [], typesSeen: [], confidence: 0 },
      });
      perRepo++;
    }
  }

  // 2. One Behavior per contract.
  for (const contract of plan.contracts) {
    const producerRepo = plan.repos.find((r) => r.name === contract.producer);
    const display = planContractDisplayName(contract);
    const targetFile = producerRepo
      ? pickTargetFile(producerRepo, { file: '', name: display, kind: 'function' })
      : '';
    const consumers = planContractConsumers(contract);
    out.push({
      id: makeId(idx++, base),
      kind: 'contract',
      intent: `${contract.kind.toUpperCase()} contract "${display}" holds between ${contract.producer} and ${consumers.join(', ') || '(no consumers)'}`,
      target: { file: targetFile, symbol: display },
      preconditions: [],
      inputs: { description: `Contract inputs for ${display}` },
      expected: {
        description: planContractDescription(contract) || `Contract ${display} is honored`,
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

// ── Plan v2 — Behaviors directly from plan.tests TestCaseSpec[] ──────────

/**
 * Phase F — when the plan declares structured TestCaseSpec[], emit one
 * Behavior per spec so test-gen produces a real scaffold per spec
 * (rather than inferring behaviors from symbols).
 */
export function extractBehaviorsFromTestSpecs(plan: Plan): Behavior[] {
  const base = Date.now();
  const out: Behavior[] = [];
  let i = 0;
  for (const bucket of ['unit', 'integration'] as const) {
    for (const spec of plan.tests[bucket]) {
      out.push({
        id: `t-${base.toString(36)}-${i++}`,
        kind: bucket === 'integration' ? 'integration' : 'unit',
        intent: spec.then || spec.name,
        target: { file: spec.file, symbol: spec.name },
        preconditions: spec.given ? [spec.given] : [],
        inputs: { description: spec.when || `Inputs for ${spec.name}` },
        expected: {
          description: spec.then || `${spec.name} passes`,
          assertion: spec.then || `${spec.name} returns expected output`,
        },
        priority: 'critical',
        ground: { files: spec.file ? [spec.file] : [], typesSeen: [], confidence: spec.file ? 1 : 0 },
      });
    }
  }
  return out;
}
