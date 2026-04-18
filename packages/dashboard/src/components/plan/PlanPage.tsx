import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Map, Play, Download, Copy } from 'lucide-react';

export interface PlanPageProps {
  project: string | null;
  ws: WebSocket | null;
}

const models = [
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4' },
  { value: 'claude-opus-4-6', label: 'Opus 4' },
  { value: 'gpt-4o', label: 'GPT-4o' },
];

/** Simple markdown renderer — handles headers, bullets, code blocks, bold, italic. */
function renderMarkdown(md: string): string {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g,
    (_m, _lang, code) => `<pre style="background:var(--bg-base);padding:12px;border-radius:var(--radius-sm);font-family:var(--font-mono);font-size:12px;overflow-x:auto;line-height:1.5"><code>${code.trim()}</code></pre>`);

  // Inline code
  html = html.replace(/`([^`]+)`/g,
    '<code style="background:var(--bg-elevated-3);padding:1px 5px;border-radius:3px;font-family:var(--font-mono);font-size:12px">$1</code>');

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4 style="font-size:14px;font-weight:600;margin:16px 0 6px;color:var(--text-primary)">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 style="font-size:15px;font-weight:600;margin:20px 0 8px;color:var(--text-primary)">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 style="font-size:16px;font-weight:600;margin:24px 0 8px;color:var(--text-primary)">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 style="font-size:18px;font-weight:700;margin:24px 0 10px;color:var(--text-primary)">$1</h1>');

  // Bold / italic
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<li style="margin-left:16px;margin-bottom:4px">$1</li>');
  html = html.replace(/(<li[^>]*>.*<\/li>\n?)+/g, (m) => `<ul style="list-style:disc;padding-left:8px;margin:8px 0">${m}</ul>`);

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid var(--separator);margin:16px 0"/>');

  // Paragraphs
  html = html.replace(/^(?!<[huplo]|<li|<hr|<pre)(.+)$/gm, '<p style="margin:6px 0">$1</p>');
  html = html.replace(/<p>\s*<\/p>/g, '');

  return html;
}

export function PlanPage({ project, ws }: PlanPageProps) {
  const [feature, setFeature] = useState('');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [plan, setPlan] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const handleGenerate = useCallback(() => {
    if (!ws || !project || !feature.trim()) return;
    setLoading(true);
    setPlan('');
    ws.send(JSON.stringify({ action: 'run-plan', project, feature: feature.trim(), model }));
  }, [ws, project, feature, model]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && feature.trim() && project) {
      e.preventDefault();
      handleGenerate();
    }
  }, [handleGenerate, feature, project]);

  // Listen for streaming plan output
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'agent-output' && typeof msg.payload?.text === 'string') {
          setPlan((prev) => prev + msg.payload.text);
        }
        if (msg.type === 'agent-done' || msg.type === 'agent-error') {
          setLoading(false);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  // Auto-scroll during streaming
  useEffect(() => {
    if (loading && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [plan, loading]);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(plan).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [plan]);

  const handleDownload = useCallback(() => {
    const blob = new Blob([plan], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'plan.md';
    a.click();
    URL.revokeObjectURL(url);
  }, [plan]);

  const handleExecute = useCallback(() => {
    if (!ws || !project) return;
    ws.send(JSON.stringify({ action: 'run-pipeline', project, context: plan, model }));
  }, [ws, project, plan, model]);

  const canGenerate = project && feature.trim().length > 0;

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
        gap: 10,
        marginBottom: 20,
        flexShrink: 0,
      }}>
        <Map size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Architecture Plan</h2>
        {project && (
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>
        )}
      </div>

      {/* Input row: feature text + model selector + generate button */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginBottom: 16,
        flexShrink: 0,
      }}>
        <div style={{ flex: 1, position: 'relative' }}>
          <input
            value={feature}
            onChange={(e) => setFeature(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the feature to plan..."
            style={{
              width: '100%',
              height: 40,
              padding: '0 16px',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-md)',
              color: 'var(--text-primary)',
              fontSize: 14,
              fontFamily: 'var(--font-sans)',
              outline: 'none',
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
        </div>

        {/* Model selector */}
        <div style={{ position: 'relative' }}>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            style={{
              appearance: 'none',
              height: 40,
              padding: '0 28px 0 12px',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              fontSize: 12,
              fontFamily: 'var(--font-sans)',
              cursor: 'pointer',
              outline: 'none',
            }}
          >
            {models.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <svg
            width={12} height={12}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              position: 'absolute', right: 9, top: '50%',
              transform: 'translateY(-50%)', pointerEvents: 'none',
              color: 'var(--text-tertiary)',
            }}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>

        <button
          onClick={handleGenerate}
          disabled={loading || !canGenerate}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            height: 40,
            padding: '0 20px',
            fontSize: 13,
            fontWeight: 600,
            background: 'var(--accent)',
            color: 'var(--text-inverse)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: loading || !canGenerate ? 'not-allowed' : 'pointer',
            opacity: loading || !canGenerate ? 0.6 : 1,
            fontFamily: 'var(--font-sans)',
            whiteSpace: 'nowrap',
          }}
        >
          <Map size={14} strokeWidth={1.75} />
          {loading ? 'Generating...' : 'Generate Plan'}
        </button>
      </div>

      {/* Plan content */}
      {(plan || loading) && (
        <div ref={contentRef} style={{
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
          padding: '20px 24px',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          fontSize: 13,
          lineHeight: 1.7,
          color: 'var(--text-secondary)',
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
        }}>
          {plan ? (
            <div dangerouslySetInnerHTML={{ __html: renderMarkdown(plan) }} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: 'var(--text-tertiary)' }}>
              <div className="status-dot-spin" style={{ width: 16, height: 16 }} />
              Generating architecture plan...
            </div>
          )}
          {loading && plan && (
            <div style={{
              display: 'inline-block',
              width: 6,
              height: 14,
              background: 'var(--accent)',
              borderRadius: 1,
              animation: 'pulse 1s ease-in-out infinite',
              verticalAlign: 'middle',
              marginLeft: 2,
            }} />
          )}
        </div>
      )}

      {/* Empty state */}
      {!plan && !loading && (
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
          <Map size={32} style={{ opacity: 0.3 }} />
          <span>Describe a feature to generate an architecture plan</span>
          <kbd style={{
            fontSize: 11,
            color: 'var(--text-quaternary)',
            padding: '2px 6px',
            borderRadius: 4,
            background: 'var(--bg-elevated-3)',
          }}>
            {'\u2318'} Enter to generate
          </kbd>
        </div>
      )}

      {/* Action buttons — shown after plan is generated */}
      {plan && !loading && (
        <div style={{
          flexShrink: 0,
          marginTop: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <button
            onClick={handleExecute}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 34,
              padding: '0 16px',
              fontSize: 13,
              fontWeight: 600,
              background: 'var(--accent)',
              color: 'var(--text-inverse)',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <Play size={14} strokeWidth={1.75} />
            Execute Pipeline
          </button>
          <button
            onClick={handleCopy}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 34,
              padding: '0 14px',
              fontSize: 12,
              fontWeight: 500,
              background: 'var(--bg-elevated-2)',
              color: copied ? 'var(--color-success)' : 'var(--text-secondary)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              transition: 'color var(--duration-fast) var(--ease-default)',
            }}
          >
            <Copy size={14} strokeWidth={1.75} />
            {copied ? 'Copied!' : 'Copy to Clipboard'}
          </button>
          <button
            onClick={handleDownload}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 34,
              padding: '0 14px',
              fontSize: 12,
              fontWeight: 500,
              background: 'var(--bg-elevated-2)',
              color: 'var(--text-secondary)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <Download size={14} strokeWidth={1.75} />
            Download
          </button>
        </div>
      )}
    </div>
  );
}

export default PlanPage;
