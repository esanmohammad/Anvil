/**
 * NeedsChangesCard — Review Phase R10.
 *
 * Collapsible amber-accented card for "needs-changes" severity findings.
 * Collapsed view shows only a persona badge + short title. Expanding
 * reveals evidence checks, the quoted snippet, an optional patch preview,
 * and resolution buttons (addressed / dismiss / apply-patch).
 *
 * Keyboard: Enter expands, Esc collapses.
 */

import React, { useState } from 'react';
import { AlertTriangle, FileDiff } from 'lucide-react';

interface EvidenceCheck {
  name: string;
  passed: boolean;
  label?: string;
}

interface FindingShape {
  id: string;
  severity?: string;
  message?: string;
  description?: string;
  filePath?: string;
  file?: string;
  lineNumber?: number;
  line?: number;
  snippet?: string;
  quotedFromDiff?: string;
  proposedPatch?: string;
  persona?: string;
  evidenceChecks?: EvidenceCheck[];
}

export interface NeedsChangesCardProps {
  finding: unknown;
  onDismiss?: (id: string, reason: string) => void;
  onApplyPatch?: (id: string, patch: string) => void;
  onResolve?: (id: string, status: 'addressed' | 'dismiss' | 'apply-patch') => void;
}

const styles = {
  card: {
    width: '100%',
    border: '1px solid var(--warn-border, #fde68a)',
    borderLeft: '4px solid var(--warn-accent, #f59e0b)',
    borderRadius: 6,
    background: 'var(--warn-bg, #fffbeb)',
    padding: 12,
    marginBottom: 10,
    fontFamily: 'var(--anvil-font, system-ui, sans-serif)',
    color: 'var(--text-color, #1f2937)',
  } as React.CSSProperties,
  headerBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    background: 'transparent',
    border: 'none',
    padding: 0,
    cursor: 'pointer',
    color: 'inherit',
    font: 'inherit',
    textAlign: 'left',
  } as React.CSSProperties,
  personaBadge: {
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 999,
    background: 'var(--persona-bg, #fef3c7)',
    color: 'var(--persona-fg, #92400e)',
    textTransform: 'capitalize',
  } as React.CSSProperties,
  title: { flex: 1, fontWeight: 500, fontSize: 14 } as React.CSSProperties,
  caret: { fontSize: 12, color: 'var(--muted, #6b7280)' } as React.CSSProperties,
  body: { marginTop: 10, fontSize: 13 } as React.CSSProperties,
  mono: {
    fontFamily: 'var(--mono-font, ui-monospace, monospace)',
    fontSize: 12,
    color: 'var(--muted, #6b7280)',
    marginBottom: 6,
  } as React.CSSProperties,
  snippet: {
    background: 'var(--snippet-bg, #1f2937)',
    color: 'var(--snippet-fg, #e5e7eb)',
    padding: 10,
    borderRadius: 4,
    fontFamily: 'var(--mono-font, ui-monospace, monospace)',
    fontSize: 12,
    overflowX: 'auto',
    margin: '6px 0',
  } as React.CSSProperties,
  patchPreview: {
    background: 'var(--patch-bg, #f3f4f6)',
    color: 'var(--text-color, #1f2937)',
    border: '1px solid var(--btn-border, #d1d5db)',
    padding: 10,
    borderRadius: 4,
    fontFamily: 'var(--mono-font, ui-monospace, monospace)',
    fontSize: 12,
    maxHeight: 200,
    overflow: 'auto',
    margin: '6px 0',
  } as React.CSSProperties,
  badgeRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 } as React.CSSProperties,
  badge: {
    fontSize: 11,
    padding: '2px 8px',
    borderRadius: 999,
    background: 'var(--badge-bg, #e5e7eb)',
    color: 'var(--badge-fg, #1f2937)',
  } as React.CSSProperties,
  badgePass: {
    background: 'var(--badge-pass-bg, #d1fae5)',
    color: 'var(--badge-pass-fg, #065f46)',
  } as React.CSSProperties,
  badgeFail: {
    background: 'var(--badge-fail-bg, #fee2e2)',
    color: 'var(--badge-fail-fg, #7f1d1d)',
  } as React.CSSProperties,
  footer: { display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' } as React.CSSProperties,
  btn: {
    padding: '6px 12px',
    fontSize: 13,
    borderRadius: 4,
    border: '1px solid var(--btn-border, #d1d5db)',
    background: 'var(--btn-bg, #fff)',
    color: 'var(--text-color, #1f2937)',
    cursor: 'pointer',
  } as React.CSSProperties,
  btnPrimary: {
    background: 'var(--warn-accent, #f59e0b)',
    color: '#fff',
    borderColor: 'var(--warn-accent, #f59e0b)',
  } as React.CSSProperties,
} as const;

