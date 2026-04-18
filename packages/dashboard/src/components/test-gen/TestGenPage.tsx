import React, { useState, useEffect, useRef, useCallback } from 'react';
import { TestTube, Play, Check, X, FileCode } from 'lucide-react';

export interface TestGenPageProps {
  project: string | null;
  ws: WebSocket | null;
}

interface ChangedFile {
  path: string;
  language: string;
}

interface GeneratedTest {
  file: string;
  passed: boolean;
  error?: string;
}

export function TestGenPage({ project, ws }: TestGenPageProps) {
  const [files, setFiles] = useState<ChangedFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [testType, setTestType] = useState<'unit' | 'integration' | 'e2e'>('unit');
  const [framework, setFramework] = useState<string>('auto-detect');
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState('');
  const [results, setResults] = useState<GeneratedTest[] | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);

  // Fetch changed files on mount
  useEffect(() => {
    if (!ws || !project) return;
    ws.send(JSON.stringify({ action: 'get-changed-files', project }));
  }, [ws, project]);

  // Listen for messages
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'changed-files' && msg.payload) {
          const f: ChangedFile[] = msg.payload.files || [];
          setFiles(f);
          setSelected(new Set(f.map((file) => file.path)));
        }
        if (msg.type === 'test-gen-output' && msg.payload) {
          setOutput((prev) => prev + msg.payload.text);
        }
        if (msg.type === 'test-gen-complete' && msg.payload) {
          setRunning(false);
          setResults(msg.payload.results || []);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [output]);

  const toggleFile = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(files.map((f) => f.path)));
  }, [files]);

  const deselectAll = useCallback(() => {
    setSelected(new Set());
  }, []);

  const handleGenerate = useCallback(() => {
    if (!ws || !project || selected.size === 0) return;
    setRunning(true);
    setOutput('');
    setResults(null);
    ws.send(JSON.stringify({
      action: 'run-test-gen',
      project,
      files: Array.from(selected),
      testType,
      framework,
    }));
  }, [ws, project, selected, testType, framework]);

  const langColor = (lang: string): string => {
    const map: Record<string, string> = {
      typescript: 'var(--color-info)',
      javascript: 'var(--color-warning)',
      python: 'var(--color-success)',
      go: '#00ADD8',
      rust: '#DEA584',
    };
    return map[lang.toLowerCase()] || 'var(--text-tertiary)';
  };

  if (!project) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        height: '100%', color: 'var(--text-tertiary)', fontSize: 14,
      }}>
        Select a project from the home page first.
      </div>
    );
  }

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
        display: 'flex', alignItems: 'center', gap: 10,
        marginBottom: 16, flexShrink: 0,
      }}>
        <TestTube size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Test Generation</h2>
        <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>
      </div>

      {/* Changed files list */}
      <div style={{
        flex: files.length > 0 && !output ? 1 : undefined,
        minHeight: files.length > 0 ? 120 : undefined,
        maxHeight: output ? 200 : undefined,
        overflow: 'auto',
        marginBottom: 12,
        flexShrink: 0,
      }}>
        {files.length > 0 ? (
          <>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              marginBottom: 8,
            }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-tertiary)' }}>
                Changed Files ({selected.size}/{files.length} selected)
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={selectAll} style={linkButtonStyle}>Select All</button>
                <button onClick={deselectAll} style={linkButtonStyle}>Deselect All</button>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {files.map((f) => (
                <label
                  key={f.path}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '6px 10px',
                    background: selected.has(f.path) ? 'var(--bg-elevated-2)' : 'transparent',
                    border: '1px solid transparent',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    fontSize: 13,
                    transition: 'background var(--duration-fast) var(--ease-default)',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(f.path)}
                    onChange={() => toggleFile(f.path)}
                    style={{ accentColor: 'var(--accent)' }}
                  />
                  <FileCode size={14} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
                  <span style={{
                    flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12,
                    color: 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {f.path}
                  </span>
                  <span style={{
                    fontSize: 10, fontWeight: 500, padding: '1px 6px',
                    borderRadius: 'var(--radius-full)',
                    background: langColor(f.language),
                    color: '#fff',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                  }}>
                    {f.language}
                  </span>
                </label>
              ))}
            </div>
          </>
        ) : (
          !running && !results && (
            <div style={{
              padding: 24, background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)',
              textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13,
            }}>
              No changed files detected. Make some changes and come back.
            </div>
          )
        )}
      </div>

      {/* Options row */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        marginBottom: 12, flexShrink: 0,
      }}>
        {/* Test type dropdown */}
        <div style={{ position: 'relative' }}>
          <select
            value={testType}
            onChange={(e) => setTestType(e.target.value as 'unit' | 'integration' | 'e2e')}
            style={selectStyle}
          >
            <option value="unit">Unit</option>
            <option value="integration">Integration</option>
            <option value="e2e">E2E</option>
          </select>
        </div>

        {/* Framework dropdown */}
        <div style={{ position: 'relative' }}>
          <select
            value={framework}
            onChange={(e) => setFramework(e.target.value)}
            style={selectStyle}
          >
            <option value="auto-detect">Auto-detect</option>
            <option value="jest">Jest</option>
            <option value="vitest">Vitest</option>
            <option value="pytest">Pytest</option>
            <option value="go-test">Go Test</option>
          </select>
        </div>

        <div style={{ flex: 1 }} />

        {/* Generate button */}
        <button
          onClick={handleGenerate}
          disabled={selected.size === 0 || running}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            padding: '8px 20px', fontSize: 13, fontWeight: 600,
            background: 'var(--accent)', color: '#fff', border: 'none',
            borderRadius: 'var(--radius-sm)',
            cursor: selected.size === 0 || running ? 'not-allowed' : 'pointer',
            opacity: selected.size === 0 || running ? 0.6 : 1,
            fontFamily: 'var(--font-sans)',
            transition: 'opacity var(--duration-fast) var(--ease-default)',
          }}
        >
          <Play size={14} strokeWidth={1.75} />
          {running ? 'Generating...' : 'Generate Tests'}
        </button>
      </div>

      {/* Output area */}
      {(output || running) && (
        <div
          ref={outputRef}
          style={{
            flex: 1,
            minHeight: 120,
            padding: '12px 16px',
            background: 'var(--bg-base)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: 1.6,
            color: 'var(--text-secondary)',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            marginBottom: results ? 12 : 0,
          }}
        >
          {output || (
            <span style={{ color: 'var(--text-tertiary)' }}>
              Generating tests...
            </span>
          )}
          {running && (
            <span className="status-dot-spin" style={{
              display: 'inline-block', width: 8, height: 8, marginLeft: 4,
            }} />
          )}
        </div>
      )}

      {/* Results panel */}
      {results && results.length > 0 && (
        <div style={{ flexShrink: 0, marginTop: output ? 0 : 12 }}>
          <div style={{
            fontSize: 12, fontWeight: 500, color: 'var(--text-tertiary)',
            marginBottom: 8,
          }}>
            Generated Tests ({results.filter((r) => r.passed).length}/{results.length} passed)
          </div>
          <div className="stagger" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {results.map((r) => (
              <div
                key={r.file}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 12px',
                  background: 'var(--bg-elevated-2)',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                }}
              >
                {r.passed ? (
                  <Check size={14} strokeWidth={1.75} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
                ) : (
                  <X size={14} strokeWidth={1.75} style={{ color: 'var(--color-error)', flexShrink: 0 }} />
                )}
                <span style={{
                  flex: 1, fontFamily: 'var(--font-mono)', fontSize: 12,
                  color: 'var(--text-primary)',
                }}>
                  {r.file}
                </span>
                <span style={{
                  fontSize: 11,
                  color: r.passed ? 'var(--color-success)' : 'var(--color-error)',
                }}>
                  {r.passed ? 'Passed' : 'Failed'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Empty state */}
      {!running && !output && !results && files.length > 0 && (
        <div style={{
          textAlign: 'center', padding: '48px 0',
          color: 'var(--text-tertiary)', fontSize: 14,
        }}>
          Select files and click &apos;Generate Tests&apos; to create test coverage
        </div>
      )}
    </div>
  );
}

const linkButtonStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  fontSize: 12,
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
  padding: '2px 4px',
  borderRadius: 'var(--radius-sm)',
};

const selectStyle: React.CSSProperties = {
  appearance: 'none',
  height: 30,
  padding: '0 28px 0 10px',
  background: 'var(--bg-elevated-2)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-secondary)',
  fontSize: 12,
  fontFamily: 'var(--font-sans)',
  cursor: 'pointer',
  outline: 'none',
};

export default TestGenPage;
