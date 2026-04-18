import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search } from 'lucide-react';

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  category?: string;
  shortcut?: string;
  action: () => void;
}

export interface CommandPaletteProps {
  commands: CommandItem[];
  isOpen: boolean;
  onClose: () => void;
}

export function CommandPalette({ commands, isOpen, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = commands.filter((cmd) =>
    cmd.label.toLowerCase().includes(query.toLowerCase()) ||
    (cmd.description?.toLowerCase().includes(query.toLowerCase()))
  );

  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (isOpen) onClose();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && filtered[selectedIndex]) {
      e.preventDefault();
      filtered[selectedIndex].action();
      onClose();
    } else if (e.key === 'Escape') {
      onClose();
    }
  }, [filtered, selectedIndex, onClose]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '20vh',
        zIndex: 9999,
        animation: 'fadeIn var(--duration-fast) var(--ease-default)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="frosted"
        style={{
          width: '100%',
          maxWidth: 520,
          background: 'rgba(28,28,30,0.92)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
          animation: 'fadeInUp var(--duration-fast) var(--ease-default)',
        }}
        role="dialog"
        aria-label="Command palette"
      >
        {/* Search input */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px',
          borderBottom: '1px solid var(--separator)',
        }}>
          <Search size={16} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
          <input
            ref={inputRef}
            placeholder="Type a command..."
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            onKeyDown={handleKeyDown}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              fontSize: 15, color: 'var(--text-primary)', fontFamily: 'var(--font-sans)',
            }}
          />
        </div>

        {/* Results */}
        <ul style={{ maxHeight: 320, overflow: 'auto', listStyle: 'none', padding: '4px 0' }}>
          {filtered.map((cmd, idx) => (
            <li
              key={cmd.id}
              onClick={() => { cmd.action(); onClose(); }}
              style={{
                padding: '8px 16px',
                cursor: 'pointer',
                background: idx === selectedIndex ? 'var(--bg-elevated-3)' : undefined,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                transition: 'background var(--duration-fast) var(--ease-default)',
              }}
            >
              <div>
                <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>{cmd.label}</div>
                {cmd.description && (
                  <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 1 }}>{cmd.description}</div>
                )}
              </div>
              {cmd.shortcut && (
                <kbd style={{
                  fontSize: 11, color: 'var(--text-tertiary)',
                  background: 'var(--bg-elevated-2)',
                  padding: '2px 6px', borderRadius: 'var(--radius-xs)',
                }}>
                  {cmd.shortcut}
                </kbd>
              )}
            </li>
          ))}
          {filtered.length === 0 && (
            <li style={{
              padding: 'var(--space-lg)', color: 'var(--text-tertiary)',
              textAlign: 'center', fontSize: 13,
            }}>
              No commands found
            </li>
          )}
        </ul>
      </div>
    </div>
  );
}

export default CommandPalette;
