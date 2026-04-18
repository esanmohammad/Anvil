import React from 'react';
import { Badge } from '../ui/Badge.js';
import type { PipelineStage } from '../../../server/types.js';

export interface StageCardProps {
  stage: PipelineStage;
  index: number;
  isSelected: boolean;
  onClick: (index: number) => void;
}

const statusVariant: Record<PipelineStage['status'], 'primary' | 'success' | 'error' | 'warning' | 'neutral'> = {
  pending: 'neutral',
  running: 'primary',
  completed: 'success',
  failed: 'error',
  skipped: 'neutral',
};

export function StageCard({ stage, index, isSelected, onClick }: StageCardProps) {
  return (
    <button
      className="card"
      onClick={() => onClick(index)}
      style={{
        cursor: 'pointer',
        minWidth: 120,
        textAlign: 'center',
        borderColor: isSelected ? 'var(--color-accent)' : undefined,
        position: 'relative',
      }}
      aria-selected={isSelected}
    >
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 4 }}>
        Stage {index + 1}
      </div>
      <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 8, textTransform: 'capitalize' }}>
        {stage.name}
      </div>
      <Badge variant={statusVariant[stage.status]}>{stage.status}</Badge>
      {stage.status === 'running' && (
        <div style={{ marginTop: 8, height: 4, background: 'var(--bg-hover)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
          <div style={{ width: `${stage.progress}%`, height: '100%', background: 'var(--color-primary)', transition: 'width var(--transition-fast)' }} />
        </div>
      )}
    </button>
  );
}

export default StageCard;
