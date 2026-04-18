import React, { useState, useEffect, useMemo } from 'react';
import { Search, GitCompare, Zap, Brain, Hash, Network, Layers, ChevronDown, ChevronRight } from 'lucide-react';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RetrievalMode = 'vector' | 'bm25' | 'vector+bm25' | 'vector+graph' | 'vector+bm25+graph';
type BenchTab = 'rag' | 'retrieval';

const ALL_MODES: RetrievalMode[] = ['vector', 'bm25', 'vector+bm25', 'vector+graph', 'vector+bm25+graph'];

const MODE_META: Record<RetrievalMode, { label: string; short: string; icon: React.ReactNode; color: string }> = {
  'vector':            { label: 'Vector',           short: 'Vec',   icon: <Zap size={12} />,     color: '#6366f1' },
  'bm25':              { label: 'BM25',             short: 'BM25',  icon: <Hash size={12} />,    color: '#f59e0b' },
  'vector+bm25':       { label: 'Vector + BM25',    short: 'V+B',   icon: <Layers size={12} />,  color: '#22d3ee' },
  'vector+graph':      { label: 'Vector + Graph',   short: 'V+G',   icon: <Network size={12} />, color: '#10b981' },
  'vector+bm25+graph': { label: 'Full Hybrid',      short: 'V+B+G', icon: <Brain size={12} />,   color: '#8b5cf6' },
};

// -- Retrieval types
interface BenchResult { id: string; filePath: string; entityName: string; relevanceScore: number; codePreview: string; tokens: number; source: string }
interface BenchSide { results: BenchResult[]; totalTokens: number; graphContextTokens: number; chunkCount: number; durationMs: number }

// -- RAG types
interface RagModeData {
  retrieval: { chunkCount: number; totalTokens: number; graphContextTokens: number; durationMs: number };
  answer: { text: string; inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; contextTokens: number; model: string };
  judge: { correctness: number; completeness: number; groundedness: number; hallucination_count?: number; similarity?: number; overall: number; reasoning: string };
}

function costStr(tokens: number, perMTok: number): string {
  return `$${((tokens / 1_000_000) * perMTok).toFixed(5)}`;
}

function extractQueryTerms(query: string): string[] {
  const stops = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one', 'our', 'out', 'how', 'has', 'its', 'from', 'with', 'this', 'that', 'have', 'been', 'they', 'what', 'when', 'where', 'which', 'does', 'into']);
  return query.toLowerCase().split(/\s+/).filter((w) => w.length >= 3 && !stops.has(w));
}

function highlightTerms(text: string, terms: string[]): React.ReactNode {
  if (terms.length === 0) return text;
  const pattern = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  const parts = text.split(pattern);
  return parts.map((part, i) =>
    terms.some((t) => part.toLowerCase() === t)
      ? <mark key={i} style={{ background: 'rgba(250,204,21,0.3)', color: 'inherit', borderRadius: 2, padding: '0 1px' }}>{part}</mark>
      : part,
  );
}

function keywordHitRate(text: string, terms: string[]): number {
  if (terms.length === 0) return 0;
  const lower = text.toLowerCase();
  return terms.filter((t) => lower.includes(t)).length / terms.length;
}

const SUGGESTIONS = [
  'how is user input validated before saving',
  'error handling and retry logic',
  'what calls the database connection pool',
  'functions that depend on the config loader',
  'kafka consumer batch commit offset',
  'JWT token refresh expiry middleware',
  'logging and observability instrumentation',
  'rate limiting and throttling',
];

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export interface ComparisonPageProps { projectName: string; ws: WebSocket | null }

