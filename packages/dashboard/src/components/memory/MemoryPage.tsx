import React, { useEffect, useState, useCallback } from 'react';
import { Brain, Search, Check, X, AlertCircle } from 'lucide-react';
import { RowSkeleton, useLoadingState } from '../common/Skeleton.js';
import { MemoryInsightsPanel } from './MemoryInsightsPanel.js';

export interface MemoryPageProps {
  project: string | null;
  ws: WebSocket | null;
}

interface MemoryItem {
  id: string;
  kind: string;
  subtype?: string;
  content: unknown;
  tags: string[];
  confidence: number;
  bitemporal: { validAt: string; invalidAt?: string };
  decay: { strength: number };
}

interface Proposal {
  id: string;
  candidate: MemoryItem;
  status: string;
  reason?: string;
  enqueuedAt: string;
}

interface MemoryStats {
  total: number;
  byKind: Record<string, number>;
  bySubtype: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  invalidated: number;
  withCodeBinding: number;
}

interface MemoryPayload {
  items: MemoryItem[];
  stats: MemoryStats | null;
  proposals: Proposal[];
}

interface MemoryConfig {
  reflectionEnabled: boolean;
  sleeptimeIntervalMs: number;
  mode: string;
}

const kindColor: Record<string, string> = {
  semantic: 'var(--accent)',
  episodic: 'var(--color-info)',
  profile: 'var(--color-success)',
  procedural: 'var(--color-warning)',
  working: 'var(--text-tertiary)',
};

