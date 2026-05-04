import { CheckCircle2, AlertTriangle, Circle, MinusCircle } from 'lucide-react';

/**
 * Vertical stage list — replaces horizontal stage chips.
 * Renders as a sidebar panel with progress bar + stage dots.
 */

export interface StageChipData {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  cost?: number;
  modelLabel?: string;
  permissionClasses?: ('read' | 'write' | 'exec')[];
}

export interface StageChipsProps {
  stages: StageChipData[];
  currentStage: number;
  onStageSelect?: (index: number) => void;
  selectedStage?: number | null;
}

const stageDisplayNames: Record<string, string> = {
  clarify: 'Understanding',
  requirements: 'Requirements',
  'repo-requirements': 'Architecture',
  specs: 'Specification',
  tasks: 'Task Planning',
  build: 'Implementation',
  validate: 'Validation',
  ship: 'Delivery',
  discover: 'Discovery',
  analyze: 'Analysis',
  plan: 'Planning',
  implement: 'Implementation',
  fix: 'Fix',
  review: 'Review',
};

function getDisplayName(raw: string): string {
  return stageDisplayNames[raw] ?? raw.replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function StageChips({ stages, currentStage: _currentStage, onStageSelect, selectedStage }: StageChipsProps) {
  const completedCount = stages.filter((s) => s.status === 'completed' || s.status === 'skipped').length;
  const progress = stages.length > 0 ? (completedCount / stages.length) * 100 : 0;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 0,
      width: '100%',
    }}>
      {/* Progress bar + step counter */}
      <div style={{ padding: '16px 16px 12px' }}>
        <div style={{
          height: 3,
          background: 'var(--bg-elevated-3)',
          borderRadius: 'var(--radius-full)',
          overflow: 'hidden',
          marginBottom: 8,
        }}>
          <div style={{
            height: '100%',
            width: `${progress}%`,
            background: 'var(--accent)',
            borderRadius: 'var(--radius-full)',
            transition: 'width var(--duration-slow) ease-out',
          }} />
        </div>
        <div style={{
          fontSize: 12,
          color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-sans)',
        }}>
          Step {Math.min(completedCount + 1, stages.length)} of {stages.length}
        </div>
      </div>

      {/* Stage list */}
      <nav style={{ display: 'flex', flexDirection: 'column', gap: 1, padding: '0 8px' }}>
        {stages.map((stage, idx) => {
          const isRunning = stage.status === 'running';
          const isCompleted = stage.status === 'completed';
          const isFailed = stage.status === 'failed';
          const isSkipped = stage.status === 'skipped';
          const isPending = stage.status === 'pending';
          const isSelected = selectedStage === idx;

          return (
            <button
              key={idx}
              onClick={() => !isPending && onStageSelect?.(idx)}
              disabled={isPending}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '6px 8px',
                background: isSelected ? 'var(--accent-subtle)' : 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                cursor: isPending ? 'default' : 'pointer',
                opacity: isPending ? 0.35 : isSkipped ? 0.5 : 1,
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                color: isSelected
                  ? 'var(--accent)'
                  : isRunning
                    ? 'var(--text-primary)'
                    : isCompleted
                      ? 'var(--text-secondary)'
                      : isFailed
                        ? 'var(--color-error)'
                        : isSkipped
                          ? 'var(--text-tertiary)'
                          : 'var(--text-tertiary)',
                fontWeight: isSelected || isRunning ? 500 : 400,
                textAlign: 'left',
                transition: 'all var(--duration-fast) var(--ease-default)',
              }}
            >
              {/* Status indicator */}
              <span style={{ display: 'flex', alignItems: 'center', height: 20, flexShrink: 0 }}>
                {isCompleted && (
                  <CheckCircle2 size={16} strokeWidth={1.75} style={{ color: 'var(--accent)' }} />
                )}
                {isRunning && (
                  <div className="status-dot-spin" style={{ width: 16, height: 16 }} />
                )}
                {isFailed && (
                  <AlertTriangle size={16} strokeWidth={1.75} style={{ color: 'var(--color-error)' }} />
                )}
                {isSkipped && (
                  <MinusCircle size={16} strokeWidth={1.75} style={{ color: 'var(--text-quaternary)' }} />
                )}
                {isPending && (
                  <Circle size={16} strokeWidth={1.75} style={{ color: 'var(--text-quaternary)' }} />
                )}
              </span>

              {/* Stage name (full width) + model/cost row below */}
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    lineHeight: '20px',
                  }}
                >
                  {getDisplayName(stage.name)}
                </span>

                {(stage.modelLabel || (isCompleted && stage.cost != null)) && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                    {stage.modelLabel && (
                      <span
                        title={`Resolved: ${stage.modelLabel}`}
                        style={{
                          fontSize: 10,
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-tertiary)',
                          background: 'var(--bg-elevated-3)',
                          padding: '1px 5px',
                          borderRadius: 'var(--radius-sm)',
                          lineHeight: '14px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          maxWidth: '100%',
                        }}
                      >
                        {stage.modelLabel}
                      </span>
                    )}
                    {isCompleted && stage.cost != null && (
                      // Show cost even when $0.00 — confirms the stage was
                      // tracked (e.g. fully cache-hit Anthropic call) instead
                      // of leaving the user wondering whether it was missed.
                      <span style={{
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                        color: 'var(--text-tertiary)',
                        flexShrink: 0,
                      }}
                      title={stage.cost === 0 ? 'Stage completed at $0.00 (likely full cache hit)' : undefined}
                      >
                        ${stage.cost.toFixed(2)}
                      </span>
                    )}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}

export default StageChips;
