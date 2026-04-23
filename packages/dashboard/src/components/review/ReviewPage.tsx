import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  GitPullRequest,
  AlertCircle,
  AlertTriangle,
  Info,
  Minus,
  CheckCircle2,
  XCircle,
  MessageSquare,
  Upload,
  RefreshCw,
  ChevronDown,
  ChevronRight,
  Wrench,
  ExternalLink,
  Shield,
  Bug,
  FileCode,
  Gauge,
  BookOpen,
  Layers,
  Loader2,
  Check,
  X,
  Ban,
  Clock,
} from 'lucide-react';

export interface ReviewPageProps {
  project: string | null;
  ws: WebSocket | null;
}

// ── Types (mirror server review-store.ts) ──────────────────────────────

type Severity = 'blocker' | 'error' | 'warn' | 'info' | 'nit';
type Category = 'correctness' | 'security' | 'convention' | 'test' | 'perf' | 'docs' | 'plan-drift';
type Verdict = 'approve' | 'request-changes' | 'comment';
type Persona = 'architect' | 'security' | 'style' | 'tester' | 'domain';
type Resolution = 'pending' | 'addressed' | 'dismissed' | 'wont-fix';

interface ReviewFinding {
  id: string;
  severity: Severity;
  category: Category;
  persona?: Persona;
  file: string;
  line: number;
  snippet: string;
  description: string;
  suggestedFix: { diff: string; rationale: string } | null;
  kbRef?: { nodeId: string; repo: string };
  cve?: string;
  confidence: 'high' | 'med' | 'low';
  resolution: Resolution;
}

interface PlanComplianceReport {
  matchRate: number;
  unplannedFiles: Array<{ repo: string; file: string; severity: 'warn' | 'info' }>;
  missedFiles: Array<{ repo: string; file: string; severity: 'error' | 'warn' }>;
  missedSymbols: string[];
  deliveredContracts: string[];
  missingContracts: string[];
}

interface Review {
  version: number;
  id: string;
  project: string;
  pr: { repo: string; number: number; url: string; headSha: string; baseSha: string };
  planSlug?: string;
  trigger: 'ship' | 'push' | 'manual' | 'webhook' | 'schedule';
  personas: Persona[];
  diffStats: { additions: number; deletions: number; files: number };
  findings: ReviewFinding[];
  planCompliance: PlanComplianceReport | null;
  convention: { rulesChecked: number; violations: number };
  security: { checks: string[]; flags: number };
  summary: string;
  verdict: Verdict;
  estimate: { usd: number; seconds: number };
  model: string;
  createdAt: string;
  startedAt: string;
  completedAt: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const models = [
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4' },
  { value: 'claude-opus-4-6', label: 'Opus 4' },
  { value: 'gpt-4o', label: 'GPT-4o' },
];

const ALL_PERSONAS: Persona[] = ['architect', 'security', 'style', 'tester', 'domain'];

const personaConfig: Record<Persona, { label: string; icon: React.ComponentType<any> }> = {
  architect: { label: 'Architect', icon: Layers },
  security: { label: 'Security', icon: Shield },
  style: { label: 'Style', icon: FileCode },
  tester: { label: 'Tester', icon: Bug },
  domain: { label: 'Domain', icon: BookOpen },
};

const severityConfig: Record<Severity, {
  label: string;
  color: string;
  icon: React.ComponentType<any>;
  weight: number;
}> = {
  blocker: { label: 'Blocker', color: 'var(--color-error, #ef4444)', icon: AlertCircle, weight: 4 },
  error:   { label: 'Error',   color: 'var(--color-error, #ef4444)', icon: AlertCircle, weight: 3 },
  warn:    { label: 'Warn',    color: 'var(--color-warning, #f59e0b)', icon: AlertTriangle, weight: 2 },
  info:    { label: 'Info',    color: 'var(--color-info, #3b82f6)', icon: Info, weight: 1 },
  nit:     { label: 'Nit',     color: 'var(--text-tertiary)', icon: Minus, weight: 0 },
};

const categoryConfig: Record<Category, { label: string; color: string }> = {
  correctness: { label: 'correctness', color: 'var(--color-error, #ef4444)' },
  security:    { label: 'security',    color: 'var(--color-error, #ef4444)' },
  convention:  { label: 'convention',  color: 'var(--text-tertiary)' },
  test:        { label: 'test',        color: 'var(--color-info, #3b82f6)' },
  perf:        { label: 'perf',        color: 'var(--color-warning, #f59e0b)' },
  docs:        { label: 'docs',        color: 'var(--text-tertiary)' },
  'plan-drift': { label: 'plan-drift', color: 'var(--color-warning, #f59e0b)' },
};

const verdictConfig: Record<Verdict, {
  label: string;
  background: string;
  border: string;
  color: string;
  icon: React.ComponentType<any>;
}> = {
  approve: {
    label: 'Approved',
    background: 'rgba(34, 197, 94, 0.08)',
    border: 'var(--color-success, #22c55e)',
    color: 'var(--color-success, #22c55e)',
    icon: CheckCircle2,
  },
  'request-changes': {
    label: 'Changes requested',
    background: 'rgba(239, 68, 68, 0.08)',
    border: 'var(--color-error, #ef4444)',
    color: 'var(--color-error, #ef4444)',
    icon: XCircle,
  },
  comment: {
    label: 'Comment only',
    background: 'var(--bg-elevated-2)',
    border: 'var(--separator)',
    color: 'var(--text-secondary)',
    icon: MessageSquare,
  },
};

const resolutionConfig: Record<Exclude<Resolution, 'pending'>, {
  label: string;
  color: string;
  icon: React.ComponentType<any>;
}> = {
  addressed: { label: 'Addressed', color: 'var(--color-success, #22c55e)', icon: Check },
  dismissed: { label: 'Dismissed', color: 'var(--text-tertiary)', icon: X },
  'wont-fix': { label: "Won't fix", color: 'var(--text-tertiary)', icon: Ban },
};

// ── Shared small primitives ────────────────────────────────────────────

function Pill({
  children,
  color = 'var(--text-tertiary)',
  bg,
  border,
  mono,
}: {
  children: React.ReactNode;
  color?: string;
  bg?: string;
  border?: string;
  mono?: boolean;
}) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      height: 18, padding: '0 7px',
      fontSize: 10, fontWeight: 600,
      color,
      background: bg ?? 'var(--bg-elevated-3)',
      border: border ?? '1px solid transparent',
      borderRadius: 999,
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
      textTransform: 'uppercase',
      letterSpacing: 0.3,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

function ConfidenceDot({ confidence }: { confidence: 'high' | 'med' | 'low' }) {
  const base = {
    width: 8, height: 8, borderRadius: 999,
    display: 'inline-block',
    flexShrink: 0,
  } as const;
  const label = `Confidence: ${confidence}`;
  if (confidence === 'high') {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        style={{ ...base, background: 'var(--text-secondary)' }}
      />
    );
  }
  if (confidence === 'med') {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        style={{ ...base, background: 'transparent', border: '1.5px solid var(--text-secondary)' }}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ ...base, background: 'transparent', border: '1.5px dashed var(--text-tertiary)' }}
    />
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function parseGithubPrUrl(input: string): { repo: string; number: number } | null {
  try {
    const url = new URL(input.trim());
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (!match) return null;
    return { repo: `${match[1]}/${match[2]}`, number: parseInt(match[3], 10) };
  } catch {
    return null;
  }
}