function formatContent(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

export function MemoryPage({ project, ws }: MemoryPageProps) {
  const [payload, setPayload] = useState<MemoryPayload | null>(null);
  const [config, setConfig] = useState<MemoryConfig | null>(null);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'items' | 'proposals' | 'insights'>('items');
  const { loading, loaded, errored: loadError, reset: resetLoading } = useLoadingState();

  const fetchMemories = useCallback(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'list-memories', project, search: search.trim() || undefined, limit: 100 }));
  }, [ws, project, search]);

  const fetchConfig = useCallback(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ action: 'get-memory-config' }));
  }, [ws]);

  useEffect(() => {
    if (!ws) return;
    const handler = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'memories' && msg.payload) {
          setPayload(msg.payload as MemoryPayload);
          setError(null);
          loaded();
        }
        if (msg.type === 'memory-config' && msg.payload) {
          setConfig(msg.payload as MemoryConfig);
        }
        if (msg.type === 'proposal-ratified' || msg.type === 'proposal-rejected') {
          // Refresh after a mutation
          fetchMemories();
        }
        if (msg.type === 'error' && typeof msg.payload?.message === 'string' &&
            (msg.payload.message.startsWith('Memory list failed') ||
             msg.payload.message.startsWith('Ratify failed') ||
             msg.payload.message.startsWith('Reject failed'))) {
          setError(msg.payload.message);
          if (msg.payload.message.startsWith('Memory list failed')) {
            loadError(msg.payload.message);
          }
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    fetchMemories();
    fetchConfig();
    return () => ws.removeEventListener('message', handler);
  }, [ws, project, fetchMemories, fetchConfig, loaded, loadError]);

  // Re-show skeleton when the user changes project — fresh fetch is in flight
  useEffect(() => {
    resetLoading();
    // resetLoading is stable inside useLoadingState, no need to depend on it
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project]);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    fetchMemories();
  }, [fetchMemories]);

  const handleRatify = useCallback((id: string) => {
    if (!ws) return;
    ws.send(JSON.stringify({ action: 'ratify-proposal', id }));
  }, [ws]);

  const handleReject = useCallback((id: string) => {
    if (!ws) return;
    ws.send(JSON.stringify({ action: 'reject-proposal', id, reason: 'manual reject from UI' }));
  }, [ws]);

  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)',
      maxWidth: 1100,
      margin: '0 auto',
      width: '100%',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
        <Brain size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Memory</h2>
        {project && (
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>
        )}
        <div style={{ flex: 1 }} />
        {payload?.stats && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            {payload.stats.total} total · {payload.stats.invalidated} invalidated · {payload.stats.withCodeBinding} bound
          </span>
        )}
      </div>

      {/* Stats bar */}
      {payload?.stats && Object.keys(payload.stats.byKind).length > 0 && (
        <div style={{
          display: 'flex', gap: 8, marginBottom: 8,
          padding: '10px 14px',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          fontSize: 12, fontFamily: 'var(--font-mono)',
        }}>
          {Object.entries(payload.stats.byKind).filter(([, n]) => n > 0).map(([kind, count]) => (
            <span key={kind} style={{ color: 'var(--text-secondary)' }}>
              <span style={{ color: kindColor[kind] ?? 'var(--text-tertiary)' }}>●</span> {kind}: {count}
            </span>
          ))}
        </div>
      )}

      {/* Config badge */}
      {config && (
        <div style={{
          marginBottom: 16, fontSize: 11,
          color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)',
        }}>
          <span style={{ color: config.reflectionEnabled ? 'var(--accent)' : 'var(--text-tertiary)' }}>●</span>{' '}
          Reflection: {config.reflectionEnabled ? 'on' : 'off'}
          {config.reflectionEnabled
            ? ` (set ANVIL_REFLECTION=off to disable${config.mode === 'on-success' ? '; mode=on-success' : ''})`
            : ' (set ANVIL_REFLECTION=always to enable)'}
          {' · '}Sleeptime: every {Math.round(config.sleeptimeIntervalMs / 60000)}m
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: 0, borderBottom: '1px solid var(--separator)', marginBottom: 16 }}>
        {(['items', 'proposals', 'insights'] as const).map((id) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            style={{
              padding: '8px 16px',
              background: 'none',
              border: 'none',
              borderBottom: tab === id ? '2px solid var(--accent)' : '2px solid transparent',
              color: tab === id ? 'var(--accent)' : 'var(--text-secondary)',
              fontSize: 13,
              fontWeight: tab === id ? 600 : 400,
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              marginBottom: -1,
              textTransform: 'capitalize',
            }}
          >
            {id} {id === 'proposals' && payload?.proposals.length ? `(${payload.proposals.length})` : ''}
          </button>
        ))}
      </div>

      {/* Search bar (only on items tab) */}
      {tab === 'items' && (
        <form onSubmit={handleSearch} style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={14} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="BM25 search across memory content..."
              style={{
                width: '100%', height: 32, padding: '0 12px 0 30px',
                background: 'var(--bg-elevated-2)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)',
                fontSize: 13, fontFamily: 'var(--font-sans)',
                outline: 'none',
              }}
            />
          </div>
          <button type="submit" style={{
            padding: '0 14px', height: 32,
            background: 'var(--accent)', color: 'var(--text-inverse)',
            border: 'none', borderRadius: 'var(--radius-sm)',
            fontSize: 12, fontWeight: 500, cursor: 'pointer',
          }}>
            Search
          </button>
        </form>
      )}

      {/* Error banner */}
      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 12px', marginBottom: 12,
          background: 'rgba(239,68,68,0.10)',
          border: '1px solid var(--color-error)',
          borderRadius: 'var(--radius-sm)',
          fontSize: 12, color: 'var(--color-error)',
        }}>
          <AlertCircle size={14} />
          {error}
        </div>
      )}

      {/* Items tab */}
      {tab === 'items' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {loading && <RowSkeleton count={6} height={56} />}
          {!loading && payload?.items.length === 0 && (
            <div style={{
              padding: 32, textAlign: 'center',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-md)',
              fontSize: 13, color: 'var(--text-tertiary)',
            }}>
              No memories yet. Reflection runs at end of every pipeline by default (set <code style={{ fontFamily: 'var(--font-mono)' }}>ANVIL_REFLECTION=off</code> to disable).
            </div>
          )}
          {!loading && payload?.items.map((m) => (
            <MemoryItemRow key={m.id} item={m} />
          ))}
        </div>
      )}

      {/* Proposals tab */}
      {tab === 'proposals' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {loading && <RowSkeleton count={4} height={64} />}
          {!loading && payload?.proposals.length === 0 && (
            <div style={{
              padding: 32, textAlign: 'center',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-md)',
              fontSize: 13, color: 'var(--text-tertiary)',
            }}>
              No pending proposals. Sleeptime consolidate runs every 30 minutes by default.
            </div>
          )}
          {!loading && payload?.proposals.map((p) => (
            <ProposalRow key={p.id} proposal={p} onRatify={handleRatify} onReject={handleReject} />
          ))}
        </div>
      )}

      {/* Insights tab — Wave 3 + Wave 4 telemetry */}
      {tab === 'insights' && (
        <MemoryInsightsPanel project={project} ws={ws} />
      )}
    </div>
  );
}

