import React, { useEffect, useRef, useState } from 'react';

/**
 * Modal shown when a run breaches its cost ceiling. The run keeps executing
 * during a countdown (see graceEndsAt). The user can:
 *  - Raise the limit by a delta (quick-buttons or custom input)
 *  - Extend grace by 30s (capped at 2 extensions — reflected via extensionsUsed)
 *  - Reject with confirmation, which stops the run via Phase 9 checkpoint flush
 *
 * Once the countdown reaches 0 the modal shows an "Auto-resolving..." state
 * while the server applies the policy default.
 */

export interface CostBreachModalBreach {
  runId: string;
  project: string;
  currentUsd: number;
  limitUsd: number;
  projectedUsd: number;
  graceEndsAt: string;
  topSpenders: Array<{ stage: string; usd: number }>;
  extensionsUsed: number;
}

export interface CostBreachModalProps {
  breach: CostBreachModalBreach;
  onRaise: (deltaUsd: number) => void;
  onReject: () => void;
  onExtend: (seconds: number) => void;
  onClose: () => void;
}

const MAX_EXTENSIONS = 2;
const QUICK_DELTAS = [1, 5, 10];

function fmtUsd(n: number): string {
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 100) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
}

function secondsRemaining(graceEndsAt: string): number {
  const end = Date.parse(graceEndsAt);
  if (!Number.isFinite(end)) return 0;
  return Math.max(0, Math.round((end - Date.now()) / 1000));
}

