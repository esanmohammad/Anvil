import React from 'react';

export interface InvariantMarkerProps {
  lineNumber: number;
  invariantId: string;
  description: string;
}

export function InvariantMarker({ lineNumber, invariantId, description }: InvariantMarkerProps) {
  return (
    <div
      className="invariant-marker"
      title={`Invariant: ${description}`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        background: 'rgba(255, 176, 32, 0.2)',
        borderRadius: 'var(--radius-sm)',
        fontSize: 'var(--text-xs)',
        color: 'var(--color-warning)',
        cursor: 'help',
      }}
    >
      <span style={{ fontWeight: 600 }}>L{lineNumber}</span>
      <span>{invariantId}</span>
    </div>
  );
}

export default InvariantMarker;
