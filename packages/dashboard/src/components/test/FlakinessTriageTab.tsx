/**
 * FlakinessTriageTab — renders flaky-test root-cause clusters and canned
 * fix suggestions. Driven by the useFlakinessTriage hook over WebSocket.
 */

import React, { useMemo, useState } from 'react';
import { Activity, Clock, Database, Server, HelpCircle, RefreshCw, Copy, Check } from 'lucide-react';

import {
  useFlakinessTriage,
  type FlakyCluster,
  type FlakyFixSuggestion,
  type FlakyRootCause,
} from './useFlakinessTriage.js';

// ── Props ────────────────────────────────────────────────────────────────

export interface FlakinessTriageTabProps {
  project: string;
  specSlug: string;
  ws: WebSocket | null;
}

// ── Root-cause presentation config ───────────────────────────────────────

interface CauseConfig {
  label: string;
  color: string;
  bg: string;
  border: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
}

const causeConfig: Record<FlakyRootCause, CauseConfig> = {
  'timing-sensitive': {
    label: 'Timing',
    color: 'var(--color-warning, #f59e0b)',
    bg: 'rgba(245, 158, 11, 0.12)',
    border: 'var(--color-warning, #f59e0b)',
    icon: Clock,
  },
  'order-dependent': {
    label: 'Order',
    color: 'var(--color-info, #3b82f6)',
    bg: 'rgba(59, 130, 246, 0.12)',
    border: 'var(--color-info, #3b82f6)',
    icon: Activity,
  },
  'data-dependent': {
    label: 'Data',
    color: 'var(--accent)',
    bg: 'rgba(139, 92, 246, 0.12)',
    border: 'var(--accent)',
    icon: Database,
  },
  'env-dependent': {
    label: 'Env',
    color: 'var(--color-error, #ef4444)',
    bg: 'rgba(239, 68, 68, 0.12)',
    border: 'var(--color-error, #ef4444)',
    icon: Server,
  },
  unknown: {
    label: 'Unknown',
    color: 'var(--text-tertiary)',
    bg: 'var(--bg-elevated-3)',
    border: 'var(--separator)',
    icon: HelpCircle,
  },
};

const causeOrder: FlakyRootCause[] = [
  'timing-sensitive',
  'order-dependent',
  'data-dependent',
  'env-dependent',
  'unknown',
];

// ── Helpers ──────────────────────────────────────────────────────────────

