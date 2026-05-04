// CI Triage Panel — Phase 3.
//
// Lets an engineer paste (or fetch) a CI log and see it bucketed into
// root-cause clusters (OOM, port conflict, DB lock, network timeout, etc.).
// Each cluster renders with an icon, severity pill, example lines, and a
// suggested fix. Results can be saved to the triage store for history and
// learning.
//
// All WebSocket handlers use functional setState — no stale-closure reads.

import React, { useCallback, useMemo, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  Cog,
  Database,
  FileX,
  Lock,
  Network,
  Search,
} from 'lucide-react';

import {
  useCiTriage,
  type CiFailureCluster,
  type CiFailurePattern,
  type CiFailureSeverity,
} from './useCiTriage.js';

export interface TriagePanelProps {
  project: string | null;
  ws: WebSocket | null;
  initialLog?: string;
}

// ── Visual helpers ──────────────────────────────────────────────────────

const SEVERITY_COLOR: Record<CiFailureSeverity, { bg: string; fg: string }> = {
  critical: { bg: '#3a0f12', fg: '#ff7b85' },
  high: { bg: '#3a1f0f', fg: '#ffad6b' },
  medium: { bg: '#2f2f10', fg: '#e7d86b' },
  low: { bg: '#14281f', fg: '#66d099' },
};

function iconForPattern(pattern: CiFailurePattern): React.ReactElement {
  switch (pattern) {
    case 'oom': return <AlertOctagon size={16} />;
    case 'port-conflict': return <Network size={16} />;
    case 'db-lock': return <Database size={16} />;
    case 'network-timeout': return <Network size={16} />;
    case 'known-flake': return <Activity size={16} />;
    case 'dependency-mismatch': return <Cog size={16} />;
    case 'permission-denied': return <Lock size={16} />;
    case 'missing-file': return <FileX size={16} />;
    case 'compile-error': return <Cog size={16} />;
    case 'assertion-failure': return <AlertOctagon size={16} />;
    default: return <Search size={16} />;
  }
}

function prettyPattern(pattern: CiFailurePattern): string {
  return pattern.replace(/-/g, ' ');
}

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  return new Date(t).toLocaleString();
}

// ── Styles ──────────────────────────────────────────────────────────────

const containerStyle: React.CSSProperties = {
  padding: 20,
  display: 'flex',
  flexDirection: 'column',
  gap: 16,
  color: 'var(--text-primary)',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 600,
  margin: 0,
};

const formCardStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  background: 'var(--surface)',
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 140,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  padding: 8,
  background: 'var(--surface-alt)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  resize: 'vertical',
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
};

const urlInputStyle: React.CSSProperties = {
  flex: 1,
  padding: '8px 10px',
  background: 'var(--surface-alt)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 13,
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'var(--accent)',
  color: 'var(--accent-contrast, white)',
  border: 'none',
  borderRadius: 6,
  cursor: 'pointer',
  fontWeight: 500,
  fontSize: 13,
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '8px 14px',
  background: 'transparent',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 13,
};

const emptyStyle: React.CSSProperties = {
  padding: 40,
  textAlign: 'center',
  color: 'var(--text-tertiary)',
  border: '1px dashed var(--border)',
  borderRadius: 8,
};

const skeletonStyle: React.CSSProperties = {
  height: 96,
  borderRadius: 8,
  background: 'linear-gradient(90deg, var(--surface) 0%, var(--surface-alt) 50%, var(--surface) 100%)',
  backgroundSize: '200% 100%',
  animation: 'triage-skeleton 1.4s ease-in-out infinite',
};

const clusterCardStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  background: 'var(--surface)',
};

const clusterHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 10,
};

const badgeStyle = (sev: CiFailureSeverity): React.CSSProperties => ({
  padding: '2px 8px',
  borderRadius: 12,
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  background: SEVERITY_COLOR[sev].bg,
  color: SEVERITY_COLOR[sev].fg,
  letterSpacing: 0.4,
});

const examplePreStyle: React.CSSProperties = {
  margin: 0,
  padding: 10,
  background: 'var(--surface-alt)',
  borderRadius: 6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12,
  color: 'var(--text-primary)',
  overflowX: 'auto',
  whiteSpace: 'pre-wrap',
};

const suggestedFixStyle: React.CSSProperties = {
  padding: 10,
  borderLeft: '3px solid var(--accent)',
  background: 'var(--surface-alt)',
  borderRadius: '0 6px 6px 0',
  fontSize: 13,
  color: 'var(--text-secondary)',
};

const errorBannerStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: 6,
  background: '#3a0f12',
  color: '#ff7b85',
  fontSize: 13,
};

const statsRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 16,
  fontSize: 12,
  color: 'var(--text-tertiary)',
};

// ── Subcomponents ───────────────────────────────────────────────────────

