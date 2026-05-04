// Override / verify modal for the Regression Guard bound-tests registry.
//
// Two tabs:
//   * Override — requires a ≥20 char reason; confirms, then calls onOverride.
//   * Verify   — re-runs the bound test; surfaces pass/fail + raw output.
//
// Backdrop click and ESC close the modal. All inline styles; CSS variables
// track the dashboard's design tokens.

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  RefreshCw,
  Shield,
  X,
} from 'lucide-react';
import type { BoundRecord, VerifyResult } from './bound-tests-types.js';

export interface OverrideModalProps {
  record: BoundRecord;
  /** Optional verify result for the current record — re-renders when set. */
  verifyResult?: VerifyResult | null;
  /** True while a verify call is in flight. */
  verifying?: boolean;
  onClose: () => void;
  onOverride: (reason: string) => void;
  onVerify: () => void;
}

const MIN_REASON_CHARS = 20;

type TabKey = 'override' | 'verify';

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}

export function OverrideModal({
  record,
  verifyResult,
  verifying,
  onClose,
  onOverride,
  onVerify,
}: OverrideModalProps): React.ReactElement {
  const [tab, setTab] = useState<TabKey>('override');
  const [reason, setReason] = useState<string>('');
  const [confirming, setConfirming] = useState<boolean>(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (tab === 'override') {
      textareaRef.current?.focus();
    }
  }, [tab]);

  const trimmedLen = reason.trim().length;
  const canSubmit = trimmedLen >= MIN_REASON_CHARS;
  const charsLeft = Math.max(0, MIN_REASON_CHARS - trimmedLen);

  const handleConfirmOverride = (): void => {
    if (!canSubmit) return;
    if (!confirming) {
      setConfirming(true);
      return;
    }
    onOverride(reason.trim());
  };

  return (
    <div
      style={backdropStyle}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div style={cardStyle} role="dialog" aria-modal="true">
        <header style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Shield size={18} color="var(--color-warning)" />
            <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
              Bound test
            </span>
            <StatusPill severity={record.severity ?? 'warning'} />
          </div>
          <button
            type="button"
            onClick={onClose}
            style={iconButtonStyle}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>

        <section style={metaSectionStyle}>
          <MetaRow label="File" value={record.filePath} mono />
          <MetaRow label="Incident" value={record.incidentId} mono />
          <MetaRow label="Replay" value={record.replayId} mono />
          <MetaRow label="Bound" value={relativeTime(record.addedAt)} />
          {record.lastVerifiedAt ? (
            <MetaRow
              label="Last verified"
              value={relativeTime(record.lastVerifiedAt)}
            />
          ) : null}
        </section>

        <nav style={tabsStyle}>
          <TabButton
            active={tab === 'override'}
            onClick={() => setTab('override')}
            label="Override"
          />
          <TabButton
            active={tab === 'verify'}
            onClick={() => setTab('verify')}
            label="Verify"
          />
        </nav>

        {tab === 'override' ? (
          <section style={bodyStyle}>
            <p style={warnTextStyle}>
              <AlertTriangle
                size={14}
                color="var(--color-warning)"
                style={{ marginRight: 6, verticalAlign: 'middle' }}
              />
              Overriding removes this binding. A reason of at least{' '}
              {MIN_REASON_CHARS} characters is required and will be recorded
              in the audit log.
            </p>
            <textarea
              ref={textareaRef}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                if (confirming) setConfirming(false);
              }}
              placeholder="Why is this binding no longer needed?"
              rows={5}
              style={textareaStyle}
            />
            <div style={reasonFooterStyle}>
              <span
                style={{
                  color: canSubmit
                    ? 'var(--color-success)'
                    : 'var(--text-tertiary)',
                  fontSize: 12,
                }}
              >
                {canSubmit
                  ? `${trimmedLen} chars — ready`
                  : `${charsLeft} more char${charsLeft === 1 ? '' : 's'} needed`}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  type="button"
                  onClick={onClose}
                  style={secondaryButtonStyle}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleConfirmOverride}
                  disabled={!canSubmit}
                  style={{
                    ...primaryButtonStyle,
                    background: confirming
                      ? 'var(--color-error)'
                      : 'var(--color-warning)',
                    opacity: canSubmit ? 1 : 0.4,
                    cursor: canSubmit ? 'pointer' : 'not-allowed',
                  }}
                >
                  {confirming ? 'Confirm override' : 'Override'}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section style={bodyStyle}>
            <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: 0 }}>
              Re-runs the bound test in its current form. Verification outcomes
              are recorded to the audit log.
            </p>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={onVerify}
                disabled={verifying}
                style={primaryButtonStyle}
              >
                <RefreshCw
                  size={14}
                  style={{
                    marginRight: 6,
                    verticalAlign: 'middle',
                    animation: verifying ? 'spin 1s linear infinite' : undefined,
                  }}
                />
                {verifying ? 'Verifying…' : 'Run verify'}
              </button>
              {verifyResult ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    color: verifyResult.passed
                      ? 'var(--color-success)'
                      : 'var(--color-error)',
                    fontSize: 13,
                    fontWeight: 600,
                  }}
                >
                  {verifyResult.passed ? <Check size={14} /> : <X size={14} />}
                  {verifyResult.passed ? 'Passed' : 'Failed'}
                  <span style={{ color: 'var(--text-tertiary)', fontWeight: 400 }}>
                    · {relativeTime(verifyResult.at)}
                  </span>
                </span>
              ) : null}
            </div>
            {verifyResult ? (
              <pre style={outputStyle}>{verifyResult.output || '(no output)'}</pre>
            ) : (
              <div style={placeholderStyle}>
                No verify run yet. Kick one off above.
              </div>
            )}
          </section>
        )}
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ── Small subcomponents ─────────────────────────────────────────────────

