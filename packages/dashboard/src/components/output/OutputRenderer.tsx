import React, { useRef, useEffect } from 'react';
import { ToolCallSection } from './ToolCallSection.js';
import type { OutputChunk } from '../../../server/types.js';

export interface OutputRendererProps {
  chunks: OutputChunk[];
  autoScroll?: boolean;
  searchQuery?: string;
}

export function OutputRenderer({ chunks, autoScroll = true, searchQuery }: OutputRendererProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chunks.length, autoScroll]);

  const highlight = (text: string): React.ReactNode => {
    if (!searchQuery) return text;
    const idx = text.toLowerCase().indexOf(searchQuery.toLowerCase());
    if (idx === -1) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark style={{ background: 'var(--color-warning)', color: 'var(--text-inverse)' }}>
          {text.slice(idx, idx + searchQuery.length)}
        </mark>
        {text.slice(idx + searchQuery.length)}
      </>
    );
  };

  return (
    <div
      className="output-renderer"
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 'var(--text-xs)',
        lineHeight: 1.6,
        padding: 'var(--space-sm)',
        background: 'var(--bg-root)',
        borderRadius: 'var(--radius-md)',
        overflow: 'auto',
        height: '100%',
      }}
    >
      {chunks.map((chunk, i) => {
        if (chunk.type === 'tool_call' || chunk.type === 'tool_result') {
          return (
            <ToolCallSection
              key={i}
              toolName={chunk.toolName ?? chunk.type}
              content={chunk.content}
              timestamp={chunk.timestamp}
            />
          );
        }
        return (
          <div
            key={i}
            style={{
              color: chunk.type === 'stderr' ? 'var(--color-error)' : 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
            }}
          >
            {highlight(chunk.content)}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

export default OutputRenderer;
