import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Map, CheckCircle2, ArrowLeft } from 'lucide-react';

export interface PlanComparePageProps {
  ws: WebSocket | null;
}

// ── Types (mirrored from PlanPage.tsx) ─────────────────────────────────

// ── Plan v2 mirror — keep in sync with PlanPage.tsx + core-pipeline ─────

interface FileClaim { path: string; kind: 'new' | 'modified'; reason: string }
interface SymbolClaim { file: string; name: string; kind: string; signature?: string }
interface PlanRepoImpact {
  name: string;
  changes: string;
  mustExist: FileClaim[];
  mustTouch: FileClaim[];
  mustNotBreak: string[];
  symbols: SymbolClaim[];
}
type PlanContract =
  | { kind: 'http'; method: string; path: string; producer: string; consumers: string[]; status: number[] }
  | { kind: 'kafka'; topic: string; producer: string; consumers: string[]; schemaRef: string }
  | { kind: 'grpc'; service: string; method: string; producer: string; consumers: string[] }
  | { kind: 'db'; table: string; producer: string; columns: Array<{ name: string; type: string }> };
interface PlanRisk {
  id: string; title: string; severity: 'low' | 'med' | 'high';
  blastRadius: string; mitigation: string; detection: string;
}
interface ScopeItem { id: string; description: string; acceptance: string[] }
interface TestCaseSpec { id: string; acceptanceRef: string; file: string; name: string; given: string; when: string; then: string }
interface ManualStep { id: string; description: string; expected: string }

interface Plan {
  schema: 2;
  version: number;
  parentVersion: number | null;
  contentHash: string;
  slug: string;
  project: string;
  title: string;
  problem: { statement: string; why_now: string; success_signals: string[] };
  scope: { inScope: ScopeItem[]; outOfScope: ScopeItem[] };
  repos: PlanRepoImpact[];
  contracts: PlanContract[];
  data: Array<{ kind: string; repo: string; migrationFile: string; rollback: string }>;
  observability: { signals: Array<{ kind: string; name: string; reason: string }> };
  architecture: { mermaid: string; notes: string };
  risks: PlanRisk[];
  rollout: { strategy: string; flags: string[]; order: string[]; rollback: { command: string; verify: string } };
  tests: { unit: TestCaseSpec[]; integration: TestCaseSpec[]; manual: ManualStep[] };
  estimate: { usd: number; minutes: number; prs: number; calibratedFrom: string[] };
  model: string;
  feature: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: { kind: 'model' | 'human'; model?: string };
  approval?: { user: string; approvedAt: string; planHash: string; note?: string };
}

// ── Local helpers (v2 contract / repo display) ──────────────────────────

function contractDisplay(c: PlanContract): string {
  if (c.kind === 'http') return `${c.method} ${c.path}`;
  if (c.kind === 'kafka') return c.topic;
  if (c.kind === 'grpc') return `${c.service}.${c.method}`;
  return c.table;
}
function contractConsumers(c: PlanContract): string[] {
  return c.kind === 'db' ? [] : c.consumers;
}
function repoTouchedPaths(r: PlanRepoImpact): string[] {
  const out = new Set<string>();
  for (const f of r.mustTouch ?? []) if (f?.path) out.add(f.path);
  for (const f of r.mustExist ?? []) if (f?.path) out.add(f.path);
  return [...out];
}

// ── Phase H — Variant scoring ──────────────────────────────────────────

interface VariantScore {
  /** Lower is better. */
  costUsd: number;
  /** Count of risks weighted by severity (high=3, med=2, low=1). */
  riskScore: number;
  /** Repos with ≥ 1 mustTouch/mustExist file. */
  reposTouched: number;
  /** Total files claimed. */
  filesClaimed: number;
  /** Plan agent-reported PR count. */
  prs: number;
  /** Total acceptance criteria — more criteria = more thorough plan. */
  acceptanceCount: number;
}