function MemoryItemRow({ item }: { item: MemoryItem }) {
  const isInvalid = !!item.bitemporal.invalidAt;
  return (
    <div style={{
      padding: '10px 14px',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-sm)',
      opacity: isInvalid ? 0.5 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ color: kindColor[item.kind] ?? 'var(--text-tertiary)' }}>●</span>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          {item.kind}{item.subtype ? `:${item.subtype}` : ''}
        </span>
        {item.tags.slice(0, 4).map((t) => (
          <span key={t} style={{
            padding: '0 6px', fontSize: 10, lineHeight: '16px',
            background: 'var(--bg-elevated-3)', color: 'var(--text-tertiary)',
            borderRadius: 'var(--radius-full)', fontFamily: 'var(--font-mono)',
          }}>
            {t}
          </span>
        ))}
        <span style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          conf {item.confidence}
        </span>
      </div>
      <pre style={{
        margin: 0, fontSize: 12, lineHeight: 1.5,
        fontFamily: typeof item.content === 'string' ? 'var(--font-sans)' : 'var(--font-mono)',
        color: 'var(--text-primary)',
        whiteSpace: 'pre-wrap',
        overflow: 'hidden',
        maxHeight: 180,
      }}>
        {formatContent(item.content)}
      </pre>
    </div>
  );
}

function ProposalRow({
  proposal,
  onRatify,
  onReject,
}: {
  proposal: Proposal;
  onRatify: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div style={{
      padding: '10px 14px',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-sm)',
      borderLeft: '3px solid var(--color-warning)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>
          {proposal.candidate.kind}{proposal.candidate.subtype ? `:${proposal.candidate.subtype}` : ''}
        </span>
        {proposal.reason && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            — {proposal.reason}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <button
            onClick={() => onRatify(proposal.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 8px', fontSize: 11,
              background: 'var(--color-success)', color: 'var(--text-inverse)',
              border: 'none', borderRadius: 'var(--radius-xs)',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}
          >
            <Check size={11} />
            Ratify
          </button>
          <button
            onClick={() => onReject(proposal.id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 8px', fontSize: 11,
              background: 'transparent', color: 'var(--color-error)',
              border: '1px solid var(--color-error)', borderRadius: 'var(--radius-xs)',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}
          >
            <X size={11} />
            Reject
          </button>
        </div>
      </div>
      <pre style={{
        margin: 0, fontSize: 12, lineHeight: 1.5,
        fontFamily: typeof proposal.candidate.content === 'string' ? 'var(--font-sans)' : 'var(--font-mono)',
        color: 'var(--text-primary)',
        whiteSpace: 'pre-wrap',
        overflow: 'hidden',
        maxHeight: 180,
      }}>
        {formatContent(proposal.candidate.content)}
      </pre>
    </div>
  );
}

export default MemoryPage;
