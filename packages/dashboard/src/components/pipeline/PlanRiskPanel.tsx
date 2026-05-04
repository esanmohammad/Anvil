// Dense risk-assessment panel for a paused pipeline run. Shows the overall
// risk tier, confidence gauge, factor breakdown, and planner-emitted caveats.

import React from 'react';
import { AlertTriangle, ShieldCheck, Gauge } from 'lucide-react';
import type { RiskScore, RiskTier } from './pipeline-ui-types.js';

export interface PlanRiskPanelProps {
  risk: RiskScore;
}

const tierConfig: Record<RiskTier, { label: string; color: string; bg: string; border: string }> = {
  low: {
    label: 'Low risk',
    color: 'var(--color-success)',
    bg: 'rgba(111, 175, 138, 0.10)',
    border: 'var(--color-success)',
  },
  med: {
    label: 'Medium risk',
    color: 'var(--color-warning)',
    bg: 'rgba(212, 162, 74, 0.10)',
    border: 'var(--color-warning)',
  },
  high: {
    label: 'High risk',
    color: 'var(--color-error)',
    bg: 'rgba(201, 115, 115, 0.10)',
    border: 'var(--color-error)',
  },
};

function colorForScore(score: number): string {
  if (score < 0.3) return 'var(--color-success)';
  if (score < 0.65) return 'var(--color-warning)';
  return 'var(--color-error)';
}

function weightLabel(weight: number): { label: string; color: string; bg: string } {
  if (weight < 0.3) return {
    label: 'low',
    color: 'var(--color-success)',
    bg: 'rgba(111, 175, 138, 0.12)',
  };
  if (weight < 0.65) return {
    label: 'med',
    color: 'var(--color-warning)',
    bg: 'rgba(212, 162, 74, 0.12)',
  };
  return {
    label: 'high',
    color: 'var(--color-error)',
    bg: 'rgba(201, 115, 115, 0.12)',
  };
}

function clampPct(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n * 100)));
}

export function PlanRiskPanel({ risk }: PlanRiskPanelProps) {
  const tier = tierConfig[risk.tier];
  const overallPct = clampPct(risk.overall);
  const confidencePct = clampPct(risk.confidence);
  const overallColor = colorForScore(risk.overall);
  const TierIcon = risk.tier === 'low' ? ShieldCheck : AlertTriangle;

  return (
    <section
      aria-label="Plan risk assessment"
      style={{
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        padding: 14,
        marginBottom: 12,
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Top strip */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            padding: '4px 10px',
            background: tier.bg,
            border: `1px solid ${tier.border}`,
            borderRadius: 'var(--radius-full)',
            color: tier.color,
            fontSize: 12, fontWeight: 700,
            textTransform: 'uppercase', letterSpacing: 0.4,
          }}
        >
          <TierIcon size={12} strokeWidth={2} aria-hidden="true" />
          {tier.label}
        </span>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 11, color: 'var(--text-tertiary)',
          }}>
            <span>Overall</span>
            <span style={{
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
            }}>{overallPct}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={overallPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Overall risk score"
            style={{
              height: 6, width: '100%',
              background: 'var(--bg-elevated-3)',
              borderRadius: 'var(--radius-full)',
              overflow: 'hidden',
            }}
          >
            <div style={{
              width: `${overallPct}%`, height: '100%',
              background: overallColor,
              transition: 'width var(--duration-normal) var(--ease-default)',
            }} />
          </div>
        </div>
        <div style={{ minWidth: 110, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            fontSize: 11, color: 'var(--text-tertiary)',
            gap: 6,
          }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Gauge size={11} strokeWidth={1.75} aria-hidden="true" />
              Confidence
            </span>
            <span style={{
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
            }}>{confidencePct}%</span>
          </div>
          <div
            role="progressbar"
            aria-valuenow={confidencePct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Risk assessment confidence"
            style={{
              height: 4, width: '100%',
              background: 'var(--bg-elevated-3)',
              borderRadius: 'var(--radius-full)',
              overflow: 'hidden',
            }}
          >
            <div style={{
              width: `${confidencePct}%`, height: '100%',
              background: 'var(--text-secondary)',
              transition: 'width var(--duration-normal) var(--ease-default)',
            }} />
          </div>
        </div>
      </div>

      {/* Factor grid */}
      {risk.factors.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: 4,
          marginBottom: risk.scopeBoundaryRisks.length > 0 ? 12 : 0,
        }}>
          {risk.factors.map((f) => {
            const wl = weightLabel(f.weight);
            return (
              <div
                key={f.key}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-sm)',
                  background: 'var(--bg-elevated-1)',
                  fontSize: 12,
                }}
              >
                <span
                  style={{
                    minWidth: 44, textAlign: 'center',
                    padding: '2px 8px',
                    background: wl.bg,
                    color: wl.color,
                    borderRadius: 'var(--radius-full)',
                    fontSize: 10, fontWeight: 700,
                    textTransform: 'uppercase', letterSpacing: 0.3,
                    fontFamily: 'var(--font-mono)',
                  }}
                  title={`weight ${clampPct(f.weight)}%`}
                >
                  {wl.label}
                </span>
                <span style={{
                  color: 'var(--text-primary)', fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}>
                  {f.label}
                </span>
                {f.detail && (
                  <span style={{
                    color: 'var(--text-tertiary)', fontSize: 11,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {f.detail}
                  </span>
                )}
                <span style={{
                  marginLeft: 'auto',
                  fontFamily: 'var(--font-mono)', fontSize: 10,
                  color: 'var(--text-tertiary)',
                }}>
                  {clampPct(f.weight)}%
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Scope boundary risks */}
      {risk.scopeBoundaryRisks.length > 0 && (
        <div>
          <div style={{
            fontSize: 10, textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: 'var(--text-tertiary)',
            marginBottom: 4,
          }}>
            Scope boundary caveats
          </div>
          <ul style={{
            listStyle: 'none', padding: 0, margin: 0,
            display: 'flex', flexDirection: 'column', gap: 3,
          }}>
            {risk.scopeBoundaryRisks.map((r, i) => (
              <li
                key={i}
                style={{
                  display: 'flex', alignItems: 'flex-start', gap: 6,
                  fontSize: 12, lineHeight: 1.4,
                  color: 'var(--text-secondary)',
                }}
              >
                <AlertTriangle
                  size={12}
                  strokeWidth={1.75}
                  style={{ color: 'var(--color-warning)', flexShrink: 0, marginTop: 2 }}
                  aria-hidden="true"
                />
                <span>{r}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export default PlanRiskPanel;
