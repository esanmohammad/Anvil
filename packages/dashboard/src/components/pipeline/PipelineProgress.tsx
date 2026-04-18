import React from 'react';
import { StageCard } from './StageCard.js';
import { PIPELINE_STAGES } from './usePipelineState.js';
import type { PipelineUpdate } from '../../../server/types.js';

export interface PipelineProgressProps {
  pipeline: PipelineUpdate | null;
  selectedStage: number | null;
  onStageSelect: (index: number) => void;
}

export function PipelineProgress({ pipeline, selectedStage, onStageSelect }: PipelineProgressProps) {
  const stages = pipeline?.stages ?? PIPELINE_STAGES.map((name) => ({
    name,
    status: 'pending' as const,
    progress: 0,
  }));

  return (
    <div className="pipeline-progress">
      {/* Overall progress bar */}
      <div style={{ marginBottom: 'var(--space-md)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 'var(--text-sm)', marginBottom: 4 }}>
          <span style={{ color: 'var(--text-secondary)' }}>
            {pipeline?.status === 'running' ? 'Running...' : pipeline?.status ?? 'Idle'}
          </span>
          <span style={{ color: 'var(--text-muted)' }}>{pipeline?.overallProgress ?? 0}%</span>
        </div>
        <div style={{ height: 6, background: 'var(--bg-hover)', borderRadius: 'var(--radius-full)', overflow: 'hidden' }}>
          <div
            style={{
              width: `${pipeline?.overallProgress ?? 0}%`,
              height: '100%',
              background: pipeline?.status === 'failed' ? 'var(--color-error)' : 'var(--color-primary)',
              transition: 'width var(--transition-normal)',
            }}
          />
        </div>
      </div>

      {/* Stage cards */}
      <div style={{ display: 'flex', gap: 'var(--space-sm)', overflowX: 'auto', paddingBottom: 'var(--space-sm)' }}>
        {stages.map((stage, idx) => (
          <React.Fragment key={stage.name}>
            {idx > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', color: 'var(--text-muted)' }}>
                &rarr;
              </div>
            )}
            <StageCard
              stage={stage}
              index={idx}
              isSelected={selectedStage === idx}
              onClick={onStageSelect}
            />
          </React.Fragment>
        ))}
      </div>
    </div>
  );
}

export default PipelineProgress;