function asFinding(u: unknown): FindingShape {
  if (u === null || typeof u !== 'object') return { id: 'unknown' };
  return u as FindingShape;
}

export function NeedsChangesCard(props: NeedsChangesCardProps): React.ReactElement {
  const f = asFinding(props.finding);
  const [expanded, setExpanded] = useState<boolean>(false);

  const title = f.message ?? f.description ?? 'Needs changes';
  const filePath = f.filePath ?? f.file ?? 'unknown';
  const lineNumber = f.lineNumber ?? f.line ?? 0;
  const snippet = f.quotedFromDiff ?? f.snippet ?? '';
  const checks: EvidenceCheck[] = Array.isArray(f.evidenceChecks) ? f.evidenceChecks : [];

  function handleKey(e: React.KeyboardEvent<HTMLButtonElement>): void {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setExpanded((prev) => !prev);
    } else if (e.key === 'Escape' && expanded) {
      e.preventDefault();
      setExpanded((_p) => false);
    }
  }

  function handleResolve(kind: 'addressed' | 'dismiss' | 'apply-patch'): void {
    if (kind === 'apply-patch') {
      if (typeof f.proposedPatch === 'string' && typeof props.onApplyPatch === 'function') {
        props.onApplyPatch(f.id, f.proposedPatch);
      }
    } else if (kind === 'dismiss') {
      if (typeof props.onDismiss === 'function') props.onDismiss(f.id, 'dismissed via needs-changes card');
    }
    if (typeof props.onResolve === 'function') props.onResolve(f.id, kind);
  }

  return (
    <div style={styles.card} data-testid="needs-changes-card" data-finding-id={f.id}>
      <button
        type="button"
        style={styles.headerBtn}
        onClick={() => setExpanded((s) => !s)}
        onKeyDown={handleKey}
        aria-expanded={expanded}
      >
        <AlertTriangle size={16} color="var(--warn-accent, #f59e0b)" aria-hidden="true" />
        {typeof f.persona === 'string' && f.persona.length > 0 ? (
          <span style={styles.personaBadge}>{f.persona}</span>
        ) : null}
        <span style={styles.title}>{title}</span>
        <span style={styles.caret} aria-hidden="true">{expanded ? '\u25BC' : '\u25B6'}</span>
      </button>

      {expanded ? (
        <div style={styles.body}>
          <div style={styles.mono}>
            {filePath}:{lineNumber}
          </div>
          {checks.length > 0 ? (
            <div style={styles.badgeRow}>
              {checks.map((c, i) => (
                <span
                  key={`${c.name}-${i}`}
                  style={{ ...styles.badge, ...(c.passed ? styles.badgePass : styles.badgeFail) }}
                >
                  {c.passed ? '\u2713' : '\u2717'} {c.label ?? c.name}
                </span>
              ))}
            </div>
          ) : null}
          {snippet.length > 0 ? <pre style={styles.snippet}>{snippet}</pre> : null}
          {typeof f.proposedPatch === 'string' && f.proposedPatch.length > 0 ? (
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 10 }}>
                <FileDiff size={14} aria-hidden="true" />
                <span style={{ fontSize: 12, fontWeight: 600 }}>Proposed patch</span>
              </div>
              <pre style={styles.patchPreview}>{f.proposedPatch}</pre>
            </div>
          ) : null}
          <div style={styles.footer}>
            <button
              type="button"
              style={{ ...styles.btn, ...styles.btnPrimary }}
              onClick={() => handleResolve('addressed')}
            >
              Mark addressed
            </button>
            {typeof f.proposedPatch === 'string' && f.proposedPatch.length > 0 ? (
              <button
                type="button"
                style={styles.btn}
                onClick={() => handleResolve('apply-patch')}
              >
                Apply patch
              </button>
            ) : null}
            <button type="button" style={styles.btn} onClick={() => handleResolve('dismiss')}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
