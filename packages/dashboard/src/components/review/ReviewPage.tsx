import React, { useState, useEffect, useCallback } from 'react';
import { GitCompareArrows, AlertTriangle, AlertCircle, Info, ChevronDown, ChevronRight, Wrench } from 'lucide-react';

export interface ReviewPageProps {
  project: string | null;
  ws: WebSocket | null;
}

type Severity = 'error' | 'warning' | 'info';

interface Finding {
  severity: Severity;
  file: string;
  line: number;
  description: string;
  suggestedFix: string | null;
}

function parseFindingsFromOutput(text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (const line of lines) {
    const match = line.match(/\*\*(ERROR|WARNING|INFO)\*\*\s*[:—–-]\s*`?([^:`\s]+)`?\s*(?:[:]\s*L?(\d+))?\s*[:—–-]\s*(.+)/i);
    if (match) {
      const severity = match[1].toLowerCase() as Severity;
      const file = match[2];
      const lineNum = match[3] ? parseInt(match[3], 10) : 0;
      const description = match[4].trim();
      findings.push({ severity, file, line: lineNum, description, suggestedFix: null });
      continue;
    }
    // Also try simpler patterns
    const simpleMatch = line.match(/\[(ERROR|WARNING|INFO)\]\s*([^:]+):?(\d+)?\s*[-—:]\s*(.+)/i);
    if (simpleMatch) {
      findings.push({
        severity: simpleMatch[1].toLowerCase() as Severity,
        file: simpleMatch[2].trim(),
        line: simpleMatch[3] ? parseInt(simpleMatch[3], 10) : 0,
        description: simpleMatch[4].trim(),
        suggestedFix: null,
      });
    }
  }
  return findings;
}

const severityConfig: Record<Severity, { icon: React.ComponentType<any>; color: string; label: string }> = {
  error:   { icon: AlertCircle,   color: 'var(--color-error)',   label: 'Error' },
  warning: { icon: AlertTriangle, color: 'var(--color-warning)', label: 'Warning' },
  info:    { icon: Info,          color: 'var(--color-info)',    label: 'Info' },
};

export function ReviewPage({ project, ws }: ReviewPageProps) {
  const [findings, setFindings] = useState<Finding[]>([]);
  const [loading, setLoading] = useState(false);
  const [branch, setBranch] = useState('main');
  const [filters, setFilters] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: true });
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);
  const [hasRun, setHasRun] = useState(false);

  const toggleFilter = useCallback((sev: Severity) => {
    setFilters((prev) => ({ ...prev, [sev]: !prev[sev] }));
  }, []);

  const handleReview = useCallback(() => {
    if (!ws || !project) return;
    setLoading(true);
    setFindings([]);
    setHasRun(true);
    ws.send(JSON.stringify({ action: 'run-diff', project, against: branch }));
  }, [ws, project, branch]);

  // Listen for agent output
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'agent-output' && typeof msg.payload?.text === 'string') {
          const parsed = parseFindingsFromOutput(msg.payload.text);
          if (parsed.length > 0) {
            setFindings((prev) => [...prev, ...parsed]);
          }
        }
        if (msg.type === 'agent-done' || msg.type === 'agent-error') {
          setLoading(false);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const filtered = findings.filter((f) => filters[f.severity]);
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const warningCount = findings.filter((f) => f.severity === 'warning').length;
  const infoCount = findings.filter((f) => f.severity === 'info').length;

  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)',
      maxWidth: 900,
      margin: '0 auto',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 20,
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <GitCompareArrows size={20} style={{ color: 'var(--accent)' }} />
          <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Code Review</h2>
          {project && (
            <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>
          )}
        </div>
        <button
          onClick={handleReview}
          disabled={loading || !project}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 20px',
            fontSize: 13,
            fontWeight: 600,
            background: 'var(--accent)',
            color: 'var(--text-inverse)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: loading || !project ? 'not-allowed' : 'pointer',
            opacity: loading || !project ? 0.6 : 1,
            fontFamily: 'var(--font-sans)',
          }}
        >
          <GitCompareArrows size={14} strokeWidth={1.75} />
          {loading ? 'Reviewing...' : 'Review Changes'}
        </button>
      </div>

      {/* Branch selector + severity filters */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 16,
        flexShrink: 0,
      }}>
        {/* Branch dropdown */}
        <div style={{ position: 'relative' }}>
          <select
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            style={{
              appearance: 'none',
              height: 28,
              padding: '0 24px 0 10px',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            <option value="main">main</option>
            <option value="develop">develop</option>
            <option value="staging">staging</option>
          </select>
          <ChevronDown
            size={12}
            strokeWidth={2}
            style={{
              position: 'absolute', right: 7, top: '50%',
              transform: 'translateY(-50%)', pointerEvents: 'none',
              color: 'var(--text-tertiary)',
            }}
          />
        </div>

        {/* Severity filter pills */}
        <div style={{ display: 'flex', gap: 4 }}>
          {(Object.keys(severityConfig) as Severity[]).map((sev) => {
            const cfg = severityConfig[sev];
            const isActive = filters[sev];
            return (
              <button
                key={sev}
                onClick={() => toggleFilter(sev)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  height: 28,
                  padding: '0 10px',
                  background: isActive ? 'var(--bg-elevated-3)' : 'transparent',
                  color: isActive ? cfg.color : 'var(--text-quaternary)',
                  border: isActive ? `1px solid ${cfg.color}` : '1px solid var(--separator)',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12,
                  fontWeight: isActive ? 500 : 400,
                  fontFamily: 'var(--font-sans)',
                  cursor: 'pointer',
                  transition: 'all var(--duration-fast) var(--ease-default)',
                }}
              >
                <cfg.icon size={14} strokeWidth={1.75} />
                {cfg.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Loading spinner */}
      {loading && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 48,
          flexShrink: 0,
        }}>
          <div className="status-dot-spin" style={{ width: 20, height: 20, marginRight: 12 }} />
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
            Analyzing changes against <span style={{ fontFamily: 'var(--font-mono)' }}>{branch}</span>...
          </span>
        </div>
      )}

      {/* Findings list */}
      {!loading && hasRun && filtered.length > 0 && (
        <div className="stagger" style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          minHeight: 0,
        }}>
          {filtered.map((finding, idx) => {
            const cfg = severityConfig[finding.severity];
            const SevIcon = cfg.icon;
            const isExpanded = expandedIdx === idx;
            return (
              <div
                key={idx}
                style={{
                  padding: '12px 16px',
                  background: 'var(--bg-elevated-2)',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-md)',
                  transition: 'border-color var(--duration-fast) var(--ease-default)',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.borderColor = cfg.color; }}
                onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--separator)'; }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                  <SevIcon size={14} strokeWidth={1.75} style={{ color: cfg.color, marginTop: 2, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                      <span style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--text-primary)',
                      }}>
                        {finding.file}
                      </span>
                      {finding.line > 0 && (
                        <span style={{
                          fontSize: 11,
                          color: 'var(--text-tertiary)',
                          padding: '1px 6px',
                          background: 'var(--bg-elevated-3)',
                          borderRadius: 'var(--radius-xs)',
                          fontFamily: 'var(--font-mono)',
                        }}>
                          L{finding.line}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                      {finding.description}
                    </div>
                    {/* Suggested fix toggle */}
                    {finding.suggestedFix && (
                      <button
                        onClick={() => setExpandedIdx(isExpanded ? null : idx)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          marginTop: 8,
                          padding: 0,
                          background: 'none',
                          border: 'none',
                          fontSize: 12,
                          color: 'var(--accent)',
                          cursor: 'pointer',
                          fontFamily: 'var(--font-sans)',
                        }}
                      >
                        {isExpanded
                          ? <ChevronDown size={14} strokeWidth={1.75} />
                          : <ChevronRight size={14} strokeWidth={1.75} />
                        }
                        <Wrench size={14} strokeWidth={1.75} />
                        Suggested Fix
                      </button>
                    )}
                    {isExpanded && finding.suggestedFix && (
                      <pre style={{
                        marginTop: 8,
                        padding: '10px 12px',
                        background: 'var(--bg-base)',
                        borderRadius: 'var(--radius-sm)',
                        fontSize: 12,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-secondary)',
                        whiteSpace: 'pre-wrap',
                        wordBreak: 'break-word',
                        lineHeight: 1.5,
                        overflow: 'auto',
                      }}>
                        {finding.suggestedFix}
                      </pre>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {!loading && !hasRun && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          fontSize: 14,
          gap: 12,
        }}>
          <GitCompareArrows size={32} style={{ opacity: 0.3 }} />
          <span>Click &quot;Review Changes&quot; to analyze your uncommitted changes</span>
        </div>
      )}

      {/* No findings after run */}
      {!loading && hasRun && findings.length === 0 && (
        <div style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--color-success)',
          fontSize: 14,
          gap: 12,
        }}>
          <GitCompareArrows size={32} />
          <span>No issues found — looking good!</span>
        </div>
      )}

      {/* All filtered out */}
      {!loading && hasRun && findings.length > 0 && filtered.length === 0 && (
        <div style={{
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: 'var(--text-tertiary)',
          fontSize: 13,
        }}>
          All findings are hidden by your active filters.
        </div>
      )}

      {/* Summary bar */}
      {hasRun && findings.length > 0 && (
        <div style={{
          flexShrink: 0,
          marginTop: 12,
          padding: '10px 16px',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          display: 'flex',
          alignItems: 'center',
          gap: 16,
        }}>
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
            Found {findings.length} issue{findings.length !== 1 ? 's' : ''}
          </span>
          {errorCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-error)' }}>
              <AlertCircle size={12} strokeWidth={1.75} />
              {errorCount} error{errorCount !== 1 ? 's' : ''}
            </span>
          )}
          {warningCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-warning)' }}>
              <AlertTriangle size={12} strokeWidth={1.75} />
              {warningCount} warning{warningCount !== 1 ? 's' : ''}
            </span>
          )}
          {infoCount > 0 && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, color: 'var(--color-info)' }}>
              <Info size={12} strokeWidth={1.75} />
              {infoCount} info
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default ReviewPage;
