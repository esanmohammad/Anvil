import React from 'react';

/**
 * Shared input primitives for inline plan section editing.
 *
 * Keeps styling consistent across section editors by reusing the same
 * `var(--bg-base)`, `var(--separator)`, `var(--accent)` tokens that the
 * rest of PlanPage uses.
 */

const baseFieldStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-base)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontSize: 12,
  fontFamily: 'var(--font-sans)',
  lineHeight: 1.5,
  outline: 'none',
  boxSizing: 'border-box',
};

export function EditLabel({
  children,
  htmlFor,
}: {
  children: React.ReactNode;
  htmlFor?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      style={{
        display: 'block',
        fontSize: 11,
        color: 'var(--text-tertiary)',
        marginBottom: 4,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
      }}
    >
      {children}
    </label>
  );
}

export function TextInput(
  props: React.InputHTMLAttributes<HTMLInputElement>,
) {
  const { style, ...rest } = props;
  return (
    <input
      type="text"
      {...rest}
      style={{ ...baseFieldStyle, height: 32, ...style }}
    />
  );
}

export function NumberInput(
  props: React.InputHTMLAttributes<HTMLInputElement>,
) {
  const { style, ...rest } = props;
  return (
    <input
      type="number"
      {...rest}
      style={{ ...baseFieldStyle, height: 32, ...style }}
    />
  );
}

export function TextArea(
  props: React.TextareaHTMLAttributes<HTMLTextAreaElement>,
) {
  const { style, ...rest } = props;
  return (
    <textarea
      {...rest}
      style={{ ...baseFieldStyle, resize: 'vertical', fontFamily: 'var(--font-mono)', ...style }}
    />
  );
}

export function SelectInput(
  props: React.SelectHTMLAttributes<HTMLSelectElement>,
) {
  const { style, children, ...rest } = props;
  return (
    <select
      {...rest}
      style={{
        ...baseFieldStyle,
        height: 32,
        appearance: 'none',
        cursor: 'pointer',
        ...style,
      }}
    >
      {children}
    </select>
  );
}

/** Utility: split a multi-line textarea value into a string[] by newline, trimming empties. */
export function linesToList(value: string): string[] {
  return value
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Utility: join a string[] back into multi-line textarea content. */
export function listToLines(value: string[] | undefined): string {
  return (value ?? []).join('\n');
}

/** A small, consistently styled + / × button used for add/remove list entries. */
export function IconButton({
  label,
  onClick,
  variant = 'default',
  disabled,
}: {
  label: string;
  onClick: () => void;
  variant?: 'default' | 'danger';
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={disabled}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 22,
        height: 22,
        padding: 0,
        fontSize: 14,
        lineHeight: 1,
        background: 'transparent',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-sm)',
        color:
          variant === 'danger'
            ? 'var(--color-error, #ef4444)'
            : 'var(--text-secondary)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {variant === 'danger' ? '×' : '+'}
    </button>
  );
}

export function FieldRow({ children }: { children: React.ReactNode }) {
  return <div style={{ marginBottom: 10 }}>{children}</div>;
}

export function EntryCard({
  children,
  onRemove,
}: {
  children: React.ReactNode;
  onRemove?: () => void;
}) {
  return (
    <div
      style={{
        position: 'relative',
        padding: 10,
        background: 'var(--bg-base)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-sm)',
        marginBottom: 8,
      }}
    >
      {onRemove && (
        <div style={{ position: 'absolute', top: 6, right: 6 }}>
          <IconButton label="Remove entry" onClick={onRemove} variant="danger" />
        </div>
      )}
      {children}
    </div>
  );
}
