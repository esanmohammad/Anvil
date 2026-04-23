import React from 'react';
import { Wrench, Loader2, Check, X, Ban } from 'lucide-react';
import {
  severityConfig,
  resolutionConfig,
  ConfidenceDot,
  type Resolution,
  type ResolvableFinding,
} from './findingPrimitives.js';

// ── ResolveButton — internal ───────────────────────────────────────────

function ResolveButton({
  label,
  icon: Icon,
  color,
  onClick,
  loading,
}: {
  label: string;
  icon: React.ComponentType<any>;
  color: string;
  onClick: () => void;
  loading: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        height: 22, padding: '0 8px',
        fontSize: 11, fontWeight: 500,
        background: 'transparent',
        border: '1px solid var(--separator)',
        borderRadius: 999,
        color,
        cursor: loading ? 'wait' : 'pointer',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <Icon size={10} strokeWidth={2} aria-hidden="true" />
      {label}
    </button>
  );
}

// ── Props ──────────────────────────────────────────────────────────────

export interface FindingCardProps<F extends ResolvableFinding> {
  finding: F;
  /** Domain-specific pill (e.g. category). Rendered in the meta row after the severity icon. */
  renderCategoryPill?: (f: F) => React.ReactNode;
  /** Domain-specific pill (e.g. persona). Rendered next to the category pill. */
  renderPersonaPill?: (f: F) => React.ReactNode;
  /**
   * Domain-specific location tag — `file:line`, CVE badge, KB ref, etc. The
   * default location rendering (finding.file + :line) is NOT emitted when this
   * is supplied, so callers that want the default plus extras should include
   * file:line themselves.
   */
  renderLocationTag?: (f: F) => React.ReactNode;
  applying: boolean;
  resolving: boolean;
  onApplyFix?: () => void;
  onResolve: (resolution: Exclude<Resolution, 'pending'>) => void;
}

// ── Component ──────────────────────────────────────────────────────────

export function FindingCard<F extends ResolvableFinding>({
  finding,
  renderCategoryPill,
  renderPersonaPill,
  renderLocationTag,
  applying,
  resolving,
  onApplyFix,
  onResolve,
}: FindingCardProps<F>) {
  const sevCfg = severityConfig[finding.severity];
  const SevIcon = sevCfg.icon;
  const isResolved = finding.resolution !== 'pending';
  const resCfg = isResolved
    ? resolutionConfig[finding.resolution as Exclude<Resolution, 'pending'>]
    : null;
  const ResIcon = resCfg?.icon;

  return (
    <article
      aria-label={`Finding: ${finding.description.slice(0, 80)}`}
      style={{
        padding: '12px 14px',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        opacity: isResolved && finding.resolution !== 'addressed' ? 0.65 : 1,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <SevIcon
          size={16}
          strokeWidth={1.75}
          style={{ color: sevCfg.color, marginTop: 2, flexShrink: 0 }}
          aria-label={sevCfg.label}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* meta row */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            flexWrap: 'wrap', marginBottom: 6,
          }}>
            {renderCategoryPill?.(finding)}
            {renderPersonaPill?.(finding)}
            <ConfidenceDot confidence={finding.confidence} />
            {renderLocationTag
              ? renderLocationTag(finding)
              : (finding.file && (
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11,
                    color: 'var(--text-secondary)',
                    marginLeft: 2,
                  }}>
                    {finding.file}
                    {finding.line != null && (
                      <span style={{ color: 'var(--text-tertiary)' }}>:{finding.line}</span>
                    )}
                  </span>
                ))}
          </div>

          {/* snippet */}
          {finding.snippet && (
            <pre style={{
              margin: '0 0 8px', padding: '8px 10px',
              background: 'var(--bg-base)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
              lineHeight: 1.5,
              whiteSpace: 'pre',
              overflowX: 'auto',
            }}>
              {finding.snippet}
            </pre>
          )}

          {/* description */}
          <div style={{ fontSize: 13, color: 'var(--text-primary)', lineHeight: 1.55 }}>
            {finding.description}
          </div>

          {/* suggested fix */}
          {finding.suggestedFix && (
            <div style={{
              marginTop: 10,
              padding: '8px 10px',
              background: 'var(--bg-elevated-3)',
              border: '1px dashed var(--separator)',
              borderRadius: 'var(--radius-sm)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
                marginBottom: 4, textTransform: 'uppercase',
              }}>
                <Wrench size={11} strokeWidth={1.75} aria-hidden="true" />
                Suggested fix
              </div>
              <div style={{
                fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5,
                marginBottom: 8,
              }}>
                {finding.suggestedFix.rationale}
              </div>
              {finding.suggestedFix.diff && (
                <details>
                  <summary style={{
                    fontSize: 11, color: 'var(--accent)',
                    cursor: 'pointer', userSelect: 'none',
                    fontFamily: 'var(--font-sans)',
                  }}>
                    Show diff
                  </summary>
                  <pre style={{
                    margin: '6px 0 0', padding: '8px 10px',
                    background: 'var(--bg-base)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 11, fontFamily: 'var(--font-mono)',
                    color: 'var(--text-secondary)',
                    lineHeight: 1.5,
                    whiteSpace: 'pre',
                    overflowX: 'auto',
                    border: '1px solid var(--separator)',
                  }}>
                    {finding.suggestedFix.diff}
                  </pre>
                </details>
              )}
              {!isResolved && onApplyFix && (
                <button
                  onClick={onApplyFix}
                  disabled={applying}
                  aria-busy={applying}
                  style={{
                    marginTop: 8,
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    height: 26, padding: '0 10px',
                    fontSize: 11, fontWeight: 600,
                    background: 'var(--accent)',
                    color: 'var(--text-inverse)',
                    border: 'none', borderRadius: 'var(--radius-sm)',
                    cursor: applying ? 'wait' : 'pointer',
                    opacity: applying ? 0.7 : 1,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  {applying ? (
                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
                  ) : (
                    <Wrench size={11} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {applying ? 'Applying…' : 'Apply fix'}
                </button>
              )}
            </div>
          )}

          {/* resolution footer */}
          <div style={{
            marginTop: 10, paddingTop: 8,
            borderTop: '1px dashed var(--separator)',
            display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11,
          }}>
            {isResolved && resCfg && ResIcon ? (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                height: 22, padding: '0 8px', borderRadius: 999,
                fontSize: 11, fontWeight: 600,
                color: resCfg.color,
                background: 'var(--bg-elevated-3)',
                border: `1px solid ${resCfg.color === 'var(--text-tertiary)' ? 'var(--separator)' : resCfg.color}`,
              }}>
                <ResIcon size={11} strokeWidth={2} aria-hidden="true" />
                {resCfg.label}
              </span>
            ) : (
              <>
                <span style={{ color: 'var(--text-tertiary)' }}>Mark as:</span>
                <ResolveButton
                  label="Addressed"
                  icon={Check}
                  color="var(--color-success, #22c55e)"
                  onClick={() => onResolve('addressed')}
                  loading={resolving}
                />
                <ResolveButton
                  label="Dismiss"
                  icon={X}
                  color="var(--text-secondary)"
                  onClick={() => onResolve('dismissed')}
                  loading={resolving}
                />
                <ResolveButton
                  label="Won't fix"
                  icon={Ban}
                  color="var(--text-secondary)"
                  onClick={() => onResolve('wont-fix')}
                  loading={resolving}
                />
              </>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}
