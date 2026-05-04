// CI Triage Phase 2 — PR Board row expansion panel that surfaces the set of
// tests the AST graph says are reachable from a PR's changed symbols. The
// panel summarises the denominator ("47 of 8000 — 88% saved"), lists every
// ranked test with a distance pill + matched-symbols column, and exposes a
// "Run relevant only" button that emits a `run-relevant-tests` WS action.
//
// All state transitions use functional setState — the parent row may flip
// prUrl/project at any time and we must not capture stale values.

import React, { useMemo, useState } from 'react';
import { GitPullRequest, PlayCircle, List } from 'lucide-react';
import type { RankedTest, RelevanceResult } from '../../../server/test-relevance-ranker.js';
import { useTestRelevance } from './useTestRelevance.js';

export interface TestRelevancePanelProps {
  prUrl: string;
  project: string;
  ws: WebSocket | null;
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function distanceStyle(d: number): { bg: string; fg: string; label: string } {
  if (d <= 1) return {
    bg: 'rgba(201, 115, 115, 0.15)',
    fg: 'var(--color-error)',
    label: `d${d}`,
  };
  if (d === 2) return {
    bg: 'rgba(212, 162, 74, 0.15)',
    fg: 'var(--color-warning)',
    label: `d${d}`,
  };
  return {
    bg: 'rgba(111, 175, 138, 0.15)',
    fg: 'var(--color-success)',
    label: `d${d}`,
  };
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

function shortSymbol(full: string): string {
  const parts = full.split('::');
  if (parts.length <= 1) return full;
  const fileSeg = parts[0].split('/').pop() ?? parts[0];
  return `${fileSeg}::${parts.slice(1).join('::')}`;
}

/* ─── Sub-components ───────────────────────────────────────────────────── */

function Summary({ result }: { result: RelevanceResult }): React.ReactElement {
  const { rankedRelevant, totalTests, estimatedRuntimeMs } = result;
  const saved = totalTests > 0
    ? Math.max(0, Math.round(((totalTests - rankedRelevant.length) / totalTests) * 100))
    : 0;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '10px 12px',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 10,
      }}
    >
      <GitPullRequest size={14} aria-hidden="true" style={{ color: 'var(--text-secondary)' }} />
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
        {rankedRelevant.length} of {totalTests} tests relevant
      </span>
      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        — est. {fmtDuration(estimatedRuntimeMs)}
      </span>
      <span
        style={{
          marginLeft: 'auto',
          fontSize: 11, fontWeight: 600,
          padding: '2px 8px',
          borderRadius: 'var(--radius-full)',
          background: saved > 50
            ? 'rgba(111, 175, 138, 0.15)'
            : 'rgba(107, 138, 171, 0.15)',
          color: saved > 50 ? 'var(--color-success)' : 'var(--color-info)',
        }}
      >
        {saved}% saved
      </span>
    </div>
  );
}

function MatchedCell({ matched }: { matched: string[] }): React.ReactElement {
  const first = matched.slice(0, 3);
  const more = matched.length - first.length;
  return (
    <span style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
      {first.map((s, i) => (
        <span key={s} title={s}>
          {i > 0 ? ', ' : ''}
          {shortSymbol(s)}
        </span>
      ))}
      {more > 0 && (
        <span style={{ color: 'var(--text-tertiary)' }} title={matched.slice(3).join('\n')}>
          {' '}+{more} more
        </span>
      )}
    </span>
  );
}

interface TestTableProps {
  rows: RankedTest[];
  caption?: string;
  muted?: boolean;
}

