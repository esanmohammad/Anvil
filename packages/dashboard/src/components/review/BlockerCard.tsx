/**
 * BlockerCard — Review Phase R10.
 *
 * Progressive-disclosure UI for blocker-severity findings. Shows the title,
 * file/line, a quoted-from-diff snippet, and evidence-check badges. Offers
 * one-click patch apply (when a proposed patch exists) and a dismiss flow
 * with a reason. Immutable blockers require a ≥ 50-char override reason
 * that the caller forwards to the audit log.
 *
 * No third-party deps; inline style objects + CSS vars only.
 */

import React, { useState } from 'react';
import { XCircle } from 'lucide-react';

// ── Types ────────────────────────────────────────────────────────────────

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
  immutable?: boolean;
  evidenceChecks?: EvidenceCheck[];
}

export interface BlockerCardProps {
  finding: unknown;
  onDismiss?: (id: string, reason: string) => void;
  onApplyPatch?: (id: string, patch: string) => void;
}

// ── Styles ───────────────────────────────────────────────────────────────

const styles = {
  card: {
    width: '100%',
    border: '1px solid var(--blocker-border, #f5c2c7)',
    borderLeft: '4px solid var(--blocker-accent, #dc3545)',
    borderRadius: 6,
    background: 'var(--blocker-bg, #fff5f5)',
    padding: 16,
    marginBottom: 12,
    fontFamily: 'var(--anvil-font, system-ui, sans-serif)',
    color: 'var(--text-color, #1f2937)',
  } as React.CSSProperties,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 10,
  } as React.CSSProperties,
  title: { fontWeight: 600, fontSize: 15, flex: 1 } as React.CSSProperties,
  severityPill: {
    fontSize: 11,
    fontWeight: 700,
    textTransform: 'uppercase',
    padding: '2px 8px',
    borderRadius: 999,
    background: 'var(--blocker-accent, #dc3545)',
    color: '#fff',
  } as React.CSSProperties,
  body: { fontSize: 13, marginBottom: 10 } as React.CSSProperties,
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
  footer: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
    paddingTop: 10,
    borderTop: '1px solid var(--blocker-border, #f5c2c7)',
  } as React.CSSProperties,
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
    background: 'var(--btn-primary-bg, #dc3545)',
    color: '#fff',
    borderColor: 'var(--btn-primary-bg, #dc3545)',
  } as React.CSSProperties,
  overrideBanner: {
    marginTop: 10,
    padding: 10,
    background: 'var(--override-bg, #fff7ed)',
    border: '1px solid var(--override-border, #fdba74)',
    borderRadius: 4,
    fontSize: 12,
  } as React.CSSProperties,
  textarea: {
    width: '100%',
    minHeight: 60,
    marginTop: 6,
    padding: 6,
    fontFamily: 'inherit',
    fontSize: 13,
    border: '1px solid var(--btn-border, #d1d5db)',
    borderRadius: 4,
    boxSizing: 'border-box',
  } as React.CSSProperties,
  errorText: { color: 'var(--blocker-accent, #dc3545)', fontSize: 12, marginTop: 4 } as React.CSSProperties,
} as const;

// ── Helpers ──────────────────────────────────────────────────────────────

function asFinding(u: unknown): FindingShape {
  if (u === null || typeof u !== 'object') return { id: 'unknown' };
  return u as FindingShape;
}

// ── Component ────────────────────────────────────────────────────────────

export function BlockerCard(props: BlockerCardProps): React.ReactElement {
  const f = asFinding(props.finding);
  const [showDismiss, setShowDismiss] = useState<boolean>(false);
  const [reason, setReason] = useState<string>('');
  const [error, setError] = useState<string>('');

  const title = f.message ?? f.description ?? 'Blocker finding';
  const filePath = f.filePath ?? f.file ?? 'unknown';
  const lineNumber = f.lineNumber ?? f.line ?? 0;
  const snippet = f.quotedFromDiff ?? f.snippet ?? '';
  const checks: EvidenceCheck[] = Array.isArray(f.evidenceChecks) ? f.evidenceChecks : [];
  const minChars = f.immutable === true ? 50 : 20;

  function handleApply(): void {
    if (!f.proposedPatch || typeof props.onApplyPatch !== 'function') return;
    props.onApplyPatch(f.id, f.proposedPatch);
  }

  function handleSubmitDismiss(): void {
    const trimmed = reason.trim();
    if (trimmed.length < minChars) {
      setError(`Reason must be at least ${minChars} characters (currently ${trimmed.length}).`);
      return;
    }
    setError('');
    if (typeof props.onDismiss === 'function') {
      props.onDismiss(f.id, trimmed);
    }
    setShowDismiss((_s) => false);
    setReason((_r) => '');
  }

  return (
    <div style={styles.card} data-testid="blocker-card" data-finding-id={f.id}>
      <div style={styles.header}>
        <XCircle size={18} color="var(--blocker-accent, #dc3545)" aria-hidden="true" />
        <span style={styles.title}>{title}</span>
        <span style={styles.severityPill}>blocker</span>
      </div>
      <div style={styles.body}>
        <div style={styles.mono}>
          {filePath}:{lineNumber}
        </div>
        {snippet.length > 0 ? <pre style={styles.snippet}>{snippet}</pre> : null}
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
      </div>
      <div style={styles.footer}>
        {typeof f.proposedPatch === 'string' && f.proposedPatch.length > 0 ? (
          <button
            type="button"
            style={{ ...styles.btn, ...styles.btnPrimary }}
            onClick={handleApply}
          >
            Apply fix
          </button>
        ) : null}
        <button
          type="button"
          style={styles.btn}
          onClick={() => setShowDismiss((s) => !s)}
          aria-expanded={showDismiss}
        >
          Dismiss with reason
        </button>
      </div>
      {showDismiss ? (
        <div>
          {f.immutable === true ? (
            <div style={styles.overrideBanner}>
              This blocker is marked immutable. Override requires a ≥ 50 character justification; it
              will be forwarded to the audit log.
            </div>
          ) : null}
          <textarea
            style={styles.textarea}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={`Reason (min ${minChars} chars)…`}
            aria-label="Dismissal reason"
          />
          {error.length > 0 ? <div style={styles.errorText}>{error}</div> : null}
          <div style={{ ...styles.footer, borderTop: 'none', paddingTop: 0 }}>
            <button type="button" style={{ ...styles.btn, ...styles.btnPrimary }} onClick={handleSubmitDismiss}>
              Submit dismissal
            </button>
            <button
              type="button"
              style={styles.btn}
              onClick={() => {
                setShowDismiss((_s) => false);
                setReason((_r) => '');
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
