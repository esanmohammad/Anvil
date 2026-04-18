import React from 'react';

export interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

export function Spinner({ size = 'md', className = '' }: SpinnerProps) {
  return (
    <span
      className={`spinner spinner-${size} ${className}`.trim()}
      role="status"
      aria-label="Loading"
    />
  );
}

export default Spinner;
