import React from 'react';
import { CheckCircle2, X } from 'lucide-react';

export interface ToastProps {
  message: string;
  canUndo: boolean;
  onUndo?: () => void;
  onDismiss: () => void;
}

/**
 * Bottom-right fixed-position toast with optional undo action. Auto-dismiss
 * timing is the caller's responsibility — this is a pure presentational
 * primitive (see `useResolvableFinding` for the 4s timer).
 */
export function Toast({ message, canUndo, onUndo, onDismiss }: ToastProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        background: 'var(--bg-elevated-3)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        color: 'var(--text-primary)',
        fontSize: 13,
        fontFamily: 'var(--font-sans)',
        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
        animation: 'slide-in 200ms var(--ease-default, ease-out)',
      }}
    >
      <CheckCircle2 size={14} style={{ color: 'var(--color-success, #22c55e)' }} aria-hidden="true" />
      <span>{message}</span>
      {canUndo && onUndo && (
        <button
          onClick={() => { onUndo(); onDismiss(); }}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--accent)',
            fontWeight: 600,
            fontSize: 12,
            cursor: 'pointer',
            padding: 0,
            marginLeft: 4,
          }}
        >
          Undo
        </button>
      )}
      <button
        onClick={onDismiss}
        aria-label="Dismiss toast"
        style={{
          background: 'transparent', border: 'none',
          color: 'var(--text-tertiary)', cursor: 'pointer',
          padding: 0, marginLeft: 4,
        }}
      >
        <X size={12} strokeWidth={2} />
      </button>
    </div>
  );
}
