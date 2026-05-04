import React, { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, FileCode, PlayCircle } from 'lucide-react';
import type {
  ContractChange,
  ContractChangeSeverity,
  ImpactReport,
  ImpactReportChangeGroup,
} from './contract-ui-types.js';

export interface ContractDriftPanelProps {
  report: ImpactReport | null;
  loading: boolean;
  onGenerateTests: () => void;
}

// ── Colors & labels ────────────────────────────────────────────────────

function severityColor(severity: ContractChangeSeverity): string {
  switch (severity) {
    case 'breaking':
      return 'var(--color-error)';
    case 'needs-review':
      return 'var(--color-warning)';
    case 'non-breaking':
      return 'var(--color-success)';
    default:
      return 'var(--text-tertiary)';
  }
}

function severityLabel(severity: ContractChangeSeverity): string {
  switch (severity) {
    case 'breaking':
      return 'Breaking';
    case 'needs-review':
      return 'Needs review';
    case 'non-breaking':
      return 'Safe';
    default:
      return severity;
  }
}

function changeKindLabel(kind: string): string {
  return kind.replace(/-/g, ' ');
}

// ── Shared styles ──────────────────────────────────────────────────────

const panelStyle: React.CSSProperties = {
  background: 'var(--bg-elevated-2)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-md)',
  fontFamily: 'var(--font-sans)',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  position: 'relative',
};

const bodyStyle: React.CSSProperties = {
  padding: 'var(--space-lg)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-lg)',
  overflowY: 'auto',
  flex: 1,
  minHeight: 0,
  paddingBottom: 72,
};

const summaryGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 'var(--space-md)',
};

const summaryCardStyle: React.CSSProperties = {
  background: 'var(--bg-elevated-1)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  padding: 'var(--space-md)',
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
};

const summaryLabelStyle: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  fontWeight: 600,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  color: 'var(--text-tertiary)',
  fontWeight: 600,
};

const footerStyle: React.CSSProperties = {
  position: 'sticky',
  bottom: 0,
  left: 0,
  right: 0,
  padding: 'var(--space-md) var(--space-lg)',
  borderTop: '1px solid var(--separator)',
  background: 'var(--bg-elevated-2)',
  display: 'flex',
  justifyContent: 'flex-end',
};

// ── Sub-components ─────────────────────────────────────────────────────

function SummaryCard(props: {
  label: string;
  value: string;
  valueColor?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div style={summaryCardStyle}>
      <div
        style={{
          ...summaryLabelStyle,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {props.icon}
        <span>{props.label}</span>
      </div>
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
          color: props.valueColor ?? 'var(--text-primary)',
        }}
      >
        {props.value}
      </div>
    </div>
  );
}

function SeverityBadge({ severity }: { severity: ContractChangeSeverity }) {
  const color = severityColor(severity);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 8px',
        borderRadius: 'var(--radius-full)',
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color,
        border: `1px solid ${color}`,
      }}
    >
      {severityLabel(severity)}
    </span>
  );
}

function KindPill({ kind }: { kind: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        background: 'var(--bg-base)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-sm)',
        padding: '1px 6px',
      }}
    >
      {changeKindLabel(kind)}
    </span>
  );
}

