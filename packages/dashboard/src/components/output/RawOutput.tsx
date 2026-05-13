import React, { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { MarkdownRenderer } from './MarkdownRenderer.js';

/**
 * Raw output view.
 *
 * Renders agent output as either markdown (when the content looks like
 * a structured doc — headings, lists, code fences) OR as a monospace
 * terminal-style log (the common case for agent transcripts that
 * interleave `bash: <cmd>`, tool-call markers, file listings, test
 * output, and exit codes).
 *
 * The terminal renderer also groups noisy file-content blocks into
 * collapsed summary lines. `Reading /path/to/foo.go` followed by 80
 * lines of numbered file content becomes a single click-to-expand
 * row. Without this the Raw view drowns out the actual signal (test
 * results, commands run, agent thinking) in cat-of-source-file noise.
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

// ── Line classification ─────────────────────────────────────────────────

type LineKind =
  | 'cmd'         // `bash: <cmd>`
  | 'tool'        // `read_file:`, `write_file:`, `edit:`, `glob:`, `grep:`, `tool_result:`
  | 'meta'        // `(no output)`, `[exit N]`, `Artifact:` standalone
  | 'pass'        // `PASS`, `ok <package>`, `=== RUN`
  | 'fail'        // `FAIL`, `--- FAIL:`, `sh: command not found`
  | 'header'      // `=== ...` Go-test section markers
  | 'comment'     // `// ...` source-line excerpts
  | 'file-open'   // `Reading /path` / `Writing /path` / `Edited /path`
  | 'file-line'   // a numbered file-content line (`  12  package foo`)
  | 'plain';

const FILE_OPEN_RE = /^(Reading|Writing|Editing|Edited|Wrote|Read)\s+(\S.+)$/;
const FILE_LINE_RE = /^\s*\d+\s/;

function classifyLine(line: string): LineKind {
  const t = line.trimStart();
  if (/^bash:\s/i.test(t)) return 'cmd';
  if (/^(read_file|write_file|edit|glob|grep|list|tool_result|tool_use):/i.test(t)) return 'tool';
  if (t === '(no output)' || /^\[exit\s+\d+\]$/.test(t) || /^Artifact:\s*$/.test(t)) return 'meta';
  if (/^===\s/.test(t)) return 'header';
  if (/^---\s+PASS:/.test(t) || /^PASS$/.test(t) || /^ok\s+\S/.test(t)) return 'pass';
  if (/^---\s+FAIL:/.test(t) || /^FAIL$/.test(t) || /^sh:\s.*not found/.test(t) || /^Error:/.test(t)) return 'fail';
  if (FILE_OPEN_RE.test(t)) return 'file-open';
  if (FILE_LINE_RE.test(t)) return 'file-line';
  if (/^\/\//.test(t)) return 'comment';
  return 'plain';
}

const KIND_COLORS: Record<LineKind, string> = {
  cmd:        'var(--accent)',
  tool:       'var(--color-info, var(--accent))',
  meta:       'var(--text-tertiary)',
  pass:       'var(--color-success)',
  fail:       'var(--color-error)',
  header:     'var(--text-secondary)',
  comment:    'var(--text-tertiary)',
  'file-open':'var(--color-info, var(--accent))',
  'file-line':'var(--text-secondary)',
  plain:      'var(--text-primary)',
};

// ── Block grouping ──────────────────────────────────────────────────────
//
// We walk lines and group consecutive `file-line` rows under their
// preceding `file-open` row. The block is rendered collapsed by default
// with a "(N lines)" hint and a chevron the user can click to expand.

interface RawBlock {
  /** Stable key for React. */
  key: number;
  kind: 'file-block' | 'lines';
  /** For 'file-block': the opening line (e.g. "Reading /path"). */
  header?: string;
  /** Content lines under the header (file content, or any block body). */
  lines: string[];
}

