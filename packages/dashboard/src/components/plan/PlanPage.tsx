import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Map, Play, Download, Copy, RefreshCw, CheckCircle2,
  AlertTriangle, AlertCircle, Info, ClipboardCheck,
  Edit2, Check, X,
} from 'lucide-react';
import {
  ProblemEditor,
  ScopeEditor,
  ReposEditor,
  ContractsEditor,
  ArchitectureEditor,
  RisksEditor,
  RolloutEditor,
  TestsEditor,
  EstimateEditor,
} from './edit/SectionEditors';
import { RoutingCard } from '../common/RoutingCard.js';

export interface PlanPageProps {
  project: string | null;
  ws: WebSocket | null;
}

// ── Types (mirror server plan-store.ts) ────────────────────────────────

type PlanSection =
  | 'problem' | 'scope' | 'repos' | 'contracts' | 'architecture'
  | 'risks' | 'rollout' | 'tests' | 'estimate';

interface PlanRepoImpact { name: string; changes: string; files: string[]; symbols: string[] }
interface PlanContract { kind: string; name: string; producer: string; consumers: string[]; description: string }
interface PlanRisk { title: string; mitigation: string; severity: 'low' | 'med' | 'high' }

interface Plan {
  version: number;
  slug: string;
  project: string;
  title: string;
  problem: string;
  scope: { inScope: string[]; outOfScope: string[] };
  repos: PlanRepoImpact[];
  contracts: PlanContract[];
  architecture: { mermaid: string; notes: string };
  risks: PlanRisk[];
  rollout: { strategy: string; flags: string[]; order: string[]; rollback: string };
  tests: { unit: string[]; integration: string[]; manual: string[] };
  estimate: { usd: number; minutes: number; prs: number };
  model: string;
  feature: string;
  createdAt: string;
  updatedAt: string;
}

interface PlanIssue {
  severity: 'error' | 'warn' | 'info';
  path: string;
  message: string;
  repo?: string;
  hint?: string;
}

interface PlanValidation {
  generatedAt: string;
  planVersion: number;
  issues: PlanIssue[];
  counts: { errors: number; warnings: number; infos: number };
}

// ── Helpers ────────────────────────────────────────────────────────────

