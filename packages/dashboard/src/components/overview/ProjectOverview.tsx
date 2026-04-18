import React, { useState, useEffect } from 'react';
import { MemoryList } from './MemoryList.js';
import type { Memory } from './MemoryList.js';
import { CheckCircle2, XCircle, Clock, RefreshCw, Brain, Shield, DollarSign, Sparkles } from 'lucide-react';

export interface SystemRepo {
  name: string;
  language: string;
}

export interface SystemFeature {
  slug: string;
  description: string;
  status: string;
  totalCost: number;
  updatedAt: string;
}

export interface KBRepoStatus {
  repoName: string;
  status: string;
  lastRefreshed: string | null;
  nodeCount: number;
  communityCount: number;
  error: string | null;
}

export interface KBStatus {
  project: string;
  repos: KBRepoStatus[];
  overallStatus: string;
  lastRefreshed: string | null;
}

export interface ConventionRule {
  name: string;
  description: string;
  severity: 'error' | 'warning' | 'info';
}

export interface BudgetStatus {
  dailyLimit: number | null;
  dailyUsed: number;
  perRunLimit: number | null;
  configured: boolean;
}


export interface ProjectOverviewProps {
  projectName: string;
  repos: SystemRepo[];
  memories: Memory[];
  conventions: string[];
  features: SystemFeature[];
  kbStatus: KBStatus | null;
  kbRefreshing: boolean;
  kbProgress: { repo: string; message: string; repoIndex: number; totalRepos: number } | null;
  onRefreshKB: () => void;
  ws?: WebSocket | null;
}

