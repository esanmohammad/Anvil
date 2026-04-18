import React, { useState, useCallback } from 'react';
import {
  FileText, Pencil, Terminal, Search, FolderOpen, Bot, Brain, Rocket,
  HelpCircle, CheckCircle2, AlertTriangle, ChevronDown, ChevronRight,
  Globe, Target, Wrench, Database, Plug,
} from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer.js';

/**
 * Activity line — Conversation-style, Apple-inspired.
 *
 * No line numbers, no pipe separators, no emoji prefixes.
 * AI text as rounded cards, user messages right-aligned,
 * tool ops collapsed into summaries.
 */

export interface ActivityEntry {
  id: number;
  timestamp: number;
  kind: 'text' | 'tool_use' | 'thinking' | 'project' | 'result' | 'stderr' | 'tool_result' | 'user-message' | 'artifact' | 'clarify-question' | 'clarify-ack';
  tool?: string;
  summary: string;
  content?: string;
  stage?: string;
  repo?: string;
  runId?: string;
}

interface ToolMeta {
  Icon: React.ComponentType<any>;
  color: string;
  label: string;
}

function toolMeta(tool?: string): ToolMeta {
  switch (tool) {
    case 'Read':       return { Icon: FileText,  color: 'var(--accent)',        label: 'Read' };
    case 'Edit':       return { Icon: Pencil,    color: 'var(--color-warning)', label: 'Edit' };
    case 'Write':      return { Icon: Pencil,    color: 'var(--color-warning)', label: 'Write' };
    case 'Bash':       return { Icon: Terminal,   color: 'var(--color-success)', label: 'Run' };
    case 'Grep':       return { Icon: Search,    color: 'var(--color-info)',    label: 'Search' };
    case 'Glob':       return { Icon: FolderOpen, color: 'var(--color-info)',   label: 'Find' };
    case 'Agent':      return { Icon: Bot,       color: 'var(--color-error)',   label: 'Agent' };
    case 'Skill':      return { Icon: Target,    color: '#a855f7',             label: 'Skill' };
    case 'WebSearch':  return { Icon: Globe,     color: 'var(--color-info)',    label: 'Search' };
    case 'WebFetch':   return { Icon: Globe,     color: 'var(--color-info)',    label: 'Fetch' };
    default:           return { Icon: Wrench,    color: 'var(--text-secondary)', label: tool ?? 'Tool' };
  }
}

