import React from 'react';
import { CheckCircle2, XCircle, Radio, Ban } from 'lucide-react';

export interface RunSummary {
  id: string;
  project: string;
  feature: string;
  featureSlug?: string;
  status: 'completed' | 'failed' | 'running' | 'cancelled';
  model?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  totalCost?: number;
  stages: number;
  completedStages: number;
  repos: string[];
  prUrls?: string[];
  runType?: string;
  output?: string;
  stageDetails?: Array<{
    name: string;
    label: string;
    status: string;
    cost: number;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
  }>;
}

export interface RunRowProps {
  run: RunSummary;
  isSelected: boolean;
  onClick: (id: string) => void;
}

const statusIcon: Record<string, { Icon: typeof CheckCircle2; color: string }> = {
  completed: { Icon: CheckCircle2, color: 'var(--color-success)' },
  failed: { Icon: XCircle, color: 'var(--color-error)' },
  running: { Icon: Radio, color: 'var(--color-warning)' },
  cancelled: { Icon: Ban, color: 'var(--text-tertiary)' },
};

export function RunRow({ run, isSelected, onClick }: RunRowProps) {
  const duration = run.completedAt
    ? Math.round((run.completedAt - run.startedAt) / 1000)
    : Math.round((Date.now() - run.startedAt) / 1000);
  const durationLabel = duration < 60 ? `${duration}s` : `${Math.round(duration / 60)}m`;
  const { Icon: StatusIcon, color: statusColor } = statusIcon[run.status] ?? statusIcon.cancelled;

  return (
    <button
      onClick={() => onClick(run.id)}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: isSelected ? 'var(--bg-elevated-2)' : 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--separator)',
        borderRadius: isSelected ? 'var(--radius-sm)' : 0,
        cursor: 'pointer',
        color: 'var(--text-primary)',
        fontSize: 13,
        width: '100%',
        textAlign: 'left',
        fontFamily: 'var(--font-sans)',
        transition: 'background var(--duration-fast) var(--ease-default)',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'var(--bg-elevated-2)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) (e.currentTarget as HTMLElement).style.background = 'transparent';
      }}
    >
      <StatusIcon size={16} strokeWidth={1.75} style={{ color: statusColor, flexShrink: 0 }} />

      {run.runType && run.runType !== 'build' && (
        <span style={{
          fontSize: 11, fontWeight: 500, padding: '1px 6px',
          borderRadius: 'var(--radius-xs)',
          background: run.runType === 'fix' ? 'rgba(251,191,36,0.12)' : 'rgba(96,165,250,0.12)',
          color: run.runType === 'fix' ? 'var(--color-warning)' : 'var(--color-info)',
        }}>
          {run.runType === 'spike' ? 'research' : run.runType}
        </span>
      )}

      <span style={{ flex: 1, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {run.feature}
      </span>

      <span style={{
        fontSize: 11, color: 'var(--text-tertiary)',
        padding: '1px 6px', borderRadius: 'var(--radius-xs)',
        background: 'var(--bg-elevated-3)', fontFamily: 'var(--font-mono)',
      }}>
        {run.project}
      </span>

      {run.totalCost != null && run.totalCost > 0 && (
        <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
          ${run.totalCost.toFixed(2)}
        </span>
      )}

      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{durationLabel}</span>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
        {new Date(run.startedAt).toLocaleDateString()}
      </span>
    </button>
  );
}

export default RunRow;