function computeVariantScore(plan: Plan): VariantScore {
  const riskScore = plan.risks.reduce((s, r) => {
    if (r.severity === 'high') return s + 3;
    if (r.severity === 'med') return s + 2;
    return s + 1;
  }, 0);
  const reposTouched = plan.repos.filter((r) => repoTouchedPaths(r).length > 0).length;
  const filesClaimed = plan.repos.reduce((s, r) => s + repoTouchedPaths(r).length, 0);
  const acceptanceCount = plan.scope.inScope.reduce((s, item) => s + item.acceptance.length, 0);
  return {
    costUsd: plan.estimate.usd,
    riskScore,
    reposTouched,
    filesClaimed,
    prs: plan.estimate.prs,
    acceptanceCount,
  };
}

/**
 * Compute relative score badges across all variant slots so we can
 * highlight the cheapest cost, the lowest-risk plan, etc. Returns a
 * map from variant index → which badges this variant "wins".
 */
function computeRelativeBadges(variants: VariantSlot[]): Record<number, Set<string>> {
  const scored = variants
    .map((v) => v.plan ? { idx: v.index, score: computeVariantScore(v.plan) } : null)
    .filter((x): x is { idx: number; score: VariantScore } => x !== null);
  if (scored.length < 2) return {};
  const badges: Record<number, Set<string>> = {};
  const minBy = <K extends keyof VariantScore>(key: K): number =>
    scored.reduce((acc, s) => (s.score[key] < acc.score[key] ? s : acc), scored[0]).idx;
  const maxBy = <K extends keyof VariantScore>(key: K): number =>
    scored.reduce((acc, s) => (s.score[key] > acc.score[key] ? s : acc), scored[0]).idx;
  const stamp = (idx: number, badge: string) => {
    (badges[idx] = badges[idx] ?? new Set()).add(badge);
  };
  stamp(minBy('costUsd'), 'cheapest');
  stamp(minBy('riskScore'), 'safest');
  stamp(minBy('filesClaimed'), 'smallest');
  stamp(maxBy('acceptanceCount'), 'most-thorough');
  return badges;
}

const BADGE_LABELS: Record<string, { label: string; color: string }> = {
  cheapest: { label: '$ cheapest', color: 'var(--color-success, #22c55e)' },
  safest: { label: '⛨ safest', color: 'var(--color-success, #22c55e)' },
  smallest: { label: '◯ smallest', color: 'var(--accent)' },
  'most-thorough': { label: '✓ most thorough', color: 'var(--accent)' },
};

interface VariantSlot {
  label: string;
  index: number;
  plan: Plan | null;
}