function StatusPill({
  severity,
}: {
  severity: 'info' | 'warning' | 'block';
}): React.ReactElement {
  const color =
    severity === 'block'
      ? 'var(--color-error)'
      : severity === 'warning'
        ? 'var(--color-warning)'
        : 'var(--color-success)';
  return (
    <span
      style={{
        fontSize: 11,
        padding: '2px 8px',
        borderRadius: 'var(--radius-full)',
        background: 'var(--bg-elevated-2)',
        color,
        textTransform: 'uppercase',
        letterSpacing: 0.4,
        fontWeight: 600,
      }}
    >
      {severity}
    </span>
  );
}

function TabButton({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '8px 12px',
        background: 'transparent',
        border: 'none',
        borderBottom: active
          ? '2px solid var(--text-primary)'
          : '2px solid transparent',
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        fontFamily: 'var(--font-sans)',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );
}

function MetaRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div style={{ display: 'flex', gap: 12, fontSize: 13 }}>
      <span style={{ color: 'var(--text-tertiary)', minWidth: 96 }}>{label}</span>
      <span
        style={{
          color: 'var(--text-primary)',
          fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </span>
    </div>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0, 0, 0, 0.55)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
  padding: 20,
};

const cardStyle: React.CSSProperties = {
  width: 'min(560px, 100%)',
  maxHeight: '90vh',
  overflow: 'auto',
  background: 'var(--bg-elevated-1)',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--separator)',
  display: 'flex',
  flexDirection: 'column',
  fontFamily: 'var(--font-sans)',
};

const headerStyle: React.CSSProperties = {
  padding: '12px 16px',
  borderBottom: '1px solid var(--separator)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const iconButtonStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'var(--text-secondary)',
  cursor: 'pointer',
  padding: 4,
  display: 'flex',
  borderRadius: 'var(--radius-xs)',
};

const metaSectionStyle: React.CSSProperties = {
  padding: '12px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  background: 'var(--bg-base)',
};

const tabsStyle: React.CSSProperties = {
  display: 'flex',
  gap: 4,
  padding: '0 12px',
  borderBottom: '1px solid var(--separator)',
};

const bodyStyle: React.CSSProperties = {
  padding: 16,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const warnTextStyle: React.CSSProperties = {
  margin: 0,
  color: 'var(--text-secondary)',
  fontSize: 13,
  lineHeight: 1.5,
};

const textareaStyle: React.CSSProperties = {
  width: '100%',
  padding: 10,
  background: 'var(--bg-base)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  resize: 'vertical',
  minHeight: 90,
};

const reasonFooterStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--color-warning)',
  color: 'var(--bg-base)',
  border: 'none',
  borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryButtonStyle: React.CSSProperties = {
  padding: '6px 14px',
  background: 'var(--bg-elevated-2)',
  color: 'var(--text-primary)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  fontFamily: 'var(--font-sans)',
  fontSize: 13,
  cursor: 'pointer',
};

const outputStyle: React.CSSProperties = {
  background: 'var(--bg-base)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  padding: 10,
  maxHeight: 220,
  overflow: 'auto',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  color: 'var(--text-primary)',
  whiteSpace: 'pre-wrap',
  margin: 0,
};

const placeholderStyle: React.CSSProperties = {
  padding: 16,
  borderRadius: 'var(--radius-sm)',
  background: 'var(--bg-base)',
  color: 'var(--text-tertiary)',
  fontSize: 12,
  textAlign: 'center',
};