function TestTable({ rows, caption, muted }: TestTableProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 4px' }}>
        No tests in this bucket.
      </div>
    );
  }
  return (
    <div>
      {caption && (
        <div style={{
          fontSize: 10, textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-tertiary)',
          marginBottom: 4,
        }}>
          {caption}
        </div>
      )}
      <div role="table" style={{
        display: 'flex', flexDirection: 'column',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden',
        opacity: muted ? 0.7 : 1,
      }}>
        <div role="row" style={{
          display: 'grid', gridTemplateColumns: '44px 1fr 1.5fr',
          gap: 8, padding: '6px 10px',
          background: 'var(--bg-elevated-2)',
          fontSize: 10, fontWeight: 700,
          textTransform: 'uppercase', letterSpacing: 0.4,
          color: 'var(--text-tertiary)',
        }}>
          <span>Dist</span>
          <span>Test file</span>
          <span>Matched symbols</span>
        </div>
        {rows.map((r) => {
          const ds = distanceStyle(r.distance);
          return (
            <div
              role="row"
              key={`${r.repoName}::${r.testFile}`}
              style={{
                display: 'grid', gridTemplateColumns: '44px 1fr 1.5fr',
                gap: 8, padding: '6px 10px',
                fontSize: 12,
                borderTop: '1px solid var(--separator)',
                alignItems: 'center',
              }}
            >
              <span style={{
                justifySelf: 'start',
                padding: '1px 7px',
                background: ds.bg,
                color: ds.fg,
                borderRadius: 'var(--radius-full)',
                fontFamily: 'var(--font-mono)',
                fontSize: 10, fontWeight: 700,
              }}>
                {ds.label}
              </span>
              <span style={{
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-primary)',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }} title={r.testFile}>
                {r.testFile}
              </span>
              <MatchedCell matched={r.matchedSymbols} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LoadingSkeleton(): React.ReactElement {
  return (
    <div aria-label="Loading test relevance" style={{ padding: '10px 0' }}>
      <div style={{
        height: 38, width: '100%',
        background: 'var(--bg-elevated-2)',
        borderRadius: 'var(--radius-md)',
        marginBottom: 10,
      }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} style={{
            height: 28, width: '100%',
            background: 'var(--bg-elevated-2)',
            borderRadius: 'var(--radius-sm)',
            opacity: 0.6 - i * 0.15,
          }} />
        ))}
      </div>
    </div>
  );
}

/* ─── Main ─────────────────────────────────────────────────────────────── */

export function TestRelevancePanel({
  prUrl,
  project,
  ws,
}: TestRelevancePanelProps): React.ReactElement {
  const { result, loading, error, runRelevant } = useTestRelevance(ws, project, prUrl);
  const [showOther, setShowOther] = useState<boolean>(false);

  const { relevant, irrelevant } = useMemo(() => {
    if (!result) return { relevant: [] as RankedTest[], irrelevant: [] as RankedTest[] };
    // Rule: maxDistance tests with only transitive-indirect matches go in the
    // "not relevant" bucket so the user can still inspect them for debugging.
    const rel: RankedTest[] = [];
    const irr: RankedTest[] = [];
    for (const t of result.rankedRelevant) {
      if (t.distance <= 2) rel.push(t);
      else irr.push(t);
    }
    return { relevant: rel, irrelevant: irr };
  }, [result]);

  return (
    <section
      aria-label="Test relevance panel"
      style={{
        padding: 12,
        fontFamily: 'var(--font-sans)',
        background: 'var(--bg-elevated-1)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
      }}
    >
      {/* Toolbar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{
          fontSize: 11, textTransform: 'uppercase',
          letterSpacing: 0.5,
          color: 'var(--text-tertiary)',
        }}>
          Test relevance
        </span>
        <button
          type="button"
          onClick={runRelevant}
          disabled={!result || result.rankedRelevant.length === 0 || !ws}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 12, fontWeight: 600,
            padding: '4px 10px',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--bg-elevated-2)',
            color: 'var(--text-primary)',
            cursor: (!result || result.rankedRelevant.length === 0 || !ws) ? 'not-allowed' : 'pointer',
            opacity: (!result || result.rankedRelevant.length === 0 || !ws) ? 0.5 : 1,
          }}
        >
          <PlayCircle size={12} aria-hidden="true" />
          Run relevant only
        </button>
      </div>

      {loading && <LoadingSkeleton />}

      {!loading && error && (
        <div style={{
          padding: '8px 10px',
          border: '1px solid var(--color-error)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--color-error)',
          fontSize: 12,
        }}>
          {error}
        </div>
      )}

      {!loading && !error && result && result.rankedRelevant.length === 0 && (
        <div style={{
          padding: '12px',
          border: '1px dashed var(--separator)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-tertiary)',
          fontSize: 12,
          textAlign: 'center',
        }}>
          No tests on the AST graph are reachable from this PR's changed symbols.
          <div style={{ marginTop: 4, fontSize: 11 }}>
            You may still want to run a smoke suite.
          </div>
        </div>
      )}

      {!loading && !error && result && result.rankedRelevant.length > 0 && (
        <>
          <Summary result={result} />
          <TestTable rows={relevant} caption={`Relevant (${relevant.length})`} />

          {irrelevant.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                onClick={() => setShowOther((prev) => !prev)}
                aria-expanded={showOther}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 11, fontWeight: 600,
                  padding: '3px 8px',
                  background: 'transparent',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-secondary)',
                  cursor: 'pointer',
                }}
              >
                <List size={11} aria-hidden="true" />
                {showOther ? 'Hide' : 'Show'} not relevant to this diff ({irrelevant.length})
              </button>
              {showOther && (
                <div style={{ marginTop: 6 }}>
                  <TestTable rows={irrelevant} muted />
                </div>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

export default TestRelevancePanel;