const SECTIONS = [
  { id: 'problem', label: 'Problem' },
  { id: 'scope', label: 'Scope' },
  { id: 'repos', label: 'Repos' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'architecture', label: 'Architecture' },
  { id: 'risks', label: 'Risks' },
  { id: 'rollout', label: 'Rollout' },
  { id: 'tests', label: 'Tests' },
  { id: 'estimate', label: 'Estimate' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

// ── Helpers: parse URL query from hash ────────────────────────────────

function parseHashQuery(): Record<string, string> {
  const hash = window.location.hash.slice(1);
  const idx = hash.indexOf('?');
  if (idx < 0) return {};
  const qs = hash.slice(idx + 1);
  const out: Record<string, string> = {};
  for (const part of qs.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = eq >= 0 ? part.slice(0, eq) : part;
    const v = eq >= 0 ? decodeURIComponent(part.slice(eq + 1)) : '';
    out[decodeURIComponent(k)] = v;
  }
  return out;
}

// ── Helpers: build a canonical text representation of each section ────

function sectionText(plan: Plan, section: SectionId): string {
  switch (section) {
    case 'problem':
      return [plan.problem.statement, plan.problem.why_now, ...plan.problem.success_signals]
        .filter(Boolean).join(' | ');
    case 'scope':
      return [
        'IN:', ...plan.scope.inScope.map((s) => s.description),
        'OUT:', ...plan.scope.outOfScope.map((s) => s.description),
      ].join(' ');
    case 'repos':
      return plan.repos
        .map((r) => `${r.name} ${r.changes} touched:${repoTouchedPaths(r).join(',')} symbols:${r.symbols.map((s) => s.name).join(',')}`)
        .join(' | ');
    case 'contracts':
      return plan.contracts
        .map((c) => `${c.kind} ${contractDisplay(c)} ${c.producer}->${contractConsumers(c).join(',')}`)
        .join(' | ');
    case 'architecture':
      return `${plan.architecture.notes || ''} ${plan.architecture.mermaid || ''}`.trim();
    case 'risks':
      return plan.risks.map((r) => `[${r.severity}/${r.blastRadius}] ${r.title} — ${r.mitigation}`).join(' | ');
    case 'rollout':
      return [
        plan.rollout.strategy,
        `flags:${plan.rollout.flags.join(',')}`,
        `order:${plan.rollout.order.join('>')}`,
        `rollback:${plan.rollout.rollback.command || ''}`,
      ].join(' ');
    case 'tests':
      return [
        'unit:', ...plan.tests.unit.map((t) => t.name || t.then),
        'integration:', ...plan.tests.integration.map((t) => t.name || t.then),
        'manual:', ...plan.tests.manual.map((m) => m.description),
      ].join(' ');
    case 'estimate':
      return `$${plan.estimate.usd} ${plan.estimate.minutes}min ${plan.estimate.prs}prs`;
    default:
      return '';
  }
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * Word-level difference score between two strings. Returns a number in [0, 1].
 * 0 = identical, 1 = entirely different. Uses simple set overlap (Jaccard).
 */
function wordDiffScore(a: string, b: string): number {
  if (a === b) return 0;
  const aw = new Set(tokenize(a));
  const bw = new Set(tokenize(b));
  if (aw.size === 0 && bw.size === 0) return 0;
  let intersection = 0;
  for (const w of aw) if (bw.has(w)) intersection += 1;
  const union = aw.size + bw.size - intersection;
  if (union === 0) return 0;
  return 1 - intersection / union;
}

/** Whether any two loaded variants differ for this section. */
function sectionDiffers(variants: VariantSlot[], section: SectionId): boolean {
  const loaded = variants.filter((v) => v.plan);
  if (loaded.length < 2) return false;
  const first = sectionText(loaded[0].plan as Plan, section);
  for (let i = 1; i < loaded.length; i += 1) {
    const txt = sectionText(loaded[i].plan as Plan, section);
    if (wordDiffScore(first, txt) > 0.01) return true;
  }
  return false;
}

// ── Small presentational primitives ───────────────────────────────────

function ChipList({ items }: { items: string[] }) {
  if (!items || items.length === 0) {
    return <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>;
  }
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.map((it, i) => (
        <span
          key={i}
          style={{
            fontSize: 11,
            background: 'var(--bg-elevated-3)',
            color: 'var(--text-secondary)',
            padding: '2px 7px',
            borderRadius: 999,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {it}
        </span>
      ))}
    </div>
  );
}

function Bullets({ items, empty = '—' }: { items: string[]; empty?: string }) {
  if (!items || items.length === 0) {
    return <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{empty}</span>;
  }
  return (
    <ul style={{ listStyle: 'disc', paddingLeft: 18, margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
      {items.map((it, i) => (
        <li key={i} style={{ marginBottom: 3 }}>{it}</li>
      ))}
    </ul>
  );
}

function DeltaBadge() {
  return (
    <span
      aria-label="Differs between variants"
      title="Differs between variants"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 16, height: 16,
        fontSize: 10, fontWeight: 700,
        color: 'var(--color-warning, #f59e0b)',
        background: 'rgba(245,158,11,0.12)',
        border: '1px solid rgba(245,158,11,0.4)',
        borderRadius: 999,
        marginLeft: 6,
        fontFamily: 'var(--font-mono)',
      }}
    >
      Δ
    </span>
  );
}

// ── Section renderers (render plan section into column cell) ──────────

function renderSection(plan: Plan, section: SectionId): React.ReactNode {
  switch (section) {
    case 'problem':
      return (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          <p style={{ margin: 0 }}>{plan.problem.statement || '—'}</p>
          {plan.problem.why_now && (
            <p style={{ margin: '4px 0 0', fontSize: 11 }}>
              <em style={{ color: 'var(--text-tertiary)' }}>Why now:</em> {plan.problem.why_now}
            </p>
          )}
        </div>
      );
    case 'scope':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>IN SCOPE</div>
            <Bullets items={plan.scope.inScope.map((s) => `${s.id}: ${s.description}`)} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>OUT OF SCOPE</div>
            <Bullets items={plan.scope.outOfScope.map((s) => s.description)} />
          </div>
        </div>
      );
    case 'repos':
      if (plan.repos.length === 0) return <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No repos.</span>;
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {plan.repos.map((r) => (
            <div
              key={r.name}
              style={{
                padding: 8,
                background: 'var(--bg-base)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 3, color: 'var(--text-primary)' }}>
                {r.name}
              </div>
              <p style={{ margin: '0 0 6px', fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
                {r.changes}
              </p>
              <ChipList items={repoTouchedPaths(r)} />
              <div style={{ height: 4 }} />
              <ChipList items={r.symbols.map((s) => s.name)} />
            </div>
          ))}
        </div>
      );
    case 'contracts':
      if (plan.contracts.length === 0) {
        return <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>None.</span>;
      }
      return (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {plan.contracts.map((c, i) => (
            <li key={i} style={{ marginBottom: 6, fontSize: 12 }}>
              <span
                style={{
                  fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
                  padding: '1px 5px', borderRadius: 4,
                  background: 'var(--bg-elevated-3)', color: 'var(--text-secondary)',
                  marginRight: 5, textTransform: 'uppercase',
                }}
              >
                {c.kind}
              </span>
              <strong style={{ color: 'var(--text-primary)' }}>{contractDisplay(c)}</strong>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 2 }}>
                {c.producer}{contractConsumers(c).length ? ` → ${contractConsumers(c).join(', ')}` : ''}
              </div>
            </li>
          ))}
        </ul>
      );
    case 'architecture':
      return (
        <div>
          {plan.architecture.notes && (
            <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              {plan.architecture.notes}
            </p>
          )}
          {plan.architecture.mermaid ? (
            <pre
              style={{
                background: 'var(--bg-base)', padding: 8,
                borderRadius: 'var(--radius-sm)', fontSize: 10,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-secondary)',
                overflowX: 'auto', margin: 0, lineHeight: 1.5,
              }}
            >
              {plan.architecture.mermaid}
            </pre>
          ) : (
            !plan.architecture.notes && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
          )}
        </div>
      );
    case 'risks':
      if (plan.risks.length === 0) {
        return <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No risks.</span>;
      }
      return (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {plan.risks.map((r, i) => (
            <li key={i} style={{ marginBottom: 6, fontSize: 12 }}>
              <span
                style={{
                  fontSize: 10, fontWeight: 700, marginRight: 5,
                  padding: '1px 5px', borderRadius: 4,
                  background: r.severity === 'high' ? 'rgba(239,68,68,0.12)'
                    : r.severity === 'med' ? 'rgba(245,158,11,0.12)'
                    : 'var(--bg-elevated-3)',
                  color: r.severity === 'high' ? 'var(--color-error, #ef4444)'
                    : r.severity === 'med' ? 'var(--color-warning, #f59e0b)'
                    : 'var(--text-tertiary)',
                  textTransform: 'uppercase',
                }}
              >
                {r.severity}
              </span>
              <strong style={{ color: 'var(--text-primary)' }}>{r.title}</strong>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                <em style={{ color: 'var(--text-tertiary)' }}>Mitigation:</em> {r.mitigation}
              </div>
            </li>
          ))}
        </ul>
      );
    case 'rollout':
      return (
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
          {plan.rollout.strategy && (
            <p style={{ margin: '0 0 6px' }}>{plan.rollout.strategy}</p>
          )}
          <div style={{ fontSize: 11 }}>
            <div><span style={{ color: 'var(--text-tertiary)' }}>Flags:</span> {plan.rollout.flags.join(', ') || '—'}</div>
            <div><span style={{ color: 'var(--text-tertiary)' }}>Order:</span> {plan.rollout.order.join(' → ') || '—'}</div>
            <div><span style={{ color: 'var(--text-tertiary)' }}>Rollback:</span> {plan.rollout.rollback.command || '—'}</div>
            {plan.rollout.rollback.verify && (
              <div><span style={{ color: 'var(--text-tertiary)' }}>Verify:</span> {plan.rollout.rollback.verify}</div>
            )}
          </div>
        </div>
      );
    case 'tests':
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>UNIT</div>
            <Bullets items={plan.tests.unit.map((t) => t.name || t.then)} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>INTEGRATION</div>
            <Bullets items={plan.tests.integration.map((t) => t.name || t.then)} />
          </div>
          <div>
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 3 }}>MANUAL</div>
            <Bullets items={plan.tests.manual.map((m) => m.description)} />
          </div>
        </div>
      );
    case 'estimate':
      return (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
          <li><span style={{ color: 'var(--text-tertiary)' }}>Cost:</span> ~${plan.estimate.usd.toFixed(2)}</li>
          <li><span style={{ color: 'var(--text-tertiary)' }}>Duration:</span> {plan.estimate.minutes} min</li>
          <li><span style={{ color: 'var(--text-tertiary)' }}>PRs:</span> {plan.estimate.prs}</li>
        </ul>
      );
    default:
      return null;
  }
}