export function ProjectOverview({ projectName, repos, memories, conventions, features, kbStatus, kbRefreshing, kbProgress, onRefreshKB, ws }: ProjectOverviewProps) {
  if (!projectName || projectName === 'None') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: 'var(--text-tertiary)', fontSize: 14,
      }}>
        Select a project from the home page to view details.
      </div>
    );
  }

  // Conventions rules state
  const [conventionRules, setConventionRules] = useState<ConventionRule[]>([]);
  const [budgetStatus, setBudgetStatus] = useState<BudgetStatus | null>(null);
  const [generatingConventions, setGeneratingConventions] = useState(false);

  // Fetch conventions, budget via WS
  useEffect(() => {
    if (!ws || !projectName) return;
    ws.send(JSON.stringify({ action: 'get-conventions', project: projectName }));
    ws.send(JSON.stringify({ action: 'get-budget-status', project: projectName }));
  }, [ws, projectName]);

  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'conventions' && msg.payload) {
          setConventionRules(msg.payload.rules || []);
          setGeneratingConventions(false);
        }
        if (msg.type === 'budget-status' && msg.payload) {
          const p = msg.payload;
          setBudgetStatus({
            dailyLimit: p.maxPerDay ?? p.dailyLimit ?? null,
            dailyUsed: p.todaySpent ?? p.dailyUsed ?? 0,
            perRunLimit: p.maxPerRun ?? p.perRunLimit ?? null,
            configured: !!(p.maxPerDay || p.maxPerRun || p.dailyLimit || p.perRunLimit),
          });
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const completed = features.filter((f) => f.status === 'completed').length;
  const failed = features.filter((f) => f.status === 'failed').length;
  const totalCost = features.reduce((sum, f) => sum + (f.totalCost || 0), 0);
  const languages = [...new Set(repos.map((r) => r.language).filter(Boolean))];

  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)',
      maxWidth: 800,
      margin: '0 auto',
      overflowY: 'auto',
      height: '100%',
    }}>
      {/* Header */}
      <div style={{ marginBottom: 32 }}>
        <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 10 }}>
          {projectName}
        </h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <StatPill label={`${repos.length} repos`} />
          {languages.map((l) => <StatPill key={l} label={l} />)}
          <StatPill label={`${features.length} features`} />
          {totalCost > 0 && <StatPill label={`$${totalCost.toFixed(2)}`} />}
        </div>
      </div>

      {/* Repos grid */}
      <Section title="Repositories">
        {repos.length === 0 ? (
          <EmptyState>No repositories discovered for this project.</EmptyState>
        ) : (
          <div className="stagger" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {repos.map((r) => (
              <div key={r.name} className="card" style={{
                padding: '10px 14px',
                display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, fontSize: 13 }}>{r.name}</span>
                {r.language && (
                  <span style={{
                    fontSize: 11, padding: '1px 6px',
                    borderRadius: 'var(--radius-xs)',
                    background: 'var(--accent-subtle)', color: 'var(--accent)',
                  }}>
                    {r.language}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Knowledge Base */}
      <Section title="Knowledge Base">
        <KnowledgeBaseSection
          kbStatus={kbStatus}
          kbRefreshing={kbRefreshing}
          kbProgress={kbProgress}
          onRefresh={onRefreshKB}
        />
      </Section>

      {/* Memory */}
      <Section title="Memory">
        <MemoryList memories={memories} />
      </Section>

      {/* Conventions — single unified section */}
      <Section title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Shield size={14} style={{ color: 'var(--accent)' }} />
          Conventions
        </span>
      }>
        {conventions.length === 0 && conventionRules.length === 0 ? (
          <div style={{
            padding: '14px 16px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
          }}>
            <div style={{
              color: 'var(--text-tertiary)',
              fontSize: 13, lineHeight: 1.6, marginBottom: 12,
            }}>
              No conventions discovered yet. Generate conventions from your codebase to enforce coding patterns,
              file structure, naming, and testing approaches.
            </div>
            <button
              onClick={() => {
                if (!ws || !projectName) return;
                setGeneratingConventions(true);
                ws.send(JSON.stringify({ action: 'generate-conventions', project: projectName }));
              }}
              disabled={generatingConventions}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 14px', fontSize: 12, fontWeight: 500,
                background: 'var(--accent)', color: '#fff', border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: generatingConventions ? 'not-allowed' : 'pointer',
                opacity: generatingConventions ? 0.6 : 1,
              }}
            >
              <Sparkles size={12} />
              {generatingConventions ? 'Generating...' : 'Generate Conventions'}
            </button>
          </div>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {conventionRules.length + conventions.length} rule{conventionRules.length + conventions.length !== 1 ? 's' : ''} loaded
              </span>
              <button
                onClick={() => {
                  if (!ws || !projectName) return;
                  setGeneratingConventions(true);
                  ws.send(JSON.stringify({ action: 'generate-conventions', project: projectName }));
                }}
                disabled={generatingConventions}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  padding: '4px 10px', fontSize: 11, fontWeight: 500,
                  background: 'var(--bg-elevated-2)', color: 'var(--text-secondary)',
                  border: '1px solid var(--separator)', borderRadius: 'var(--radius-sm)',
                  cursor: generatingConventions ? 'not-allowed' : 'pointer',
                  opacity: generatingConventions ? 0.6 : 1,
                }}
              >
                <RefreshCw size={10} className={generatingConventions ? 'spin' : ''} />
                {generatingConventions ? 'Regenerating...' : 'Regenerate'}
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {/* Severity-tagged rules from factory.yaml */}
              {conventionRules.map((rule, i) => {
                const dotColor = rule.severity === 'error' ? 'var(--color-error)'
                  : rule.severity === 'warning' ? 'var(--color-warning)'
                  : 'var(--color-info, var(--accent))';
                return (
                  <div key={`rule-${i}`} style={{
                    display: 'flex', alignItems: 'flex-start', gap: 8,
                    padding: '8px 12px', fontSize: 13,
                    color: 'var(--text-secondary)',
                  }}>
                    <div style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, marginTop: 4, flexShrink: 0 }} />
                    <div>
                      <span style={{ fontWeight: 500 }}>{rule.name}</span>
                      {rule.description && (
                        <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>— {rule.description}</span>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* Learned conventions (simple strings) */}
              {conventions.map((c, i) => (
                <div key={`conv-${i}`} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 8,
                  padding: '8px 12px', fontSize: 13,
                  color: 'var(--text-secondary)',
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--color-info, var(--accent))', marginTop: 4, flexShrink: 0, opacity: 0.5 }} />
                  <span>{c}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Section>

      {/* Budget */}
      <Section title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <DollarSign size={14} style={{ color: 'var(--accent)' }} />
          Budget
        </span>
      }>
        {!budgetStatus || !budgetStatus.configured ? (
          <div style={{
            padding: '14px 16px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-tertiary)',
            fontSize: 13, lineHeight: 1.6,
          }}>
            No budget configured. Add a budget section to factory.yaml.
          </div>
        ) : (
          <div style={{
            padding: '14px 16px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
          }}>
            {budgetStatus.dailyLimit != null && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  <span>Daily budget</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>${budgetStatus.dailyUsed.toFixed(2)} / ${budgetStatus.dailyLimit.toFixed(2)}</span>
                </div>
                <div style={{ height: 6, background: 'var(--bg-base)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{
                    height: '100%',
                    width: `${Math.min((budgetStatus.dailyUsed / budgetStatus.dailyLimit) * 100, 100)}%`,
                    background: (budgetStatus.dailyUsed / budgetStatus.dailyLimit) > 0.9 ? 'var(--color-error)' : 'var(--accent)',
                    borderRadius: 3,
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              </div>
            )}
            {budgetStatus.perRunLimit != null && (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                Per-run limit: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>${budgetStatus.perRunLimit.toFixed(2)}</span>
              </div>
            )}
          </div>
        )}
      </Section>

      {/* Feature history — vertical timeline */}
      <Section title="Feature History">
        {features.length === 0 ? (
          <EmptyState>No features built for this project yet.</EmptyState>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0, paddingLeft: 8 }}>
            {features.map((f, i) => {
              const statusIcon = f.status === 'completed' ? CheckCircle2
                : f.status === 'failed' ? XCircle : Clock;
              const StatusIcon = statusIcon;
              const color = f.status === 'completed' ? 'var(--color-success)'
                : f.status === 'failed' ? 'var(--color-error)' : 'var(--color-warning)';

              return (
                <div key={f.slug} style={{
                  display: 'flex', alignItems: 'flex-start', gap: 12,
                  padding: '8px 0',
                  borderLeft: i < features.length - 1 ? '1px solid var(--separator)' : '1px solid transparent',
                  marginLeft: 7,
                  paddingLeft: 16,
                  position: 'relative',
                }}>
                  {/* Timeline dot */}
                  <div style={{
                    position: 'absolute', left: -8, top: 10,
                    width: 16, height: 16,
                    background: 'var(--bg-base)',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                  }}>
                    <StatusIcon size={14} strokeWidth={1.75} style={{ color }} />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 13, fontWeight: 500,
                      color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {f.slug.replace(/-/g, ' ')}
                    </div>
                    <div style={{
                      display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-tertiary)',
                      marginTop: 2,
                    }}>
                      <span>{new Date(f.updatedAt).toLocaleDateString()}</span>
                      {f.totalCost > 0 && (
                        <span style={{ fontFamily: 'var(--font-mono)' }}>${f.totalCost.toFixed(2)}</span>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}

function KnowledgeBaseSection({
  kbStatus,
  kbRefreshing,
  kbProgress,
  onRefresh,
}: {
  kbStatus: KBStatus | null;
  kbRefreshing: boolean;
  kbProgress: { repo: string; message: string; repoIndex: number; totalRepos: number } | null;
  onRefresh: () => void;
}) {
  // No status yet or no repos
  if (!kbStatus || kbStatus.repos.length === 0) {
    return (
      <div style={{
        padding: '14px 16px',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Brain size={14} style={{ color: 'var(--text-tertiary)' }} />
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>No knowledge base built yet</span>
          </div>
          <button
            onClick={onRefresh}
            disabled={kbRefreshing}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px',
              fontSize: 12, fontWeight: 500,
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: kbRefreshing ? 'not-allowed' : 'pointer',
              opacity: kbRefreshing ? 0.6 : 1,
            }}
          >
            <RefreshCw size={12} className={kbRefreshing ? 'spin' : ''} />
            {kbRefreshing ? 'Building...' : 'Build Knowledge Base'}
          </button>
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.5 }}>
          Generates an AST-extracted architectural map of each repo — modules, functions, imports, dependencies, and community clusters.
          Agents will use this instead of exploring the entire codebase from scratch.
        </div>
        {kbRefreshing && kbProgress && (
          <div style={{ marginTop: 10 }}>
            <ProgressBar current={kbProgress.repoIndex + 1} total={kbProgress.totalRepos} />
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{kbProgress.message}</div>
          </div>
        )}
      </div>
    );
  }

  // Has status
  const statusColor = kbStatus.overallStatus === 'ready' ? 'var(--color-success)'
    : kbStatus.overallStatus === 'stale' ? 'var(--color-warning)'
    : kbStatus.overallStatus === 'building' ? 'var(--accent)'
    : 'var(--text-tertiary)';

  const statusLabel = kbStatus.overallStatus === 'ready' ? 'Ready'
    : kbStatus.overallStatus === 'stale' ? 'Stale'
    : kbStatus.overallStatus === 'building' ? 'Building...'
    : kbStatus.overallStatus === 'partial' ? 'Partial'
    : 'Not Built';

  const totalNodes = kbStatus.repos.reduce((sum, r) => sum + (r.nodeCount || 0), 0);
  const totalCommunities = kbStatus.repos.reduce((sum, r) => sum + (r.communityCount || 0), 0);

  return (
    <div style={{
      padding: '14px 16px',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Brain size={14} style={{ color: statusColor }} />
          <span style={{
            fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
            color: statusColor,
          }}>
            {statusLabel}
          </span>
          {totalNodes > 0 && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              {totalNodes} nodes / {totalCommunities} communities
            </span>
          )}
          {kbStatus.lastRefreshed && (
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
              Updated {formatRelativeTime(kbStatus.lastRefreshed)}
            </span>
          )}
        </div>
        <button
          onClick={onRefresh}
          disabled={kbRefreshing}
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 12px',
            fontSize: 12, fontWeight: 500,
            background: kbStatus.overallStatus === 'stale' ? 'var(--color-warning)' : 'var(--bg-base)',
            color: kbStatus.overallStatus === 'stale' ? '#fff' : 'var(--text-secondary)',
            border: kbStatus.overallStatus === 'stale' ? 'none' : '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            cursor: kbRefreshing ? 'not-allowed' : 'pointer',
            opacity: kbRefreshing ? 0.6 : 1,
          }}
        >
          <RefreshCw size={11} className={kbRefreshing ? 'spin' : ''} />
          {kbRefreshing ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {/* Per-repo status */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {kbStatus.repos.map((r) => {
          const dotColor = r.status === 'ready' ? 'var(--color-success)'
            : r.status === 'stale' ? 'var(--color-warning)'
            : r.status === 'error' ? 'var(--color-error)'
            : 'var(--text-tertiary)';
          return (
            <div key={r.repoName} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px',
              fontSize: 12,
              background: 'var(--bg-base)',
              borderRadius: 'var(--radius-xs)',
              border: '1px solid var(--separator)',
            }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: dotColor }} />
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{r.repoName}</span>
              {r.nodeCount > 0 && (
                <span style={{ fontSize: 10, color: 'var(--text-tertiary)' }}>{r.nodeCount}n</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Progress */}
      {kbRefreshing && kbProgress && (
        <div style={{ marginTop: 10 }}>
          <ProgressBar current={kbProgress.repoIndex + 1} total={kbProgress.totalRepos} />
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>{kbProgress.message}</div>
        </div>
      )}
    </div>
  );
}

function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  return (
    <div style={{
      height: 4, background: 'var(--bg-base)', borderRadius: 2, overflow: 'hidden',
    }}>
      <div style={{
        height: '100%', width: `${pct}%`,
        background: 'var(--accent)',
        borderRadius: 2,
        transition: 'width 0.3s ease',
      }} />
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

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <h3 style={{
        fontSize: 14, fontWeight: 600,
        color: 'var(--text-primary)',
        marginBottom: 12,
      }}>
        {title}
      </h3>
      {children}
    </div>
  );
}

function StatPill({ label }: { label: string }) {
  return (
    <span style={{
      fontSize: 12,
      padding: '3px 10px',
      borderRadius: 'var(--radius-full)',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      color: 'var(--text-secondary)',
    }}>
      {label}
    </span>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '8px 0', lineHeight: 1.5 }}>
      {children}
    </div>
  );
}

export default ProjectOverview;