export function ComparisonPage({ projectName, ws }: ComparisonPageProps) {
  const [query, setQuery] = useState('');
  const [maxChunks, setMaxChunks] = useState(10);
  const [referenceAnswer, setReferenceAnswer] = useState('');
  const [showReference, setShowReference] = useState(false);
  const [benchTab, setBenchTab] = useState<BenchTab>('rag');

  // Retrieval-only state
  const [searching, setSearching] = useState(false);
  const [retrievalResults, setRetrievalResults] = useState<Record<RetrievalMode, BenchSide> | null>(null);
  const [activeDetailTab, setActiveDetailTab] = useState<RetrievalMode>('vector');

  // RAG state
  const [ragRunning, setRagRunning] = useState(false);
  const [ragProgress, setRagProgress] = useState<string | null>(null);
  const [ragResults, setRagResults] = useState<{ modes: Record<RetrievalMode, RagModeData>; expertAnswer?: string; judgeCost: { costUsd: number }; totalCostUsd: number; model: string } | null>(null);
  const [ragAnswerTab, setRagAnswerTab] = useState<RetrievalMode>('vector+bm25+graph');

  const [error, setError] = useState<string | null>(null);
  const queryTerms = useMemo(() => extractQueryTerms(query), [query]);

  // WS listener
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        switch (msg.type) {
          case 'benchmark-results':
            if (msg.payload.error) setError(msg.payload.error);
            else { setRetrievalResults(msg.payload.modes); setError(null); }
            setSearching(false);
            break;
          case 'benchmark-rag-progress':
            setRagProgress(msg.payload.message);
            break;
          case 'benchmark-rag-results':
            if (msg.payload.error) setError(msg.payload.error);
            else { setRagResults(msg.payload); setError(null); }
            setRagRunning(false);
            setRagProgress(null);
            break;
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const handleRetrieval = (q: string) => {
    if (!ws || !q.trim()) return;
    setSearching(true); setError(null); setRetrievalResults(null);
    ws.send(JSON.stringify({ action: 'benchmark-search', project: projectName, query: q.trim(), maxChunks }));
  };

  const handleRag = (q: string) => {
    if (!ws || !q.trim()) return;
    setRagRunning(true); setError(null); setRagResults(null); setRagProgress('Starting...');
    ws.send(JSON.stringify({
      action: 'benchmark-rag', project: projectName, query: q.trim(), maxChunks,
      referenceAnswer: referenceAnswer.trim() || undefined,
    }));
  };

  const handleRun = (q: string) => {
    if (benchTab === 'rag') handleRag(q);
    else handleRetrieval(q);
  };

  const isRunning = searching || ragRunning;

  if (!projectName || projectName === 'None') {
    return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)', fontSize: 14 }}>Select a project from the home page first.</div>;
  }

  return (
    <div className="page-enter" style={{ padding: 'var(--space-lg)', height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexShrink: 0 }}>
        <GitCompare size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Retrieval Benchmark</h2>
        <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {projectName}</span>
      </div>

      {/* Mode tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--separator)', marginBottom: 12, flexShrink: 0 }}>
        {([['rag', 'RAG Evaluation'], ['retrieval', 'Retrieval Only']] as const).map(([tab, label]) => (
          <button key={tab} onClick={() => setBenchTab(tab)} style={{
            padding: '8px 16px', fontSize: 13, fontWeight: benchTab === tab ? 600 : 400,
            color: benchTab === tab ? 'var(--accent)' : 'var(--text-tertiary)',
            background: 'none', border: 'none',
            borderBottom: benchTab === tab ? '2px solid var(--accent)' : '2px solid transparent',
            cursor: 'pointer', fontFamily: 'var(--font-sans)', marginBottom: -1,
          }}>{label}</button>
        ))}
      </div>

      {/* Search bar */}
      <div style={{ padding: '16px 20px', background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)', marginBottom: 16, flexShrink: 0 }}>
        <form onSubmit={(e) => { e.preventDefault(); handleRun(query); }} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ flex: 1, position: 'relative' }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
            <input type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder={benchTab === 'rag' ? 'Ask a question about your codebase...' : 'Enter a query to benchmark retrieval modes...'}
              style={{ width: '100%', padding: '8px 10px 8px 32px', fontSize: 13, background: 'var(--bg-base)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', outline: 'none', fontFamily: 'var(--font-sans)' }}
            />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <label style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Chunks:</label>
            <select value={maxChunks} onChange={(e) => setMaxChunks(Number(e.target.value))}
              style={{ padding: '6px 8px', fontSize: 12, background: 'var(--bg-base)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontFamily: 'var(--font-mono)' }}>
              {[5, 10, 15, 20].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>
          <button type="submit" disabled={isRunning || !query.trim()} style={{
            padding: '8px 16px', fontSize: 12, fontWeight: 500,
            background: 'var(--accent)', color: '#fff', border: 'none',
            borderRadius: 'var(--radius-sm)', cursor: isRunning ? 'not-allowed' : 'pointer',
            opacity: (isRunning || !query.trim()) ? 0.6 : 1, whiteSpace: 'nowrap',
          }}>
            {isRunning ? 'Running...' : benchTab === 'rag' ? 'Run RAG' : 'Benchmark'}
          </button>
        </form>

        {/* Reference answer (RAG tab only) */}
        {benchTab === 'rag' && (
          <div style={{ marginTop: 8 }}>
            <button onClick={() => setShowReference(!showReference)} style={{
              display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: 'var(--text-tertiary)',
              background: 'none', border: 'none', cursor: 'pointer', padding: 0,
            }}>
              {showReference ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Reference answer (optional — enables similarity scoring)
            </button>
            {showReference && (
              <textarea value={referenceAnswer} onChange={(e) => setReferenceAnswer(e.target.value)}
                placeholder="Paste the expected/correct answer here for similarity comparison..."
                rows={3} style={{
                  width: '100%', marginTop: 6, padding: '8px 10px', fontSize: 12,
                  background: 'var(--bg-base)', border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
                  outline: 'none', fontFamily: 'var(--font-sans)', resize: 'vertical',
                }}
              />
            )}
          </div>
        )}

        {/* Suggestions */}
        {!ragResults && !retrievalResults && !isRunning && (
          <div style={{ marginTop: 10, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SUGGESTIONS.map((q) => (
              <button key={q} onClick={() => { setQuery(q); handleRun(q); }} style={{
                padding: '4px 10px', fontSize: 11, background: 'var(--bg-base)', color: 'var(--text-secondary)',
                border: '1px solid var(--separator)', borderRadius: 'var(--radius-full)', cursor: 'pointer', fontFamily: 'var(--font-mono)',
              }}>{q}</button>
            ))}
          </div>
        )}
      </div>

      {error && <div style={{ padding: '12px 16px', background: '#fef2f2', border: '1px solid #ef4444', borderRadius: 'var(--radius-md)', color: '#ef4444', fontSize: 12, marginBottom: 16, flexShrink: 0 }}>{error}</div>}

      {/* Progress */}
      {ragRunning && ragProgress && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '16px 20px', background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)', marginBottom: 16, flexShrink: 0 }}>
          <div className="spin" style={{ width: 14, height: 14, border: '2px solid var(--separator)', borderTopColor: 'var(--accent)', borderRadius: '50%', flexShrink: 0 }} />
          <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{ragProgress}</span>
        </div>
      )}

      {searching && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 40, color: 'var(--text-tertiary)', fontSize: 13 }}>
          <div className="spin" style={{ width: 16, height: 16, border: '2px solid var(--separator)', borderTopColor: 'var(--accent)', borderRadius: '50%' }} />
          Running 5 retrieval modes...
        </div>
      )}

      {/* RAG Results */}
      {benchTab === 'rag' && ragResults && (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <RagResultsView data={ragResults} expertAnswer={ragResults.expertAnswer} activeTab={ragAnswerTab} onTabChange={setRagAnswerTab} />
        </div>
      )}

      {/* Retrieval Results */}
      {benchTab === 'retrieval' && retrievalResults && (
        <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
          <RetrievalResultsView modes={retrievalResults} activeTab={activeDetailTab} onTabChange={setActiveDetailTab} queryTerms={queryTerms} />
        </div>
      )}

      {/* Empty state */}
      {!ragResults && !retrievalResults && !isRunning && !error && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center', color: 'var(--text-tertiary)' }}>
            <GitCompare size={32} style={{ margin: '0 auto 12px', opacity: 0.3 }} />
            <div style={{ fontSize: 14, color: 'var(--text-secondary)', fontWeight: 500, marginBottom: 8 }}>
              {benchTab === 'rag' ? 'RAG Evaluation' : 'Retrieval Benchmark'}
            </div>
            <div style={{ fontSize: 12, maxWidth: 480, lineHeight: 1.6 }}>
              {benchTab === 'rag'
                ? <>Run your question through <strong>5 retrieval modes</strong>, generate an LLM answer from each, then have a judge LLM score quality. Costs ~$0.10 per run.</>
                : <>Compare retrieval quality across 5 modes — chunks, tokens, cost, latency, and overlap.</>
              }
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RAG Results View
// ---------------------------------------------------------------------------

function RagResultsView({ data, expertAnswer, activeTab, onTabChange }: {
  data: { modes: Record<RetrievalMode, RagModeData>; judgeCost: { costUsd: number }; totalCostUsd: number; model: string };
  expertAnswer?: string;
  activeTab: RetrievalMode;
  onTabChange: (m: RetrievalMode) => void;
}) {
  const { modes, totalCostUsd, model } = data;

  // Find best overall score
  const bestMode = ALL_MODES.reduce((best, m) => (modes[m]?.judge.overall ?? 0) > (modes[best]?.judge.overall ?? 0) ? m : best, ALL_MODES[0]);

  return (
    <div>
      {/* Judge Scores Table */}
      <div style={{ background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--separator)' }}>
              <th style={thStyle}>Judge Scores</th>
              {ALL_MODES.map((m) => (
                <th key={m} style={{ ...thStyle, textAlign: 'center' }}>
                  <span style={{ color: MODE_META[m].color }}>{MODE_META[m].short}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(['correctness', 'completeness', 'groundedness', ...(modes[ALL_MODES[0]]?.judge.hallucination_count !== undefined ? ['hallucination_count'] : []), ...(modes[ALL_MODES[0]]?.judge.similarity !== undefined ? ['similarity'] : [])] as const).map((dim) => {
              const vals = ALL_MODES.map((m) => (modes[m]?.judge as unknown as Record<string, number>)[dim] ?? 0);
              const maxVal = Math.max(...vals);
              return (
                <tr key={dim} style={{ borderBottom: '1px solid var(--separator)' }}>
                  <td style={{ ...tdStyle, textTransform: 'capitalize' }}>{dim}</td>
                  {ALL_MODES.map((m, i) => (
                    <td key={m} style={{
                      ...tdStyle, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 600,
                      fontSize: 14,
                      color: vals[i] === maxVal && maxVal > 0 ? '#10b981' : 'var(--text-primary)',
                      background: vals[i] === maxVal && maxVal > 0 ? 'rgba(16,185,129,0.06)' : undefined,
                    }}>
                      {vals[i] || '—'}
                    </td>
                  ))}
                </tr>
              );
            })}
            <tr style={{ borderBottom: '1px solid var(--separator)', background: 'var(--bg-base)' }}>
              <td style={{ ...tdStyle, fontWeight: 700 }}>Overall</td>
              {ALL_MODES.map((m) => (
                <td key={m} style={{
                  ...tdStyle, textAlign: 'center', fontFamily: 'var(--font-mono)', fontWeight: 700, fontSize: 16,
                  color: m === bestMode ? '#10b981' : 'var(--text-primary)',
                }}>
                  {modes[m]?.judge.overall ?? '—'}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      {/* Cost & Performance Table */}
      <div style={{ background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--separator)' }}>
              <th style={thStyle}>Performance</th>
              {ALL_MODES.map((m) => (
                <th key={m} style={{ ...thStyle, textAlign: 'right' }}>
                  <span style={{ color: MODE_META[m].color }}>{MODE_META[m].short}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { label: 'Retrieval', fn: (m: RagModeData) => `${m.retrieval.durationMs}ms` },
              { label: 'Answer gen', fn: (m: RagModeData) => `${(m.answer.durationMs / 1000).toFixed(1)}s` },
              { label: 'Context tokens', fn: (m: RagModeData) => m.answer.contextTokens.toLocaleString() },
              { label: 'Answer tokens', fn: (m: RagModeData) => m.answer.outputTokens.toLocaleString() },
              { label: 'Answer cost', fn: (m: RagModeData) => `$${m.answer.costUsd.toFixed(4)}` },
            ].map((row) => (
              <tr key={row.label} style={{ borderBottom: '1px solid var(--separator)' }}>
                <td style={tdStyle}>{row.label}</td>
                {ALL_MODES.map((m) => (
                  <td key={m} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                    {modes[m] ? row.fn(modes[m]) : '—'}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ padding: '8px 14px', fontSize: 11, color: 'var(--text-tertiary)', borderTop: '1px solid var(--separator)', display: 'flex', gap: 16 }}>
          <span>Model: {model}</span>
          <span>Total cost: ${totalCostUsd.toFixed(4)} (5 answers + 1 judge)</span>
        </div>
      </div>

      {/* Answer tabs */}
      <div style={{ background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)', overflow: 'hidden' }}>
        <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--separator)' }}>
          {ALL_MODES.map((m) => {
            const meta = MODE_META[m];
            const active = activeTab === m;
            const score = modes[m]?.judge.overall;
            return (
              <button key={m} onClick={() => onTabChange(m)} style={{
                display: 'flex', alignItems: 'center', gap: 4,
                padding: '10px 14px', fontSize: 12, fontWeight: active ? 600 : 400,
                color: active ? meta.color : 'var(--text-tertiary)',
                background: active ? 'var(--bg-base)' : 'none', border: 'none',
                borderBottom: active ? `2px solid ${meta.color}` : '2px solid transparent',
                cursor: 'pointer', fontFamily: 'var(--font-sans)', marginBottom: -1,
              }}>
                {meta.icon} {meta.short}
                {score !== undefined && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, marginLeft: 4, opacity: 0.7 }}>{score}</span>}
              </button>
            );
          })}
        </div>

        {/* Active answer */}
        {modes[activeTab] && (
          <div style={{ padding: 20 }}>
            {/* Score badges */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
              {(['correctness', 'completeness', 'groundedness', ...(modes[activeTab].judge.hallucination_count !== undefined ? ['hallucination_count'] : []), ...(modes[activeTab].judge.similarity !== undefined ? ['similarity'] : [])] as string[]).map((dim) => {
                const val = (modes[activeTab].judge as unknown as Record<string, number>)[dim] ?? 0;
                return (
                  <span key={dim} style={{
                    padding: '4px 10px', fontSize: 11, borderRadius: 'var(--radius-full)',
                    background: val >= 8 ? 'rgba(16,185,129,0.12)' : val >= 5 ? 'rgba(245,158,11,0.12)' : 'rgba(239,68,68,0.12)',
                    color: val >= 8 ? '#10b981' : val >= 5 ? '#f59e0b' : '#ef4444',
                    fontWeight: 600, textTransform: 'capitalize',
                  }}>
                    {dim}: {val}/10
                  </span>
                );
              })}
              <span style={{ padding: '4px 10px', fontSize: 11, borderRadius: 'var(--radius-full)', background: 'var(--accent-subtle)', color: 'var(--accent)', fontWeight: 700 }}>
                Overall: {modes[activeTab].judge.overall}/10
              </span>
            </div>

            {/* Judge reasoning */}
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', marginBottom: 16, padding: '8px 12px', background: 'var(--bg-base)', borderRadius: 'var(--radius-sm)', borderLeft: '3px solid var(--accent)' }}>
              {modes[activeTab].judge.reasoning}
            </div>

            {/* Answer text */}
            <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
              {modes[activeTab].answer.text}
            </div>
          </div>
        )}

        {/* Expert Judge's Own Answer */}
        {expertAnswer && (
          <div style={{ marginTop: 16, padding: 16, background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)' }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent)', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
              <Brain size={14} />
              Expert Judge&apos;s Answer (based on 40 code chunks)
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 8, fontStyle: 'italic' }}>
              The judge read the actual source code and wrote this answer before scoring the candidates above.
            </div>
            <div style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-primary)', whiteSpace: 'pre-wrap' }}>
              {expertAnswer}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Retrieval Results View (from previous implementation)
// ---------------------------------------------------------------------------

function RetrievalResultsView({ modes, activeTab, onTabChange, queryTerms }: {
  modes: Record<RetrievalMode, BenchSide>;
  activeTab: RetrievalMode;
  onTabChange: (m: RetrievalMode) => void;
  queryTerms: string[];
}) {
  const analysis = useMemo(() => {
    const sets: Record<string, Set<string>> = {};
    for (const mode of ALL_MODES) sets[mode] = new Set(modes[mode]?.results.map((r) => r.id) ?? []);
    const matrix: Record<string, Record<string, number>> = {};
    for (const a of ALL_MODES) { matrix[a] = {}; for (const b of ALL_MODES) { let s = 0; for (const id of sets[a]) { if (sets[b].has(id)) s++; } matrix[a][b] = s; } }
    const uniq: Record<string, number> = {};
    for (const mode of ALL_MODES) { let c = 0; for (const id of sets[mode]) { if (!ALL_MODES.some((m) => m !== mode && sets[m].has(id))) c++; } uniq[mode] = c; }
    const kwHits: Record<string, number> = {};
    for (const mode of ALL_MODES) {
      const results = modes[mode]?.results ?? [];
      if (results.length === 0 || queryTerms.length === 0) { kwHits[mode] = 0; continue; }
      kwHits[mode] = results.reduce((s, r) => s + keywordHitRate(`${r.entityName} ${r.filePath} ${r.codePreview}`, queryTerms), 0) / results.length;
    }
    return { sets: sets as Record<RetrievalMode, Set<string>>, matrix, uniq: uniq as Record<RetrievalMode, number>, kwHits: kwHits as Record<RetrievalMode, number> };
  }, [modes, queryTerms]);

  const totals = (m: RetrievalMode) => modes[m].totalTokens + modes[m].graphContextTokens;
  const minTok = Math.min(...ALL_MODES.map(totals));
  const minLat = Math.min(...ALL_MODES.map((m) => modes[m].durationMs));
  const maxKw = Math.max(...ALL_MODES.map((m) => analysis.kwHits[m]));

  return (
    <div>
      {/* Summary */}
      <div style={{ background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)', overflow: 'hidden', marginBottom: 16 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead><tr style={{ borderBottom: '1px solid var(--separator)' }}><th style={thStyle}>Metric</th>{ALL_MODES.map((m) => <th key={m} style={{ ...thStyle, textAlign: 'right' }}><span style={{ color: MODE_META[m].color }}>{MODE_META[m].short}</span></th>)}</tr></thead>
          <tbody>
            {[
              { label: 'Keyword hit rate', vals: ALL_MODES.map((m) => `${(analysis.kwHits[m] * 100).toFixed(0)}%`), best: maxKw > 0 ? ALL_MODES.find((m) => analysis.kwHits[m] === maxKw) : undefined },
              { label: 'Unique chunks', vals: ALL_MODES.map((m) => String(analysis.uniq[m])) },
              { label: 'Chunks', vals: ALL_MODES.map((m) => String(modes[m].chunkCount)) },
              { label: 'Total tokens', vals: ALL_MODES.map((m) => totals(m).toLocaleString()), best: ALL_MODES.find((m) => totals(m) === minTok) },
              { label: 'Cost (Sonnet)', vals: ALL_MODES.map((m) => costStr(totals(m), 3.0)) },
              { label: 'Latency', vals: ALL_MODES.map((m) => `${modes[m].durationMs}ms`), best: ALL_MODES.find((m) => modes[m].durationMs === minLat) },
            ].map((row) => (
              <tr key={row.label} style={{ borderBottom: '1px solid var(--separator)' }}>
                <td style={tdStyle}>{row.label}</td>
                {ALL_MODES.map((m, i) => (
                  <td key={m} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono)', fontWeight: 500, color: row.best === m ? '#10b981' : 'var(--text-primary)', background: row.best === m ? 'rgba(16,185,129,0.06)' : undefined }}>
                    {row.vals[i]}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Detail tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--separator)', marginBottom: 12 }}>
        {ALL_MODES.map((m) => {
          const meta = MODE_META[m]; const active = activeTab === m;
          return <button key={m} onClick={() => onTabChange(m)} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 14px', fontSize: 12, fontWeight: active ? 600 : 400, color: active ? meta.color : 'var(--text-tertiary)', background: 'none', border: 'none', borderBottom: active ? `2px solid ${meta.color}` : '2px solid transparent', cursor: 'pointer', fontFamily: 'var(--font-sans)', marginBottom: -1 }}>{meta.icon} {meta.short}</button>;
        })}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {modes[activeTab]?.results.map((result, i) => {
          const foundIn = ALL_MODES.filter((m) => m !== activeTab && analysis.sets[m]?.has(result.id));
          const isUnique = foundIn.length === 0;
          const meta = MODE_META[activeTab];
          const kwHit = keywordHitRate(`${result.entityName} ${result.filePath} ${result.codePreview}`, queryTerms);
          return (
            <div key={result.id ?? i} style={{ padding: '10px 14px', background: 'var(--bg-elevated-2)', border: `1px solid ${isUnique ? meta.color + '44' : 'var(--separator)'}`, borderRadius: 'var(--radius-md)', borderLeft: isUnique ? `3px solid ${meta.color}` : undefined }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flexWrap: 'wrap' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: meta.color, fontWeight: 500 }}>#{i + 1} {result.entityName}</span>
                  {isUnique && <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 'var(--radius-full)', background: meta.color + '22', color: meta.color, fontWeight: 600, textTransform: 'uppercase' }}>unique</span>}
                  {foundIn.map((m) => <span key={m} style={{ fontSize: 9, padding: '1px 5px', borderRadius: 'var(--radius-full)', background: MODE_META[m].color + '18', color: MODE_META[m].color, fontWeight: 500 }}>{MODE_META[m].short}</span>)}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', padding: '2px 6px', borderRadius: 'var(--radius-xs)', background: kwHit >= 0.5 ? 'rgba(16,185,129,0.12)' : kwHit > 0 ? 'rgba(245,158,11,0.12)' : 'transparent', color: kwHit >= 0.5 ? '#10b981' : kwHit > 0 ? '#f59e0b' : 'var(--text-tertiary)' }}>kw {(kwHit * 100).toFixed(0)}%</span>
                  <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>{result.tokens} tok</span>
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{result.filePath}</div>
              {result.codePreview && (
                <pre style={{ margin: 0, padding: '6px 8px', fontSize: 10, lineHeight: 1.5, background: 'var(--bg-base)', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', overflow: 'auto', maxHeight: 80, fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap' }}>
                  {highlightTerms(result.codePreview, queryTerms)}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const thStyle: React.CSSProperties = { padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', background: 'var(--bg-base)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px' };
const tdStyle: React.CSSProperties = { padding: '8px 14px', color: 'var(--text-primary)' };
