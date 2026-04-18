import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
  label?: string;
}

export function Input({ error, label, className = '', id, ...props }: InputProps) {
  const inputId = id || label?.toLowerCase().replace(/\s+/g, '-');
  const classes = ['input', error ? 'input-error' : '', className].filter(Boolean).join(' ');

  return (
    <div className="input-wrapper">
      {label && (
        <label htmlFor={inputId} style={{ display: 'block', marginBottom: 4, fontSize: 'var(--text-sm)', color: 'var(--text-secondary)' }}>
          {label}
        </label>
      )}
      <input id={inputId} className={classes} aria-invalid={error || undefined} {...props} />
    </div>
  );
}

export default Input;
