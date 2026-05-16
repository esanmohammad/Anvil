import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Brain, RefreshCw, Search, Database, ArrowLeft, Maximize2, Minimize2 } from 'lucide-react';
import { ForceGraph, NodeDetailPanel } from './ForceGraph';
import { transformRepoGraph, transformProjectGraph } from './graph-utils';
import type { GraphData, GraphNode } from './graph-utils';

export interface KBRepoStatus {
  repoName: string;
  status: string;
  lastRefreshed: string | null;
  nodeCount: number;
  communityCount: number;
  error: string | null;
  /** Vector store stats (knowledge-core's index_meta.json). null = not embedded yet. */
  vectorChunks?: number | null;
  embeddingProvider?: string | null;
  lastEmbeddedAt?: string | null;
}

export interface KBProgress {
  repo: string;
  message: string;
  repoIndex: number;
  totalRepos: number;
  phase?: string;
}

export interface KBStatus {
  project: string;
  repos: KBRepoStatus[];
  overallStatus: string;
  lastRefreshed: string | null;
  /** Cached snapshot from the server — populated only while a build is in flight. */
  currentProgress?: KBProgress | null;
}

export interface KnowledgeGraphPageProps {
  projectName: string;
  kbStatus: KBStatus | null;
  kbRefreshing: boolean;
  kbProgress: KBProgress | null;
  onRefreshKB: () => void;
  ws: WebSocket | null;
}

