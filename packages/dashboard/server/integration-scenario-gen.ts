/**
 * integration-scenario-gen — turn a Plan's user-facing capabilities and
 * rollout order into end-to-end `Behavior` entries suitable for integration /
 * e2e test generation.
 *
 * The grounder downstream is responsible for pinning these loosely-grounded
 * behaviors to real files/symbols — we deliberately emit `target.file =
 * "integration"` and a low `ground.confidence` so later stages know to either
 * enrich or drop them.
 *
 * Pure, synchronous, deterministic (apart from the Date.now() id suffix).
 */

import type { Behavior, BehaviorKind, Priority } from './test-types.js';
import type { Plan } from './plan-store.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface ScenarioOptions {
  plan: Plan;
  /** Max scenarios to emit. Default 10. */
  maxScenarios?: number;
  /** Optional raw journeys from somewhere else (e.g. a hand-authored markdown list). */
  extraJourneys?: string[];
}

export interface ScenarioResult {
  behaviors: Behavior[];
  derivedFrom: Array<{ source: string; count: number }>;
}

// ── Constants ────────────────────────────────────────────────────────────

const DEFAULT_MAX_SCENARIOS = 10;

/**
 * Tokens that push a scenario from "integration" to "e2e". Lowercased; matched
 * against the lowercased intent with word-ish boundaries so "navigate" does
 * not accidentally fire on "navigable".
 */
const E2E_SIGNAL_RE = /\b(ui|click|clicks|navigate|navigates|navigation|login|logs? in|logged in|user flow)\b/i;

/**
 * Risk severity threshold at/above which we emit a recovery scenario.
 * The spec says "≥ 'med'", so med + high qualify.
 */
const RISK_SEVERITIES_TO_EMIT = new Set(['med', 'high']);

/**
 * Heuristic for "security-flavoured" inScope entries — bumps the behavior
 * priority to 'critical'.
 */
const SECURITY_FLAVOR_RE = /\b(auth|authn|authz|security|permission|permissions|password|token|secret|secrets|rbac|oauth|csrf|xss|sql injection|encryption|decrypt)\b/i;

/**
 * Preconditions sniffer — each pattern captures ONE bullet's worth of setup
 * context from the source string. We scan the whole intent with /g to surface
 * every mention.
 */
const PRECONDITION_PATTERNS: Array<{ re: RegExp; kind: 'loggedIn' | 'has' | 'after' }> = [
  { re: /\blogged in\b/gi, kind: 'loggedIn' },
  { re: /\bhas\s+(?:an?\s+|the\s+)?([a-z][a-z0-9 _-]{1,40}?)(?=[.,;]|\s+(?:and|but|who|that|which|so)\b|$)/gi, kind: 'has' },
  { re: /\bafter\s+([a-z][a-z0-9 _-]{1,40}?)(?=[.,;]|\s+(?:and|but|so|then)\b|$)/gi, kind: 'after' },
];

/**
 * "Should / will / must" clause extractor — used to populate
 * `expected.description` with the final state implied by the scenario text.
 * First match wins; the rest of the sentence after the modal is taken up to
 * the next clause terminator.
 */
const EXPECTED_CLAUSE_RE = /\b(?:should|will|must)\s+([^.;]+?)(?=[.;]|$)/i;

// ── Small helpers ────────────────────────────────────────────────────────

function capitalize(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return trimmed;
  return trimmed[0].toUpperCase() + trimmed.slice(1);
}

function inferKind(intent: string): BehaviorKind {
  return E2E_SIGNAL_RE.test(intent) ? 'e2e' : 'integration';
}

/**
 * Extract a rough "verb-noun" pair from the intent to use as a synthetic
 * symbol name. This is a best-effort heuristic — the grounder will replace it
 * with a real symbol if one exists.
 *
 * Strategy: strip leading subject noise ("Users can", "The system will"),
 * take the first alphabetic verb, then the next alphabetic word as noun,
 * camelCase them. Fall back to a slug of the first two words.
 */
function deriveSymbol(intent: string): string {
  const cleaned = intent
    .replace(/^(users?|the user|customers?|admins?|operators?|clients?|the system|system|service|we)\s+/i, '')
    .replace(/^(can|could|should|must|will|shall|may)\s+/i, '')
    .trim();

  const words = cleaned.match(/[a-zA-Z][a-zA-Z0-9]*/g) ?? [];
  const first = words[0];
  if (!first) return 'scenario';
  if (words.length === 1) return first.toLowerCase();

  const noun = words[1];
  if (!noun) return first.toLowerCase();
  return first.toLowerCase() + noun.charAt(0).toUpperCase() + noun.slice(1).toLowerCase();
}

function extractPreconditions(intent: string): string[] {
  const out: string[] = [];
  for (const { re, kind } of PRECONDITION_PATTERNS) {
    // Reset lastIndex since the patterns are /g.
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(intent)) !== null) {
      if (kind === 'loggedIn') {
        out.push('User is logged in');
      } else if (kind === 'has') {
        const obj = m[1]?.trim();
        if (obj) out.push(`Has ${obj}`);
      } else {
        const step = m[1]?.trim();
        if (step) out.push(`After ${step}`);
      }
    }
  }
  // Dedup while preserving order.
  return Array.from(new Set(out));
}

function extractExpected(intent: string): string {
  const m = intent.match(EXPECTED_CLAUSE_RE);
  if (m && m[1]) return m[1].trim();
  // Fallback — assume the scenario's happy path ends in "success".
  return 'the scenario reaches its final success state';
}