function looksLikeMarkdown(text: string): boolean {
  if (!text) return false;
  return /^#{1,6}\s/m.test(text) ||
    /\*\*.+\*\*/m.test(text) ||
    /^[-*+]\s/m.test(text) ||
    /^\d+[.)]\s/m.test(text) ||
    /^```/m.test(text) ||
    /^>/m.test(text);
}

interface ActivityLineProps {
  entry: ActivityEntry;
  lineNumber: number;
  isExpanded?: boolean;
  onToggleExpanded?: (id: number) => void;
  isLastText?: boolean;
}

export function ActivityLine({ entry, lineNumber: _lineNumber, isExpanded, onToggleExpanded, isLastText }: ActivityLineProps) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = isExpanded ?? localExpanded;
  const toggleExpand = useCallback(() => {
    if (onToggleExpanded) onToggleExpanded(entry.id);
    else setLocalExpanded((prev) => !prev);
  }, [entry.id, onToggleExpanded]);

  if (entry.kind === 'tool_result') return null;

  // Project integration events (KB injection, project context) — subtle info bar
  if (entry.kind === 'project') {
    const content = entry.content || entry.summary;
    const isKB = content.includes('[knowledge-base]');
    const isProject = content.includes('[project-context]');
    const isWarn = content.includes('No Knowledge Base') || content.includes('Could not load') || content.includes('manually');
    const Icon = isKB ? Database : isProject ? Plug : Rocket;
    const color = isWarn ? 'var(--color-warning)' : 'var(--color-info)';

    return (
      <div style={{
        padding: '3px 16px',
      }}>
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderRadius: 'var(--radius-sm)',
          background: isWarn ? 'rgba(var(--warning-rgb, 255,171,0), 0.08)' : 'rgba(var(--info-rgb, 56,152,255), 0.08)',
          border: `1px solid ${isWarn ? 'rgba(var(--warning-rgb, 255,171,0), 0.15)' : 'rgba(var(--info-rgb, 56,152,255), 0.15)'}`,
          fontFamily: 'var(--font-sans)',
          fontSize: 12,
          color,
        }}>
          <Icon size={14} strokeWidth={1.75} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            {content.replace(/^[📚🔌ℹ️]+\s*/, '')}
          </span>
        </div>
      </div>
    );
  }

  // User messages — right-aligned with accent-muted background
  if (entry.kind === 'user-message') {
    return (
      <div style={{
        display: 'flex',
        justifyContent: 'flex-end',
        padding: '6px 16px',
        animation: 'fadeInUp var(--duration-fast) var(--ease-default)',
      }}>
        <div style={{
          maxWidth: '75%',
          padding: '10px 14px',
          background: 'var(--accent-muted)',
          borderRadius: '14px 14px 4px 14px',
          fontSize: 13,
          color: 'var(--text-primary)',
          lineHeight: 1.5,
        }}>
          {entry.summary}
        </div>
      </div>
    );
  }

  // Clarify question — left-bordered card
  if (entry.kind === 'clarify-question') {
    return (
      <div style={{
        margin: '8px 16px',
        padding: '14px 16px',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderLeft: '3px solid var(--accent)',
        borderRadius: 'var(--radius-md)',
        animation: 'fadeInUp var(--duration-fast) var(--ease-default)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <HelpCircle size={16} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
          <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--accent)' }}>Question</span>
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'var(--text-primary)' }}>
          {looksLikeMarkdown(entry.content ?? entry.summary) ? (
            <MarkdownRenderer content={entry.content ?? entry.summary} />
          ) : (
            <span>{entry.content ?? entry.summary}</span>
          )}
        </div>
      </div>
    );
  }

  // Clarify acknowledgment
  if (entry.kind === 'clarify-ack') {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 16px', margin: '4px 16px',
        fontSize: 12, color: 'var(--color-success)',
      }}>
        <CheckCircle2 size={14} strokeWidth={1.75} />
        <span>{entry.content ?? entry.summary}</span>
      </div>
    );
  }

  const hasExpandableContent = !!entry.content && entry.content.length > 200;
  const effectiveExpanded = expanded || (isLastText && !!entry.content);

  // Text activities — AI text as rounded card
  if (entry.kind === 'text') {
    const fullText = entry.summary + (effectiveExpanded && entry.content ? '\n' + entry.content : '');
    const isMd = looksLikeMarkdown(fullText);

    return (
      <div style={{
        padding: '6px 16px',
        animation: 'fadeInUp var(--duration-fast) var(--ease-default)',
      }}>
        <div style={{
          padding: '12px 16px',
          background: 'var(--bg-elevated-2)',
          borderRadius: 'var(--radius-md)',
          position: 'relative',
        }}>
          {isMd ? (
            <div style={{ fontSize: 13, lineHeight: 1.6 }}>
              <MarkdownRenderer content={fullText} />
            </div>
          ) : (
            <pre style={{
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              lineHeight: 1.6,
              fontFamily: 'var(--font-sans)',
              color: 'var(--text-primary)',
              margin: 0,
            }}>
              {entry.summary}
              {hasExpandableContent && !effectiveExpanded && (
                <span style={{ color: 'var(--text-tertiary)' }}>...</span>
              )}
              {effectiveExpanded && entry.content && (
                <span style={{ color: 'var(--text-secondary)' }}>{'\n'}{entry.content}</span>
              )}
            </pre>
          )}
          {hasExpandableContent && (
            <button
              onClick={toggleExpand}
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                padding: 2,
                color: 'var(--text-tertiary)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
          )}
        </div>
      </div>
    );
  }

  // Tool use / thinking — collapsed summary
  const meta = entry.kind === 'tool_use'
    ? toolMeta(entry.tool)
    : entry.kind === 'thinking'
      ? { Icon: Brain, color: 'var(--text-tertiary)', label: 'Thinking' }
      : entry.kind === 'result'
        ? { Icon: CheckCircle2, color: 'var(--color-success)', label: 'Done' }
        : entry.kind === 'stderr'
          ? { Icon: AlertTriangle, color: 'var(--color-warning)', label: 'Warning' }
          : entry.kind === 'artifact'
            ? { Icon: FileText, color: 'var(--accent)', label: 'Artifact' }
            : { Icon: Terminal, color: 'var(--text-primary)', label: 'Output' };

  const MetaIcon = meta.Icon;

  return (
    <div style={{ padding: '2px 16px' }}>
      <button
        onClick={() => hasExpandableContent && toggleExpand()}
        aria-expanded={hasExpandableContent ? expanded : undefined}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '5px 10px',
          textAlign: 'left',
          cursor: hasExpandableContent ? 'pointer' : 'default',
          background: 'transparent',
          border: 'none',
          borderRadius: 'var(--radius-sm)',
          fontFamily: 'var(--font-sans)',
          fontSize: 12,
          color: 'var(--text-secondary)',
          transition: 'background var(--duration-fast) var(--ease-default)',
        }}
        onMouseEnter={(e) => { if (hasExpandableContent) e.currentTarget.style.background = 'var(--bg-elevated-2)'; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
      >
        <MetaIcon size={14} strokeWidth={1.75} style={{ color: meta.color, flexShrink: 0 }} />
        <span style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          color: entry.kind === 'thinking' ? 'var(--text-tertiary)' : 'var(--text-secondary)',
          fontStyle: entry.kind === 'thinking' ? 'italic' : 'normal',
        }}>
          {entry.summary}
        </span>
        {hasExpandableContent && (
          expanded ? <ChevronDown size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
                   : <ChevronRight size={12} style={{ flexShrink: 0, color: 'var(--text-tertiary)' }} />
        )}
      </button>

      {/* Expanded content */}
      {expanded && entry.content && (
        <div style={{
          paddingLeft: 32,
          paddingRight: 16,
          paddingBottom: 6,
          animation: 'fadeInUp var(--duration-fast) var(--ease-default)',
        }}>
          <pre style={{
            fontSize: 12,
            fontFamily: 'var(--font-mono)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            maxHeight: 600,
            overflow: 'auto',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 10px',
            lineHeight: 1.6,
            background: 'var(--bg-elevated-2)',
            color: 'var(--text-tertiary)',
            border: '1px solid var(--separator)',
            margin: 0,
          }}>
            {entry.content}
          </pre>
        </div>
      )}
    </div>
  );
}

export default ActivityLine;