export function CostBreachModal({
  breach,
  onRaise,
  onReject,
  onExtend,
  onClose,
}: CostBreachModalProps): React.ReactElement {
  const [secondsLeft, setSecondsLeft] = useState<number>(() => secondsRemaining(breach.graceEndsAt));
  const [custom, setCustom] = useState<string>('');
  const [confirmReject, setConfirmReject] = useState<boolean>(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setSecondsLeft(secondsRemaining(breach.graceEndsAt));
    }, 1000);
    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [breach.graceEndsAt]);

  const overage = Math.max(0, breach.currentUsd - breach.limitUsd);
  const extensionsRemaining = Math.max(0, MAX_EXTENSIONS - breach.extensionsUsed);
  const autoResolving = secondsLeft <= 0;

  const topMax = Math.max(1, ...breach.topSpenders.map((s) => s.usd));

  const handleCustomRaise = (): void => {
    const n = Number.parseFloat(custom);
    if (!Number.isFinite(n) || n <= 0) return;
    onRaise(n);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="cost-breach-title"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        style={{
          background: 'var(--bg-card, #141414)',
          borderRadius: 'var(--radius-lg, 12px)',
          padding: 20,
          width: 'min(560px, 90vw)',
          color: 'var(--text-primary, #eaeaea)',
          boxShadow: '0 8px 30px rgba(0,0,0,0.4)',
          border: '1px solid var(--color-danger, #ef4444)',
        }}
      >
        <header style={{ marginBottom: 12 }}>
          <h2 id="cost-breach-title" style={{ margin: 0, fontSize: 'var(--text-lg, 18px)' }}>
            Cost limit breached — agents still running
          </h2>
          <p style={{ margin: '4px 0 0', fontSize: 'var(--text-xs, 12px)', color: 'var(--text-muted, #888)' }}>
            {breach.project} · {breach.runId}
          </p>
        </header>

        <section
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 8,
            marginBottom: 12,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>Spent</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{fmtUsd(breach.currentUsd)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>Limit</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{fmtUsd(breach.limitUsd)}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: 'var(--text-muted, #888)' }}>Projected</div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{fmtUsd(breach.projectedUsd)}</div>
          </div>
        </section>

        <div
          aria-live="polite"
          style={{
            background: autoResolving ? 'var(--bg-subtle, #1a1a1a)' : 'var(--color-danger-soft, rgba(239,68,68,0.08))',
            border: '1px solid var(--color-danger, #ef4444)',
            borderRadius: 'var(--radius-md, 8px)',
            padding: 10,
            marginBottom: 12,
            textAlign: 'center',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {autoResolving ? (
            <strong>Auto-resolving...</strong>
          ) : (
            <>
              Grace window: <strong>{secondsLeft}s</strong> — overage {fmtUsd(overage)}
            </>
          )}
        </div>

        <section style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginBottom: 4 }}>
            Top spenders
          </div>
          {breach.topSpenders.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-muted, #888)' }}>No spend data.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {breach.topSpenders.map((s) => (
                <div key={s.stage} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ width: 80, textTransform: 'capitalize' }}>{s.stage}</span>
                  <span
                    style={{
                      flex: 1,
                      height: 8,
                      background: 'var(--bg-hover, #2a2a2a)',
                      borderRadius: 'var(--radius-full, 9999px)',
                      overflow: 'hidden',
                    }}
                  >
                    <span
                      style={{
                        display: 'block',
                        height: '100%',
                        width: `${Math.round((s.usd / topMax) * 100)}%`,
                        background: 'var(--color-danger, #ef4444)',
                      }}
                    />
                  </span>
                  <span style={{ width: 60, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtUsd(s.usd)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text-muted, #888)', marginBottom: 6 }}>
            Raise limit
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {QUICK_DELTAS.map((d) => (
              <button
                key={d}
                type="button"
                disabled={autoResolving}
                onClick={() => onRaise(d)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-md, 8px)',
                  border: '1px solid var(--color-success, #22c55e)',
                  background: 'transparent',
                  color: 'var(--color-success, #22c55e)',
                  cursor: autoResolving ? 'not-allowed' : 'pointer',
                  fontWeight: 600,
                }}
              >
                +${d}
              </button>
            ))}
            <input
              type="number"
              min="0"
              step="0.5"
              placeholder="custom"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              disabled={autoResolving}
              style={{
                width: 90,
                padding: '6px 8px',
                borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--border, #333)',
                background: 'var(--bg-subtle, #1a1a1a)',
                color: 'inherit',
              }}
            />
            <button
              type="button"
              onClick={handleCustomRaise}
              disabled={autoResolving || !custom}
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--color-success, #22c55e)',
                background: 'var(--color-success, #22c55e)',
                color: '#0a0a0a',
                cursor: autoResolving || !custom ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              Raise
            </button>
          </div>
        </section>

        <footer
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              disabled={autoResolving || extensionsRemaining === 0}
              onClick={() => onExtend(30)}
              title={extensionsRemaining === 0 ? 'Extension cap reached' : `Extend grace by 30s (${extensionsRemaining} left)`}
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--border, #333)',
                background: 'transparent',
                color: 'inherit',
                cursor: autoResolving || extensionsRemaining === 0 ? 'not-allowed' : 'pointer',
              }}
            >
              Extend +30s ({extensionsRemaining} left)
            </button>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--border, #333)',
                background: 'transparent',
                color: 'inherit',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>
          {confirmReject ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 12 }}>Stop the run?</span>
              <button
                type="button"
                onClick={() => setConfirmReject(false)}
                style={{
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-md, 8px)',
                  border: '1px solid var(--border, #333)',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                }}
              >
                No
              </button>
              <button
                type="button"
                onClick={() => { setConfirmReject(false); onReject(); }}
                style={{
                  padding: '6px 12px',
                  borderRadius: 'var(--radius-md, 8px)',
                  border: '1px solid var(--color-danger, #ef4444)',
                  background: 'var(--color-danger, #ef4444)',
                  color: '#0a0a0a',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Confirm reject
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={autoResolving}
              onClick={() => setConfirmReject(true)}
              style={{
                padding: '6px 12px',
                borderRadius: 'var(--radius-md, 8px)',
                border: '1px solid var(--color-danger, #ef4444)',
                background: 'transparent',
                color: 'var(--color-danger, #ef4444)',
                cursor: autoResolving ? 'not-allowed' : 'pointer',
                fontWeight: 600,
              }}
            >
              Reject
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

export default CostBreachModal;
