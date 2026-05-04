import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle2,
  XCircle,
  Zap,
  Lock,
  Unlock,
  FileText,
  ExternalLink,
} from 'lucide-react';
import { Pill } from '../common/findingPrimitives.js';
import { Toast } from '../common/Toast.js';

// ── Props ──────────────────────────────────────────────────────────────

export interface IncidentsPanelProps {
  project: string;
  ws: WebSocket | null;
  specSlug: string;
}

// ── Domain types (mirror server bug-to-test types) ─────────────────────

type IncidentSeverity = 'p1' | 'p2' | 'p3' | 'p4' | 'unknown';
type IncidentSource = 'incident.io' | 'sentry' | 'datadog' | 'jira' | 'linear' | 'manual';
type ReplayStatus = 'pending' | 'reproducing' | 'confirmed' | 'unreproducible' | 'low-confidence';
type ReplayConfidence = 'high' | 'med' | 'low';

interface FailingSymbol {
  file: string;
  function: string;
  line: number;
}

interface IncidentRecord {
  id: string;
  externalId: string;
  source: IncidentSource;
  url: string;
  title: string;
  severity: IncidentSeverity;
  occurredAt: string;
  resolvedAt?: string;
  summary: string;
  linkedPrUrl?: string;
  failingSymbol?: FailingSymbol;
}

interface ReplayStepResult {
  commitSha?: string;
  pass?: boolean;
  durationMs?: number;
  message?: string;
}

interface ReplayAttempt {
  id: string;
  incidentId: string;
  status: ReplayStatus;
  confidence: ReplayConfidence;
  notes: string[];
  preFixResult?: ReplayStepResult;
  postFixResult?: ReplayStepResult;
  boundTestFile?: string;
  createdAt: string;
  completedAt?: string;
}

interface BoundTest {
  filePath: string;
  incidentId: string;
  replayId: string;
  addedAt: string;
}

// ── Config ─────────────────────────────────────────────────────────────

const severityConfig: Record<IncidentSeverity, { label: string; color: string; bg: string; border: string }> = {
  p1: {
    label: 'P1',
    color: '#ffffff',
    bg: 'var(--color-error, #ef4444)',
    border: 'var(--color-error, #ef4444)',
  },
  p2: {
    label: 'P2',
    color: 'var(--color-error, #ef4444)',
    bg: 'rgba(239, 68, 68, 0.12)',
    border: 'var(--color-error, #ef4444)',
  },
  p3: {
    label: 'P3',
    color: 'var(--color-warning, #f59e0b)',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'var(--color-warning, #f59e0b)',
  },
  p4: {
    label: 'P4',
    color: 'var(--color-info, #3b82f6)',
    bg: 'rgba(59, 130, 246, 0.12)',
    border: 'var(--color-info, #3b82f6)',
  },
  unknown: {
    label: '—',
    color: 'var(--text-tertiary)',
    bg: 'var(--bg-elevated-3)',
    border: 'var(--separator)',
  },
};

const sourceConfig: Record<IncidentSource, { label: string }> = {
  'incident.io': { label: 'incident.io' },
  sentry: { label: 'Sentry' },
  datadog: { label: 'Datadog' },
  jira: { label: 'Jira' },
  linear: { label: 'Linear' },
  manual: { label: 'Manual' },
};

const replayStatusConfig: Record<ReplayStatus, { label: string; color: string; bg: string; border: string; icon: React.ComponentType<any> }> = {
  pending: {
    label: 'Pending',
    color: 'var(--text-tertiary)',
    bg: 'var(--bg-elevated-3)',
    border: 'var(--separator)',
    icon: AlertCircle,
  },
  reproducing: {
    label: 'Reproducing',
    color: 'var(--color-info, #3b82f6)',
    bg: 'rgba(59, 130, 246, 0.12)',
    border: 'var(--color-info, #3b82f6)',
    icon: Zap,
  },
  confirmed: {
    label: 'Confirmed',
    color: 'var(--color-success, #22c55e)',
    bg: 'rgba(34, 197, 94, 0.12)',
    border: 'var(--color-success, #22c55e)',
    icon: CheckCircle2,
  },
  unreproducible: {
    label: 'Unreproducible',
    color: 'var(--color-error, #ef4444)',
    bg: 'rgba(239, 68, 68, 0.12)',
    border: 'var(--color-error, #ef4444)',
    icon: XCircle,
  },
  'low-confidence': {
    label: 'Low confidence',
    color: 'var(--color-warning, #f59e0b)',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'var(--color-warning, #f59e0b)',
    icon: AlertTriangle,
  },
};