export function KnowledgeGraphPage({
  projectName,
  kbStatus,
  kbRefreshing,
  kbProgress,
  onRefreshKB,
  ws,
}: KnowledgeGraphPageProps) {
  // Refresh-outcome banner. Snapshots `lastRefreshed` when a refresh
  // starts; after kbRefreshing flips false, compares the new value. Same
  // value → knowledge-core skipped every repo (SHA unchanged) → surface
  // "Up to date" so a no-op refresh isn't silent.
  const [refreshOutcome, setRefreshOutcome] = useState<'up-to-date' | 'updated' | null>(null);
  const refreshStartRef = useRef<{ lastRefreshed: string | null } | null>(null);
  const wasRefreshingRef = useRef(false);
  useEffect(() => {
    if (kbRefreshing && !wasRefreshingRef.current) {
      refreshStartRef.current = { lastRefreshed: kbStatus?.lastRefreshed ?? null };
      setRefreshOutcome(null);
    } else if (!kbRefreshing && wasRefreshingRef.current) {
      const before = refreshStartRef.current?.lastRefreshed ?? null;
      const after = kbStatus?.lastRefreshed ?? null;
      setRefreshOutcome(before !== after ? 'updated' : 'up-to-date');
      const t = window.setTimeout(() => setRefreshOutcome(null), 4000);
      wasRefreshingRef.current = kbRefreshing;
      return () => window.clearTimeout(t);
    }
    wasRefreshingRef.current = kbRefreshing;
  }, [kbRefreshing, kbStatus?.lastRefreshed]);

  // Graph visualization state
  const [graphLevel, setGraphLevel] = useState<'project' | 'repo'>('project');
  const [selectedRepoForDrill, setSelectedRepoForDrill] = useState<string | null>(null);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], links: [] });
  const [loadingGraph, setLoadingGraph] = useState(false);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [graphSearch, setGraphSearch] = useState('');
  const [expanded, setExpanded] = useState(false);
  const [graphSize, setGraphSize] = useState({ width: 800, height: 500 });
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // Callback ref — attaches the ResizeObserver whenever the container
  // actually mounts (the "no KB" and "has KB" branches are different
  // subtrees, so a plain useRef + useEffect([]) misses the real element).
  const graphContainerRef = useCallback((el: HTMLDivElement | null) => {
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    if (!el) return;
    // Seed from the actual element synchronously so first paint uses real dims.
    const rect = el.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      setGraphSize({ width: rect.width, height: rect.height });
    }
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setGraphSize({
          width: entry.contentRect.width,
          height: entry.contentRect.height,
        });
      }
    });
    observer.observe(el);
    resizeObserverRef.current = observer;
  }, []);

  // Project graph (LLM) state
  const [pgStatus, setPgStatus] = useState<{
    exists: boolean; generatedAt: string | null; model: string | null; costUsd: number | null; summary: string | null;
  } | null>(null);
  const [pgBuilding, setPgBuilding] = useState(false);
  const [pgProgress, setPgProgress] = useState<string | null>(null);
  const [pgError, setPgError] = useState<string | null>(null);
  const [pgProvider, setPgProvider] = useState<string>('auto');

  const repos = kbStatus?.repos ?? [];

  // Effective progress: prefer the live event stream; fall back to the
  // server-cached snapshot so a client revisiting mid-build still sees
  // the latest message without waiting for the next tick.
  const effectiveProgress: KBProgress | null = kbProgress ?? kbStatus?.currentProgress ?? null;
  const effectiveBuilding = kbRefreshing || kbStatus?.overallStatus === 'building';

  // graphContainerRef above is a callback ref that manages the ResizeObserver.

  // Fetch graph data
  const fetchGraphData = useCallback((level: 'project' | 'repo', repo?: string) => {
    if (!ws || !projectName) return;
    setLoadingGraph(true);
    ws.send(JSON.stringify({
      action: 'get-graph-nodes',
      project: projectName,
      options: { level, repo },
    }));
  }, [ws, projectName]);

  // Load graph on mount and level change
  useEffect(() => {
    if (graphLevel === 'project') {
      fetchGraphData('project');
    } else if (selectedRepoForDrill) {
      fetchGraphData('repo', selectedRepoForDrill);
    }
    // Also fetch project graph status
    if (ws && projectName) {
      ws.send(JSON.stringify({ action: 'get-project-graph-status', project: projectName }));
    }
  }, [graphLevel, selectedRepoForDrill, fetchGraphData, ws, projectName]);

  // Listen for WS messages
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        const { type, payload } = msg;

        switch (type) {
          case 'graph-nodes':
            if (payload.level === 'project') {
              const data = transformProjectGraph(
                payload.projectGraph ?? {},
                payload.repoStats ?? repos.map(r => ({ repoName: r.repoName, nodeCount: r.nodeCount })),
              );
              setGraphData(data);
            } else if (payload.level === 'repo' && payload.data) {
              const data = transformRepoGraph(payload.data, payload.repo ?? '');
              setGraphData(data);
            }
            setLoadingGraph(false);
            break;

          case 'project-graph-status':
            setPgStatus(payload);
            break;
          case 'project-graph-started':
            setPgBuilding(true);
            setPgProgress('Starting...');
            setPgError(null);
            break;
          case 'project-graph-progress':
            setPgProgress(payload.message);
            break;
          case 'project-graph-complete':
            setPgBuilding(false);
            setPgProgress(null);
            setPgStatus({ exists: true, generatedAt: payload.generatedAt, model: payload.model, costUsd: payload.costUsd, summary: null });
            if (ws) ws.send(JSON.stringify({ action: 'get-project-graph-status', project: projectName }));
            // Refresh graph to show new data
            fetchGraphData('project');
            break;
          case 'project-graph-error':
            setPgBuilding(false);
            setPgProgress(null);
            setPgError(payload.error || 'Unknown error');
            break;
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, projectName, repos, fetchGraphData]);

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleDrillIn = useCallback((repoName: string) => {
    setSelectedNode(null);
    setSelectedRepoForDrill(repoName);
    setGraphLevel('repo');
    setGraphSearch('');
  }, []);

  const handleBackToProject = useCallback(() => {
    setSelectedNode(null);
    setSelectedRepoForDrill(null);
    setGraphLevel('project');
    setGraphSearch('');
  }, []);

  // Three distinct pre-graph states — each used to silently fall through
  // to the empty-state with `projectName === 'None'`, which read like a
  // bug ("No knowledge base for None yet") during the WS round-trip.
  const noProjectSelected = !projectName || projectName === 'None';
  const kbStatusPending = !noProjectSelected && kbStatus == null;
  const kbStatusEmpty = kbStatus != null && (kbStatus.overallStatus === 'none' || repos.length === 0);

  // 1. No project picked yet — point user back to home.
  if (noProjectSelected) {
    return (
      <div className="page-enter" style={{
        padding: 'var(--space-lg)', maxWidth: 900, margin: '0 auto', height: '100%',
      }}>
        <PageHeader projectName="" />
        <div style={{
          padding: 24, background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)', textAlign: 'center',
          color: 'var(--text-tertiary)', fontSize: 13,
        }}>
          <Database size={32} style={{ color: 'var(--text-tertiary)', marginBottom: 12 }} />
          Select a project from the home page to view its knowledge graph.
        </div>
      </div>
    );
  }

  // 2. Project selected but kb-status hasn't arrived — proper loader so
  //    the user doesn't briefly see "No knowledge base yet" before the
  //    real status lands.
  if (kbStatusPending) {
    return (
      <div className="page-enter" style={{
        padding: 'var(--space-lg)', maxWidth: 900, margin: '0 auto', height: '100%',
      }}>
        <PageHeader projectName={projectName} />
        <div style={{
          padding: 24, background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
        }}>
          <div className="status-dot-spin" style={{ width: 24, height: 24 }} />
          <div style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
            Loading {projectName} knowledge base...
          </div>
        </div>
      </div>
    );
  }

  // 3. Status loaded, no KB built — show the build CTA.
  if (kbStatusEmpty) {
    return (
      <div className="page-enter" style={{
        padding: 'var(--space-lg)', maxWidth: 900, margin: '0 auto', height: '100%',
      }}>
        <PageHeader projectName={projectName} />
        <div style={{
          padding: 24, background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)', textAlign: 'center',
        }}>
          <Database size={32} style={{ color: 'var(--text-tertiary)', marginBottom: 12 }} />
          <div style={{ fontSize: 14, color: 'var(--text-secondary)', marginBottom: 16 }}>
            No knowledge base for <strong>{projectName}</strong> yet.
          </div>

          <button onClick={onRefreshKB} disabled={kbRefreshing} style={{ ...primaryButtonStyle(kbRefreshing), marginBottom: 20 }}>
            <RefreshCw size={14} className={kbRefreshing ? 'spin' : ''} />
            {kbRefreshing ? 'Building...' : 'Build for Current Project'}
          </button>

          {effectiveBuilding && effectiveProgress && (
            <div style={{ marginTop: 16, fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono, monospace)' }}>{effectiveProgress.message}</div>
          )}
        </div>
      </div>
    );
  }

  // After this point: kbStatus is non-null with at least one repo. Tell
  // TS to narrow the type so the rest of the component doesn't have to
  // null-check everywhere.
  if (!kbStatus) return null;

  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12, flexShrink: 0 }}>
        <PageHeader projectName={projectName} />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {kbStatus.lastRefreshed && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              Updated {formatRelativeTime(kbStatus.lastRefreshed)}
            </span>
          )}
          <button onClick={onRefreshKB} disabled={kbRefreshing} style={{
            display: 'flex', alignItems: 'center', gap: 6, padding: '5px 12px',
            fontSize: 12, fontWeight: 500,
            background: kbStatus.overallStatus === 'stale' ? 'var(--color-warning)' : 'var(--bg-elevated-2)',
            color: kbStatus.overallStatus === 'stale' ? '#fff' : 'var(--text-secondary)',
            border: kbStatus.overallStatus === 'stale' ? 'none' : '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)', cursor: kbRefreshing ? 'not-allowed' : 'pointer',
            opacity: kbRefreshing ? 0.6 : 1,
          }}>
            <RefreshCw size={11} className={kbRefreshing ? 'spin' : ''} />
            {kbRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Progress bar — also driven by kbStatus.currentProgress when this
          client revisits the page after the live ws stream has gone quiet. */}
      {effectiveBuilding && effectiveProgress && (
        <div style={{ marginBottom: 8, flexShrink: 0 }}>
          <div style={{ height: 3, background: 'var(--bg-base)', borderRadius: 2, overflow: 'hidden' }}>
            <div style={{
              height: '100%',
              width: `${Math.round(((effectiveProgress.repoIndex + 1) / Math.max(1, effectiveProgress.totalRepos)) * 100)}%`,
              background: 'var(--accent)', transition: 'width 0.3s ease',
            }} />
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{effectiveProgress.message}</div>
        </div>
      )}

      {/* Refresh-outcome banner — only visible right after a refresh completes */}
      {!kbRefreshing && refreshOutcome && (
        <div style={{
          marginBottom: 8, padding: '6px 10px', fontSize: 11, flexShrink: 0,
          color: refreshOutcome === 'up-to-date' ? 'var(--color-success)' : 'var(--accent)',
          background: 'var(--bg-elevated-2)',
          border: `1px solid ${refreshOutcome === 'up-to-date' ? 'var(--color-success)' : 'var(--accent)'}`,
          borderRadius: 'var(--radius-xs)',
          opacity: 0.9,
        }}>
          {refreshOutcome === 'up-to-date'
            ? '✓ Knowledge base is up to date — no changes detected.'
            : '✓ Knowledge base refreshed.'}
        </div>
      )}

      {/* Per-repo vector store status — read-only summary of what
          knowledge-core's embedding pass has indexed into LanceDB. */}
      {repos.length > 0 && (
        <div style={{
          display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8, flexShrink: 0,
          fontSize: 11,
        }}>
          {repos.map((r) => <RepoVectorPill key={r.repoName} repo={r} />)}
        </div>
      )}

      {/* ────── Graph ────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {/* Graph toolbar */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            marginBottom: 8, flexShrink: 0,
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {graphLevel === 'repo' && (
                <button onClick={handleBackToProject} style={{
                  display: 'flex', alignItems: 'center', gap: 4, padding: '4px 10px',
                  fontSize: 12, background: 'var(--bg-elevated-2)', color: 'var(--text-secondary)',
                  border: '1px solid var(--separator)', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                }}>
                  <ArrowLeft size={12} /> Project View
                </button>
              )}
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                {graphLevel === 'project'
                  ? `${repos.length} repositories`
                  : `${selectedRepoForDrill} — ${graphData.nodes.length} nodes`
                }
              </span>
              {loadingGraph && <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>Loading...</span>}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {/* Search */}
              <div style={{ position: 'relative' }}>
                <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-tertiary)' }} />
                <input
                  type="text" value={graphSearch}
                  onChange={(e) => setGraphSearch(e.target.value)}
                  placeholder="Search nodes..."
                  style={{
                    padding: '4px 8px 4px 26px', fontSize: 11, width: 160,
                    background: 'var(--bg-base)', border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)',
                    outline: 'none', fontFamily: 'var(--font-sans)',
                  }}
                />
              </div>

              {/* Expand toggle */}
              <button onClick={() => setExpanded(!expanded)} title={expanded ? 'Collapse' : 'Expand'} style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)',
                cursor: 'pointer', color: 'var(--text-tertiary)',
              }}>
                {expanded ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
              </button>

              {/* Project graph build CTA */}
              {graphLevel === 'project' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 0 }}>
                  <select
                    value={pgProvider}
                    onChange={(e) => setPgProvider(e.target.value)}
                    disabled={pgBuilding}
                    style={{
                      height: 26, padding: '0 24px 0 8px', fontSize: 11,
                      background: 'var(--bg-elevated-2)', color: 'var(--text-secondary)',
                      border: '1px solid var(--separator)', borderRight: 'none',
                      borderRadius: 'var(--radius-sm) 0 0 var(--radius-sm)',
                      outline: 'none', cursor: pgBuilding ? 'default' : 'pointer',
                      fontFamily: 'var(--font-sans)',
                      appearance: 'none',
                      WebkitAppearance: 'none',
                      backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                      backgroundRepeat: 'no-repeat',
                      backgroundPosition: 'right 6px center',
                    }}
                  >
                    <option value="auto">Auto (Claude → Gemini)</option>
                    <option value="claude-cli">Claude CLI</option>
                    <option value="gemini-cli">Gemini CLI</option>
                    <option disabled>── coming soon ──</option>
                    <option value="anthropic" disabled>Anthropic API</option>
                    <option value="openai" disabled>OpenAI API</option>
                    <option value="gemini" disabled>Gemini API</option>
                    <option value="openrouter" disabled>OpenRouter</option>
                  </select>
                  <button
                    onClick={() => {
                      if (ws) {
                        const msg: Record<string, unknown> = { action: 'build-project-graph', project: projectName };
                        if (pgProvider !== 'auto') msg.provider = pgProvider;
                        ws.send(JSON.stringify(msg));
                      }
                    }}
                    disabled={pgBuilding}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 4,
                      padding: '4px 10px', height: 26, fontSize: 11, fontWeight: 500,
                      background: pgBuilding ? 'var(--bg-base)' : 'var(--color-accent)',
                      color: pgBuilding ? 'var(--text-tertiary)' : 'white',
                      border: 'none', borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                      cursor: pgBuilding ? 'default' : 'pointer',
                    }}
                  >
                    <Brain size={11} />
                    {pgBuilding ? 'Building...' : pgStatus?.exists ? 'Rebuild AI Graph' : 'Build AI Graph'}
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Status messages */}
          {pgBuilding && pgProgress && (
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4, flexShrink: 0 }}>
              {pgProgress}
            </div>
          )}
          {pgError && !pgBuilding && (
            <div style={{ fontSize: 11, color: 'var(--color-error, #ef4444)', marginBottom: 4, flexShrink: 0 }}>
              {pgError}
            </div>
          )}
          {pgStatus?.exists && !pgBuilding && graphLevel === 'project' && (
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 4, flexShrink: 0 }}>
              AI graph built with {pgStatus.model} · ${pgStatus.costUsd?.toFixed(4)} ·{' '}
              {pgStatus.generatedAt ? formatRelativeTime(pgStatus.generatedAt) : ''}
            </div>
          )}

          {/* Graph canvas */}
          <div
            ref={graphContainerRef}
            style={{
              flex: 1,
              position: 'relative',
              borderRadius: 'var(--radius-md)',
              overflow: 'hidden',
              border: '1px solid var(--separator)',
              background: '#0f0f1a',
              minHeight: expanded ? 'calc(100vh - 200px)' : 400,
            }}
          >
            {graphData.nodes.length > 0 ? (
              <>
                <ForceGraph
                  data={graphData}
                  width={graphSize.width || 800}
                  height={expanded ? Math.max(graphSize.height, 600) : Math.max(graphSize.height, 400)}
                  level={graphLevel}
                  onNodeClick={handleNodeClick}
                  selectedNodeId={selectedNode?.id ?? null}
                  searchQuery={graphSearch}
                />
                {selectedNode && (
                  <NodeDetailPanel
                    node={selectedNode}
                    onClose={() => setSelectedNode(null)}
                    onDrillIn={graphLevel === 'project' ? handleDrillIn : undefined}
                  />
                )}

                {/* Legend */}
                <div style={{
                  position: 'absolute', bottom: 8, left: 8,
                  padding: '6px 10px', borderRadius: 'var(--radius-sm)',
                  background: 'rgba(15,15,26,0.85)', fontSize: 10, color: '#aaa',
                  display: 'flex', gap: 12, flexWrap: 'wrap',
                }}>
                  {graphLevel === 'project' ? (
                    repos.map((r, i) => (
                      <span key={r.repoName} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                        <div style={{ width: 8, height: 8, borderRadius: '50%', background: ['#6366f1','#22d3ee','#f59e0b','#ef4444','#10b981','#8b5cf6','#f97316','#ec4899'][i % 8] }} />
                        {r.repoName}
                      </span>
                    ))
                  ) : (
                    <>
                      {[['function', '#60a5fa'], ['class', '#a78bfa'], ['interface', '#2dd4bf'], ['type', '#fb923c']].map(([t, c]) => (
                        <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: c }} />
                          {t}
                        </span>
                      ))}
                    </>
                  )}
                </div>
              </>
            ) : (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: 'var(--text-tertiary)', fontSize: 13,
              }}>
                {loadingGraph ? 'Loading graph...' : 'No graph data. Click Refresh to build the knowledge base.'}
              </div>
            )}
          </div>
      </div>
    </div>
  );
}