function planToMarkdown(plan: Plan): string {
  const parts: string[] = [];
  parts.push(`# ${plan.title}`, `_Plan v${plan.version} — ${plan.project} — ${plan.model}_`, '');
  parts.push('## Problem', plan.problem, '');
  parts.push('## Scope');
  parts.push('**In scope**'); plan.scope.inScope.forEach((s) => parts.push(`- ${s}`));
  parts.push(''); parts.push('**Out of scope**'); plan.scope.outOfScope.forEach((s) => parts.push(`- ${s}`));
  parts.push('', '## Affected repositories');
  for (const r of plan.repos) {
    parts.push(`### ${r.name}`, r.changes);
    if (r.files.length) parts.push(`**Files:** ${r.files.map((f) => `\`${f}\``).join(', ')}`);
    if (r.symbols.length) parts.push(`**Symbols:** ${r.symbols.map((s) => `\`${s}\``).join(', ')}`);
    parts.push('');
  }
  if (plan.contracts.length) {
    parts.push('## Cross-repo contracts');
    for (const c of plan.contracts) {
      parts.push(`- **${c.kind.toUpperCase()} · ${c.name}** — ${c.producer} → ${c.consumers.join(', ')}`);
      parts.push(`  ${c.description}`);
    }
    parts.push('');
  }
  if (plan.architecture.notes || plan.architecture.mermaid) {
    parts.push('## Architecture');
    if (plan.architecture.notes) parts.push(plan.architecture.notes, '');
    if (plan.architecture.mermaid) parts.push('```mermaid', plan.architecture.mermaid, '```', '');
  }
  if (plan.risks.length) {
    parts.push('## Risks');
    for (const r of plan.risks) parts.push(`- **[${r.severity}] ${r.title}** — ${r.mitigation}`);
    parts.push('');
  }
  parts.push('## Rollout');
  if (plan.rollout.strategy) parts.push(plan.rollout.strategy);
  if (plan.rollout.flags.length) parts.push(`- Flags: ${plan.rollout.flags.join(', ')}`);
  if (plan.rollout.order.length) parts.push(`- Order: ${plan.rollout.order.join(' → ')}`);
  if (plan.rollout.rollback) parts.push(`- Rollback: ${plan.rollout.rollback}`);
  parts.push('', '## Tests');
  if (plan.tests.unit.length) { parts.push('**Unit**'); plan.tests.unit.forEach((t) => parts.push(`- ${t}`)); }
  if (plan.tests.integration.length) { parts.push('**Integration**'); plan.tests.integration.forEach((t) => parts.push(`- ${t}`)); }
  if (plan.tests.manual.length) { parts.push('**Manual**'); plan.tests.manual.forEach((t) => parts.push(`- ${t}`)); }
  parts.push('', '## Estimate');
  parts.push(`- ~$${plan.estimate.usd.toFixed(2)} · ${plan.estimate.minutes} min · ${plan.estimate.prs} PR(s)`);
  return parts.join('\n');
}

// ── Small layout primitives ───────────────────────────────────────────

function SectionCard({
  title, onRegen, regenLoading, issues, children,
  onEdit, isEditing, isSaving, onSave, onCancel,
}: {
  title: string;
  onRegen?: () => void;
  regenLoading?: boolean;
  issues?: PlanIssue[];
  children: React.ReactNode;
  onEdit?: () => void;
  isEditing?: boolean;
  isSaving?: boolean;
  onSave?: () => void;
  onCancel?: () => void;
}) {
  const errorCount = issues?.filter((i) => i.severity === 'error').length ?? 0;
  const warnCount  = issues?.filter((i) => i.severity === 'warn').length  ?? 0;
  const infoCount  = issues?.filter((i) => i.severity === 'info').length  ?? 0;

  const headerBtn: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    height: 24, padding: '0 8px',
    fontSize: 11, fontWeight: 500,
    background: 'transparent',
    border: '1px solid var(--separator)',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  };

  return (
    <div style={{
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
      padding: '14px 16px',
      marginBottom: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>{title}</h3>
          {errorCount > 0 && <IssueChip icon={<AlertCircle size={11} />} count={errorCount} color="var(--color-error, #ef4444)" />}
          {warnCount  > 0 && <IssueChip icon={<AlertTriangle size={11} />} count={warnCount}  color="var(--color-warning, #f59e0b)" />}
          {infoCount  > 0 && <IssueChip icon={<Info size={11} />} count={infoCount}  color="var(--text-tertiary)" />}
          {isSaving && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
              Saving…
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {isEditing ? (
            <>
              <button
                onClick={onSave}
                disabled={isSaving}
                title="Save changes"
                aria-label={`Save ${title}`}
                style={{
                  ...headerBtn,
                  color: isSaving ? 'var(--text-tertiary)' : 'var(--accent)',
                  borderColor: isSaving ? 'var(--separator)' : 'var(--accent)',
                  cursor: isSaving ? 'wait' : 'pointer',
                }}
              >
                <Check size={11} strokeWidth={2} />
                Save
              </button>
              <button
                onClick={onCancel}
                disabled={isSaving}
                title="Cancel edits"
                aria-label={`Cancel editing ${title}`}
                style={{
                  ...headerBtn,
                  color: isSaving ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                  cursor: isSaving ? 'wait' : 'pointer',
                }}
              >
                <X size={11} strokeWidth={2} />
                Cancel
              </button>
            </>
          ) : (
            <>
              {onEdit && (
                <button
                  onClick={onEdit}
                  title="Edit this section"
                  aria-label={`Edit ${title}`}
                  style={headerBtn}
                >
                  <Edit2 size={11} strokeWidth={2} />
                  Edit
                </button>
              )}
              {onRegen && (
                <button
                  onClick={onRegen}
                  disabled={regenLoading}
                  title="Regenerate this section"
                  style={{
                    ...headerBtn,
                    color: regenLoading ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                    cursor: regenLoading ? 'wait' : 'pointer',
                  }}
                >
                  <RefreshCw size={11} strokeWidth={2} style={{
                    animation: regenLoading ? 'spin 1s linear infinite' : undefined,
                  }} />
                  {regenLoading ? 'Regenerating…' : 'Regenerate'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {children}
      {issues && issues.length > 0 && (
        <ul style={{
          listStyle: 'none', padding: 0, margin: '10px 0 0',
          borderTop: '1px dashed var(--separator)', paddingTop: 8,
          fontSize: 11, color: 'var(--text-tertiary)',
        }}>
          {issues.map((i, idx) => (
            <li key={idx} style={{ marginBottom: 3 }}>
              <span style={{
                color: i.severity === 'error' ? 'var(--color-error, #ef4444)'
                  : i.severity === 'warn' ? 'var(--color-warning, #f59e0b)'
                  : 'var(--text-tertiary)',
                fontWeight: 600, marginRight: 6,
              }}>
                [{i.severity.toUpperCase()}]
              </span>
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueChip({ icon, count, color }: { icon: React.ReactNode; count: number; color: string }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      height: 18, padding: '0 6px',
      fontSize: 11, fontWeight: 600,
      color, border: `1px solid ${color}`, borderRadius: 999,
      background: 'transparent',
    }}>
      {icon}{count}
    </span>
  );
}

function KeyValueList({ items }: { items: Array<[string, string | number]> }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
      {items.map(([k, v]) => (
        <li key={k} style={{ display: 'flex', gap: 8, margin: '3px 0' }}>
          <span style={{ color: 'var(--text-tertiary)', minWidth: 90 }}>{k}</span>
          <span style={{ color: 'var(--text-primary)' }}>{v}</span>
        </li>
      ))}
    </ul>
  );
}

function ChipList({ items }: { items: string[] }) {
  if (!items.length) return <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
      {items.map((it, i) => (
        <span key={i} style={{
          fontSize: 11,
          background: 'var(--bg-elevated-3)',
          color: 'var(--text-secondary)',
          padding: '2px 7px',
          borderRadius: 999,
          fontFamily: 'var(--font-mono)',
        }}>{it}</span>
      ))}
    </div>
  );
}

function Bullets({ items, empty = '—' }: { items: string[]; empty?: string }) {
  if (!items.length) return <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{empty}</span>;
  return (
    <ul style={{ listStyle: 'disc', paddingLeft: 18, margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
      {items.map((it, i) => <li key={i} style={{ marginBottom: 3 }}>{it}</li>)}
    </ul>
  );
}

// ── Main page ──────────────────────────────────────────────────────────

export function PlanPage({ project, ws }: PlanPageProps) {
  const [feature, setFeature] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [validation, setValidation] = useState<PlanValidation | null>(null);
  const [loading, setLoading] = useState(false);
  const [regenLoading, setRegenLoading] = useState<Record<string, boolean>>({});
  const [banner, setBanner] = useState<{ level: 'info' | 'error'; message: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Variants sub-form: labels the user can edit before kicking off
  // parallel plan generations for side-by-side compare.
  const [variantsOpen, setVariantsOpen] = useState(false);
  const [variantLabels, setVariantLabels] = useState<string[]>(['Quick', 'Clean', 'Greenfield']);

  // Inline section editing: a section is in edit mode when `drafts[section]`
  // is defined. `saving[section]` is true between ws.send('save-plan') and
  // the plan-updated broadcast (or a 5s timeout) that arrives for that
  // section. Timeouts are tracked so edit mode always exits cleanly.
  const [drafts, setDrafts] = useState<Partial<Record<PlanSection, unknown>>>({});
  const [saving, setSaving] = useState<Partial<Record<PlanSection, boolean>>>({});
  const saveTimeouts = useRef<Partial<Record<PlanSection, ReturnType<typeof setTimeout>>>>({});

  const clearSaveTimeout = useCallback((section: PlanSection) => {
    const t = saveTimeouts.current[section];
    if (t) {
      clearTimeout(t);
      delete saveTimeouts.current[section];
    }
  }, []);

  const exitEditMode = useCallback((section: PlanSection) => {
    clearSaveTimeout(section);
    setDrafts((prev) => {
      if (!(section in prev)) return prev;
      const next = { ...prev };
      delete next[section];
      return next;
    });
    setSaving((prev) => {
      if (!prev[section]) return prev;
      const next = { ...prev };
      delete next[section];
      return next;
    });
  }, [clearSaveTimeout]);

  const handleStartEdit = useCallback((section: PlanSection) => {
    if (!plan) return;
    // Deep clone to avoid mutating plan state through draft edits.
    const snapshot = JSON.parse(JSON.stringify(plan[section]));
    setDrafts((prev) => ({ ...prev, [section]: snapshot }));
  }, [plan]);

  const handleDraftChange = useCallback((section: PlanSection, value: unknown) => {
    setDrafts((prev) => ({ ...prev, [section]: value }));
  }, []);

  const handleCancelEdit = useCallback((section: PlanSection) => {
    exitEditMode(section);
  }, [exitEditMode]);

  const handleSaveEdit = useCallback((section: PlanSection) => {
    if (!ws || !project || !plan) return;
    const value = drafts[section];
    if (value === undefined) return;
    setSaving((prev) => ({ ...prev, [section]: true }));
    ws.send(JSON.stringify({
      action: 'save-plan',
      project,
      planSlug: plan.slug,
      plan: { [section]: value },
    }));
    // Fallback: if plan-updated never arrives, drop edit mode after 5s so
    // the UI doesn't get stuck spinning.
    clearSaveTimeout(section);
    saveTimeouts.current[section] = setTimeout(() => {
      exitEditMode(section);
    }, 5000);
  }, [ws, project, plan, drafts, clearSaveTimeout, exitEditMode]);

  // Clean up any pending save timeouts on unmount.
  useEffect(() => {
    return () => {
      for (const t of Object.values(saveTimeouts.current)) {
        if (t) clearTimeout(t);
      }
      saveTimeouts.current = {};
    };
  }, []);

  const handleGenerate = useCallback(() => {
    if (!ws || !project || !feature.trim() || loading) return;
    setLoading(true);
    setPlan(null);
    setValidation(null);
    setBanner(null);
    ws.send(JSON.stringify({ action: 'run-plan', project, feature: feature.trim(), options: {} }));
  }, [ws, project, feature, loading]);

  // Build per-label guidance for the prompts sent to the variants runner.
  // Each variant receives the same feature but a tailored "Approach" hint.
  const hintForLabel = useCallback((label: string): string => {
    const key = label.trim().toLowerCase();
    if (key === 'quick' || key === 'quick hack') {
      return 'Ship a minimal viable slice fast; accept some tech debt and skip heavy refactors.';
    }
    if (key === 'clean') {
      return 'Refactor shared boundaries as you go; aim for maintainable, well-tested code.';
    }
    if (key === 'greenfield') {
      return 'Design as if starting fresh; propose new modules/services where it produces a cleaner architecture.';
    }
    return `Emphasise a "${label}" approach.`;
  }, []);

  const handleGenerateVariants = useCallback(() => {
    if (!ws || !project || !feature.trim() || loading) return;
    const labels = variantLabels.map((l) => l.trim()).filter((l) => l.length > 0);
    if (labels.length < 2) {
      setBanner({ level: 'error', message: 'Add at least 2 variant labels to compare.' });
      return;
    }
    const variants = labels.map((label) => ({
      label,
      prompt: `Approach: ${label}. ${hintForLabel(label)}`,
    }));
    // Persist labels so the compare view can render placeholder columns
    // (one per variant) before any plan-variant-created messages arrive.
    try {
      window.sessionStorage.setItem('anvil.planVariants.labels', JSON.stringify(labels));
    } catch { /* ignore */ }
    ws.send(JSON.stringify({
      action: 'run-plan-variants',
      project,
      feature: feature.trim(),
      variants,
      options: {},
    }));
    setBanner({ level: 'info', message: `Drafting ${labels.length} variants — opening Compare…` });
    const q = `project=${encodeURIComponent(project)}&feature=${encodeURIComponent(feature.trim())}`;
    window.setTimeout(() => {
      window.location.hash = `/plan/compare?${q}`;
    }, 250);
  }, [ws, project, feature, loading, variantLabels, hintForLabel]);

  const handleRegenSection = useCallback((section: PlanSection) => {
    if (!ws || !project || !plan) return;
    setRegenLoading((prev) => ({ ...prev, [section]: true }));
    ws.send(JSON.stringify({
      action: 'regen-plan-section',
      project,
      planSlug: plan.slug,
      section,
      options: {},
    }));
  }, [ws, project, plan]);

  const handleValidate = useCallback(() => {
    if (!ws || !project || !plan) return;
    ws.send(JSON.stringify({ action: 'validate-plan', project, planSlug: plan.slug }));
  }, [ws, project, plan]);

  const handleExecute = useCallback((force = false) => {
    if (!ws || !project || !plan) return;
    ws.send(JSON.stringify({
      action: 'execute-plan',
      project,
      planSlug: plan.slug,
      force,
      options: {},
    }));
    setBanner({ level: 'info', message: 'Pipeline starting — opening Active Runs…' });
    // Navigate to Active Runs after a short delay so the user sees the plan
    // accepted feedback before the view changes.
    window.setTimeout(() => { window.location.hash = '/runs'; }, 400);
  }, [ws, project, plan]);

  const handleCopy = useCallback(() => {
    if (!plan) return;
    navigator.clipboard.writeText(planToMarkdown(plan)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [plan]);

  const handleDownload = useCallback(() => {
    if (!plan) return;
    const blob = new Blob([planToMarkdown(plan)], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${plan.slug}-v${plan.version}.md`;
    a.click();
    URL.revokeObjectURL(url);
  }, [plan]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && feature.trim() && project) {
      e.preventDefault();
      handleGenerate();
    }
  }, [handleGenerate, feature, project]);

  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'plan-created':
          case 'plan-updated': {
            const incoming = msg.payload?.plan as Plan | undefined;
            if (incoming) {
              setPlan(incoming);
              if (msg.payload?.validation) setValidation(msg.payload.validation);
              setLoading(false);
              if (msg.payload?.section) {
                setRegenLoading((prev) => {
                  const next = { ...prev };
                  delete next[msg.payload.section];
                  return next;
                });
              }
              // An update arrived — any section currently being saved is done.
              // Drop its draft + saving state so it flips back to read mode
              // with the freshly broadcast content.
              for (const s of Object.keys(saveTimeouts.current) as PlanSection[]) {
                exitEditMode(s);
              }
            }
            break;
          }
          case 'plan-validation': {
            if (msg.payload?.validation) setValidation(msg.payload.validation);
            if (msg.payload?.blocked && msg.payload?.message) {
              setBanner({ level: 'error', message: msg.payload.message });
            }
            break;
          }
          case 'plan-error': {
            setLoading(false);
            setRegenLoading({});
            setBanner({ level: 'error', message: msg.payload?.message ?? 'Plan generation failed.' });
            break;
          }
          case 'plan-execute-started': {
            setBanner({ level: 'info', message: 'Pipeline started. Check Active Runs.' });
            break;
          }
          case 'agent-error': {
            // If an error comes through while we were waiting on a plan, clear spinners
            if (loading || Object.keys(regenLoading).length > 0) {
              setLoading(false);
              setRegenLoading({});
              setBanner({ level: 'error', message: 'Agent error — check Active Runs for details.' });
            }
            break;
          }
          default:
            break;
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, loading, regenLoading, exitEditMode]);

  // Group validation issues by section path prefix
  const issuesBySection = useMemo<Record<PlanSection, PlanIssue[]>>(() => {
    const out: Record<string, PlanIssue[]> = {};
    if (!validation) return out as Record<PlanSection, PlanIssue[]>;
    for (const issue of validation.issues) {
      const root = issue.path.split(/[[.]/)[0] as PlanSection;
      (out[root] ??= []).push(issue);
    }
    return out as Record<PlanSection, PlanIssue[]>;
  }, [validation]);

  const canGenerate = !!project && feature.trim().length > 0;
  const hasErrors = (validation?.counts.errors ?? 0) > 0;

  // Build the edit-related props for a SectionCard. Returns `isEditing` so
  // callers can conditionally render either the read view or the editor.
  const editPropsFor = (section: PlanSection) => {
    const isEditing = section in drafts;
    return {
      isEditing,
      isSaving: !!saving[section],
      onEdit: () => handleStartEdit(section),
      onSave: () => handleSaveEdit(section),
      onCancel: () => handleCancelEdit(section),
    };
  };

  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)', maxWidth: 960, margin: '0 auto',
      height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexShrink: 0,
      }}>
        <Map size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Plan</h2>
        {project && <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>}
        {plan && (
          <span style={{
            fontSize: 11, color: 'var(--text-tertiary)',
            padding: '2px 8px', borderRadius: 999,
            background: 'var(--bg-elevated-3)', marginLeft: 'auto',
          }}>
            v{plan.version} · {plan.slug}
          </span>
        )}
      </div>

      {/* Input row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 12, flexShrink: 0,
      }}>
        <input
          value={feature}
          onChange={(e) => setFeature(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Describe the feature to plan (⌘↵ to generate)…"
          style={{
            flex: 1, height: 40, padding: '0 16px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-primary)',
            fontSize: 14, fontFamily: 'var(--font-sans)',
            outline: 'none',
          }}
        />
        <button
          onClick={handleGenerate}
          disabled={loading || !canGenerate}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            height: 40, padding: '0 18px',
            fontSize: 13, fontWeight: 600,
            background: 'var(--accent)', color: 'var(--text-inverse)',
            border: 'none', borderRadius: 'var(--radius-sm)',
            cursor: loading || !canGenerate ? 'not-allowed' : 'pointer',
            opacity: loading || !canGenerate ? 0.6 : 1,
            fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
          }}
        >
          <Map size={14} strokeWidth={1.75} />
          {loading ? 'Drafting…' : plan ? 'Re-plan' : 'Generate Plan'}
        </button>
        <button
          onClick={() => setVariantsOpen((v) => !v)}
          disabled={loading || !canGenerate}
          title="Generate 2–4 plan variants to compare side-by-side"
          aria-expanded={variantsOpen}
          aria-controls="plan-variants-form"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 40, padding: '0 14px',
            fontSize: 12, fontWeight: 500,
            background: variantsOpen ? 'var(--bg-elevated-3)' : 'transparent',
            color: 'var(--text-secondary)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            cursor: loading || !canGenerate ? 'not-allowed' : 'pointer',
            opacity: loading || !canGenerate ? 0.6 : 1,
            fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
          }}
        >
          <Map size={12} strokeWidth={1.75} />
          Generate variants
        </button>
      </div>

      {/* Routing — read-only, sourced from ~/.anvil/stage-policy.yaml */}
      <RoutingCard flow="plan" ws={ws} compact />

      {/* Variants sub-form */}
      {variantsOpen && (
        <div
          id="plan-variants-form"
          role="region"
          aria-label="Plan variants"
          style={{
            marginBottom: 12, padding: '10px 12px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            flexShrink: 0,
          }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8,
          }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>
              Variants
            </span>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              Each label becomes a parallel plan draft with its own approach.
            </span>
            <button
              onClick={() => setVariantsOpen(false)}
              aria-label="Close variants form"
              style={{
                marginLeft: 'auto',
                background: 'transparent', border: 'none',
                color: 'var(--text-tertiary)', cursor: 'pointer',
                display: 'inline-flex', alignItems: 'center',
              }}
            >
              <X size={14} strokeWidth={2} />
            </button>
          </div>
          <div style={{
            display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8,
          }}>
            {variantLabels.map((label, i) => (
              <div
                key={i}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-sm)',
                  padding: '0 2px 0 8px',
                  height: 28,
                }}
              >
                <input
                  value={label}
                  onChange={(e) => setVariantLabels((prev) => prev.map((l, idx) => (idx === i ? e.target.value : l)))}
                  aria-label={`Variant ${i + 1} label`}
                  style={{
                    minWidth: 90, width: Math.max(90, label.length * 8 + 24),
                    border: 'none', background: 'transparent',
                    color: 'var(--text-primary)', fontSize: 12,
                    fontFamily: 'var(--font-sans)', outline: 'none',
                  }}
                />
                <button
                  onClick={() => setVariantLabels((prev) => prev.filter((_, idx) => idx !== i))}
                  disabled={variantLabels.length <= 1}
                  aria-label={`Remove variant ${label || i + 1}`}
                  style={{
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    width: 22, height: 22,
                    background: 'transparent', border: 'none',
                    color: 'var(--text-tertiary)',
                    cursor: variantLabels.length <= 1 ? 'not-allowed' : 'pointer',
                  }}
                >
                  <X size={11} strokeWidth={2} />
                </button>
              </div>
            ))}
            <button
              onClick={() => setVariantLabels((prev) => (prev.length >= 4 ? prev : [...prev, `Variant ${prev.length + 1}`]))}
              disabled={variantLabels.length >= 4}
              aria-label="Add variant"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                height: 28, padding: '0 10px',
                background: 'transparent',
                border: '1px dashed var(--separator)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                fontSize: 12, fontWeight: 500,
                cursor: variantLabels.length >= 4 ? 'not-allowed' : 'pointer',
                opacity: variantLabels.length >= 4 ? 0.5 : 1,
                fontFamily: 'var(--font-sans)',
              }}
            >
              + Add variant
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <RoutingCard flow="plan" ws={ws} compact />
            <button
              onClick={handleGenerateVariants}
              disabled={loading || !canGenerate || variantLabels.filter((l) => l.trim()).length < 2}
              style={{
                marginLeft: 'auto',
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 30, padding: '0 14px',
                fontSize: 12, fontWeight: 600,
                background: 'var(--accent)', color: 'var(--text-inverse)',
                border: 'none', borderRadius: 'var(--radius-sm)',
                cursor: (loading || !canGenerate || variantLabels.filter((l) => l.trim()).length < 2) ? 'not-allowed' : 'pointer',
                opacity: (loading || !canGenerate || variantLabels.filter((l) => l.trim()).length < 2) ? 0.6 : 1,
                fontFamily: 'var(--font-sans)',
              }}
            >
              Submit
            </button>
          </div>
        </div>
      )}

      {/* Banner */}
      {banner && (
        <div style={{
          marginBottom: 12, padding: '8px 12px',
          borderRadius: 'var(--radius-sm)',
          background: banner.level === 'error' ? 'rgba(239,68,68,0.10)' : 'var(--bg-elevated-2)',
          border: `1px solid ${banner.level === 'error' ? 'var(--color-error, #ef4444)' : 'var(--separator)'}`,
          fontSize: 12, color: banner.level === 'error' ? 'var(--color-error, #ef4444)' : 'var(--text-secondary)',
          display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
        }}>
          <span>{banner.message}</span>
          <button
            onClick={() => setBanner(null)}
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12 }}
          >✕</button>
        </div>
      )}

      {/* Empty state */}
      {!plan && !loading && (
        <div style={{
          flex: 1, display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          color: 'var(--text-tertiary)', gap: 12,
        }}>
          <Map size={32} style={{ opacity: 0.3 }} />
          <span>Describe a feature to generate a structured plan.</span>
          <span style={{ fontSize: 11, maxWidth: 420, textAlign: 'center' }}>
            Plans are validated against the Knowledge Base before execution — cheap, cancellable, and re-runnable per section.
          </span>
        </div>
      )}

      {/* Loading state */}
      {loading && !plan && (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          gap: 10, color: 'var(--text-tertiary)', fontSize: 14,
        }}>
          <div className="status-dot-spin" style={{ width: 16, height: 16 }} />
          <span>Drafting plan — this usually costs a few cents.</span>
        </div>
      )}

      {/* Plan body */}
      {plan && (
        <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 6 }}>
          {/* Validation summary */}
          {validation && (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '8px 12px', marginBottom: 12,
              background: hasErrors ? 'rgba(239,68,68,0.06)' : 'var(--bg-elevated-2)',
              border: `1px solid ${hasErrors ? 'var(--color-error, #ef4444)' : 'var(--separator)'}`,
              borderRadius: 'var(--radius-sm)',
              fontSize: 12, color: 'var(--text-secondary)',
            }}>
              {hasErrors
                ? <AlertCircle size={14} style={{ color: 'var(--color-error, #ef4444)' }} />
                : <CheckCircle2 size={14} style={{ color: 'var(--color-success, #22c55e)' }} />}
              <span>
                {hasErrors
                  ? `${validation.counts.errors} error(s) · `
                  : 'Validated · '}
                {validation.counts.warnings} warning(s) · {validation.counts.infos} info(s)
              </span>
              <button
                onClick={handleValidate}
                style={{
                  marginLeft: 'auto',
                  background: 'transparent',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                  fontSize: 11, padding: '3px 8px', cursor: 'pointer',
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                }}
              >
                <ClipboardCheck size={11} /> Re-validate
              </button>
            </div>
          )}

          {/* Title */}
          <div style={{
            fontSize: 16, fontWeight: 600, color: 'var(--text-primary)',
            marginBottom: 2,
          }}>{plan.title}</div>
          <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 14 }}>
            {plan.feature}
          </div>

          <SectionCard
            title="Problem"
            onRegen={() => handleRegenSection('problem')}
            regenLoading={regenLoading.problem}
            issues={issuesBySection.problem}
            {...editPropsFor('problem')}
          >
            {'problem' in drafts ? (
              <ProblemEditor
                value={(drafts.problem as string) ?? ''}
                onChange={(v: any) => handleDraftChange('problem', v)}
              />
            ) : (
              <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                {plan.problem}
              </p>
            )}
          </SectionCard>

          <SectionCard
            title="Scope"
            onRegen={() => handleRegenSection('scope')}
            regenLoading={regenLoading.scope}
            issues={issuesBySection.scope}
            {...editPropsFor('scope')}
          >
            {'scope' in drafts ? (
              <ScopeEditor
                value={drafts.scope as Plan['scope']}
                onChange={(v: any) => handleDraftChange('scope', v)}
              />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>IN SCOPE</div>
                  <Bullets items={plan.scope.inScope} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>OUT OF SCOPE</div>
                  <Bullets items={plan.scope.outOfScope} />
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Affected repositories"
            onRegen={() => handleRegenSection('repos')}
            regenLoading={regenLoading.repos}
            issues={issuesBySection.repos}
            {...editPropsFor('repos')}
          >
            {'repos' in drafts ? (
              <ReposEditor
                value={drafts.repos as PlanRepoImpact[]}
                onChange={(v: any) => handleDraftChange('repos', v)}
              />
            ) : plan.repos.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No repos yet.</span>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {plan.repos.map((r) => (
                  <div key={r.name} style={{
                    padding: 10,
                    background: 'var(--bg-base)',
                    border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-sm)',
                  }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4, color: 'var(--text-primary)' }}>
                      {r.name}
                    </div>
                    <p style={{ margin: '0 0 8px', fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {r.changes}
                    </p>
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>FILES</div>
                    <ChipList items={r.files} />
                    <div style={{ height: 6 }} />
                    <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>SYMBOLS</div>
                    <ChipList items={r.symbols} />
                  </div>
                ))}
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Cross-repo contracts"
            onRegen={() => handleRegenSection('contracts')}
            regenLoading={regenLoading.contracts}
            issues={issuesBySection.contracts}
            {...editPropsFor('contracts')}
          >
            {'contracts' in drafts ? (
              <ContractsEditor
                value={drafts.contracts as PlanContract[]}
                onChange={(v: any) => handleDraftChange('contracts', v)}
              />
            ) : plan.contracts.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No cross-repo contracts.</span>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {plan.contracts.map((c, i) => (
                  <li key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                    <span style={{
                      fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
                      padding: '2px 6px', borderRadius: 4,
                      background: 'var(--bg-elevated-3)', color: 'var(--text-secondary)',
                      marginRight: 6, textTransform: 'uppercase',
                    }}>{c.kind}</span>
                    <strong style={{ color: 'var(--text-primary)' }}>{c.name}</strong>
                    <span style={{ color: 'var(--text-tertiary)' }}>
                      {'  '}— {c.producer} → {c.consumers.join(', ') || '(none)'}
                    </span>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>{c.description}</div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Architecture"
            onRegen={() => handleRegenSection('architecture')}
            regenLoading={regenLoading.architecture}
            issues={issuesBySection.architecture}
            {...editPropsFor('architecture')}
          >
            {'architecture' in drafts ? (
              <ArchitectureEditor
                value={drafts.architecture as Plan['architecture']}
                onChange={(v: any) => handleDraftChange('architecture', v)}
              />
            ) : (
              <>
                {plan.architecture.notes && (
                  <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    {plan.architecture.notes}
                  </p>
                )}
                {plan.architecture.mermaid ? (
                  <pre style={{
                    background: 'var(--bg-base)', padding: 10,
                    borderRadius: 'var(--radius-sm)', fontSize: 11,
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    overflowX: 'auto', margin: 0, lineHeight: 1.5,
                  }}>{plan.architecture.mermaid}</pre>
                ) : (
                  !plan.architecture.notes && <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
                )}
              </>
            )}
          </SectionCard>

          <SectionCard
            title="Risks"
            onRegen={() => handleRegenSection('risks')}
            regenLoading={regenLoading.risks}
            issues={issuesBySection.risks}
            {...editPropsFor('risks')}
          >
            {'risks' in drafts ? (
              <RisksEditor
                value={drafts.risks as PlanRisk[]}
                onChange={(v: any) => handleDraftChange('risks', v)}
              />
            ) : plan.risks.length === 0 ? (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No risks identified.</span>
            ) : (
              <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                {plan.risks.map((r, i) => (
                  <li key={i} style={{ marginBottom: 8, fontSize: 13 }}>
                    <span style={{
                      fontSize: 10, fontWeight: 700, marginRight: 6,
                      padding: '1px 6px', borderRadius: 4,
                      background: r.severity === 'high' ? 'rgba(239,68,68,0.12)'
                        : r.severity === 'med' ? 'rgba(245,158,11,0.12)'
                        : 'var(--bg-elevated-3)',
                      color: r.severity === 'high' ? 'var(--color-error, #ef4444)'
                        : r.severity === 'med' ? 'var(--color-warning, #f59e0b)'
                        : 'var(--text-tertiary)',
                      textTransform: 'uppercase',
                    }}>{r.severity}</span>
                    <strong style={{ color: 'var(--text-primary)' }}>{r.title}</strong>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                      <em style={{ color: 'var(--text-tertiary)' }}>Mitigation:</em> {r.mitigation}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </SectionCard>

          <SectionCard
            title="Rollout"
            onRegen={() => handleRegenSection('rollout')}
            regenLoading={regenLoading.rollout}
            issues={issuesBySection.rollout}
            {...editPropsFor('rollout')}
          >
            {'rollout' in drafts ? (
              <RolloutEditor
                value={drafts.rollout as Plan['rollout']}
                onChange={(v: any) => handleDraftChange('rollout', v)}
              />
            ) : (
              <>
                {plan.rollout.strategy && (
                  <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    {plan.rollout.strategy}
                  </p>
                )}
                <KeyValueList items={[
                  ['Flags', plan.rollout.flags.join(', ') || '—'],
                  ['Order', plan.rollout.order.join(' → ') || '—'],
                  ['Rollback', plan.rollout.rollback || '—'],
                ]} />
              </>
            )}
          </SectionCard>

          <SectionCard
            title="Tests"
            onRegen={() => handleRegenSection('tests')}
            regenLoading={regenLoading.tests}
            issues={issuesBySection.tests}
            {...editPropsFor('tests')}
          >
            {'tests' in drafts ? (
              <TestsEditor
                value={drafts.tests as Plan['tests']}
                onChange={(v: any) => handleDraftChange('tests', v)}
              />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>UNIT</div>
                  <Bullets items={plan.tests.unit} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>INTEGRATION</div>
                  <Bullets items={plan.tests.integration} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4 }}>MANUAL</div>
                  <Bullets items={plan.tests.manual} />
                </div>
              </div>
            )}
          </SectionCard>

          <SectionCard
            title="Estimate"
            onRegen={() => handleRegenSection('estimate')}
            regenLoading={regenLoading.estimate}
            issues={issuesBySection.estimate}
            {...editPropsFor('estimate')}
          >
            {'estimate' in drafts ? (
              <EstimateEditor
                value={drafts.estimate as Plan['estimate']}
                onChange={(v: any) => handleDraftChange('estimate', v)}
              />
            ) : (
              <KeyValueList items={[
                ['Cost', `~$${plan.estimate.usd.toFixed(2)}`],
                ['Duration', `${plan.estimate.minutes} min`],
                ['Pull requests', String(plan.estimate.prs)],
              ]} />
            )}
          </SectionCard>

          <div style={{ height: 60 }} /> {/* spacer for bottom action bar */}
        </div>
      )}

      {/* Action bar */}
      {plan && (
        <div style={{
          flexShrink: 0, marginTop: 8,
          padding: '10px 12px',
          display: 'flex', alignItems: 'center', gap: 8,
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
        }}>
          <button
            onClick={() => handleExecute(false)}
            disabled={hasErrors}
            title={hasErrors ? 'Fix validation errors or force-execute' : 'Start the pipeline from this plan'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: 34, padding: '0 16px',
              fontSize: 13, fontWeight: 600,
              background: hasErrors ? 'var(--bg-elevated-3)' : 'var(--accent)',
              color: hasErrors ? 'var(--text-tertiary)' : 'var(--text-inverse)',
              border: 'none', borderRadius: 'var(--radius-sm)',
              cursor: hasErrors ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <Play size={14} strokeWidth={1.75} />
            Execute pipeline
          </button>
          {hasErrors && (
            <button
              onClick={() => handleExecute(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 34, padding: '0 14px',
                fontSize: 12, fontWeight: 500,
                background: 'transparent',
                border: '1px solid var(--color-error, #ef4444)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--color-error, #ef4444)',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}
            >
              Force execute anyway
            </button>
          )}
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 8 }}>
            Estimated ~${plan.estimate.usd.toFixed(2)} · {plan.estimate.prs} PR(s)
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              onClick={handleCopy}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 30, padding: '0 12px',
                fontSize: 12, fontWeight: 500,
                background: 'var(--bg-elevated-3)',
                color: copied ? 'var(--color-success, #22c55e)' : 'var(--text-secondary)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}
            >
              <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={handleDownload}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                height: 30, padding: '0 12px',
                fontSize: 12, fontWeight: 500,
                background: 'var(--bg-elevated-3)',
                color: 'var(--text-secondary)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer', fontFamily: 'var(--font-sans)',
              }}
            >
              <Download size={12} /> Download
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default PlanPage;
