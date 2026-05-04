import React from 'react';

export interface ComingSoonPanelProps {
  icon?: React.ReactNode;
  title: string;
  description: string;
}

export function ComingSoonPanel({ icon, title, description }: ComingSoonPanelProps) {
  return (
    <div style={{
      padding: 40, background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)',
      textAlign: 'center',
    }}>
      {icon}
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 400, margin: '0 auto', lineHeight: 1.6, marginBottom: 16 }}>
        {description}
      </div>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 16px', fontSize: 12, fontWeight: 500,
        background: 'var(--bg-elevated-3)', color: 'var(--text-tertiary)',
        borderRadius: 'var(--radius-full)',
      }}>
        Coming Soon
      </span>
    </div>
  );
}

export default ComingSoonPanel;
