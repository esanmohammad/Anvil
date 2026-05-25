/**
 * Tier 4 — memory inspector panels that consume the Wave 3 / Wave 4
 * WS handlers (`get-memory-overview`, `search-memory`,
 * `get-memory-injections`).
 *
 * Three sub-panels:
 *   - Hit-stats by kind/subtype (Wave 4 telemetry)
 *   - Top reused memories (Wave 4 ranking)
 *   - Hybrid-search box (Wave 3 read surface — uses `hybridSearch`)
 *
 * Embedded inside `MemoryPage` so the existing surface keeps its
 * navigation; the insights mount as a sibling section.
 */

import React, { useEffect, useState, useCallback } from 'react';
import { BarChart3, Search, Star } from 'lucide-react';

export interface MemoryInsightsPanelProps {
  project: string | null;
  ws: WebSocket | null;
}

interface HitStat {
  kind: string | null;
  subtype: string | null;
  injected: number;
  used: number;
  hitRatio: number;
}

interface TopHitMemory {
  memoryId: string;
  injected: number;
  used: number;
}

interface MemoryOverview {
  project: string;
  counts: Record<string, number>;
  hitStats: HitStat[];
  topHits: TopHitMemory[];
}

interface SearchResult {
  id: string;
  kind: string;
  subtype?: string;
  content: unknown;
  tags: string[];
  decay: { strength: number };
  provenance: { createdBy: string; createdAt: string };
}

function formatContent(content: unknown, max = 220): string {
  const text = typeof content === 'string' ? content : (() => {
    try { return JSON.stringify(content) ?? ''; } catch { return ''; }
  })();
  return text.replace(/\s+/g, ' ').trim().slice(0, max);
}

export function MemoryInsightsPanel({ project, ws }: MemoryInsightsPanelProps) {
  const [overview, setOverview] = useState<MemoryOverview | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);

  // Fetch overview when project or socket changes.
  useEffect(() => {
    if (!ws || !project) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'get-memory-overview', project }));

    const onMessage = (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(ev.data) as { type: string; payload: unknown };
        if (msg.type === 'memory-overview') {
          setOverview(msg.payload as MemoryOverview);
        } else if (msg.type === 'memory-search-results') {
          const p = msg.payload as { results: SearchResult[] };
          setSearchResults(p.results);
          setSearching(false);
        }
      } catch {
        // Ignore non-JSON / unrelated frames.
      }
    };
    ws.addEventListener('message', onMessage);
    return () => ws.removeEventListener('message', onMessage);
  }, [ws, project]);

  const runSearch = useCallback(() => {
    if (!ws || !project || !searchQuery.trim()) return;
    setSearching(true);
    setSearchResults(null);
    ws.send(JSON.stringify({
      action: 'search-memory',
      project,
      query: searchQuery.trim(),
      limit: 20,
    }));
  }, [ws, project, searchQuery]);

  if (!project) {
    return (
      <div style={{ padding: 16, color: 'var(--text-secondary)' }}>
        Select a project to view memory insights.
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: 16 }}>
      <Section icon={<BarChart3 size={14} />} title="Hit ratio by memory subtype (last 7 days)">
        {overview?.hitStats && overview.hitStats.length > 0 ? (
          <HitStatsTable stats={overview.hitStats} />
        ) : (
          <Empty>No hit data yet — telemetry populates as runs complete.</Empty>
        )}
      </Section>

      <Section icon={<Star size={14} />} title="Top reused memories">
        {overview?.topHits && overview.topHits.length > 0 ? (
          <TopHitsTable hits={overview.topHits} />
        ) : (
          <Empty>No reuse data yet.</Empty>
        )}
      </Section>

      <Section icon={<Search size={14} />} title="Hybrid search (BM25 + vector + graph)">
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') runSearch(); }}
            placeholder="Search project memory… e.g. 'OOM in parser', 'auth pattern'"
            style={{
              flex: 1, padding: '6px 10px', borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--bg-secondary)',
              color: 'var(--text-primary)',
              fontSize: 13,
            }}
          />
          <button
            onClick={runSearch}
            disabled={!searchQuery.trim() || searching}
            style={{
              padding: '6px 12px', borderRadius: 4,
              border: '1px solid var(--accent)',
              background: 'var(--accent)',
              color: 'white',
              fontSize: 13,
              cursor: searching ? 'wait' : 'pointer',
            }}
          >
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {searchResults && (
          <div style={{ marginTop: 12 }}>
            {searchResults.length === 0
              ? <Empty>No matches.</Empty>
              : <SearchResultsList results={searchResults} />}
          </div>
        )}
      </Section>
    </div>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div style={{
      border: '1px solid var(--border)',
      borderRadius: 6,
      background: 'var(--bg-primary)',
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '8px 12px',
        borderBottom: '1px solid var(--border)',
        fontSize: 12, fontWeight: 600,
        color: 'var(--text-primary)',
      }}>
        {icon}
        {title}
      </div>
      <div style={{ padding: 12 }}>{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: 'var(--text-tertiary)', fontSize: 12, fontStyle: 'italic' }}>
      {children}
    </div>
  );
}