function countBySeverity(findings: ReviewFinding[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { blocker: 0, error: 0, warn: 0, info: 0, nit: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

// ── Main page ──────────────────────────────────────────────────────────

export function ReviewPage({ project, ws }: ReviewPageProps) {
  // Input form
  const [prUrl, setPrUrl] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [personas, setPersonas] = useState<Persona[]>(ALL_PERSONAS);
  const [personasOpen, setPersonasOpen] = useState(false);

  // Review lifecycle
  const [review, setReview] = useState<Review | null>(null);
  const [loading, setLoading] = useState(false);
  const [runningReviewId, setRunningReviewId] = useState<string | null>(null);
  const [runningPersonas, setRunningPersonas] = useState<Persona[]>([]);
  const [donePersonas, setDonePersonas] = useState<Record<Persona, number>>({} as Record<Persona, number>);

  // Async action state
  const [publishing, setPublishing] = useState(false);
  const [rereviewing, setRereviewing] = useState(false);
  const [applyingFix, setApplyingFix] = useState<Record<string, boolean>>({});
  const [resolvingId, setResolvingId] = useState<string | null>(null);
  const [publishedResult, setPublishedResult] = useState<{ commentsPosted: number; summaryUrl: string } | null>(null);

  // Remembers the previous resolution of the last-resolved finding for Undo.
  const lastResolveRef = useRef<{ findingId: string; prev: Resolution } | null>(null);
  const [toast, setToast] = useState<{ message: string; canUndo: boolean } | null>(null);
  const toastTimeoutRef = useRef<number | null>(null);

  const showToast = useCallback((message: string, canUndo = true) => {
    setToast({ message, canUndo });
    if (toastTimeoutRef.current) window.clearTimeout(toastTimeoutRef.current);
    toastTimeoutRef.current = window.setTimeout(() => setToast(null), 4000);
  }, []);

  // UI state
  const [banner, setBanner] = useState<{ level: 'info' | 'error' | 'success'; message: string } | null>(null);
  const [collapsedCategories, setCollapsedCategories] = useState<Partial<Record<Category, boolean>>>({});
  const [planComplianceOpen, setPlanComplianceOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);

  const personasWrapperRef = useRef<HTMLDivElement>(null);

  // Close persona multiselect on outside click
  useEffect(() => {
    if (!personasOpen) return;
    const handler = (e: MouseEvent) => {
      if (!personasWrapperRef.current) return;
      if (!personasWrapperRef.current.contains(e.target as Node)) {
        setPersonasOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [personasOpen]);

  // Rehydrate from query string on mount.
  useEffect(() => {
    if (!ws || !project) return;
    const params = new URLSearchParams(window.location.hash.includes('?')
      ? window.location.hash.split('?')[1]
      : window.location.search);
    const reviewId = params.get('reviewId');
    if (reviewId) {
      ws.send(JSON.stringify({ action: 'get-review', project, reviewId }));
    }
    // Only run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ws, project]);

  const togglePersona = useCallback((p: Persona) => {
    setPersonas((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  }, []);

  const canStart = !!project && !!ws && parseGithubPrUrl(prUrl) !== null && personas.length > 0 && !loading;

  const handleStart = useCallback(() => {
    if (!canStart) return;
    setLoading(true);
    setReview(null);
    setRunningPersonas(personas);
    setDonePersonas({} as Record<Persona, number>);
    setBanner(null);
    setPublishedResult(null);
    ws!.send(JSON.stringify({
      action: 'run-review-pr',
      project,
      prUrl: prUrl.trim(),
      options: { model, personas },
    }));
  }, [canStart, ws, project, prUrl, model, personas]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canStart) {
      e.preventDefault();
      handleStart();
    }
  }, [handleStart, canStart]);

  const handlePublish = useCallback(() => {
    if (!ws || !project || !review) return;
    setPublishing(true);
    setBanner(null);
    ws.send(JSON.stringify({ action: 'publish-review', project, reviewId: review.id }));
  }, [ws, project, review]);

  const handleRereview = useCallback(() => {
    if (!ws || !project || !review) return;
    setRereviewing(true);
    setBanner({ level: 'info', message: 'Re-reviewing latest push…' });
    ws.send(JSON.stringify({ action: 'run-review-incremental', project, reviewId: review.id }));
  }, [ws, project, review]);

  const handleApplyFix = useCallback((findingId: string) => {
    if (!ws || !project || !review) return;
    setApplyingFix((prev) => ({ ...prev, [findingId]: true }));
    ws.send(JSON.stringify({
      action: 'apply-review-fix',
      project,
      reviewId: review.id,
      findingId,
    }));
  }, [ws, project, review]);

  const handleResolve = useCallback((findingId: string, resolution: 'addressed' | 'dismissed' | 'wont-fix') => {
    if (!ws || !project || !review) return;
    setResolvingId(findingId);
    // Remember the prior resolution so we can offer undo.
    const prev = review.findings.find((f) => f.id === findingId)?.resolution ?? 'pending';
    lastResolveRef.current = { findingId, prev };
    ws.send(JSON.stringify({
      action: 'resolve-review-finding',
      project,
      reviewId: review.id,
      findingId,
      resolution,
    }));
  }, [ws, project, review]);

  const handleUndoResolve = useCallback(() => {
    if (!ws || !project || !review || !lastResolveRef.current) return;
    const { findingId, prev } = lastResolveRef.current;
    lastResolveRef.current = null;
    setResolvingId(findingId);
    ws.send(JSON.stringify({
      action: 'resolve-review-finding',
      project,
      reviewId: review.id,
      findingId,
      resolution: prev,
    }));
  }, [ws, project, review]);

  const toggleCategory = useCallback((cat: Category) => {
    setCollapsedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  }, []);

  // WebSocket subscription
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      switch (msg.type) {
        case 'review-started': {
          const p = msg.payload;
          setRunningReviewId(p?.reviewId ?? null);
          if (Array.isArray(p?.personas)) setRunningPersonas(p.personas);
          setLoading(true);
          break;
        }
        case 'review-persona-done': {
          const p = msg.payload;
          if (p?.persona) {
            setDonePersonas((prev) => ({ ...prev, [p.persona]: p.findingCount ?? 0 }));
          }
          break;
        }
        case 'review-created':
        case 'review-updated': {
          const incoming = msg.payload?.review as Review | undefined;
          if (incoming) {
            setReview(incoming);
            setLoading(false);
            setRereviewing(false);
            setRunningReviewId(incoming.id);
            // Clear any transient resolve spinner — latest review is authoritative.
            setResolvingId(null);
            setApplyingFix({});
          }
          break;
        }
        case 'review-error': {
          setLoading(false);
          setRereviewing(false);
          setPublishing(false);
          setBanner({ level: 'error', message: msg.payload?.message ?? 'Review failed.' });
          break;
        }
        case 'review-published': {
          setPublishing(false);
          const p = msg.payload;
          setPublishedResult({
            commentsPosted: p?.commentsPosted ?? 0,
            summaryUrl: p?.summaryUrl ?? '',
          });
          setBanner({
            level: 'success',
            message: `Posted ${p?.commentsPosted ?? 0} comment(s) to GitHub.`,
          });
          break;
        }
        case 'review-fix-applied': {
          const p = msg.payload;
          if (p?.findingId) {
            setApplyingFix((prev) => {
              const next = { ...prev };
              delete next[p.findingId];
              return next;
            });
            setBanner({
              level: 'success',
              message: `Fix committed: ${String(p.commitSha ?? '').slice(0, 7)}.`,
            });
          }
          break;
        }
        case 'review-finding-resolved': {
          setResolvingId(null);
          const p = msg.payload;
          if (p?.review && p.review.id === review?.id) {
            setReview(p.review as Review);
          } else if (p?.findingId && p?.resolution && review) {
            setReview({
              ...review,
              findings: review.findings.map((f) =>
                f.id === p.findingId ? { ...f, resolution: p.resolution as Resolution } : f,
              ),
            });
          }
          // Visual feedback — toast with Undo (unless the change WAS an undo).
          const res: Resolution | undefined = p?.resolution;
          if (res && res !== 'pending') {
            const label = res === 'dismissed' ? 'Finding dismissed'
              : res === 'wont-fix' ? "Marked as won't fix"
              : 'Finding marked addressed';
            showToast(label, lastResolveRef.current?.findingId === p.findingId);
          } else if (res === 'pending') {
            showToast('Restored', false);
          }
          break;
        }
        default: break;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const sevCounts = useMemo(
    () => review ? countBySeverity(review.findings) : null,
    [review],
  );

  // Group findings by category, preserving a stable category ordering.
  // Resolved findings (addressed/dismissed/wont-fix) are excluded from the
  // main list unless `showResolved` is toggled on — the count still shows.
  const [showResolved, setShowResolved] = useState(false);

  const findingsByCategory = useMemo(() => {
    if (!review) return [] as Array<[Category, ReviewFinding[]]>;
    const order: Category[] = ['correctness', 'security', 'plan-drift', 'test', 'perf', 'convention', 'docs'];
    const grouped: Record<string, ReviewFinding[]> = {};
    for (const f of review.findings) {
      if (!showResolved && f.resolution !== 'pending') continue;
      (grouped[f.category] ??= []).push(f);
    }
    for (const cat of Object.keys(grouped)) {
      grouped[cat].sort((a, b) => {
        const sev = severityConfig[b.severity].weight - severityConfig[a.severity].weight;
        if (sev !== 0) return sev;
        const pa = a.resolution === 'pending' ? 0 : 1;
        const pb = b.resolution === 'pending' ? 0 : 1;
        return pa - pb;
      });
    }
    return order
      .filter((c) => grouped[c]?.length)
      .map((c) => [c, grouped[c]] as [Category, ReviewFinding[]]);
  }, [review, showResolved]);

  const resolvedCounts = useMemo(() => {
    const counts = { addressed: 0, dismissed: 0, 'wont-fix': 0, total: 0 };
    for (const f of review?.findings ?? []) {
      if (f.resolution === 'pending') continue;
      counts[f.resolution as 'addressed' | 'dismissed' | 'wont-fix']++;
      counts.total++;
    }
    return counts;
  }, [review]);

  const parsedPr = useMemo(() => parseGithubPrUrl(prUrl), [prUrl]);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)', maxWidth: 960, margin: '0 auto',
      height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexShrink: 0,
      }}>
        <GitPullRequest size={20} style={{ color: 'var(--accent)' }} aria-hidden="true" />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>PR Review</h2>
        {project && <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>}
        {review && (
          <a
            href={review.pr.url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              marginLeft: 'auto',
              fontSize: 11, color: 'var(--text-tertiary)',
              padding: '2px 8px', borderRadius: 999,
              background: 'var(--bg-elevated-3)',
              display: 'inline-flex', alignItems: 'center', gap: 4,
              textDecoration: 'none',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {review.pr.repo} #{review.pr.number}
            <ExternalLink size={10} strokeWidth={1.75} aria-hidden="true" />
          </a>
        )}
      </div>

      {/* Input row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 12, flexShrink: 0,
      }}>
        <input
          ref={inputRef}
          value={prUrl}
          onChange={(e) => setPrUrl(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-label="Pull request URL"
          placeholder="https://github.com/owner/repo/pull/123  (⌘↵ to start)"
          style={{
            flex: 1, height: 40, padding: '0 16px',
            background: 'var(--bg-elevated-2)',
            border: `1px solid ${prUrl && !parsedPr ? 'var(--color-error, #ef4444)' : 'var(--separator)'}`,
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-primary)',
            fontSize: 13, fontFamily: 'var(--font-mono)',
            outline: 'none',
          }}
        />
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          aria-label="Model"
          style={{
            appearance: 'none', height: 40, padding: '0 12px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-secondary)',
            fontSize: 12, fontFamily: 'var(--font-sans)',
            cursor: 'pointer', outline: 'none',
          }}
        >
          {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>

        {/* Persona multi-select */}
        <div ref={personasWrapperRef} style={{ position: 'relative' }}>
          <button
            onClick={() => setPersonasOpen((v) => !v)}
            aria-haspopup="listbox"
            aria-expanded={personasOpen}
            aria-label={`Personas: ${personas.length} selected`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: 40, padding: '0 12px',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: 12, fontFamily: 'var(--font-sans)',
              cursor: 'pointer', outline: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Personas · {personas.length}/5
            <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />
          </button>
          {personasOpen && (
            <div
              role="listbox"
              aria-label="Select review personas"
              style={{
                position: 'absolute', top: 44, right: 0,
                minWidth: 180, zIndex: 10,
                background: 'var(--bg-elevated-2)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                padding: 6,
              }}
            >
              {ALL_PERSONAS.map((p) => {
                const cfg = personaConfig[p];
                const selected = personas.includes(p);
                const Icon = cfg.icon;
                return (
                  <button
                    key={p}
                    role="option"
                    aria-selected={selected}
                    onClick={() => togglePersona(p)}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      width: '100%', padding: '6px 10px',
                      background: selected ? 'var(--bg-elevated-3)' : 'transparent',
                      border: 'none', borderRadius: 'var(--radius-sm)',
                      color: selected ? 'var(--text-primary)' : 'var(--text-secondary)',
                      fontSize: 12, cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{
                      width: 14, height: 14, borderRadius: 3,
                      border: '1.5px solid var(--text-tertiary)',
                      background: selected ? 'var(--accent)' : 'transparent',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      {selected && <Check size={10} strokeWidth={3} style={{ color: 'var(--text-inverse)' }} />}
                    </span>
                    <Icon size={12} strokeWidth={1.75} aria-hidden="true" />
                    {cfg.label}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <button
          onClick={handleStart}
          disabled={!canStart}
          aria-label="Start review"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            height: 40, padding: '0 18px',
            fontSize: 13, fontWeight: 600,
            background: 'var(--accent)', color: 'var(--text-inverse)',
            border: 'none', borderRadius: 'var(--radius-sm)',
            cursor: !canStart ? 'not-allowed' : 'pointer',
            opacity: !canStart ? 0.6 : 1,
            fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
          }}
        >
          <GitPullRequest size={14} strokeWidth={1.75} aria-hidden="true" />
          {loading ? 'Reviewing…' : review ? 'Re-review' : 'Start review'}
        </button>
      </div>

      {/* Banner */}
      {banner && (
        <div
          role={banner.level === 'error' ? 'alert' : 'status'}
          style={{
            marginBottom: 12, padding: '8px 12px',
            borderRadius: 'var(--radius-sm)',
            background: banner.level === 'error' ? 'rgba(239,68,68,0.10)'
              : banner.level === 'success' ? 'rgba(34,197,94,0.10)'
              : 'var(--bg-elevated-2)',
            border: `1px solid ${
              banner.level === 'error' ? 'var(--color-error, #ef4444)'
              : banner.level === 'success' ? 'var(--color-success, #22c55e)'
              : 'var(--separator)'
            }`,
            fontSize: 12,
            color: banner.level === 'error' ? 'var(--color-error, #ef4444)'
              : banner.level === 'success' ? 'var(--color-success, #22c55e)'
              : 'var(--text-secondary)',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
          }}
        >
          <span>
            {banner.message}
            {publishedResult?.summaryUrl && banner.level === 'success' && (
              <>
                {' · '}
                <a
                  href={publishedResult.summaryUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'inherit', textDecoration: 'underline' }}
                >
                  View on GitHub
                </a>
              </>
            )}
          </span>
          <button
            onClick={() => setBanner(null)}
            aria-label="Dismiss notification"
            style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12 }}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Toast — bottom-right, auto-dismiss 4s */}
      {toast && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed',
            bottom: 24,
            right: 24,
            zIndex: 1000,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '10px 14px',
            background: 'var(--bg-elevated-3)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-primary)',
            fontSize: 13,
            fontFamily: 'var(--font-sans)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
            animation: 'slide-in 200ms var(--ease-default, ease-out)',
          }}
        >
          <CheckCircle2 size={14} style={{ color: 'var(--color-success, #22c55e)' }} aria-hidden="true" />
          <span>{toast.message}</span>
          {toast.canUndo && (
            <button
              onClick={() => { handleUndoResolve(); setToast(null); }}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--accent)',
                fontWeight: 600,
                fontSize: 12,
                cursor: 'pointer',
                padding: 0,
                marginLeft: 4,
              }}
            >
              Undo
            </button>
          )}
          <button
            onClick={() => setToast(null)}
            aria-label="Dismiss toast"
            style={{
              background: 'transparent', border: 'none',
              color: 'var(--text-tertiary)', cursor: 'pointer',
              padding: 0, marginLeft: 4,
            }}
          >
            <X size={12} strokeWidth={2} />
          </button>
        </div>
      )}

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 6 }}>
        {/* Empty state */}
        {!review && !loading && (
          <EmptyState onFocusInput={() => inputRef.current?.focus()} />
        )}

        {/* Loading / streaming personas state */}
        {loading && !review && (
          <StreamingProgress
            personas={runningPersonas.length ? runningPersonas : personas}
            done={donePersonas}
            reviewId={runningReviewId}
          />
        )}

        {/* Review body */}
        {review && (
          <>
            <VerdictBanner
              review={review}
              sevCounts={sevCounts!}
              publishing={publishing}
              rereviewing={rereviewing}
              onPublish={handlePublish}
              onRereview={handleRereview}
            />

            {review.planCompliance && (
              <PlanCompliancePanel
                report={review.planCompliance}
                open={planComplianceOpen}
                onToggle={() => setPlanComplianceOpen((v) => !v)}
              />
            )}

            {findingsByCategory.length === 0 ? (
              <div style={{
                padding: 24, textAlign: 'center',
                fontSize: 13, color: 'var(--color-success, #22c55e)',
                background: 'var(--bg-elevated-2)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-md)',
              }}>
                <CheckCircle2 size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} aria-hidden="true" />
                No findings from {review.personas.length} persona{review.personas.length !== 1 ? 's' : ''} — looks clean.
              </div>
            ) : (
              findingsByCategory.map(([cat, findings]) => (
                <CategoryGroup
                  key={cat}
                  category={cat}
                  findings={findings}
                  collapsed={!!collapsedCategories[cat]}
                  onToggle={() => toggleCategory(cat)}
                  onApplyFix={handleApplyFix}
                  onResolve={handleResolve}
                  applyingFix={applyingFix}
                  resolvingId={resolvingId}
                />
              ))
            )}

            {resolvedCounts.total > 0 && (
              <button
                onClick={() => setShowResolved((v) => !v)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  width: '100%', marginTop: 8,
                  padding: '10px 14px',
                  background: 'transparent',
                  border: '1px dashed var(--separator)',
                  borderRadius: 'var(--radius-md)',
                  color: 'var(--text-tertiary)',
                  fontSize: 12,
                  fontFamily: 'var(--font-sans)',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                {showResolved ? '— Hide resolved' : '+ Show resolved'}
                <span style={{ color: 'var(--text-secondary)' }}>
                  {resolvedCounts.addressed > 0 && ` ${resolvedCounts.addressed} addressed`}
                  {resolvedCounts.dismissed > 0 && ` · ${resolvedCounts.dismissed} dismissed`}
                  {resolvedCounts['wont-fix'] > 0 && ` · ${resolvedCounts['wont-fix']} won't fix`}
                </span>
              </button>
            )}

            <div style={{ height: 40 }} />
          </>
        )}
      </div>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────

function EmptyState({ onFocusInput }: { onFocusInput: () => void }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '48px 16px',
      color: 'var(--text-tertiary)', gap: 12, textAlign: 'center',
    }}>
      <GitPullRequest size={32} style={{ opacity: 0.3 }} aria-hidden="true" />
      <div style={{ fontSize: 14, color: 'var(--text-secondary)' }}>
        Paste a GitHub pull request URL to start a structured review.
      </div>
      <div style={{ fontSize: 12, maxWidth: 460 }}>
        Five personas (architect, security, style, tester, domain) read the diff in parallel and post
        categorised findings. Apply suggested fixes, resolve items inline, then publish to GitHub.
      </div>
      <button
        onClick={onFocusInput}
        style={{
          marginTop: 6,
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 11, color: 'var(--text-secondary)',
          padding: '4px 10px', borderRadius: 'var(--radius-sm)',
          background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)',
          cursor: 'pointer', fontFamily: 'var(--font-sans)',
        }}
      >
        <kbd style={{
          fontFamily: 'var(--font-mono)', fontSize: 11,
          padding: '1px 5px', background: 'var(--bg-elevated-3)',
          borderRadius: 3, border: '1px solid var(--separator)',
        }}>⌘↵</kbd>
        to focus input and start
      </button>
    </div>
  );
}