function failureRateColor(rate: number): { color: string; bg: string } {
  if (rate >= 0.5) return { color: 'var(--color-error, #ef4444)', bg: 'rgba(239, 68, 68, 0.12)' };
  if (rate >= 0.25) return { color: 'var(--color-warning, #f59e0b)', bg: 'rgba(245, 158, 11, 0.12)' };
  return { color: 'var(--color-info, #3b82f6)', bg: 'rgba(59, 130, 246, 0.12)' };
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

// ── Top-level component ──────────────────────────────────────────────────

export function FlakinessTriageTab({ project, specSlug, ws }: FlakinessTriageTabProps) {
  const { clusters, suggestions, loading, refresh } = useFlakinessTriage(project, specSlug, ws);

  // Suggestions keyed by testId for O(1) lookup while rendering cluster cards.
  const suggestionByTest = useMemo(() => {
    const m = new Map<string, FlakyFixSuggestion>();
    for (const s of suggestions) m.set(s.testId, s);
    return m;
  }, [suggestions]);

  const totals = useMemo(() => {
    const out: Record<FlakyRootCause, number> = {
      'timing-sensitive': 0,
      'order-dependent': 0,
      'data-dependent': 0,
      'env-dependent': 0,
      unknown: 0,
    };
    for (const c of clusters) out[c.rootCause]++;
    return out;
  }, [clusters]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16, fontFamily: 'var(--font-sans)' }}>
      <Toolbar loading={loading} onRefresh={refresh} count={clusters.length} />

      {loading && clusters.length === 0 ? (
        <LoadingSkeleton />
      ) : clusters.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SummaryBar totals={totals} total={clusters.length} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {clusters.map((c) => (
              <ClusterCard key={c.testId} cluster={c} suggestion={suggestionByTest.get(c.testId)} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Toolbar ──────────────────────────────────────────────────────────────

function Toolbar({
  loading,
  onRefresh,
  count,
}: {
  loading: boolean;
  onRefresh: () => void;
  count: number;
}) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Activity size={16} strokeWidth={2.25} aria-hidden="true" />
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
          Flakiness triage
        </h2>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          {count} cluster{count === 1 ? '' : 's'}
        </span>
      </div>
      <button
        onClick={onRefresh}
        disabled={loading}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 28, padding: '0 10px',
          background: 'var(--bg-elevated-3)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-secondary)',
          fontSize: 12, fontWeight: 500,
          cursor: loading ? 'default' : 'pointer',
          opacity: loading ? 0.5 : 1,
          fontFamily: 'var(--font-sans)',
        }}
      >
        <RefreshCw size={12} strokeWidth={2.25} aria-hidden="true" />
        Refresh
      </button>
    </div>
  );
}

// ── Summary bar (stacked horizontal bar by root cause) ───────────────────

function SummaryBar({
  totals,
  total,
}: {
  totals: Record<FlakyRootCause, number>;
  total: number;
}) {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: 12,
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          fontSize: 11, color: 'var(--text-tertiary)',
          textTransform: 'uppercase', letterSpacing: 0.3,
        }}
      >
        <span>Root-cause distribution</span>
        <span>{total} flaky test{total === 1 ? '' : 's'}</span>
      </div>
      <div
        style={{
          display: 'flex',
          height: 10,
          width: '100%',
          borderRadius: 999,
          overflow: 'hidden',
          background: 'var(--bg-elevated-3)',
        }}
      >
        {causeOrder.map((cause) => {
          const n = totals[cause];
          if (n === 0) return null;
          const cfg = causeConfig[cause];
          const width = `${(n / total) * 100}%`;
          return (
            <div
              key={cause}
              title={`${cfg.label}: ${n}`}
              style={{ width, background: cfg.color }}
            />
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {causeOrder.map((cause) => {
          const n = totals[cause];
          if (n === 0) return null;
          const cfg = causeConfig[cause];
          const Icon = cfg.icon;
          return (
            <span
              key={cause}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '2px 8px',
                fontSize: 11, fontWeight: 500,
                color: cfg.color,
                background: cfg.bg,
                border: `1px solid ${cfg.border}`,
                borderRadius: 999,
              }}
            >
              <Icon size={10} strokeWidth={2.25} />
              {cfg.label} · {n}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── Cluster card ─────────────────────────────────────────────────────────

function ClusterCard({
  cluster,
  suggestion,
}: {
  cluster: FlakyCluster;
  suggestion: FlakyFixSuggestion | undefined;
}) {
  const cfg = causeConfig[cluster.rootCause];
  const Icon = cfg.icon;
  const rateColors = failureRateColor(cluster.failureRate);

  return (
    <article
      style={{
        display: 'flex', flexDirection: 'column', gap: 10,
        padding: 14,
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      <header
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <code
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 13, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
          >
            {cluster.testId}
          </code>
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {cluster.samples} sample{cluster.samples === 1 ? '' : 's'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span
            style={{
              padding: '2px 8px',
              fontSize: 11, fontWeight: 600,
              color: rateColors.color,
              background: rateColors.bg,
              border: `1px solid ${rateColors.color}`,
              borderRadius: 999,
            }}
          >
            {pct(cluster.failureRate)} flaky
          </span>
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '2px 8px',
              fontSize: 11, fontWeight: 600,
              color: cfg.color,
              background: cfg.bg,
              border: `1px solid ${cfg.border}`,
              borderRadius: 999,
              textTransform: 'uppercase', letterSpacing: 0.3,
            }}
          >
            <Icon size={10} strokeWidth={2.25} />
            {cfg.label}
          </span>
        </div>
      </header>

      {cluster.evidence.length > 0 && (
        <ul
          style={{
            margin: 0, paddingLeft: 18,
            fontSize: 12, lineHeight: 1.5,
            color: 'var(--text-secondary)',
          }}
        >
          {cluster.evidence.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      )}

      {suggestion && <SuggestionBox suggestion={suggestion} />}
    </article>
  );
}

// ── Suggestion box + copy-patch button ───────────────────────────────────

function SuggestionBox({ suggestion }: { suggestion: FlakyFixSuggestion }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    if (!suggestion.codePatch) return;
    navigator.clipboard?.writeText(suggestion.codePatch).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 8,
        padding: 10,
        background: 'var(--bg-elevated-3)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-sm)',
      }}
    >
      <div
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <span
          style={{
            fontSize: 10, fontWeight: 600,
            color: 'var(--text-tertiary)',
            textTransform: 'uppercase', letterSpacing: 0.3,
          }}
        >
          Suggested fix · conf {pct(suggestion.confidence)}
        </span>
      </div>
      <p
        style={{
          margin: 0,
          fontSize: 12, lineHeight: 1.5,
          color: 'var(--text-primary)',
        }}
      >
        {suggestion.suggestion}
      </p>
      {suggestion.codePatch && (
        <div style={{ position: 'relative' }}>
          <pre
            style={{
              margin: 0,
              padding: 10,
              fontFamily: 'var(--font-mono)',
              fontSize: 11, lineHeight: 1.5,
              color: 'var(--text-primary)',
              background: 'var(--bg-elevated-1)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {suggestion.codePatch}
          </pre>
          <button
            onClick={copy}
            aria-label="Copy patch"
            style={{
              position: 'absolute', top: 6, right: 6,
              display: 'inline-flex', alignItems: 'center', gap: 4,
              height: 22, padding: '0 8px',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: 10, fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            {copied ? <Check size={10} strokeWidth={2.5} /> : <Copy size={10} strokeWidth={2.25} />}
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Empty / loading states ───────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 6,
        padding: 40,
        background: 'var(--bg-elevated-2)',
        border: '1px dashed var(--separator)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-tertiary)',
        textAlign: 'center',
      }}
    >
      <span style={{ fontSize: 20 }} role="img" aria-hidden="true">🎉</span>
      <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
        No flaky tests detected.
      </p>
      <p style={{ margin: 0, fontSize: 11 }}>
        New samples appear here as runs accumulate.
      </p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          style={{
            height: 88,
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            opacity: 0.6,
          }}
        />
      ))}
    </div>
  );
}
