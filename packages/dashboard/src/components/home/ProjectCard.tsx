import React, { useState } from 'react';

export interface ProjectCardProps {
  name: string;
  title: string;
  repoCount: number;
  lifecycle: string;
  repos?: Array<{ name: string; language: string }>;
  isSelected: boolean;
  onClick: () => void;
}

const lifecycleColors: Record<string, string> = {
  production: 'var(--color-success)',
  maintenance: 'var(--color-warning)',
  deprecated: 'var(--color-error)',
};

export function ProjectCard({
  name,
  title,
  repoCount,
  lifecycle,
  repos,
  isSelected,
  onClick,
}: ProjectCardProps) {
  const [hovered, setHovered] = useState(false);

  const uniqueLanguages = repos
    ? [...new Set(repos.map((r) => r.language).filter(Boolean))]
    : [];

  const badgeColor = lifecycleColors[lifecycle] ?? 'var(--text-muted)';

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-xs)',
        padding: 'var(--space-md)',
        background: isSelected ? 'color-mix(in srgb, var(--color-accent) 8%, var(--bg-card))' : 'var(--bg-card)',
        border: `1.5px solid ${isSelected ? 'var(--color-accent)' : hovered ? 'var(--text-muted)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-md)',
        cursor: 'pointer',
        minWidth: 160,
        textAlign: 'left',
        fontFamily: 'var(--font-sans)',
        transition: 'border-color 150ms ease, background 150ms ease',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)', color: 'var(--text-primary)' }}>
          {title || name}
        </span>
        <span
          style={{
            fontSize: 'var(--text-xs)',
            color: badgeColor,
            textTransform: 'capitalize',
            fontWeight: 500,
          }}
        >
          {lifecycle}
        </span>
      </div>

      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
        {repoCount} {repoCount === 1 ? 'repo' : 'repos'}
      </span>

      {uniqueLanguages.length > 0 && (
        <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap', marginTop: 2 }}>
          {uniqueLanguages.map((lang) => (
            <span
              key={lang}
              style={{
                fontSize: 'var(--text-xs)',
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-muted)',
                background: 'var(--bg-panel)',
                padding: '1px 6px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {lang}
            </span>
          ))}
        </div>
      )}
    </button>
  );
}

export default ProjectCard;