const confidenceConfig: Record<ReplayConfidence, { label: string; color: string; bg: string; border: string }> = {
  high: {
    label: 'High',
    color: 'var(--color-success, #22c55e)',
    bg: 'rgba(34, 197, 94, 0.12)',
    border: 'var(--color-success, #22c55e)',
  },
  med: {
    label: 'Med',
    color: 'var(--color-warning, #f59e0b)',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'var(--color-warning, #f59e0b)',
  },
  low: {
    label: 'Low',
    color: 'var(--color-error, #ef4444)',
    bg: 'rgba(239, 68, 68, 0.12)',
    border: 'var(--color-error, #ef4444)',
  },
};

// ── Helpers ────────────────────────────────────────────────────────────

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function truncateSha(sha: string | undefined): string {
  if (!sha) return '—';
  return sha.slice(0, 7);
}

function vscodeLink(filePath: string): string {
  // VS Code accepts vscode://file/<absolute-path>. We encode minimally so
  // spaces/unicode don't break the URL.
  const encoded = filePath.split('/').map(encodeURIComponent).join('/');
  return `vscode://file/${encoded.startsWith('/') ? encoded : `/${encoded}`}`;
}

// ── Severity pill ──────────────────────────────────────────────────────

function SeverityPill({ severity }: { severity: IncidentSeverity }) {
  const cfg = severityConfig[severity];
  return (
    <Pill color={cfg.color} bg={cfg.bg} border={`1px solid ${cfg.border}`}>
      {cfg.label}
    </Pill>
  );
}

function SourceBadge({ source }: { source: IncidentSource }) {
  return (
    <Pill color="var(--text-tertiary)" bg="var(--bg-elevated-3)" border="1px solid var(--separator)">
      {sourceConfig[source]?.label ?? source}
    </Pill>
  );
}

function StatusPill({ status }: { status: ReplayStatus }) {
  const cfg = replayStatusConfig[status];
  const Icon = cfg.icon;
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 20, padding: '0 8px',
        fontSize: 10, fontWeight: 600,
        color: cfg.color,
        background: cfg.bg,
        border: `1px solid ${cfg.border}`,
        borderRadius: 999,
        fontFamily: 'var(--font-sans)',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        whiteSpace: 'nowrap',
      }}
    >
      <Icon size={10} strokeWidth={2.25} aria-hidden="true" />
      {cfg.label}
    </span>
  );
}

function ConfidenceBadge({ confidence }: { confidence: ReplayConfidence }) {
  const cfg = confidenceConfig[confidence];
  return (
    <Pill color={cfg.color} bg={cfg.bg} border={`1px solid ${cfg.border}`}>
      {cfg.label}
    </Pill>
  );
}

// ── Paste-stack-trace modal ────────────────────────────────────────────