function makeId(index: number, timestampSuffix: string): string {
  return `b-scenario-${timestampSuffix}-${index}`;
}

// ── Behavior builder ─────────────────────────────────────────────────────

interface BuildInput {
  source: string;
  rawIntent: string;
  /** True if the behavior's source naturally implies `priority = 'critical'`. */
  forceCritical?: boolean;
}

function buildBehavior(input: BuildInput, index: number, timestampSuffix: string): Behavior {
  const intent = capitalize(input.rawIntent.replace(/\s+/g, ' ').trim());
  const kind = inferKind(intent);
  const preconditions = extractPreconditions(intent);
  const expectedDescription = extractExpected(intent);

  const securityFlavoured = input.source === 'inScope' && SECURITY_FLAVOR_RE.test(intent);
  const priority: Priority =
    input.forceCritical || securityFlavoured ? 'critical' : 'normal';

  return {
    id: makeId(index, timestampSuffix),
    kind,
    intent,
    target: {
      file: 'integration',
      symbol: deriveSymbol(intent),
    },
    preconditions,
    inputs: {
      description: `See scenario: ${intent}`,
    },
    expected: {
      description: expectedDescription,
      assertion: `End-to-end flow completes with ${expectedDescription}`,
    },
    priority,
    ground: {
      files: [],
      typesSeen: [],
      confidence: 0.4,
    },
  };
}

// ── Public entry ─────────────────────────────────────────────────────────

/**
 * Generate integration / e2e scenario behaviors from a plan.
 *
 * Walks, in order:
 *   1. `plan.scope.inScope[]`                         — one Behavior each
 *   2. `plan.rollout.order[]` consecutive pairs       — one Behavior per pair
 *   3. `plan.contracts[]` (multi-consumer only)       — producer → each consumer
 *   4. `plan.risks[]` (severity >= med)               — one recovery Behavior each
 *   5. `opts.extraJourneys[]`                         — one Behavior each
 *
 * Capped by `opts.maxScenarios` (default 10). Truncation is applied AFTER
 * every source has had a chance to contribute, so earlier sources don't starve
 * later ones — but within the cap we preserve the documented walk order.
 */
export function generateIntegrationScenarios(opts: ScenarioOptions): ScenarioResult {
  const max = Math.max(1, opts.maxScenarios ?? DEFAULT_MAX_SCENARIOS);
  const plan = opts.plan;
  const timestampSuffix = Date.now().toString(36);

  const buffered: Array<{ source: string; input: BuildInput }> = [];

  // 1. inScope
  const inScope = plan.scope?.inScope ?? [];
  for (const bullet of inScope) {
    const trimmed = (bullet ?? '').trim();
    if (!trimmed) continue;
    buffered.push({ source: 'inScope', input: { source: 'inScope', rawIntent: trimmed } });
  }

  // 2. rollout.order consecutive pairs
  const order = plan.rollout?.order ?? [];
  for (let i = 0; i + 1 < order.length; i++) {
    const a = (order[i] ?? '').trim();
    const b = (order[i + 1] ?? '').trim();
    if (!a || !b) continue;
    buffered.push({
      source: 'rollout.order',
      input: {
        source: 'rollout.order',
        rawIntent: `${a} then ${b}`,
      },
    });
  }

  // 3. contracts with multiple consumers
  const contracts = plan.contracts ?? [];
  for (const c of contracts) {
    if (!c || !Array.isArray(c.consumers) || c.consumers.length < 2) continue;
    const consumerList = c.consumers.join(', ');
    buffered.push({
      source: 'contracts',
      input: {
        source: 'contracts',
        rawIntent: `Exercise ${c.kind} contract "${c.name}" from ${c.producer} through ${consumerList}`,
      },
    });
  }

  // 4. risks with severity >= med
  const risks = plan.risks ?? [];
  for (const r of risks) {
    if (!r || !RISK_SEVERITIES_TO_EMIT.has(r.severity)) continue;
    buffered.push({
      source: 'risks',
      input: {
        source: 'risks',
        rawIntent: `Recovery scenario: ${r.title}`,
        forceCritical: true,
      },
    });
  }

  // 5. extra journeys
  const extras = opts.extraJourneys ?? [];
  for (const j of extras) {
    const trimmed = (j ?? '').trim();
    if (!trimmed) continue;
    buffered.push({
      source: 'extraJourneys',
      input: { source: 'extraJourneys', rawIntent: trimmed },
    });
  }

  // Cap, then materialize. Counting must reflect what was EMITTED, not what
  // was buffered, so callers can trust `derivedFrom`.
  const emitted = buffered.slice(0, max);
  const behaviors: Behavior[] = emitted.map((e, idx) => buildBehavior(e.input, idx, timestampSuffix));

  const counts = new Map<string, number>();
  for (const e of emitted) {
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
  }

  // Preserve the walk order in the derivedFrom array; only include sources
  // that actually contributed.
  const SOURCE_ORDER = ['inScope', 'rollout.order', 'contracts', 'risks', 'extraJourneys'];
  const derivedFrom: Array<{ source: string; count: number }> = [];
  for (const s of SOURCE_ORDER) {
    const n = counts.get(s);
    if (n && n > 0) derivedFrom.push({ source: s, count: n });
  }

  return { behaviors, derivedFrom };
}
