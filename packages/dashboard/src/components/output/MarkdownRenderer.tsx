import React from 'react';

/**
 * Lightweight zero-dependency Markdown renderer for agent text output.
 * Handles headings, code blocks, paragraphs, lists, blockquotes, and inline formatting.
 */

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Pattern: **bold**, *italic*, `code`, [link](url)
  const regex = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      nodes.push(<strong key={key++}>{match[2]}</strong>);
    } else if (match[3]) {
      nodes.push(<em key={key++}>{match[3]}</em>);
    } else if (match[4]) {
      nodes.push(
        <code key={key++} style={{
          background: 'var(--bg-hover)',
          padding: '1px 4px',
          borderRadius: 'var(--radius-sm)',
          fontSize: '0.9em',
          fontFamily: 'var(--font-mono)',
        }}>
          {match[4]}
        </code>
      );
    } else if (match[5] && match[6]) {
      nodes.push(
        <a key={key++} href={match[6]} target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--color-accent)' }}>
          {match[5]}
        </a>
      );
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }
  return nodes.length > 0 ? nodes : [text];
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  const lines = content.split('\n');
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre key={key++} style={{
          background: 'var(--bg-root)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-sm)',
          padding: 'var(--space-sm)',
          margin: '4px 0',
          overflow: 'auto',
          fontSize: 'var(--text-xs)',
          fontFamily: 'var(--font-mono)',
          lineHeight: 1.5,
        }}>
          {lang && (
            <span style={{ color: 'var(--text-muted)', fontSize: '10px', display: 'block', marginBottom: 4 }}>
              {lang}
            </span>
          )}
          <code>{escapeHtml(codeLines.join('\n'))}</code>
        </pre>
      );
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const sizes: Record<number, string> = {
        1: 'var(--text-xl)', 2: 'var(--text-lg)', 3: 'var(--text-base)',
        4: 'var(--text-sm)', 5: 'var(--text-sm)', 6: 'var(--text-xs)',
      };
      elements.push(
        <div key={key++} style={{
          fontSize: sizes[level],
          fontWeight: 600,
          margin: '8px 0 4px',
          color: 'var(--text-primary)',
        }}>
          {renderInline(headingMatch[2])}
        </div>
      );
      i++;
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <blockquote key={key++} style={{
          borderLeft: '3px solid var(--border-default)',
          paddingLeft: 'var(--space-sm)',
          margin: '4px 0',
          color: 'var(--text-secondary)',
          fontStyle: 'italic',
        }}>
          {quoteLines.map((ql, qi) => (
            <div key={qi}>{renderInline(ql)}</div>
          ))}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (line.match(/^[\-\*]\s/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^[\-\*]\s/)) {
        items.push(lines[i].replace(/^[\-\*]\s/, ''));
        i++;
      }
      elements.push(
        <ul key={key++} style={{ paddingLeft: 'var(--space-md)', margin: '4px 0', listStyleType: 'disc' }}>
          {items.map((item, ii) => (
            <li key={ii} style={{ marginBottom: 2 }}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (line.match(/^\d+\.\s/)) {
      const items: string[] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        items.push(lines[i].replace(/^\d+\.\s/, ''));
        i++;
      }
      elements.push(
        <ol key={key++} style={{ paddingLeft: 'var(--space-md)', margin: '4px 0' }}>
          {items.map((item, ii) => (
            <li key={ii} style={{ marginBottom: 2 }}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Empty line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph
    elements.push(
      <p key={key++} style={{ margin: '4px 0', lineHeight: 1.5 }}>
        {renderInline(line)}
      </p>
    );
    i++;
  }

  return (
    <div className={className} style={{ fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
      {elements}
    </div>
  );
}

export default MarkdownRenderer;