// ── Main page ─────────────────────────────────────────────────────────

export function PlanCompare({ ws }: PlanComparePageProps) {
  const [query, setQuery] = useState<Record<string, string>>(() => parseHashQuery());
  const [variants, setVariants] = useState<VariantSlot[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);

  // Re-parse query when hash changes (e.g. user pastes the link)
  useEffect(() => {
    const onHash = () => setQuery(parseHashQuery());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const project = query.project ?? '';
  const feature = query.feature ?? '';

  // Subscribe to plan-variant messages
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'plan-variant-created') {
          const payload = msg.payload ?? {};
          const plan: Plan | undefined = payload.plan;
          const variant: { label: string; index: number } | undefined = payload.variant;
          if (!plan || !variant) return;
          // Only accept variants for the current feature/project if provided
          if (project && plan.project && plan.project !== project) return;
          setVariants((prev) => {
            // Ensure we have a slot for this index; expand if needed
            const next = prev.slice();
            while (next.length <= variant.index) {
              next.push({ label: `Variant ${next.length + 1}`, index: next.length, plan: null });
            }
            next[variant.index] = {
              label: variant.label || next[variant.index].label,
              index: variant.index,
              plan,
            };
            return next;
          });
        } else if (msg.type === 'plan-error') {
          setError(msg.payload?.message ?? 'Plan variant generation failed.');
        }
      } catch {
        /* ignore */
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, project]);

  // Initialize placeholder variants from sessionStorage if present (set by PlanPage on submit)
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem('anvil.planVariants.labels');
      if (!raw) return;
      const labels: string[] = JSON.parse(raw);
      if (!Array.isArray(labels) || labels.length === 0) return;
      setVariants((prev) => {
        if (prev.length >= labels.length) return prev;
        const next: VariantSlot[] = labels.map((label, index) => ({
          label,
          index,
          plan: prev[index]?.plan ?? null,
        }));
        // Preserve any plans already received for higher indices
        for (let i = labels.length; i < prev.length; i += 1) {
          next.push(prev[i]);
        }
        return next;
      });
    } catch {
      /* ignore */
    }
  }, []);

  const handleBack = useCallback(() => {
    window.location.hash = '/plan';
  }, []);

  const handleAdopt = useCallback((plan: Plan) => {
    if (!ws || !project) return;
    setAdopting(plan.slug);
    ws.send(JSON.stringify({ action: 'adopt-plan-variant', project, variantSlug: plan.slug }));
    // Navigate back to /plan — server team wires server-side adoption
    window.setTimeout(() => { window.location.hash = '/plan'; }, 250);
  }, [ws, project]);

  const diffBySection = useMemo<Record<SectionId, boolean>>(() => {
    const out: Record<string, boolean> = {};
    for (const s of SECTIONS) out[s.id] = sectionDiffers(variants, s.id);
    return out as Record<SectionId, boolean>;
  }, [variants]);

  const columnWidth = Math.max(260, Math.floor(960 / Math.max(1, variants.length || 1)));

  const relativeBadges = useMemo(() => computeRelativeBadges(variants), [variants]);

  return (
    <div
      className="page-enter"
      style={{
        padding: 'var(--space-lg)',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexShrink: 0 }}>
        <button
          onClick={handleBack}
          className="btn btn-ghost btn-sm"
          style={{ gap: 4 }}
          aria-label="Back to Plan"
        >
          <ArrowLeft size={14} strokeWidth={2} />
          Back
        </button>
        <Map size={20} style={{ color: 'var(--accent)' }} aria-hidden="true" />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Compare plans</h2>
        {project && (
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>
        )}
        {feature && (
          <span
            style={{
              fontSize: 12, color: 'var(--text-tertiary)',
              marginLeft: 'auto', fontStyle: 'italic',
              maxWidth: 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            title={feature}
          >
            {feature}
          </span>
        )}
      </div>

      {/* Error banner */}
      {error && (
        <div
          role="alert"
          style={{
            marginBottom: 12, padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            background: 'rgba(239,68,68,0.10)',
            border: '1px solid var(--color-error, #ef4444)',
            fontSize: 12, color: 'var(--color-error, #ef4444)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          }}
        >
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12 }}
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* Empty state (no variants yet and nothing pending) */}
      {variants.length === 0 && (
        <div
          style={{
            flex: 1, display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center',
            color: 'var(--text-tertiary)', gap: 12,
          }}
        >
          <Map size={32} style={{ opacity: 0.3 }} aria-hidden="true" />
          <span>No variants to compare yet.</span>
          <span style={{ fontSize: 11, maxWidth: 420, textAlign: 'center' }}>
            Go back to Plan and click "Generate variants" to draft 2–4 approaches side-by-side.
          </span>
        </div>
      )}

      {/* Columns grid */}
      {variants.length > 0 && (
        <div
          role="table"
          aria-label="Plan variant comparison"
          style={{
            flex: 1, minHeight: 0, overflow: 'auto',
            display: 'grid',
            gridTemplateColumns: `140px repeat(${variants.length}, minmax(${columnWidth}px, 1fr))`,
            gap: 0,
            alignContent: 'start',
          }}
        >
          {/* Column headers */}
          <div
            role="columnheader"
            style={{
              position: 'sticky', top: 0, left: 0, zIndex: 3,
              background: 'var(--bg-base)',
              padding: '8px 10px',
              borderBottom: '1px solid var(--separator)',
              fontSize: 11, fontWeight: 600, color: 'var(--text-tertiary)',
              textTransform: 'uppercase', letterSpacing: 0.4,
            }}
          >
            Section
          </div>
          {variants.map((v) => (
            <div
              key={`head-${v.index}`}
              role="columnheader"
              style={{
                position: 'sticky', top: 0, zIndex: 2,
                background: 'var(--bg-elevated-2)',
                padding: '10px 12px',
                borderBottom: '1px solid var(--separator)',
                borderLeft: '1px solid var(--separator)',
                display: 'flex', flexDirection: 'column', gap: 6,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span
                  aria-hidden="true"
                  style={{
                    width: 8, height: 8, borderRadius: 999,
                    background: v.plan ? 'var(--color-success, #22c55e)' : 'var(--text-tertiary)',
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                  {v.label}
                </span>
                {v.plan && (
                  <span
                    style={{
                      fontSize: 10, color: 'var(--text-tertiary)',
                      padding: '1px 6px', borderRadius: 999,
                      background: 'var(--bg-elevated-3)', marginLeft: 'auto',
                    }}
                  >
                    {v.plan.model}
                  </span>
                )}
              </div>
              {v.plan ? (
                <>
                  {/* Phase H — score row */}
                  <div style={{
                    display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
                    gap: 4, fontSize: 11, color: 'var(--text-tertiary)',
                  }}>
                    {(() => {
                      const sc = computeVariantScore(v.plan);
                      return (
                        <>
                          <div title="Estimated cost">
                            <span style={{ color: 'var(--text-secondary)' }}>${sc.costUsd.toFixed(2)}</span>
                          </div>
                          <div title="Risks (weighted: high=3, med=2, low=1)">
                            <span style={{ color: 'var(--text-secondary)' }}>{sc.riskScore}</span> risk
                          </div>
                          <div title="Repos with files claimed">
                            <span style={{ color: 'var(--text-secondary)' }}>{sc.reposTouched}</span> repos
                          </div>
                          <div title="Total files claimed (mustTouch + mustExist)">
                            <span style={{ color: 'var(--text-secondary)' }}>{sc.filesClaimed}</span> files
                          </div>
                          <div title="Pull requests">
                            <span style={{ color: 'var(--text-secondary)' }}>{sc.prs}</span> PR
                          </div>
                          <div title="Acceptance criteria">
                            <span style={{ color: 'var(--text-secondary)' }}>{sc.acceptanceCount}</span> AC
                          </div>
                        </>
                      );
                    })()}
                  </div>
                  {relativeBadges[v.index] && relativeBadges[v.index].size > 0 && (
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {[...relativeBadges[v.index]].map((b) => (
                        <span key={b} style={{
                          fontSize: 10, padding: '1px 5px', borderRadius: 999,
                          background: 'var(--bg-elevated-3)',
                          color: BADGE_LABELS[b]?.color ?? 'var(--text-secondary)',
                          border: `1px solid ${BADGE_LABELS[b]?.color ?? 'var(--separator)'}`,
                        }}>
                          {BADGE_LABELS[b]?.label ?? b}
                        </span>
                      ))}
                    </div>
                  )}
                  <button
                    onClick={() => {
                      if (!v.plan) return;
                      if (confirm(`Adopt "${v.label}"?\n\n• Cost ~$${computeVariantScore(v.plan).costUsd.toFixed(2)}\n• ${computeVariantScore(v.plan).reposTouched} repos · ${computeVariantScore(v.plan).filesClaimed} files\n• ${computeVariantScore(v.plan).riskScore} risk-pts\n\nThis bumps the active plan and invalidates approval.`)) {
                        handleAdopt(v.plan);
                      }
                    }}
                    disabled={adopting === v.plan.slug}
                    aria-label={`Adopt variant ${v.label}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6, justifyContent: 'center',
                      height: 28, padding: '0 10px',
                      fontSize: 12, fontWeight: 600,
                      background: adopting === v.plan.slug ? 'var(--bg-elevated-3)' : 'var(--accent)',
                      color: adopting === v.plan.slug ? 'var(--text-tertiary)' : 'var(--text-inverse)',
                      border: 'none', borderRadius: 'var(--radius-sm)',
                      cursor: adopting === v.plan.slug ? 'wait' : 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    <CheckCircle2 size={12} strokeWidth={1.75} aria-hidden="true" />
                    {adopting === v.plan.slug ? 'Adopting…' : 'Adopt this variant'}
                  </button>
                </>
              ) : (
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    fontSize: 11, color: 'var(--text-tertiary)',
                  }}
                  aria-live="polite"
                  aria-busy="true"
                >
                  <span
                    className="status-dot-spin"
                    style={{ width: 12, height: 12 }}
                    aria-hidden="true"
                  />
                  <span>Drafting…</span>
                </div>
              )}
            </div>
          ))}

          {/* Section rows */}
          {SECTIONS.map((section) => (
            <React.Fragment key={section.id}>
              <div
                role="rowheader"
                style={{
                  position: 'sticky', left: 0, zIndex: 1,
                  background: 'var(--bg-base)',
                  padding: '10px 10px',
                  borderBottom: '1px solid var(--separator)',
                  fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
                  display: 'flex', alignItems: 'center',
                }}
              >
                <span>{section.label}</span>
                {diffBySection[section.id] && <DeltaBadge />}
              </div>
              {variants.map((v) => (
                <div
                  key={`cell-${section.id}-${v.index}`}
                  role="cell"
                  style={{
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--separator)',
                    borderLeft: '1px solid var(--separator)',
                    background: diffBySection[section.id]
                      ? 'rgba(245,158,11,0.04)'
                      : 'transparent',
                    minWidth: 0,
                  }}
                >
                  {v.plan ? (
                    renderSection(v.plan, section.id)
                  ) : (
                    <div
                      style={{
                        display: 'flex', alignItems: 'center', gap: 6,
                        fontSize: 11, color: 'var(--text-tertiary)',
                      }}
                      aria-busy="true"
                    >
                      <span
                        className="status-dot-spin"
                        style={{ width: 10, height: 10 }}
                        aria-hidden="true"
                      />
                      <span>Waiting…</span>
                    </div>
                  )}
                </div>
              ))}
            </React.Fragment>
          ))}
        </div>
      )}
    </div>
  );
}

export default PlanCompare;
