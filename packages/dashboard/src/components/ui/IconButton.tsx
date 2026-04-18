import React from 'react';

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: React.ReactNode;
  label: string;
  size?: 'sm' | 'md' | 'lg';
}

const sizeStyles: Record<string, React.CSSProperties> = {
  sm: { width: 28, height: 28, fontSize: 'var(--text-xs)' },
  md: { width: 36, height: 36, fontSize: 'var(--text-sm)' },
  lg: { width: 44, height: 44, fontSize: 'var(--text-base)' },
};

export function IconButton({ icon, label, size = 'md', className = '', ...props }: IconButtonProps) {
  return (
    <button
      className={`btn btn-ghost ${className}`.trim()}
      style={{ ...sizeStyles[size], padding: 0, borderRadius: 'var(--radius-md)' }}
      aria-label={label}
      title={label}
      {...props}
    >
      {icon}
    </button>
  );
}

export default IconButton;
