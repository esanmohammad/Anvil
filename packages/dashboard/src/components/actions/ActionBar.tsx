import React from 'react';
import { Button } from '../ui/Button.js';

export type PipelineAction = 'play' | 'pause' | 'retry' | 'cancel' | 'ship';

export interface ActionBarProps {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'failed';
  onAction: (action: PipelineAction) => void;
  disabled?: boolean;
}

const actionLabels: Record<PipelineAction, string> = {
  play: '\u25B6 Run',
  pause: '\u23F8 Pause',
  retry: '\u21BB Retry',
  cancel: '\u2715 Cancel',
  ship: '\u{1F680} Ship',
};

export function ActionBar({ status, onAction, disabled = false }: ActionBarProps) {
  const canPlay = status === 'idle' || status === 'completed' || status === 'failed';
  const canPause = status === 'running';
  const canRetry = status === 'failed';
  const canCancel = status === 'running' || status === 'paused';
  const canShip = status === 'completed';

  return (
    <div className="action-bar" style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
      {canPlay && (
        <Button variant="primary" size="sm" onClick={() => onAction(status === 'failed' ? 'retry' : 'play')} disabled={disabled}>
          {status === 'failed' ? actionLabels.retry : actionLabels.play}
        </Button>
      )}
      {canPause && (
        <Button variant="secondary" size="sm" onClick={() => onAction('pause')} disabled={disabled}>
          {actionLabels.pause}
        </Button>
      )}
      {canRetry && status === 'failed' && (
        <Button variant="secondary" size="sm" onClick={() => onAction('retry')} disabled={disabled}>
          {actionLabels.retry}
        </Button>
      )}
      {canCancel && (
        <Button variant="danger" size="sm" onClick={() => onAction('cancel')} disabled={disabled}>
          {actionLabels.cancel}
        </Button>
      )}
      {canShip && (
        <Button variant="primary" size="sm" onClick={() => onAction('ship')} disabled={disabled}>
          {actionLabels.ship}
        </Button>
      )}
    </div>
  );
}

export default ActionBar;