function ChangeCard({ group }: { group: ImpactReportChangeGroup }) {
  const { change, calls } = group;
  const [expanded, setExpanded] = useState<boolean>(change.severity === 'breaking');
  const color = severityColor(change.severity);

  return (
    <div
      style={{
        border: '1px solid var(--separator)',
        borderLeft: `3px solid ${color}`,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--bg-elevated-1)',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((prev) => !prev)}
        aria-expanded={expanded}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: 'var(--space-md)',
          border: 'none',
          background: 'transparent',
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          color: 'var(--text-primary)',
        }}
      >
        <AlertTriangle
          size={16}
          strokeWidth={2}
          color={color}
          aria-hidden="true"
          style={{ marginTop: 2, flexShrink: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <SeverityBadge severity={change.severity} />
            <KindPill kind={change.kind} />
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                color: 'var(--text-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
              title={change.path}
            >
              {change.path}
            </span>
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-primary)' }}>
            {change.description}
          </div>
          {(change.before || change.after) && (
            <div
              style={{
                display: 'flex',
                gap: 6,
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-tertiary)',
              }}
            >
              {change.before && <span>before: {change.before}</span>}
              {change.before && change.after && <span>→</span>}
              {change.after && <span>after: {change.after}</span>}
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
            {calls.length === 0
              ? 'No affected call sites detected'
              : `${calls.length} affected call site${calls.length === 1 ? '' : 's'}`}
          </div>
        </div>
      </button>

      {expanded && calls.length > 0 && (
        <ul
          style={{
            listStyle: 'none',
            margin: 0,
            padding: '0 var(--space-md) var(--space-md)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {calls.map((call, idx) => (
            <li
              key={`${call.repoName}:${call.filePath}:${call.lineNumber}:${idx}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                background: 'var(--bg-base)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--separator)',
                fontSize: 12,
              }}
            >
              <FileCode
                size={12}
                strokeWidth={1.75}
                color="var(--text-tertiary)"
                aria-hidden="true"
                style={{ flexShrink: 0 }}
              />
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-secondary)',
                  flexShrink: 0,
                }}
              >
                {call.repoName}
              </span>
              <span style={{ color: 'var(--text-tertiary)' }}>·</span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  minWidth: 0,
                }}
                title={call.filePath}
              >
                {call.filePath}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-tertiary)',
                  flexShrink: 0,
                }}
              >
                :{call.lineNumber}
              </span>
              <code
                style={{
                  flex: 1,
                  minWidth: 0,
                  padding: '2px 6px',
                  background: 'var(--bg-elevated-1)',
                  borderRadius: 'var(--radius-sm)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-primary)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
                title={call.snippet}
              >
                {call.snippet}
              </code>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LoadingSkeleton() {
  const row: React.CSSProperties = {
    height: 64,
    background: 'var(--bg-elevated-1)',
    borderRadius: 'var(--radius-sm)',
    animation: 'pulse var(--duration-slow, 1s) ease-in-out infinite',
    opacity: 0.6,
  };
  return (
    <div style={panelStyle} aria-busy="true" aria-label="Loading contract drift">
      <div style={{ ...bodyStyle, paddingBottom: 'var(--space-lg)' }}>
        <div style={row} />
        <div style={row} />
        <div style={row} />
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={panelStyle}>
      <div
        style={{
          padding: 'var(--space-xl)',
          textAlign: 'center',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-sm)',
          alignItems: 'center',
        }}
      >
        <PlayCircle
          size={28}
          strokeWidth={1.5}
          color="var(--color-success)"
          aria-hidden="true"
        />
        <div style={{ color: 'var(--text-secondary)', fontWeight: 600 }}>
          No drift detected.
        </div>
        <div style={{ color: 'var(--text-tertiary)', fontSize: 13, maxWidth: 360 }}>
          Contract Guard has not found any schema changes between the selected
          refs. Rescan after your next push to re-check.
        </div>
      </div>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────

export function ContractDriftPanel({
  report,
  loading,
  onGenerateTests,
}: ContractDriftPanelProps) {
  const breakingCount = report?.breakingChanges.length ?? 0;
  const reposCount = report?.affectedConsumerRepos.length ?? 0;
  const callSitesCount = report?.totalBreakingCallSites ?? 0;

  const groups = useMemo<ImpactReportChangeGroup[]>(() => {
    if (!report) return [];
    // Sort breaking first, then needs-review, then non-breaking.
    const order: Record<ContractChangeSeverity, number> = {
      breaking: 0,
      'needs-review': 1,
      'non-breaking': 2,
    };
    const orderOf = (c: ContractChange): number => order[c.severity] ?? 3;
    return [...report.affectedCallsByChange].sort(
      (a, b) => orderOf(a.change) - orderOf(b.change),
    );
  }, [report]);

  if (loading) return <LoadingSkeleton />;
  if (!report) return <EmptyState />;
  if (groups.length === 0 && breakingCount === 0) return <EmptyState />;

  const canGenerate = breakingCount > 0;

  return (
    <section style={panelStyle} aria-label="Contract drift impact report">
      <div style={bodyStyle}>
        <div style={summaryGridStyle}>
          <SummaryCard
            label="Breaking changes"
            value={String(breakingCount)}
            valueColor={breakingCount > 0 ? 'var(--color-error)' : 'var(--text-primary)'}
            icon={<AlertTriangle size={12} strokeWidth={2} aria-hidden="true" />}
          />
          <SummaryCard
            label="Affected repos"
            value={String(reposCount)}
            valueColor={reposCount > 0 ? 'var(--color-warning)' : 'var(--text-primary)'}
            icon={<ExternalLink size={12} strokeWidth={2} aria-hidden="true" />}
          />
          <SummaryCard
            label="Call sites"
            value={String(callSitesCount)}
            valueColor={callSitesCount > 0 ? 'var(--color-warning)' : 'var(--text-primary)'}
            icon={<FileCode size={12} strokeWidth={2} aria-hidden="true" />}
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
          <div style={sectionTitleStyle}>Changes</div>
          {groups.map((group, idx) => (
            <ChangeCard
              key={`${group.change.kind}:${group.change.path}:${idx}`}
              group={group}
            />
          ))}
        </div>
      </div>

      <div style={footerStyle}>
        <button
          type="button"
          onClick={onGenerateTests}
          disabled={!canGenerate}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '8px 14px',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--separator)',
            background: canGenerate ? 'var(--accent)' : 'var(--bg-elevated-1)',
            color: canGenerate ? 'var(--bg-base)' : 'var(--text-tertiary)',
            cursor: canGenerate ? 'pointer' : 'not-allowed',
            fontWeight: 600,
            fontSize: 13,
          }}
        >
          <PlayCircle size={14} strokeWidth={2} aria-hidden="true" />
          Generate contract tests
        </button>
      </div>
    </section>
  );
}

export default ContractDriftPanel;
