import React from 'react';
import { MarkdownRenderer } from './MarkdownRenderer.js';

/**
 * Raw output view — Apple-inspired design.
 *
 * Shows agent output as clean plain text / markdown.
 * User messages as right-aligned accent-muted bubbles.
 */

interface RawOutputProps {
  output: string;
  localMessages: string[];
  isRunning: boolean;
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

export function RawOutput({ output, localMessages, isRunning }: RawOutputProps) {
  const fullText = output;
  const isMd = looksLikeMarkdown(fullText);

  return (
    <div style={{
      padding: 'var(--space-md)',
      fontSize: 13,
      lineHeight: 1.6,
      minHeight: '100%',
    }}>
      {fullText || localMessages.length > 0 ? (
        <>
          {fullText && (
            isMd ? (
              <div style={{
                padding: '12px 16px',
                background: 'var(--bg-elevated-2)',
                borderRadius: 'var(--radius-md)',
              }}>
                <MarkdownRenderer content={fullText} />
              </div>
            ) : (
              <pre style={{
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'var(--font-sans)',
                color: 'var(--text-primary)',
                margin: 0,
                fontSize: 13,
                lineHeight: 1.6,
                padding: '12px 16px',
                background: 'var(--bg-elevated-2)',
                borderRadius: 'var(--radius-md)',
              }}>{fullText}</pre>
            )
          )}

          {/* User messages */}
          {localMessages.map((msg, i) => (
            <div key={i} style={{
              display: 'flex',
              justifyContent: 'flex-end',
              marginTop: 8,
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
                {msg}
              </div>
            </div>
          ))}

          {isRunning && localMessages.length > 0 && (
            <div style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}>
              <div className="status-dot-spin" style={{ width: 14, height: 14 }} />
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Working...</span>
            </div>
          )}
        </>
      ) : (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
          minHeight: 120,
          color: 'var(--text-tertiary)',
          fontSize: 13,
        }}>
          {isRunning ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="status-dot-spin" style={{ width: 16, height: 16 }} />
              <span>Awaiting output...</span>
            </div>
          ) : (
            <span>No output</span>
          )}
        </div>
      )}
    </div>
  );
}

export default RawOutput;
