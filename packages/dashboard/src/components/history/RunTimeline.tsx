import React from 'react';
import type { PipelineStage } from '../../../server/types.js';

export interface RunTimelineProps {
  stages: PipelineStage[];
}

const statusColors: Record<PipelineStage['status'], string> = {
  pending: '#666666',
  running: '#0B996E',
  completed: '#00B289',
  failed: '#FF4949',
  skipped: '#444444',
};

export function RunTimeline({ stages }: RunTimelineProps) {
  return (
    <div style={{ display: 'flex', gap: 2, alignItems: 'center', padding: 'var(--space-sm) 0' }}>
      {stages.map((stage, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1 }}>
          <div
            title={`${stage.name}: ${stage.status}`}
            style={{
              flex: 1,
              height: 8,
              borderRadius: 'var(--radius-full)',
              background: statusColors[stage.status],
              opacity: stage.status === 'pending' ? 0.3 : 1,
            }}
          />
        </div>
      ))}
    </div>
  );
}

export default RunTimeline;