function HitStatsTable({ stats }: { stats: HitStat[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
          <th style={{ padding: '4px 0' }}>Kind / subtype</th>
          <th style={{ padding: '4px 8px', textAlign: 'right' }}>Injected</th>
          <th style={{ padding: '4px 8px', textAlign: 'right' }}>Used</th>
          <th style={{ padding: '4px 8px', textAlign: 'right' }}>Hit rate</th>
        </tr>
      </thead>
      <tbody>
        {stats.map((s, i) => {
          const label = s.kind
            ? `${s.kind}${s.subtype ? ':' + s.subtype : ''}`
            : '(deleted)';
          const pct = (s.hitRatio * 100).toFixed(0);
          const color =
            s.hitRatio >= 0.5 ? 'var(--color-success)' :
            s.hitRatio >= 0.2 ? 'var(--color-warning)' :
            'var(--text-tertiary)';
          return (
            <tr key={i} style={{ borderTop: '1px solid var(--border)' }}>
              <td style={{ padding: '4px 0', color: 'var(--text-primary)' }}>{label}</td>
              <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--text-secondary)' }}>{s.injected}</td>
              <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--text-secondary)' }}>{s.used}</td>
              <td style={{ padding: '4px 8px', textAlign: 'right', color, fontWeight: 600 }}>{pct}%</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function TopHitsTable({ hits }: { hits: TopHitMemory[] }) {
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
      <thead>
        <tr style={{ textAlign: 'left', color: 'var(--text-secondary)' }}>
          <th style={{ padding: '4px 0' }}>Memory id</th>
          <th style={{ padding: '4px 8px', textAlign: 'right' }}>Used</th>
          <th style={{ padding: '4px 8px', textAlign: 'right' }}>Injected</th>
        </tr>
      </thead>
      <tbody>
        {hits.slice(0, 10).map((h) => (
          <tr key={h.memoryId} style={{ borderTop: '1px solid var(--border)' }}>
            <td style={{ padding: '4px 0', fontFamily: 'var(--font-mono)', color: 'var(--text-primary)' }}>
              {h.memoryId.slice(0, 16)}…
            </td>
            <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--text-primary)', fontWeight: 600 }}>{h.used}</td>
            <td style={{ padding: '4px 8px', textAlign: 'right', color: 'var(--text-secondary)' }}>{h.injected}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SearchResultsList({ results }: { results: SearchResult[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {results.map((r) => (
        <div key={r.id} style={{
          padding: 8, borderRadius: 4,
          border: '1px solid var(--border)',
          background: 'var(--bg-secondary)',
        }}>
          <div style={{
            display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4,
            fontSize: 11, color: 'var(--text-secondary)',
          }}>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              [{r.kind}{r.subtype ? ':' + r.subtype : ''}]
            </span>
            <span>strength {r.decay.strength}</span>
            <span>created by {r.provenance.createdBy}</span>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
            {formatContent(r.content)}
          </div>
        </div>
      ))}
    </div>
  );
}

export default MemoryInsightsPanel;
