import React from 'react';

export interface TooltipProps {
  content: string;
  children: React.ReactNode;
}

export function Tooltip({ content, children }: TooltipProps) {
  return (
    <span className="tooltip-wrapper">
      {children}
      <span className="tooltip-content" role="tooltip">{content}</span>
    </span>
  );
}

export default Tooltip;