// ── Streaming progress ─────────────────────────────────────────────────

function StreamingProgress({
  personas,
  done,
  reviewId,
}: {
  personas: Persona[];
  done: Record<Persona, number>;
  reviewId: string | null;
}) {
  return (
    <div style={{
      padding: '20px 16px',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14,
        fontSize: 13, fontWeight: 600, color: 'var(--text-primary)',
      }}>
        <Loader2
          size={14}
          style={{ animation: 'spin 1s linear infinite', color: 'var(--accent)' }}
          aria-hidden="true"
        />
        Reviewing pull request…
        {reviewId && (
          <span style={{
            marginLeft: 'auto',
            fontSize: 11, fontWeight: 400,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
          }}>
            {reviewId.slice(0, 8)}
          </span>
        )}
      </div>
      <ul
        role="list"
        aria-label="Persona progress"
        style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}
      >
        {personas.map((p) => {
          const cfg = personaConfig[p];
          const Icon = cfg.icon;
          const isDone = p in done;
          const count = done[p] ?? 0;
          return (
            <li
              key={p}
              style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '6px 10px',
                background: isDone ? 'var(--bg-elevated-3)' : 'transparent',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                color: isDone ? 'var(--text-primary)' : 'var(--text-secondary)',
                transition: 'background var(--duration-fast) var(--ease-default)',
              }}
            >
              {isDone ? (
                <CheckCircle2 size={14} style={{ color: 'var(--color-success, #22c55e)' }} aria-hidden="true" />
              ) : (
                <Loader2
                  size={14}
                  style={{ animation: 'spin 1s linear infinite', color: 'var(--text-tertiary)' }}
                  aria-hidden="true"
                />
              )}
              <Icon size={12} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
              <span style={{ fontWeight: 500 }}>{cfg.label}</span>
              <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)' }}>
                {isDone ? `${count} finding${count !== 1 ? 's' : ''}` : 'analysing…'}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Verdict banner ─────────────────────────────────────────────────────

function VerdictBanner({
  review,
  sevCounts,
  publishing,
  rereviewing,
  onPublish,
  onRereview,
}: {
  review: Review;
  sevCounts: Record<Severity, number>;
  publishing: boolean;
  rereviewing: boolean;
  onPublish: () => void;
  onRereview: () => void;
}) {
  const cfg = verdictConfig[review.verdict];
  const VerdictIcon = cfg.icon;
  const totalFindings = review.findings.length;
  return (
    <div
      role="region"
      aria-label="Review verdict"
      style={{
        marginBottom: 12,
        padding: '12px 16px',
        background: cfg.background,
        border: `1px solid ${cfg.border}`,
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <VerdictIcon size={18} style={{ color: cfg.color }} aria-hidden="true" />
        <span style={{ fontSize: 14, fontWeight: 700, color: cfg.color }}>
          {cfg.label}
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          · {totalFindings} finding{totalFindings !== 1 ? 's' : ''}
          {' · '}
          {review.diffStats.files} file{review.diffStats.files !== 1 ? 's' : ''}
          {' · '}
          <span style={{ color: 'var(--color-success, #22c55e)' }}>+{review.diffStats.additions}</span>
          {' / '}
          <span style={{ color: 'var(--color-error, #ef4444)' }}>-{review.diffStats.deletions}</span>
        </span>
      </div>

      <p style={{
        margin: '0 0 10px', fontSize: 13,
        color: 'var(--text-secondary)', lineHeight: 1.55,
      }}>
        {review.summary}
      </p>

      <div style={{
        display: 'flex', alignItems: 'center', flexWrap: 'wrap',
        gap: 6, marginBottom: 10,
      }}>
        {(['blocker', 'error', 'warn', 'info', 'nit'] as Severity[]).map((s) => {
          const count = sevCounts[s];
          if (!count) return null;
          const scfg = severityConfig[s];
          const SIcon = scfg.icon;
          return (
            <span
              key={s}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                height: 22, padding: '0 8px',
                fontSize: 11, fontWeight: 600,
                color: scfg.color,
                background: 'var(--bg-elevated-3)',
                border: '1px solid var(--separator)',
                borderRadius: 999,
              }}
            >
              <SIcon size={11} strokeWidth={1.75} aria-hidden="true" />
              {count} {scfg.label.toLowerCase()}
            </span>
          );
        })}
        <span style={{
          marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
        }}>
          ~${review.estimate.usd.toFixed(2)} · {Math.round(review.estimate.seconds)}s · {review.model}
        </span>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={onPublish}
          disabled={publishing}
          aria-busy={publishing}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 32, padding: '0 14px',
            fontSize: 12, fontWeight: 600,
            background: 'var(--accent)',
            color: 'var(--text-inverse)',
            border: 'none', borderRadius: 'var(--radius-sm)',
            cursor: publishing ? 'wait' : 'pointer',
            opacity: publishing ? 0.7 : 1,
            fontFamily: 'var(--font-sans)',
          }}
        >
          {publishing ? (
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
          ) : (
            <Upload size={12} strokeWidth={1.75} aria-hidden="true" />
          )}
          {publishing ? 'Publishing…' : 'Publish to GitHub'}
        </button>
        <button
          onClick={onRereview}
          disabled={rereviewing}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 32, padding: '0 14px',
            fontSize: 12, fontWeight: 500,
            background: 'transparent',
            color: 'var(--text-secondary)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            cursor: rereviewing ? 'wait' : 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          <RefreshCw
            size={12}
            strokeWidth={1.75}
            style={{ animation: rereviewing ? 'spin 1s linear infinite' : undefined }}
            aria-hidden="true"
          />
          Re-review after push
        </button>
        <span style={{
          marginLeft: 'auto',
          fontSize: 11, color: 'var(--text-tertiary)',
          display: 'inline-flex', alignItems: 'center', gap: 4,
        }}>
          <Clock size={11} aria-hidden="true" />
          v{review.version} · {review.trigger}
        </span>
      </div>
    </div>
  );
}