function buildBlocks(lines: string[]): RawBlock[] {
  const blocks: RawBlock[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    const kind = classifyLine(line);
    if (kind === 'file-open') {
      const header = line;
      const body: string[] = [];
      i++;
      // Collect every file-line / blank row until we hit something else.
      while (i < lines.length) {
        const nextKind = classifyLine(lines[i]);
        if (nextKind === 'file-line' || lines[i].trim() === '') {
          body.push(lines[i]);
          i++;
        } else {
          break;
        }
      }
      blocks.push({ key: key++, kind: 'file-block', header, lines: body });
      continue;
    }
    // Group runs of non-file-open lines into one 'lines' block so the
    // rendered DOM doesn't have 5000 sibling <div> nodes.
    const run: string[] = [];
    while (i < lines.length) {
      const lk = classifyLine(lines[i]);
      if (lk === 'file-open') break;
      run.push(lines[i]);
      i++;
    }
    if (run.length > 0) blocks.push({ key: key++, kind: 'lines', lines: run });
  }
  return blocks;
}

// ── Renderers ───────────────────────────────────────────────────────────

function renderClassifiedLine(raw: string, key: number): React.ReactNode {
  const kind = classifyLine(raw);
  if (kind === 'cmd') {
    const m = raw.match(/^(\s*)(bash:\s*)(.*)$/i);
    if (m) {
      return (
        <div key={key}>
          <span style={{ color: 'var(--text-tertiary)' }}>{m[1]}{m[2]}</span>
          <span style={{ color: KIND_COLORS.cmd, fontWeight: 500 }}>{m[3]}</span>
        </div>
      );
    }
  }
  if (kind === 'tool') {
    const m = raw.match(/^(\s*)([a-z_]+:)\s*(.*)$/i);
    if (m) {
      return (
        <div key={key}>
          <span style={{ color: KIND_COLORS.tool, fontWeight: 500 }}>{m[1]}{m[2]}</span>
          <span style={{ color: 'var(--text-secondary)' }}> {m[3]}</span>
        </div>
      );
    }
  }
  return (
    <div key={key} style={{ color: KIND_COLORS[kind] }}>
      {raw || '\u00A0'}
    </div>
  );
}

function FileBlock({ header, lines }: { header: string; lines: string[] }) {
  const [open, setOpen] = useState(false);
  // Strip the trailing blank lines from the body for the count display.
  const realLines = lines.filter((l) => l.trim().length > 0);
  const m = header.match(FILE_OPEN_RE);
  const verb = m?.[1] ?? 'Reading';
  const path = m?.[2] ?? header;
  const shortPath = path.length > 80 ? '…' + path.slice(-78) : path;
  return (
    <div style={{ margin: '2px 0' }}>
      <button
        onClick={() => setOpen((x) => !x)}
        title={path}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          background: 'transparent', border: 'none', padding: 0,
          color: KIND_COLORS['file-open'],
          fontFamily: 'inherit', fontSize: 'inherit',
          cursor: 'pointer',
        }}
      >
        <ChevronRight
          size={12}
          style={{
            transition: 'transform 100ms',
            transform: open ? 'rotate(90deg)' : 'none',
          }}
        />
        <span style={{ fontWeight: 500 }}>{verb}</span>
        <span style={{ color: 'var(--text-secondary)' }}>{shortPath}</span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: '0.9em' }}>
          ({realLines.length} line{realLines.length === 1 ? '' : 's'})
        </span>
      </button>
      {open && (
        <div style={{ marginLeft: 14, marginTop: 2, opacity: 0.85 }}>
          {lines.map((l, i) => renderClassifiedLine(l, i))}
        </div>
      )}
    </div>
  );
}

function TerminalView({ text }: { text: string }) {
  const blocks = useMemo(() => buildBlocks(text.split('\n')), [text]);
  return (
    <pre style={{
      margin: 0,
      padding: '12px 14px',
      background: 'var(--bg-elevated-2)',
      borderRadius: 'var(--radius-md)',
      fontFamily: 'var(--font-mono)',
      fontSize: 12.5,
      lineHeight: 1.55,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      color: 'var(--text-primary)',
      tabSize: 2,
    }}>
      {blocks.map((b) => {
        if (b.kind === 'file-block') {
          return <FileBlock key={b.key} header={b.header ?? ''} lines={b.lines} />;
        }
        return (
          <div key={b.key}>
            {b.lines.map((l, i) => renderClassifiedLine(l, i))}
          </div>
        );
      })}
    </pre>
  );
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
              <TerminalView text={fullText} />
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