function PasteStackModal({
  onClose,
  onSubmit,
}: {
  onClose: () => void;
  onSubmit: (title: string, stackTrace: string) => void;
}) {
  const [title, setTitle] = useState('');
  const [stackTrace, setStackTrace] = useState('');

  const canSubmit = stackTrace.trim().length > 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="paste-stack-title"
      style={{
        position: 'fixed', inset: 0, zIndex: 1001,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(0, 0, 0, 0.45)',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(640px, 92vw)',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          padding: 20,
          boxShadow: '0 16px 48px rgba(0,0,0,0.4)',
          fontFamily: 'var(--font-sans)',
        }}
      >
        <h3
          id="paste-stack-title"
          style={{
            margin: 0, marginBottom: 12,
            fontSize: 15, fontWeight: 600,
            color: 'var(--text-primary)',
          }}
        >
          Paste stack trace
        </h3>
        <p
          style={{
            margin: 0, marginBottom: 14,
            fontSize: 12, color: 'var(--text-tertiary)',
          }}
        >
          Manually ingest an incident from any paste-able stack trace. We'll parse the failing symbol
          and try to bind it to a replay test.
        </p>

        <label
          style={{
            display: 'block',
            fontSize: 11, fontWeight: 600,
            color: 'var(--text-secondary)',
            marginBottom: 4,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
          }}
        >
          Title (optional)
        </label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. TypeError in checkout handler"
          style={{
            width: '100%',
            height: 32, padding: '0 10px',
            marginBottom: 12,
            background: 'var(--bg-elevated-3)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 13,
            fontFamily: 'var(--font-sans)',
            boxSizing: 'border-box',
          }}
        />

        <label
          style={{
            display: 'block',
            fontSize: 11, fontWeight: 600,
            color: 'var(--text-secondary)',
            marginBottom: 4,
            textTransform: 'uppercase',
            letterSpacing: 0.3,
          }}
        >
          Stack trace
        </label>
        <textarea
          value={stackTrace}
          onChange={(e) => setStackTrace(e.target.value)}
          placeholder={'TypeError: Cannot read properties of undefined\n    at handleCheckout (/app/src/checkout.ts:42:18)'}
          rows={10}
          style={{
            width: '100%',
            padding: 10,
            background: 'var(--bg-elevated-3)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />

        <div
          style={{
            display: 'flex', justifyContent: 'flex-end', gap: 8,
            marginTop: 16,
          }}
        >
          <button
            onClick={onClose}
            style={{
              height: 30, padding: '0 14px',
              background: 'transparent',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: 12, fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={() => canSubmit && onSubmit(title.trim(), stackTrace)}
            disabled={!canSubmit}
            style={{
              height: 30, padding: '0 14px',
              background: canSubmit ? 'var(--accent)' : 'var(--bg-elevated-3)',
              color: canSubmit ? 'var(--text-inverse)' : 'var(--text-tertiary)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12, fontWeight: 600,
              cursor: canSubmit ? 'pointer' : 'not-allowed',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Ingest
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Incident row ───────────────────────────────────────────────────────

function IncidentRow({
  incident,
  hasReplay,
  onViewReplay,
  onReplay,
  replaying,
}: {
  incident: IncidentRecord;
  hasReplay: boolean;
  onViewReplay: () => void;
  onReplay: () => void;
  replaying: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-sm)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <SeverityPill severity={incident.severity} />
      <SourceBadge source={incident.source} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 13, fontWeight: 500,
            color: 'var(--text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          {incident.title}
        </div>
        {incident.failingSymbol && (
          <div
            style={{
              marginTop: 2,
              fontSize: 11,
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {incident.failingSymbol.file}:{incident.failingSymbol.line} · {incident.failingSymbol.function}
          </div>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>
        {formatTimestamp(incident.occurredAt)}
      </div>
      {incident.url && (
        <a
          href={incident.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'inline-flex', alignItems: 'center',
            color: 'var(--text-tertiary)',
          }}
          aria-label="Open source incident"
        >
          <ExternalLink size={12} aria-hidden="true" />
        </a>
      )}
      {hasReplay ? (
        <button
          onClick={onViewReplay}
          style={{
            height: 26, padding: '0 10px',
            fontSize: 11, fontWeight: 500,
            background: 'transparent',
            color: 'var(--text-secondary)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            cursor: 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          View replay
        </button>
      ) : (
        <button
          onClick={onReplay}
          disabled={replaying}
          style={{
            height: 26, padding: '0 10px',
            fontSize: 11, fontWeight: 600,
            background: replaying ? 'var(--bg-elevated-3)' : 'var(--accent)',
            color: replaying ? 'var(--text-tertiary)' : 'var(--text-inverse)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: replaying ? 'wait' : 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {replaying ? 'Replaying…' : 'Replay'}
        </button>
      )}
    </div>
  );
}

// ── Replay card ────────────────────────────────────────────────────────

function ReplayCard({
  attempt,
  incident,
  pinned,
  onReview,
}: {
  attempt: ReplayAttempt;
  incident: IncidentRecord | null;
  pinned: boolean;
  onReview?: () => void;
}) {
  const [notesOpen, setNotesOpen] = useState(false);

  const preFixBadge = useMemo(() => {
    const r = attempt.preFixResult;
    if (!r) return null;
    // Pre-fix: expected to FAIL (reproduces the bug). PASS is unexpected.
    const expectedFail = r.pass === false;
    const color = expectedFail ? 'var(--color-success, #22c55e)' : 'var(--color-warning, #f59e0b)';
    const Icon = expectedFail ? CheckCircle2 : AlertTriangle;
    return { color, Icon, label: expectedFail ? 'FAIL (expected)' : 'PASS (unexpected)', sha: r.commitSha };
  }, [attempt.preFixResult]);

  const postFixBadge = useMemo(() => {
    const r = attempt.postFixResult;
    if (!r) return null;
    // Post-fix: expected to PASS. FAIL means the fix didn't take.
    const pass = r.pass === true;
    const color = pass ? 'var(--color-success, #22c55e)' : 'var(--color-error, #ef4444)';
    const Icon = pass ? CheckCircle2 : XCircle;
    return { color, Icon, label: pass ? 'PASS' : 'FAIL', sha: r.commitSha };
  }, [attempt.postFixResult]);

  return (
    <div
      style={{
        padding: 12,
        background: 'var(--bg-elevated-2)',
        border: pinned
          ? '1px solid var(--color-warning, #f59e0b)'
          : '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 10,
        }}
      >
        <ConfidenceBadge confidence={attempt.confidence} />
        <StatusPill status={attempt.status} />
        {pinned && onReview && (
          <button
            onClick={onReview}
            style={{
              marginLeft: 'auto',
              height: 24, padding: '0 10px',
              fontSize: 11, fontWeight: 600,
              background: 'var(--color-warning, #f59e0b)',
              color: '#ffffff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            Review
          </button>
        )}
        <div
          style={{
            marginLeft: pinned && onReview ? 8 : 'auto',
            fontSize: 11, color: 'var(--text-tertiary)',
          }}
        >
          {formatTimestamp(attempt.createdAt)}
        </div>
      </div>

      {incident && (
        <div
          style={{
            fontSize: 12, color: 'var(--text-secondary)',
            marginBottom: 10,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}
        >
          <SeverityPill severity={incident.severity} /> <span style={{ marginLeft: 6 }}>{incident.title}</span>
        </div>
      )}

      {(preFixBadge || postFixBadge) && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            marginBottom: 10,
          }}
        >
          {preFixBadge && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 10px',
                background: 'var(--bg-elevated-3)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 11,
              }}
            >
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 600 }}>Pre-fix</span>
              <preFixBadge.Icon size={12} style={{ color: preFixBadge.color }} strokeWidth={2.25} aria-hidden="true" />
              <span style={{ color: preFixBadge.color, fontWeight: 600 }}>{preFixBadge.label}</span>
              {preFixBadge.sha && (
                <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  {truncateSha(preFixBadge.sha)}
                </span>
              )}
            </div>
          )}
          {postFixBadge && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '6px 10px',
                background: 'var(--bg-elevated-3)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 11,
              }}
            >
              <span style={{ color: 'var(--text-tertiary)', fontWeight: 600 }}>Post-fix</span>
              <postFixBadge.Icon size={12} style={{ color: postFixBadge.color }} strokeWidth={2.25} aria-hidden="true" />
              <span style={{ color: postFixBadge.color, fontWeight: 600 }}>{postFixBadge.label}</span>
              {postFixBadge.sha && (
                <span style={{ marginLeft: 'auto', color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
                  {truncateSha(postFixBadge.sha)}
                </span>
              )}
            </div>
          )}
        </div>
      )}

      {attempt.boundTestFile && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 10,
            padding: '6px 10px',
            background: 'var(--bg-elevated-3)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 11,
          }}
        >
          <FileText size={12} style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
          <a
            href={vscodeLink(attempt.boundTestFile)}
            style={{
              color: 'var(--accent)',
              textDecoration: 'none',
              fontFamily: 'var(--font-mono)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              flex: 1, minWidth: 0,
            }}
          >
            {attempt.boundTestFile}
          </a>
          <ExternalLink size={11} style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
        </div>
      )}

      {attempt.notes.length > 0 && (
        <div>
          <button
            onClick={() => setNotesOpen((v) => !v)}
            aria-expanded={notesOpen}
            style={{
              padding: 0,
              background: 'transparent',
              border: 'none',
              color: 'var(--text-tertiary)',
              fontSize: 11, fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {notesOpen ? '— Hide notes' : `+ Show notes (${attempt.notes.length})`}
          </button>
          {notesOpen && (
            <ul
              style={{
                margin: '6px 0 0 0',
                padding: '0 0 0 18px',
                fontSize: 12,
                color: 'var(--text-secondary)',
                lineHeight: 1.5,
              }}
            >
              {attempt.notes.map((n, i) => (
                <li key={i} style={{ marginBottom: 2 }}>{n}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Bound tests registry ───────────────────────────────────────────────

function BoundTestsTable({
  bound,
  incidentsById,
  onOverride,
}: {
  bound: BoundTest[];
  incidentsById: Record<string, IncidentRecord>;
  onOverride: (replayId: string, reason: string) => void;
}) {
  if (bound.length === 0) {
    return (
      <div
        style={{
          padding: 18,
          textAlign: 'center',
          background: 'var(--bg-elevated-2)',
          border: '1px dashed var(--separator)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-tertiary)',
          fontSize: 12,
          fontFamily: 'var(--font-sans)',
        }}
      >
        <Lock size={14} aria-hidden="true" style={{ verticalAlign: 'middle', marginRight: 6 }} />
        No bound tests yet — confirmed replays will lock their backing test files here.
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 2fr 1fr auto',
          gap: 12,
          padding: '8px 12px',
          background: 'var(--bg-elevated-3)',
          borderBottom: '1px solid var(--separator)',
          fontSize: 10, fontWeight: 700,
          color: 'var(--text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: 0.4,
        }}
      >
        <span>File path</span>
        <span>Incident</span>
        <span>Added</span>
        <span> </span>
      </div>
      {bound.map((b) => {
        const inc = incidentsById[b.incidentId];
        return (
          <div
            key={`${b.replayId}-${b.filePath}`}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 2fr 1fr auto',
              gap: 12,
              padding: '10px 12px',
              alignItems: 'center',
              borderBottom: '1px solid var(--separator)',
              fontSize: 12,
            }}
          >
            <a
              href={vscodeLink(b.filePath)}
              style={{
                color: 'var(--accent)',
                textDecoration: 'none',
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              title={b.filePath}
            >
              {b.filePath}
            </a>
            <span
              style={{
                color: 'var(--text-secondary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}
              title={inc?.title ?? b.incidentId}
            >
              {inc?.title ?? <span style={{ color: 'var(--text-tertiary)', fontStyle: 'italic' }}>{b.incidentId}</span>}
            </span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>
              {formatTimestamp(b.addedAt)}
            </span>
            <button
              onClick={() => {
                const reason = typeof window !== 'undefined' ? window.prompt('Override reason') : null;
                if (reason && reason.trim().length > 0) onOverride(b.replayId, reason.trim());
              }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                height: 24, padding: '0 8px',
                fontSize: 11, fontWeight: 500,
                background: 'transparent',
                color: 'var(--text-secondary)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
                fontFamily: 'var(--font-sans)',
              }}
            >
              <Unlock size={11} aria-hidden="true" />
              Override
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ── Section header ─────────────────────────────────────────────────────

function SectionHeader({
  title,
  count,
  icon: Icon,
  action,
}: {
  title: string;
  count?: number;
  icon: React.ComponentType<any>;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 10,
        fontFamily: 'var(--font-sans)',
      }}
    >
      <Icon size={14} style={{ color: 'var(--text-secondary)' }} aria-hidden="true" />
      <h3
        style={{
          margin: 0,
          fontSize: 13, fontWeight: 600,
          color: 'var(--text-primary)',
        }}
      >
        {title}
      </h3>
      {count != null && (
        <span
          style={{
            fontSize: 11, fontWeight: 500,
            color: 'var(--text-tertiary)',
          }}
        >
          {count}
        </span>
      )}
      {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
    </div>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────

export function IncidentsPanel({ project, ws, specSlug }: IncidentsPanelProps) {
  const [incidents, setIncidents] = useState<IncidentRecord[]>([]);
  const [replays, setReplays] = useState<ReplayAttempt[]>([]);
  const [bound, setBound] = useState<BoundTest[]>([]);
  const [replayingIncidentId, setReplayingIncidentId] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [focusedReplayId, setFocusedReplayId] = useState<string | null>(null);

  const toastTimer = useRef<number | null>(null);
  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3500);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current != null) window.clearTimeout(toastTimer.current);
  }, []);

  // Initial fetch when ws or project changes.
  useEffect(() => {
    if (!ws || !project) return;
    try {
      ws.send(JSON.stringify({ action: 'list-incidents', project }));
      ws.send(JSON.stringify({ action: 'list-replays', project }));
      ws.send(JSON.stringify({ action: 'list-bound-tests', project }));
    } catch {
      // ws may not be OPEN yet — the page's reconnect logic will resend.
    }
  }, [ws, project, specSlug]);

  // WebSocket message handler. Functional setState only — no stale closures.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      const p = msg?.payload ?? {};
      switch (msg.type) {
        case 'incidents': {
          if (Array.isArray(p.incidents)) {
            setIncidents((_prev) => p.incidents as IncidentRecord[]);
          }
          break;
        }
        case 'replays': {
          if (Array.isArray(p.replays)) {
            setReplays((_prev) => p.replays as ReplayAttempt[]);
          }
          break;
        }
        case 'bound-tests': {
          if (Array.isArray(p.bound)) {
            setBound((_prev) => p.bound as BoundTest[]);
          }
          break;
        }
        case 'incident-ingested': {
          const inc = p.incident as IncidentRecord | undefined;
          if (inc) {
            setIncidents((prev) => [inc, ...prev.filter((i) => i.id !== inc.id)]);
            showToast(`Incident ingested: ${inc.title}`);
          }
          break;
        }
        case 'replay-step': {
          const attempt = p.attempt as ReplayAttempt | undefined;
          if (attempt) {
            setReplays((prev) => {
              const next = prev.filter((r) => r.id !== attempt.id);
              return [attempt, ...next];
            });
          }
          break;
        }
        case 'replay-complete': {
          const attempt = p.attempt as ReplayAttempt | undefined;
          const boundFilePath = p.boundFilePath as string | undefined;
          if (attempt) {
            setReplays((prev) => {
              const next = prev.filter((r) => r.id !== attempt.id);
              return [attempt, ...next];
            });
            setReplayingIncidentId((prev) => (prev === attempt.incidentId ? null : prev));
            if (boundFilePath) {
              setBound((prev) => {
                const next = prev.filter((b) => b.replayId !== attempt.id);
                return [
                  {
                    filePath: boundFilePath,
                    incidentId: attempt.incidentId,
                    replayId: attempt.id,
                    addedAt: attempt.completedAt ?? new Date().toISOString(),
                  },
                  ...next,
                ];
              });
            }
            showToast(`Replay ${attempt.status}: ${attempt.confidence} confidence`);
          }
          break;
        }
        case 'bind-overridden': {
          const replayId = p.replayId as string | undefined;
          if (replayId) {
            setBound((prev) => prev.filter((b) => b.replayId !== replayId));
            showToast('Bind overridden.');
          }
          break;
        }
        default: break;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, project, specSlug]);

  // ── Derived views ───────────────────────────────────────────────────

  const incidentsById = useMemo(() => {
    const out: Record<string, IncidentRecord> = {};
    for (const i of incidents) out[i.id] = i;
    return out;
  }, [incidents]);

  const unresolvedIncidents = useMemo(
    () => incidents.filter((i) => !i.resolvedAt),
    [incidents],
  );
  const resolvedIncidents = useMemo(
    () => incidents.filter((i) => !!i.resolvedAt),
    [incidents],
  );

  const latestReplayByIncidentId = useMemo(() => {
    const out: Record<string, ReplayAttempt> = {};
    for (const r of replays) {
      const cur = out[r.incidentId];
      if (!cur || new Date(r.createdAt).getTime() > new Date(cur.createdAt).getTime()) {
        out[r.incidentId] = r;
      }
    }
    return out;
  }, [replays]);

  const orderedReplays = useMemo(() => {
    const sorted = [...replays].sort((a, b) =>
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    // Low-confidence pinned to top.
    const pinned = sorted.filter((r) => r.confidence === 'low' || r.status === 'low-confidence');
    const rest = sorted.filter((r) => !(r.confidence === 'low' || r.status === 'low-confidence'));
    return [...pinned, ...rest];
  }, [replays]);

  // ── Actions ─────────────────────────────────────────────────────────

  const sendReplay = useCallback((incidentId: string) => {
    if (!ws || !project) return;
    setReplayingIncidentId(incidentId);
    try {
      ws.send(JSON.stringify({ action: 'replay-incident', project, incidentId }));
    } catch {
      setReplayingIncidentId(null);
    }
  }, [ws, project]);

  const sendIngest = useCallback((title: string, stackTrace: string) => {
    if (!ws || !project) return;
    try {
      ws.send(JSON.stringify({
        action: 'ingest-incident',
        project,
        source: 'manual',
        payload: { stackTrace, title },
      }));
      setPasteOpen(false);
      showToast('Stack trace submitted…');
    } catch {
      showToast('Failed to submit stack trace.');
    }
  }, [ws, project, showToast]);

  const sendOverride = useCallback((replayId: string, reason: string) => {
    if (!ws || !project) return;
    try {
      ws.send(JSON.stringify({ action: 'override-bind', project, replayId, reason }));
    } catch {
      showToast('Failed to send override.');
    }
  }, [ws, project, showToast]);

  const jumpToReplay = useCallback((incidentId: string) => {
    const r = latestReplayByIncidentId[incidentId];
    if (r) setFocusedReplayId(r.id);
  }, [latestReplayByIncidentId]);

  // ── Render ──────────────────────────────────────────────────────────

  const pasteButton = (
    <button
      onClick={() => setPasteOpen(true)}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        height: 26, padding: '0 10px',
        fontSize: 11, fontWeight: 600,
        background: 'var(--accent)',
        color: 'var(--text-inverse)',
        border: 'none',
        borderRadius: 'var(--radius-sm)',
        cursor: 'pointer',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <AlertTriangle size={11} strokeWidth={2} aria-hidden="true" />
      Paste stack trace
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, fontFamily: 'var(--font-sans)' }}>
      {/* Section 1: Incidents */}
      <section>
        <SectionHeader
          title="Incidents"
          count={incidents.length}
          icon={AlertTriangle}
          action={pasteButton}
        />
        {incidents.length === 0 ? (
          <div
            style={{
              padding: 18,
              textAlign: 'center',
              background: 'var(--bg-elevated-2)',
              border: '1px dashed var(--separator)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-tertiary)',
              fontSize: 12,
            }}
          >
            No incidents bound to this project yet. Paste a stack trace to ingest one manually, or
            connect an integration (incident.io, Sentry, Datadog, Jira, Linear).
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {unresolvedIncidents.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: 10, fontWeight: 700,
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    marginBottom: 6,
                  }}
                >
                  Unresolved · {unresolvedIncidents.length}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {unresolvedIncidents.map((i) => (
                    <IncidentRow
                      key={i.id}
                      incident={i}
                      hasReplay={!!latestReplayByIncidentId[i.id]}
                      onViewReplay={() => jumpToReplay(i.id)}
                      onReplay={() => sendReplay(i.id)}
                      replaying={replayingIncidentId === i.id}
                    />
                  ))}
                </div>
              </div>
            )}
            {resolvedIncidents.length > 0 && (
              <div>
                <div
                  style={{
                    fontSize: 10, fontWeight: 700,
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    marginBottom: 6,
                  }}
                >
                  Resolved · {resolvedIncidents.length}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: 0.78 }}>
                  {resolvedIncidents.map((i) => (
                    <IncidentRow
                      key={i.id}
                      incident={i}
                      hasReplay={!!latestReplayByIncidentId[i.id]}
                      onViewReplay={() => jumpToReplay(i.id)}
                      onReplay={() => sendReplay(i.id)}
                      replaying={replayingIncidentId === i.id}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Section 2: Replays */}
      <section>
        <SectionHeader title="Replays" count={replays.length} icon={Zap} />
        {replays.length === 0 ? (
          <div
            style={{
              padding: 18,
              textAlign: 'center',
              background: 'var(--bg-elevated-2)',
              border: '1px dashed var(--separator)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-tertiary)',
              fontSize: 12,
            }}
          >
            No replays yet — trigger one from the incidents above.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {orderedReplays.map((r) => {
              const pinned = r.confidence === 'low' || r.status === 'low-confidence';
              return (
                <div
                  key={r.id}
                  style={{
                    outline: focusedReplayId === r.id ? '2px solid var(--accent)' : 'none',
                    outlineOffset: 2,
                    borderRadius: 'var(--radius-md)',
                  }}
                >
                  <ReplayCard
                    attempt={r}
                    incident={incidentsById[r.incidentId] ?? null}
                    pinned={pinned}
                    onReview={pinned ? () => setFocusedReplayId(r.id) : undefined}
                  />
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* Section 3: Bound tests registry */}
      <section>
        <SectionHeader
          title="Bound tests"
          count={bound.length}
          icon={Lock}
        />
        <BoundTestsTable
          bound={bound}
          incidentsById={incidentsById}
          onOverride={sendOverride}
        />
      </section>

      {pasteOpen && (
        <PasteStackModal
          onClose={() => setPasteOpen(false)}
          onSubmit={sendIngest}
        />
      )}

      {toast && (
        <Toast
          message={toast}
          canUndo={false}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}

export default IncidentsPanel;