function RepoVectorPill({ repo }: { repo: KBRepoStatus }) {
  const chunks = repo.vectorChunks ?? null;
  const provider = repo.embeddingProvider ?? null;
  const embedded = chunks !== null && chunks > 0;

  let detail: string;
  let bg: string;
  let color: string;

  if (embedded) {
    detail = `${formatChunkCount(chunks)} chunks${provider ? ` · ${provider}` : ''}`;
    bg = 'var(--bg-elevated-2)';
    color = 'var(--text-secondary)';
  } else {
    detail = 'not embedded';
    bg = 'rgba(245, 158, 11, 0.12)';
    color = 'var(--color-warning, #f59e0b)';
  }

  const tooltip = embedded && repo.lastEmbeddedAt
    ? `Last embedded ${formatRelativeTime(repo.lastEmbeddedAt)}`
    : 'Run anvil index <project> to embed';

  return (
    <span title={tooltip} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 8px', borderRadius: 'var(--radius-sm)',
      background: bg, color, border: '1px solid var(--separator)',
      fontFamily: 'var(--font-sans)', whiteSpace: 'nowrap',
    }}>
      <Database size={10} />
      <span style={{ fontWeight: 500 }}>{repo.repoName}</span>
      <span style={{ opacity: 0.75 }}>· {detail}</span>
    </span>
  );
}

function formatChunkCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function PageHeader({ projectName }: { projectName: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <Brain size={20} style={{ color: 'var(--accent)' }} />
      <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Knowledge Graph</h2>
      <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {projectName}</span>
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 8,
    padding: '8px 20px', fontSize: 13, fontWeight: 600,
    background: 'var(--accent)', color: '#fff', border: 'none',
    borderRadius: 'var(--radius-sm)', cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
  };
}

