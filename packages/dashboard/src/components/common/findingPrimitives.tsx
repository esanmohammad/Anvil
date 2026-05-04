import React from 'react';
import { AlertCircle, AlertTriangle, Info, Minus, Check, X, Ban } from 'lucide-react';

// ── Shared types ───────────────────────────────────────────────────────

export type Severity = 'blocker' | 'error' | 'warn' | 'info' | 'nit';
export type Confidence = 'high' | 'med' | 'low';
export type Resolution = 'pending' | 'addressed' | 'dismissed' | 'wont-fix';

/**
 * Minimal shape all resolvable findings must expose. Domain-specific fields
 * (category, persona, kbRef, cve, etc.) are up to callers — they pass render
 * slots into FindingCard/FindingList for those extras.
 */
export interface ResolvableFinding {
  id: string;
  severity: Severity;
  description: string;
  resolution: Resolution;
  confidence: Confidence;
  file?: string;
  line?: number;
  snippet?: string;
  suggestedFix?: { diff?: string; rationale: string } | null;
}

// ── Severity + resolution configs (lifted verbatim from ReviewPage) ────

export const severityConfig: Record<Severity, {
  label: string;
  color: string;
  icon: React.ComponentType<any>;
  weight: number;
}> = {
  blocker: { label: 'Blocker', color: 'var(--color-error, #ef4444)', icon: AlertCircle, weight: 4 },
  error:   { label: 'Error',   color: 'var(--color-error, #ef4444)', icon: AlertCircle, weight: 3 },
  warn:    { label: 'Warn',    color: 'var(--color-warning, #f59e0b)', icon: AlertTriangle, weight: 2 },
  info:    { label: 'Info',    color: 'var(--color-info, #3b82f6)', icon: Info, weight: 1 },
  nit:     { label: 'Nit',     color: 'var(--text-tertiary)', icon: Minus, weight: 0 },
};

export const resolutionConfig: Record<Exclude<Resolution, 'pending'>, {
  label: string;
  color: string;
  icon: React.ComponentType<any>;
}> = {
  addressed: { label: 'Addressed', color: 'var(--color-success, #22c55e)', icon: Check },
  dismissed: { label: 'Dismissed', color: 'var(--text-tertiary)', icon: X },
  'wont-fix': { label: "Won't fix", color: 'var(--text-tertiary)', icon: Ban },
};

// ── Pill ───────────────────────────────────────────────────────────────

export interface PillProps {
  children: React.ReactNode;
  color?: string;
  bg?: string;
  border?: string;
  mono?: boolean;
}

export function Pill({
  children,
  color = 'var(--text-tertiary)',
  bg,
  border,
  mono,
}: PillProps) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      height: 18, padding: '0 7px',
      fontSize: 10, fontWeight: 600,
      color,
      background: bg ?? 'var(--bg-elevated-3)',
      border: border ?? '1px solid transparent',
      borderRadius: 999,
      fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
      textTransform: 'uppercase',
      letterSpacing: 0.3,
      whiteSpace: 'nowrap',
    }}>
      {children}
    </span>
  );
}

// ── Confidence dot ─────────────────────────────────────────────────────

export function ConfidenceDot({ confidence }: { confidence: Confidence }) {
  const base = {
    width: 8, height: 8, borderRadius: 999,
    display: 'inline-block',
    flexShrink: 0,
  } as const;
  const label = `Confidence: ${confidence}`;
  if (confidence === 'high') {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        style={{ ...base, background: 'var(--text-secondary)' }}
      />
    );
  }
  if (confidence === 'med') {
    return (
      <span
        role="img"
        aria-label={label}
        title={label}
        style={{ ...base, background: 'transparent', border: '1.5px solid var(--text-secondary)' }}
      />
    );
  }
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ ...base, background: 'transparent', border: '1.5px dashed var(--text-tertiary)' }}
    />
  );
}
