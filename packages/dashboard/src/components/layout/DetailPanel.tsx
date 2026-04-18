import React from 'react';

export interface DetailPanelProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}

export function DetailPanel({ open, onClose, title, children }: DetailPanelProps) {
  return (
    <aside
      className="detail-panel"
      data-open={open}
      style={{
        width: open ? 'var(--detail-panel-width)' : 0,
        background: 'var(--bg-panel)',
        borderLeft: open ? '1px solid var(--border-default)' : 'none',
        overflow: 'hidden',
        transition: 'width var(--transition-normal)',
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
      }}
    >
      {open && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: 'var(--space-md)', borderBottom: '1px solid var(--border-default)' }}>
            <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600 }}>{title}</h3>
            <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close panel">&times;</button>
          </div>
          <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-md)' }}>
            {children}
          </div>
        </>
      )}
    </aside>
  );
}

export default DetailPanel;
