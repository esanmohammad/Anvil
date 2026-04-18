import React from 'react';
import type { ClarificationOption } from './types.js';

export interface OptionChipsProps {
  options: ClarificationOption[];
  onSelect: (optionId: string) => void;
  disabled?: boolean;
}

export function OptionChips({ options, onSelect, disabled }: OptionChipsProps) {
  return (
    <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap', padding: 'var(--space-sm) 0' }}>
      {options.map((opt) => (
        <button
          key={opt.id}
          className="btn btn-secondary btn-sm"
          onClick={() => onSelect(opt.id)}
          disabled={disabled}
          title={opt.description}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

export default OptionChips;
