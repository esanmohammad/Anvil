import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { ActivityLine } from './ActivityLine.js';
import type { ActivityEntry } from './ActivityLine.js';
import { RawOutput } from './RawOutput.js';
import { MarkdownRenderer } from './MarkdownRenderer.js';
import { Search, Copy, Check, ArrowUp } from 'lucide-react';

/**
 * Output panel — Conversation-style, Apple-inspired.
 *
 * Two tabs: Activity | Changes (removed "Raw")
 * Conversation-style feed, clean input bar at bottom.
 */

export interface ChangeEntry {
  file: string;
  tool: 'Edit' | 'Write';
  summary: string;
  timestamp: number;
  diff?: string;
  repo?: string;
}

export interface OutputPanelAgent {
  id: string;
  name: string;
  persona: string;
  status: 'running' | 'done' | 'error' | 'idle';
  output: string;
}

export interface OutputPanelProps {
  agent?: OutputPanelAgent | null;
  activities: ActivityEntry[];
  rawOutput?: string;
  changes?: ChangeEntry[];
  isRunning?: boolean;
  onSendInput?: (agentIdOrText: string, text?: string) => void;
  inputPlaceholder?: string;
}

type ViewMode = 'activity' | 'changes' | 'raw';

export function OutputPanel({
  agent,
  activities,
  rawOutput = '',
  changes = [],
  isRunning: isRunningProp,
  onSendInput,
  inputPlaceholder,
}: OutputPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [input, setInput] = useState('');
  const [localMessages, setLocalMessages] = useState<string[]>([]);
  const [inputPending, setInputPending] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('activity');
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<number>>(new Set());
  const scrollPositions = useRef(new Map<string, number>());
  const prevAgentId = useRef<string | null>(null);

  const isRunning = isRunningProp ?? agent?.status === 'running';
  const showInput = isRunning || agent?.status === 'done' || !!onSendInput;
  const agentId = agent?.id ?? '';
  const baseOutput = agent?.output ?? rawOutput ?? '';

  const toggleExpanded = useCallback((id: number) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Save/restore scroll position per agent
  useEffect(() => {
    if (prevAgentId.current && scrollRef.current) {
      scrollPositions.current.set(prevAgentId.current, scrollRef.current.scrollTop);
    }
    if (agentId && scrollRef.current) {
      const saved = scrollPositions.current.get(agentId);
      if (saved !== undefined) {
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = saved;
        });
      }
    }
    prevAgentId.current = agentId || null;
  }, [agentId]);

  useEffect(() => { setLocalMessages([]); }, [agentId]);

  // Clear local messages once the server echoes them back as user-message activities
  // This prevents double-rendering (local optimistic + server echo)
  useEffect(() => {
    if (localMessages.length > 0 && activities.some((a) => a.kind === 'user-message')) {
      setLocalMessages([]);
    }
  }, [activities, localMessages.length]);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [baseOutput, localMessages, activities, autoScroll]);

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 40);
    if (agentId) scrollPositions.current.set(agentId, scrollTop);
  };

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(baseOutput);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* silent */ }
  }, [baseOutput]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !onSendInput || inputPending) return;
    const text = input.trim();
    setLocalMessages((prev) => [...prev, text]);
    setInputPending(true);
    if (agent) onSendInput(agent.id, text);
    else onSendInput(text);
    setInput('');
    inputRef.current?.focus();
  };

  // Clear pending state when new activity arrives (question, ack, or pipeline advances)
  useEffect(() => {
    if (inputPending && activities.length > 0) {
      const last = activities[activities.length - 1];
      if (last.kind === 'clarify-question' || last.kind === 'clarify-ack' || last.kind === 'text') {
        setInputPending(false);
      }
    }
  }, [activities, inputPending]);

  // Filter activities — include clarify-question, clarify-ack, user-message for conversation flow, project for integration events
  const allowedKinds = new Set(['tool_use', 'thinking', 'text', 'clarify-question', 'clarify-ack', 'user-message', 'project']);
  const feedActivities = useMemo(() => {
    return activities.filter((a) => {
      if (!allowedKinds.has(a.kind)) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (
          !a.summary?.toLowerCase().includes(q) &&
          !a.content?.toLowerCase().includes(q) &&
          !a.tool?.toLowerCase().includes(q)
        ) return false;
      }
      return true;
    });
  }, [activities, searchQuery]);

  // Empty state
  if (!agent && activities.length === 0 && !baseOutput) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', flexDirection: 'column', gap: 12,
      }}>
        {isRunning ? (
          <>
            <div className="status-dot-spin" style={{ width: 24, height: 24 }} />
            <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>Awaiting output...</p>
          </>
        ) : (
          <p style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>No output for this stage yet</p>
        )}
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
    }}>
      {/* Content area */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{ flex: 1, overflow: 'auto', background: 'var(--bg-base)' }}
      >
        {viewMode === 'changes' ? (
          changes.length === 0 ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: 'var(--text-tertiary)', fontSize: 13,
            }}>
              No file changes yet
            </div>
          ) : (
            <div style={{ padding: '4px 0' }}>
              {changes.map((ch, i) => {
                const isExpanded = expandedIds.has(-(i + 1));
                const hasDiff = !!ch.diff;
                const shortPath = ch.file.replace(/.*\/workspace\/[^/]+\/[^/]+\//, '');
                const diffLines = hasDiff ? ch.diff!.split('\n') : [];
                const additions = diffLines.filter((l) => l.startsWith('+') && !l.startsWith('+++')).length;
                const deletions = diffLines.filter((l) => l.startsWith('-') && !l.startsWith('---')).length;

                return (
                  <div key={i} style={{
                    borderBottom: '1px solid var(--separator)',
                  }}>
                    {/* File header — GitHub style */}
                    <div
                      onClick={() => hasDiff && toggleExpanded(-(i + 1))}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '8px 16px',
                        background: 'var(--bg-elevated-1)',
                        cursor: hasDiff ? 'pointer' : 'default',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        userSelect: 'none',
                      }}
                    >
                      {/* Expand/collapse arrow */}
                      {hasDiff && (
                        <span style={{
                          color: 'var(--text-tertiary)', fontSize: 10, width: 12,
                          display: 'inline-flex', alignItems: 'center',
                          transition: 'transform var(--duration-fast) var(--ease-default)',
                          transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                        }}>
                          {'\u25B6'}
                        </span>
                      )}
                      {!hasDiff && <span style={{ width: 12 }} />}

                      {/* File status icon */}
                      <span style={{
                        fontSize: 11, fontWeight: 600, flexShrink: 0,
                        color: ch.tool === 'Write' ? 'var(--color-success)' : 'var(--color-warning)',
                      }}>
                        {ch.tool === 'Write' ? 'A' : 'M'}
                      </span>

                      {/* Repo badge */}
                      {ch.repo && (
                        <span style={{
                          fontSize: 10, padding: '1px 5px',
                          borderRadius: 'var(--radius-xs)',
                          background: 'var(--accent-subtle)', color: 'var(--accent)',
                          fontWeight: 500, flexShrink: 0,
                        }}>
                          {ch.repo}
                        </span>
                      )}

                      {/* File path */}
                      <span style={{ flex: 1, color: 'var(--text-primary)' }}>
                        {shortPath || ch.file}
                      </span>

                      {/* +/- stats */}
                      {hasDiff && (
                        <span style={{ display: 'flex', gap: 6, fontSize: 11, flexShrink: 0 }}>
                          {additions > 0 && (
                            <span style={{ color: 'var(--color-success)' }}>+{additions}</span>
                          )}
                          {deletions > 0 && (
                            <span style={{ color: 'var(--color-error)' }}>-{deletions}</span>
                          )}
                        </span>
                      )}
                    </div>

                    {/* Diff body — GitHub-style */}
                    {isExpanded && hasDiff && (
                      <div style={{
                        overflowX: 'auto', maxHeight: 500, overflowY: 'auto',
                        borderTop: '1px solid var(--separator)',
                      }}>
                        <table style={{
                          width: '100%', borderCollapse: 'collapse',
                          fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: '20px',
                        }}>
                          <tbody>
                            {(() => {
                              let oldLine = 0;
                              let newLine = 0;
                              return diffLines.map((line, li) => {
                                // Hunk header
                                const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
                                if (hunkMatch) {
                                  oldLine = parseInt(hunkMatch[1]);
                                  newLine = parseInt(hunkMatch[2]);
                                  return (
                                    <tr key={li}>
                                      <td colSpan={3} style={{
                                        padding: '4px 12px',
                                        background: 'rgba(96,165,250,0.06)',
                                        color: 'var(--color-info)',
                                        fontSize: 11,
                                        borderTop: li > 0 ? '1px solid var(--separator)' : undefined,
                                        borderBottom: '1px solid var(--separator)',
                                      }}>
                                        {line}
                                      </td>
                                    </tr>
                                  );
                                }

                                // Skip file headers
                                if (line.startsWith('---') || line.startsWith('+++') || line.startsWith('diff ')) {
                                  return null;
                                }

                                const isAdd = line.startsWith('+');
                                const isDel = line.startsWith('-');
                                const content = (isAdd || isDel) ? line.slice(1) : line.startsWith(' ') ? line.slice(1) : line;

                                const bg = isAdd ? 'rgba(52,211,153,0.08)'
                                  : isDel ? 'rgba(248,113,113,0.08)'
                                  : 'transparent';
                                const textColor = isAdd ? 'var(--color-success)'
                                  : isDel ? 'var(--color-error)'
                                  : 'var(--text-secondary)';

                                const oldNum = isDel ? oldLine : !isAdd ? oldLine : null;
                                const newNum = isAdd ? newLine : !isDel ? newLine : null;
                                if (isDel || (!isAdd && !isDel)) oldLine++;
                                if (isAdd || (!isAdd && !isDel)) newLine++;

                                return (
                                  <tr key={li} style={{ background: bg }}>
                                    {/* Old line number */}
                                    <td style={{
                                      width: 44, padding: '0 8px', textAlign: 'right',
                                      color: 'var(--text-quaternary)', userSelect: 'none',
                                      borderRight: '1px solid var(--separator)',
                                      verticalAlign: 'top', fontSize: 11,
                                    }}>
                                      {oldNum ?? ''}
                                    </td>
                                    {/* New line number */}
                                    <td style={{
                                      width: 44, padding: '0 8px', textAlign: 'right',
                                      color: 'var(--text-quaternary)', userSelect: 'none',
                                      borderRight: '1px solid var(--separator)',
                                      verticalAlign: 'top', fontSize: 11,
                                    }}>
                                      {newNum ?? ''}
                                    </td>
                                    {/* Content */}
                                    <td style={{
                                      padding: '0 12px',
                                      color: textColor,
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-all',
                                    }}>
                                      <span style={{
                                        display: 'inline-block', width: 16,
                                        color: isAdd ? 'var(--color-success)' : isDel ? 'var(--color-error)' : 'transparent',
                                        userSelect: 'none', fontWeight: 600,
                                      }}>
                                        {isAdd ? '+' : isDel ? '-' : ' '}
                                      </span>
                                      {content}
                                    </td>
                                  </tr>
                                );
                              });
                            })()}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )
        ) : viewMode === 'raw' ? (
          /* Raw output */
          <RawOutput
            output={baseOutput}
            localMessages={localMessages}
            isRunning={!!isRunning}
          />
        ) : (
          /* Activity feed */
          <div style={{ minHeight: '100%', padding: '8px 0' }}>
            {feedActivities.length > 0 ? (
              feedActivities.map((activity, i) => {
                const isLastText = activity.kind === 'text' &&
                  !feedActivities.slice(i + 1).some((a) => a.kind === 'text');
                return (
                  <ActivityLine
                    key={activity.id}
                    entry={activity}
                    lineNumber={i + 1}
                    isExpanded={expandedIds.has(activity.id)}
                    onToggleExpanded={toggleExpanded}
                    isLastText={isLastText}
                  />
                );
              })
            ) : isRunning ? (
              <div style={{
                display: 'flex', alignItems: 'center', gap: 10,
                padding: '20px 16px',
              }}>
                <div className="status-dot-spin" style={{ width: 16, height: 16 }} />
                <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
                  Working...
                </span>
              </div>
            ) : baseOutput ? (
              <div style={{ padding: 16 }}>
                <MarkdownRenderer content={baseOutput} />
              </div>
            ) : (
              <div style={{
                padding: '20px 16px', fontSize: 13,
                color: 'var(--text-tertiary)',
              }}>
                No output
              </div>
            )}

            {/* Optimistic user messages — only show those not yet echoed by the server */}
            {localMessages
              .filter((msg) => !feedActivities.some((a) => a.kind === 'user-message' && (a.content === msg || a.summary === msg)))
              .map((msg, i) => (
              <div key={`local-${i}`} style={{
                display: 'flex', justifyContent: 'flex-end',
                padding: '6px 16px',
              }}>
                <div style={{
                  maxWidth: '75%',
                  padding: '10px 14px',
                  background: 'var(--accent-muted)',
                  borderRadius: '14px 14px 4px 14px',
                  fontSize: 13,
                  color: 'var(--text-primary)',
                }}>
                  {msg}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Tab bar + actions */}
      <div style={{
        display: 'flex', alignItems: 'center',
        padding: '0 16px',
        height: 36,
        borderTop: '1px solid var(--separator)',
        background: 'var(--bg-elevated-1)',
        flexShrink: 0,
        gap: 4,
      }}>
        {/* Tabs */}
        {(['activity', 'changes', 'raw'] as ViewMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => setViewMode(mode)}
            style={{
              padding: '4px 10px',
              fontSize: 12,
              fontWeight: viewMode === mode ? 500 : 400,
              fontFamily: 'var(--font-sans)',
              color: viewMode === mode ? 'var(--text-primary)' : 'var(--text-tertiary)',
              background: viewMode === mode ? 'var(--bg-elevated-3)' : 'transparent',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              transition: 'all var(--duration-fast) var(--ease-default)',
              textTransform: 'capitalize' as const,
            }}
          >
            {mode === 'changes' ? `Changes (${changes.length})` : mode === 'raw' ? 'Raw' : 'Activity'}
          </button>
        ))}

        <div style={{ flex: 1 }} />

        {/* Search toggle */}
        <button
          onClick={() => {
            setShowSearch(!showSearch);
            if (!showSearch) setTimeout(() => searchRef.current?.focus(), 50);
          }}
          style={{
            padding: 4, background: 'transparent', border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: showSearch ? 'var(--accent)' : 'var(--text-tertiary)',
            cursor: 'pointer',
          }}
        >
          <Search size={14} strokeWidth={1.75} />
        </button>

        {/* Copy */}
        <button
          onClick={handleCopy}
          style={{
            padding: 4, background: 'transparent', border: 'none',
            borderRadius: 'var(--radius-sm)',
            color: copied ? 'var(--color-success)' : 'var(--text-tertiary)',
            cursor: 'pointer',
          }}
        >
          {copied ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />}
        </button>

        {/* Running indicator */}
        {isRunning && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 11, color: 'var(--color-success)',
          }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: 'var(--color-success)',
              animation: 'pulse 2s ease-in-out infinite',
            }} />
            live
          </div>
        )}
      </div>

      {/* Search bar */}
      {showSearch && viewMode === 'activity' && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 16px',
          background: 'var(--bg-elevated-2)',
          borderTop: '1px solid var(--separator)',
        }}>
          <Search size={14} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <input
            ref={searchRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search output..."
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 12, color: 'var(--text-primary)', fontFamily: 'var(--font-sans)',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              style={{
                background: 'transparent', border: 'none',
                color: 'var(--text-tertiary)', cursor: 'pointer', fontSize: 12,
              }}
            >
              Clear
            </button>
          )}
        </div>
      )}

      {/* Input bar */}
      {showInput && (
        <form
          onSubmit={handleSubmit}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '8px 16px',
            flexShrink: 0,
            background: 'var(--bg-elevated-1)',
            borderTop: '1px solid var(--separator)',
          }}
        >
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={inputPending ? 'Processing...' : (inputPlaceholder ?? (isRunning ? 'Type a message...' : 'Resume session...'))}
            style={{
              flex: 1, height: 36,
              padding: '0 12px',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              outline: 'none',
              fontSize: 13,
              color: 'var(--text-primary)',
              fontFamily: 'var(--font-sans)',
              transition: 'border-color var(--duration-fast) var(--ease-default), box-shadow var(--duration-fast) var(--ease-default)',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'var(--accent)';
              e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-subtle)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'var(--separator)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          />
          {inputPending && (
            <div className="status-dot-spin" style={{ width: 16, height: 16, flexShrink: 0 }} />
          )}
          <button
            type="submit"
            disabled={!input.trim() || inputPending}
            style={{
              width: 32, height: 32,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: 'var(--radius-sm)',
              background: input.trim() && !inputPending ? 'var(--accent)' : 'var(--bg-elevated-3)',
              border: 'none', flexShrink: 0,
              color: input.trim() && !inputPending ? 'var(--text-inverse)' : 'var(--text-tertiary)',
              cursor: input.trim() && !inputPending ? 'pointer' : 'default',
              transition: 'all var(--duration-fast) var(--ease-default)',
            }}
          >
            <ArrowUp size={16} strokeWidth={2} />
          </button>
        </form>
      )}
    </div>
  );
}

export default OutputPanel;
