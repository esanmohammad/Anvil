import React from 'react';
import { Square, RotateCcw, Play } from 'lucide-react';

/**
 * Pipeline control bar — simplified, merged into header pattern.
 */

export interface ControlBarProps {
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'paused';
  currentStage: number;
  totalStages: number;
  totalCost: number;
  onStop?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onRunAgain?: () => void;
}

function getStatusLabel(status: string): string {
  switch (status) {
    case 'running': return 'Building';
    case 'paused': return 'Waiting for input';
    case 'completed': return 'Complete';
    case 'failed': return 'Failed';
    case 'cancelled': return 'Stopped';
    default: return 'Idle';
  }
}

export function ControlBar({
  status,
  currentStage,
  totalStages,
  totalCost,
  onStop,
  onResume,
  onRetry,
  onRunAgain,
}: ControlBarProps) {
  const isRunning = status === 'running';
  const isPaused = status === 'paused';
  const isFailed = status === 'failed';
  const isCancelled = status === 'cancelled';
  const isCompleted = status === 'completed';
  const isIdle = status === 'idle';
  const canResume = isCancelled || isFailed || isCompleted;

  const dotColor = isRunning ? 'var(--color-success)'
    : isPaused ? 'var(--color-warning)'
    : isFailed ? 'var(--color-error)'
    : isCompleted ? 'var(--color-success)'
    : isCancelled ? 'var(--color-warning)'
    : 'var(--text-tertiary)';

  const textColor = dotColor;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      padding: '0 16px',
      height: 40,
      background: 'var(--bg-elevated-1)',
      borderBottom: '1px solid var(--separator)',
      flexShrink: 0,
    }}>
      {/* Status section */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 500, color: textColor }}>
          <span style={{
            width: 7, height: 7, borderRadius: '50%', background: dotColor,
            ...(isRunning || isPaused ? { animation: 'pulse 2s ease-in-out infinite' } : {}),
          }} />
          {getStatusLabel(status)}
        </span>

        {!isIdle && (
          <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
            Step {currentStage + 1} of {totalStages}
          </span>
        )}

        {totalCost > 0 && (
          <span style={{
            fontSize: 12, fontFamily: 'var(--font-mono)',
            color: 'var(--text-tertiary)',
          }}>
            ${totalCost.toFixed(2)}
          </span>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {isRunning && (
          <button
            onClick={onStop}
            className="btn btn-danger btn-sm"
            style={{ gap: 4 }}
          >
            <Square size={12} strokeWidth={2} />
            Stop
          </button>
        )}

        {canResume && (
          <button
            onClick={() => {
              if (isFailed) onRetry?.();
              else if (isCompleted) onRunAgain?.();
              else onResume?.();
            }}
            className="btn btn-sm"
            style={{
              background: 'rgba(52, 211, 153, 0.1)',
              color: 'var(--accent)',
              border: '1px solid rgba(52, 211, 153, 0.2)',
              gap: 4,
            }}
          >
            {isFailed ? <RotateCcw size={12} strokeWidth={2} /> : <Play size={12} strokeWidth={2} />}
            {isFailed ? 'Retry' : isCompleted ? 'Run Again' : 'Resume'}
          </button>
        )}
      </div>
    </div>
  );
}

export default ControlBar;
