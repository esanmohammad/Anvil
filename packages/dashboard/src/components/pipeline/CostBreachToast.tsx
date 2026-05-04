// Bottom-right pill that surfaces a pending cost breach and opens the full modal on click.

import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { fmtUsd, tierBgVar } from '../../lib/cost-tier.js';

export interface CostBreachToastProps {
  /** Same shape as CostBreachModalBreach. */
  breach: {
    runId: string;
    project: string;
    currentUsd: number;
    limitUsd: number;
    graceEndsAt: string;
  };
  /** Click handler — opens the full modal. */
  onOpen: () => void;
  /** Optional dismiss — hides the toast but the breach is still pending. */
  onDismiss?: () => void;
}

export function CostBreachToast({
  breach,
  onOpen,
  onDismiss,
}: CostBreachToastProps): React.ReactElement {
  const [hovered, setHovered] = useState<boolean>(false);

  const overage = Math.max(0, breach.currentUsd - breach.limitUsd);
  const runIdPrefix = breach.runId.slice(0, 8);

  const handleDismiss = (e: React.MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    onDismiss?.();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Cost breach for run ${runIdPrefix}, ${fmtUsd(overage)} over limit. Press to decide.`}
      onClick={onOpen}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 1000,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        background: tierBgVar('breach'),
        backgroundColor: 'var(--bg-elevated-2)',
        backgroundImage: `linear-gradient(${tierBgVar('breach')}, ${tierBgVar('breach')})`,
        color: 'var(--text-primary)',
        border: `1px solid ${hovered ? 'var(--accent)' : 'var(--separator)'}`,
        borderRadius: 'var(--radius-md)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        cursor: 'pointer',
        fontSize: 13,
        lineHeight: 1.2,
        fontVariantNumeric: 'tabular-nums',
        userSelect: 'none',
        transition: 'border-color 120ms ease',
      }}
    >
      <AlertTriangle
        size={14}
        strokeWidth={1.75}
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      />
      <span style={{ whiteSpace: 'nowrap' }}>
        <strong style={{ fontWeight: 600 }}>Cost breach</strong>
        <span style={{ opacity: 0.7 }}> · run </span>
        <span style={{ fontFamily: 'var(--font-mono, monospace)' }}>{runIdPrefix}</span>
        <span style={{ opacity: 0.7 }}> · </span>
        <span>{fmtUsd(overage)} over</span>
        <span style={{ opacity: 0.7 }}> · </span>
        <span
          style={{
            color: 'var(--accent)',
            textDecoration: 'underline',
            fontWeight: 500,
          }}
        >
          Decide ↗
        </span>
      </span>
      {onDismiss !== undefined && (
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss cost breach toast"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 18,
            height: 18,
            marginLeft: 4,
            padding: 0,
            background: 'transparent',
            border: 'none',
            borderRadius: 'var(--radius-sm, 4px)',
            color: 'var(--text-primary)',
            opacity: 0.6,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <X size={14} strokeWidth={1.75} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export default CostBreachToast;
