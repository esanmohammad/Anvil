// Per-stage USD spend table with proportional bars and optional collapse.

import React, { useState } from 'react';
import { Activity, ChevronDown, ChevronRight } from 'lucide-react';
import { fmtUsd } from '../../lib/cost-tier.js';

export interface StageSpendPanelProps {
  /** Map of stage name → USD spent in that stage. */
  perStageUsd: Record<string, number>;
  /** Optional total to compute per-stage percentages. If omitted, sums perStageUsd. */
  totalUsd?: number;
  /** Optional collapsible behavior — defaults to expanded. */
  defaultCollapsed?: boolean;
}

const MIN_ROWS = 4;

export function StageSpendPanel({
  perStageUsd,
  totalUsd,
  defaultCollapsed = false,
}: StageSpendPanelProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<boolean>(defaultCollapsed);

  const entries = Object.entries(perStageUsd ?? {});
  const visible = entries
    .filter(([, usd]) => Number.isFinite(usd) && usd > 0)
    .sort((a, b) => b[1] - a[1]);

  const summedTotal = entries.reduce(
    (sum, [, usd]) => (Number.isFinite(usd) ? sum + usd : sum),
    0,
  );
  const total = totalUsd !== undefined && Number.isFinite(totalUsd) ? totalUsd : summedTotal;
  const maxUsd = visible.length > 0 ? visible[0][1] : 0;

  const allZero = visible.length === 0;

  const headerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: '0.06em',
    textTransform: 'uppercase',
    color: 'var(--text-tertiary)',
    marginBottom: collapsed ? 0 : 12,
  };

  const toggleable = defaultCollapsed !== undefined;

  const summary = `Σ ${fmtUsd(total)} across ${visible.length} stage${visible.length === 1 ? '' : 's'}`;

  return (
    <section
      style={{
        padding: 16,
        borderRadius: 'var(--radius-md)',
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
      }}
      aria-label="Spend by stage"
    >
      <header style={headerStyle}>
        <Activity size={14} aria-hidden="true" />
        {toggleable ? (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-controls="stage-spend-panel-body"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              background: 'transparent',
              border: 'none',
              padding: 0,
              margin: 0,
              cursor: 'pointer',
              color: 'inherit',
              font: 'inherit',
              letterSpacing: 'inherit',
              textTransform: 'inherit',
            }}
          >
            <span>SPEND BY STAGE</span>
            {collapsed
              ? <ChevronRight size={12} aria-hidden="true" />
              : <ChevronDown size={12} aria-hidden="true" />}
          </button>
        ) : (
          <span>SPEND BY STAGE</span>
        )}
        {collapsed && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 11,
              fontWeight: 500,
              letterSpacing: 0,
              textTransform: 'none',
              color: 'var(--text-tertiary)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {summary}
          </span>
        )}
      </header>

      {!collapsed && (
        <div id="stage-spend-panel-body">
          {allZero ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--text-tertiary)',
                fontStyle: 'italic',
              }}
            >
              No spend recorded yet
            </div>
          ) : (
            <table
              style={{
                width: '100%',
                fontSize: 12,
                borderCollapse: 'collapse',
              }}
            >
              <thead>
                <tr style={{ textAlign: 'left', color: 'var(--text-tertiary)' }}>
                  <th style={{ padding: '4px 8px', fontWeight: 500 }}>Stage</th>
                  <th style={{ padding: '4px 8px', fontWeight: 500, textAlign: 'right' }}>$USD</th>
                  <th style={{ padding: '4px 8px', fontWeight: 500, textAlign: 'right' }}>% of total</th>
                  <th style={{ padding: '4px 8px', fontWeight: 500, width: '30%' }}></th>
                </tr>
              </thead>
              <tbody>
                {visible.map(([stage, usd]) => {
                  const pct = total > 0 ? (usd / total) * 100 : 0;
                  const barPct = maxUsd > 0 ? (usd / maxUsd) * 100 : 0;
                  return (
                    <tr
                      key={stage}
                      style={{ borderTop: '1px solid var(--separator)' }}
                    >
                      <td
                        style={{
                          padding: '6px 8px',
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        {stage}
                      </td>
                      <td
                        style={{
                          padding: '6px 8px',
                          textAlign: 'right',
                          fontFamily: 'var(--font-mono)',
                          fontVariantNumeric: 'tabular-nums',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {fmtUsd(usd)}
                      </td>
                      <td
                        style={{
                          padding: '6px 8px',
                          textAlign: 'right',
                          fontFamily: 'var(--font-mono)',
                          fontVariantNumeric: 'tabular-nums',
                          color: 'var(--text-tertiary)',
                        }}
                      >
                        {pct.toFixed(1)}%
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <div
                          style={{
                            height: 4,
                            width: '100%',
                            background: 'var(--accent-muted)',
                            borderRadius: 'var(--radius-full)',
                            overflow: 'hidden',
                          }}
                          role="img"
                          aria-label={`${pct.toFixed(0)}% of total`}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${barPct}%`,
                              background: 'var(--accent)',
                              borderRadius: 'var(--radius-full)',
                              transition: 'width var(--duration-slow) ease-out',
                            }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {Array.from({ length: Math.max(0, MIN_ROWS - visible.length) }).map((_, i) => (
                  <tr
                    key={`__pad-${i}`}
                    aria-hidden="true"
                    style={{ borderTop: '1px solid var(--separator)' }}
                  >
                    <td style={{ padding: '6px 8px', color: 'transparent' }}>—</td>
                    <td style={{ padding: '6px 8px' }} />
                    <td style={{ padding: '6px 8px' }} />
                    <td style={{ padding: '6px 8px' }} />
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

export default StageSpendPanel;