// ── Plan compliance panel ──────────────────────────────────────────────

function PlanCompliancePanel({
  report,
  open,
  onToggle,
}: {
  report: PlanComplianceReport;
  open: boolean;
  onToggle: () => void;
}) {
  const matchPct = Math.max(0, Math.min(100, Math.round(report.matchRate * 100)));
  const barColor = matchPct >= 85
    ? 'var(--color-success, #22c55e)'
    : matchPct >= 60
    ? 'var(--color-warning, #f59e0b)'
    : 'var(--color-error, #ef4444)';
  return (
    <section
      aria-label="Plan compliance"
      style={{
        marginBottom: 12,
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="plan-compliance-body"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', padding: '10px 14px',
          background: 'transparent', border: 'none',
          color: 'var(--text-primary)',
          fontSize: 13, fontWeight: 600,
          cursor: 'pointer', textAlign: 'left',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <Gauge size={14} style={{ color: 'var(--accent)' }} aria-hidden="true" />
        Plan compliance
        <span style={{
          marginLeft: 8, fontSize: 11, fontWeight: 500,
          color: 'var(--text-tertiary)',
        }}>
          {matchPct}% match
        </span>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-tertiary)', fontWeight: 400 }}>
          {report.missedFiles.length} missed · {report.unplannedFiles.length} unplanned
        </span>
      </button>

      {open && (
        <div id="plan-compliance-body" style={{ padding: '0 14px 14px' }}>
          {/* Progress bar */}
          <div
            role="progressbar"
            aria-valuenow={matchPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Plan match rate: ${matchPct}%`}
            style={{
              height: 8, width: '100%',
              background: 'var(--bg-elevated-3)',
              borderRadius: 999,
              overflow: 'hidden',
              marginBottom: 12,
            }}
          >
            <div style={{
              width: `${matchPct}%`, height: '100%',
              background: barColor,
              transition: 'width var(--duration-base) var(--ease-default)',
            }} />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <ComplianceList
              title="Missed files"
              empty="None — all planned files were touched."
              items={report.missedFiles.map((f) => ({
                label: `${f.repo}/${f.file}`,
                severity: f.severity,
              }))}
            />
            <ComplianceList
              title="Unplanned files"
              empty="None — no surprise edits."
              items={report.unplannedFiles.map((f) => ({
                label: `${f.repo}/${f.file}`,
                severity: f.severity,
              }))}
            />
          </div>

          {report.missedSymbols.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, textTransform: 'uppercase' }}>
                Missed symbols
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {report.missedSymbols.map((s) => (
                  <span
                    key={s}
                    style={{
                      fontSize: 11, fontFamily: 'var(--font-mono)',
                      padding: '2px 7px', borderRadius: 999,
                      background: 'var(--bg-elevated-3)',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {s}
                  </span>
                ))}
              </div>
            </div>
          )}

          {(report.missingContracts.length > 0 || report.deliveredContracts.length > 0) && (
            <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, textTransform: 'uppercase' }}>
                  Delivered contracts
                </div>
                {report.deliveredContracts.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {report.deliveredContracts.map((c) => (
                      <span
                        key={c}
                        style={{
                          fontSize: 11, fontFamily: 'var(--font-mono)',
                          padding: '2px 7px', borderRadius: 999,
                          background: 'rgba(34,197,94,0.12)',
                          color: 'var(--color-success, #22c55e)',
                        }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, textTransform: 'uppercase' }}>
                  Missing contracts
                </div>
                {report.missingContracts.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
                ) : (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {report.missingContracts.map((c) => (
                      <span
                        key={c}
                        style={{
                          fontSize: 11, fontFamily: 'var(--font-mono)',
                          padding: '2px 7px', borderRadius: 999,
                          background: 'rgba(239,68,68,0.12)',
                          color: 'var(--color-error, #ef4444)',
                          border: '1px solid rgba(239,68,68,0.35)',
                        }}
                      >
                        {c}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ComplianceList({
  title,
  items,
  empty,
}: {
  title: string;
  items: Array<{ label: string; severity: 'error' | 'warn' | 'info' }>;
  empty: string;
}) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, textTransform: 'uppercase' }}>
        {title}
      </div>
      {items.length === 0 ? (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>{empty}</span>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {items.map((it, i) => {
            const color = it.severity === 'error'
              ? 'var(--color-error, #ef4444)'
              : it.severity === 'warn'
              ? 'var(--color-warning, #f59e0b)'
              : 'var(--text-tertiary)';
            return (
              <li key={i} style={{
                fontSize: 12, fontFamily: 'var(--font-mono)',
                color: 'var(--text-secondary)',
                margin: '2px 0',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{
                  width: 6, height: 6, borderRadius: 999,
                  background: color, flexShrink: 0,
                }} />
                {it.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Category group ─────────────────────────────────────────────────────

function CategoryGroup({
  category,
  findings,
  collapsed,
  onToggle,
  onApplyFix,
  onResolve,
  applyingFix,
  resolvingId,
}: {
  category: Category;
  findings: ReviewFinding[];
  collapsed: boolean;
  onToggle: () => void;
  onApplyFix: (id: string) => void;
  onResolve: (id: string, resolution: 'addressed' | 'dismissed' | 'wont-fix') => void;
  applyingFix: Record<string, boolean>;
  resolvingId: string | null;
}) {
  const cfg = categoryConfig[category];
  const pendingCount = findings.filter((f) => f.resolution === 'pending').length;
  return (
    <section
      aria-label={`${cfg.label} findings`}
      style={{ marginBottom: 12 }}
    >
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={`category-${category}-body`}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', padding: '8px 12px',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-primary)',
          fontSize: 13, fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
          textAlign: 'left',
        }}
      >
        {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: 999,
          background: cfg.color, flexShrink: 0,
        }} />
        {cfg.label}
        <span style={{
          fontSize: 11, fontWeight: 500,
          color: 'var(--text-tertiary)',
          marginLeft: 4,
        }}>
          {findings.length}
        </span>
        {pendingCount > 0 && pendingCount !== findings.length && (
          <span style={{
            fontSize: 10, fontWeight: 600,
            padding: '1px 6px', borderRadius: 999,
            background: 'var(--bg-elevated-3)',
            color: 'var(--text-tertiary)',
            marginLeft: 4,
          }}>
            {pendingCount} pending
          </span>
        )}
      </button>

      {!collapsed && (
        <div
          id={`category-${category}-body`}
          style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}
        >
          {findings.map((f) => (
            <FindingCard
              key={f.id}
              finding={f}
              onApplyFix={() => onApplyFix(f.id)}
              onResolve={(r) => onResolve(f.id, r)}
              applying={!!applyingFix[f.id]}
              resolving={resolvingId === f.id}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Finding card ───────────────────────────────────────────────────────

function FindingCard({
  finding,
  onApplyFix,
  onResolve,
  applying,
  resolving,
}: {
  finding: ReviewFinding;
  onApplyFix: () => void;
  onResolve: (resolution: 'addressed' | 'dismissed' | 'wont-fix') => void;
  applying: boolean;
  resolving: boolean;
}) {
  const sevCfg = severityConfig[finding.severity];
  const SevIcon = sevCfg.icon;
  const catCfg = categoryConfig[finding.category];
  const personaCfg = finding.persona ? personaConfig[finding.persona] : null;
  const PersonaIcon = personaCfg?.icon;
  const isResolved = finding.resolution !== 'pending';
  const resCfg = isResolved ? resolutionConfig[finding.resolution as Exclude<Resolution, 'pending'>] : null;
  const ResIcon = resCfg?.icon;

  return (
    <article
      aria-label={`Finding: ${finding.description.slice(0, 80)}`}
      style={{
        padding: '12px 14px',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        opacity: isResolved && finding.resolution !== 'addressed' ? 0.65 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <SevIcon
          size={16}
          strokeWidth={1.75}
          style={{ color: sevCfg.color, marginTop: 2, flexShrink: 0 }}
          aria-label={sevCfg.label}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* meta row */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            flexWrap: 'wrap', marginBottom: 6,
          }}>
            <Pill color={catCfg.color} border={`1px solid ${catCfg.color}`} bg="transparent">
              {catCfg.label}
            </Pill>
            {personaCfg && PersonaIcon && (
              <Pill>
                <PersonaIcon size={10} strokeWidth={1.75} aria-hidden="true" />
                {personaCfg.label}
              </Pill>
            )}
            <ConfidenceDot confidence={finding.confidence} />
            {finding.cve && (
              <Pill color="var(--color-error, #ef4444)" border="1px solid var(--color-error, #ef4444)" bg="transparent" mono>
                {finding.cve}
              </Pill>
            )}
            <span style={{
              fontFamily: 'var(--font-mono)', fontSize: 11,
              color: 'var(--text-secondary)',
              marginLeft: 2,
            }}>
              {finding.file}
              <span style={{ color: 'var(--text-tertiary)' }}>:{finding.line}</span>
            </span>
            {finding.kbRef && (
              <span
                style={{
                  fontSize: 10, fontFamily: 'var(--font-mono)',
                  color: 'var(--text-tertiary)',
                  padding: '1px 6px', borderRadius: 3,
                  background: 'var(--bg-elevated-3)',
                }}
                title={`KB: ${finding.kbRef.repo}#${finding.kbRef.nodeId}`}
              >
                kb:{finding.kbRef.nodeId.slice(0, 6)}
              </span>
            )}
          </div>

          {/* snippet */}
          {finding.snippet && (
            <pre style={{
              margin: '0 0 8px', padding: '8px 10px',
              background: 'var(--bg-base)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
              whiteSpace: 'pre',
              overflowX: 'auto',
            }}>
              {finding.snippet}
            </pre>
          )}

          {/* description */}
          <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.55 }}>
            {finding.description}
          </div>

          {/* suggested fix */}
          {finding.suggestedFix && (
            <div style={{
              marginTop: 10,
              padding: '8px 10px',
              background: 'var(--bg-elevated-3)',
              border: '1px dashed var(--separator)',
              borderRadius: 'var(--radius-sm)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
                marginBottom: 4, textTransform: 'uppercase',
              }}>
                <Wrench size={11} strokeWidth={1.75} aria-hidden="true" />
                Suggested fix
              </div>
              <div style={{
                fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
                marginBottom: 8,
              }}>
                {finding.suggestedFix.rationale}
              </div>
              <details>
                <summary style={{
                  fontSize: 11, color: 'var(--accent)',
                  cursor: 'pointer', userSelect: 'none',
                  fontFamily: 'var(--font-sans)',
                }}>
                  Show diff
                </summary>
                <pre style={{
                  margin: '6px 0 0', padding: '8px 10px',
                  background: 'var(--bg-base)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 11, fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  lineHeight: 1.5,
                  whiteSpace: 'pre',
                  overflowX: 'auto',
                  border: '1px solid var(--separator)',
                }}>
                  {finding.suggestedFix.diff}
                </pre>
              </details>
              {!isResolved && (
                <button
                  onClick={onApplyFix}
                  disabled={applying}
                  aria-busy={applying}
                  style={{
                    marginTop: 8,
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    height: 26, padding: '0 10px',
                    fontSize: 11, fontWeight: 600,
                    background: 'var(--accent)',
                    color: 'var(--text-inverse)',
                    border: 'none', borderRadius: 'var(--radius-sm)',
                    cursor: applying ? 'wait' : 'pointer',
                    opacity: applying ? 0.7 : 1,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  {applying ? (
                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
                  ) : (
                    <Wrench size={11} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {applying ? 'Applying…' : 'Apply fix'}
                </button>
              )}
            </div>
          )}

          {/* resolution footer */}
          <div style={{
            marginTop: 10, paddingTop: 8,
            borderTop: '1px dashed var(--separator)',
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11,
          }}>
            {isResolved && resCfg && ResIcon ? (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                height: 22, padding: '0 8px', borderRadius: 999,
                fontSize: 11, fontWeight: 600,
                color: resCfg.color,
                background: 'var(--bg-elevated-3)',
                border: `1px solid ${resCfg.color === 'var(--text-tertiary)' ? 'var(--separator)' : resCfg.color}`,
              }}>
                <ResIcon size={11} strokeWidth={2} aria-hidden="true" />
                {resCfg.label}
              </span>
            ) : (
              <>
                <span style={{ color: 'var(--text-tertiary)' }}>Mark as:</span>
                <ResolveButton
                  label="Addressed"
                  icon={Check}
                  color="var(--color-success, #22c55e)"
                  onClick={() => onResolve('addressed')}
                  loading={resolving}
                />
                <ResolveButton
                  label="Dismiss"
                  icon={X}
                  color="var(--text-secondary)"
                  onClick={() => onResolve('dismissed')}
                  loading={resolving}
                />
                <ResolveButton
                  label="Won't fix"
                  icon={Ban}
                  color="var(--text-secondary)"
                  onClick={() => onResolve('wont-fix')}
                  loading={resolving}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

function ResolveButton({
  label,
  icon: Icon,
  color,
  onClick,
  loading,
}: {
  label: string;
  icon: React.ComponentType<any>;
  color: string;
  onClick: () => void;
  loading: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 22, padding: '0 8px',
        fontSize: 11, fontWeight: 500,
        background: 'transparent',
        border: '1px solid var(--separator)',
        borderRadius: 999,
        color,
        cursor: loading ? 'wait' : 'pointer',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <Icon size={10} strokeWidth={2} aria-hidden="true" />
      {label}
    </button>
  );
}

export default ReviewPage;