function ClusterCard({ cluster }: { cluster: CiFailureCluster }): React.ReactElement {
  return (
    <div style={clusterCardStyle}>
      <div style={clusterHeaderStyle}>
        {iconForPattern(cluster.pattern)}
        <strong style={{ textTransform: 'capitalize' }}>{prettyPattern(cluster.pattern)}</strong>
        <span style={badgeStyle(cluster.severity)}>{cluster.severity}</span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
          {cluster.count}x · lines {cluster.firstLine}–{cluster.lastLine} · confidence {cluster.confidence.toFixed(2)}
        </span>
      </div>
      <div style={suggestedFixStyle}>
        <strong>Suggested fix: </strong>{cluster.suggestedFix}
      </div>
      {cluster.examples.length > 0 && (
        <pre style={examplePreStyle}>
          {cluster.examples.map((ex, idx) => `${idx + 1}. ${ex}`).join('\n')}
        </pre>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

export function TriagePanel({
  project,
  ws,
  initialLog,
}: TriagePanelProps): React.ReactElement {
  const [logText, setLogText] = useState<string>(initialLog || '');
  const [logUrl, setLogUrl] = useState<string>('');

  const { report, loading, error, analyzeLog, saveReport, clear } = useCiTriage(ws, project);

  const handleAnalyze = useCallback((): void => {
    if (!logText.trim()) return;
    analyzeLog({ logText });
  }, [analyzeLog, logText]);

  const handleFetchUrl = useCallback((): void => {
    if (!logUrl.trim()) return;
    analyzeLog({ logUrl: logUrl.trim() });
  }, [analyzeLog, logUrl]);

  const handleSave = useCallback((): void => {
    saveReport();
  }, [saveReport]);

  const handleClear = useCallback((): void => {
    setLogText(() => '');
    setLogUrl(() => '');
    clear();
  }, [clear]);

  const clusters = useMemo<CiFailureCluster[]>(
    () => (report ? report.clusters : []),
    [report],
  );

  return (
    <div style={containerStyle}>
      <style>{`@keyframes triage-skeleton { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }`}</style>

      <header style={headerStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Search size={18} color="var(--text-primary)" />
          <h2 style={titleStyle}>CI Triage</h2>
          {project && (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              project: {project}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {report && (
            <button type="button" onClick={handleSave} style={secondaryButtonStyle} disabled={!project}>
              Save to triage history
            </button>
          )}
          {(report || logText || logUrl) && (
            <button type="button" onClick={handleClear} style={secondaryButtonStyle}>
              Clear
            </button>
          )}
        </div>
      </header>

      <section style={formCardStyle}>
        <label style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          Paste CI log output
        </label>
        <textarea
          value={logText}
          onChange={(event) => setLogText(event.target.value)}
          placeholder="Paste stdout/stderr from the failing job here..."
          style={textareaStyle}
          spellCheck={false}
        />
        <div style={rowStyle}>
          <button
            type="button"
            onClick={handleAnalyze}
            style={primaryButtonStyle}
            disabled={!project || !logText.trim() || loading}
          >
            Analyze pasted log
          </button>
          <span style={{ flex: 1, textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 12 }}>
            — or —
          </span>
          <input
            type="url"
            value={logUrl}
            onChange={(event) => setLogUrl(event.target.value)}
            placeholder="https://github.com/owner/repo/actions/runs/12345"
            style={urlInputStyle}
          />
          <button
            type="button"
            onClick={handleFetchUrl}
            style={secondaryButtonStyle}
            disabled={!project || !logUrl.trim() || loading}
          >
            Fetch log
          </button>
        </div>
      </section>

      {error && (
        <div style={errorBannerStyle} role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={skeletonStyle} />
          <div style={skeletonStyle} />
          <div style={skeletonStyle} />
        </div>
      ) : report ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={statsRowStyle}>
            <span>source: {report.logSource}</span>
            <span>total lines: {report.totalLines.toLocaleString()}</span>
            <span>error lines: {report.errorLines.toLocaleString()}</span>
            <span>computed: {formatDate(report.computedAt)}</span>
          </div>
          {clusters.length === 0 ? (
            <div style={emptyStyle}>
              <Search size={24} color="var(--text-tertiary)" />
              <div style={{ marginTop: 8 }}>
                No known failure patterns matched — inspect the unknown excerpt below.
              </div>
            </div>
          ) : (
            clusters.map((cluster) => (
              <ClusterCard key={cluster.pattern} cluster={cluster} />
            ))
          )}
          {report.unknownExcerpt.length > 0 && (
            <section style={clusterCardStyle}>
              <div style={clusterHeaderStyle}>
                <Search size={16} />
                <strong>Unclassified error lines</strong>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 12 }}>
                  {report.unknownExcerpt.length} sample
                </span>
              </div>
              <pre style={examplePreStyle}>
                {report.unknownExcerpt.map((line, idx) => `${idx + 1}. ${line}`).join('\n')}
              </pre>
            </section>
          )}
        </div>
      ) : (
        <div style={emptyStyle}>
          <Search size={24} color="var(--text-tertiary)" />
          <div style={{ marginTop: 8 }}>
            Paste a CI log or fetch one by URL to triage failures into root-cause buckets.
          </div>
        </div>
      )}
    </div>
  );
}

export default TriagePanel;
