import React, { useState, useCallback } from 'react';
import { CheckCircle2, ChevronDown, ChevronRight } from 'lucide-react';
import { FindingCard } from './FindingCard.js';
import type { Resolution, ResolvableFinding } from './findingPrimitives.js';

// ── Types ──────────────────────────────────────────────────────────────

export interface FindingGroup<F extends ResolvableFinding> {
  key: string;
  label: string;
  color: string;
  findings: F[];
}

export interface FindingListProps<F extends ResolvableFinding> {
  groups: FindingGroup<F>[];
  emptyMessage: string;
  resolvedCount: { addressed: number; dismissed: number; 'wont-fix': number; total: number };
  showResolved: boolean;
  onToggleShowResolved: () => void;
  onApplyFix?: (findingId: string) => void;
  onResolve: (findingId: string, resolution: Exclude<Resolution, 'pending'>) => void;
  applyingFix?: Record<string, boolean>;
  resolvingId: string | null;
  renderCategoryPill?: (f: F) => React.ReactNode;
  renderPersonaPill?: (f: F) => React.ReactNode;
  renderLocationTag?: (f: F) => React.ReactNode;
}

// ── Group section ──────────────────────────────────────────────────────

interface GroupSectionProps<F extends ResolvableFinding> {
  group: FindingGroup<F>;
  collapsed: boolean;
  onToggle: () => void;
  onApplyFix?: (findingId: string) => void;
  onResolve: (findingId: string, resolution: Exclude<Resolution, 'pending'>) => void;
  applyingFix?: Record<string, boolean>;
  resolvingId: string | null;
  renderCategoryPill?: (f: F) => React.ReactNode;
  renderPersonaPill?: (f: F) => React.ReactNode;
  renderLocationTag?: (f: F) => React.ReactNode;
}

function GroupSection<F extends ResolvableFinding>({
  group,
  collapsed,
  onToggle,
  onApplyFix,
  onResolve,
  applyingFix,
  resolvingId,
  renderCategoryPill,
  renderPersonaPill,
  renderLocationTag,
}: GroupSectionProps<F>) {
  const pendingCount = group.findings.filter((f) => f.resolution === 'pending').length;
  return (
    <section
      aria-label={`${group.label} findings`}
      style={{ marginBottom: 12 }}
    >
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        aria-controls={`group-${group.key}-body`}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          width: '100%', padding: '8px 12px',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-primary)',
          fontSize: 13, fontWeight: 600,
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
          textAlign: 'left',
        }}
      >
        {collapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
        <span style={{
          display: 'inline-block', width: 8, height: 8, borderRadius: 999,
          background: group.color, flexShrink: 0,
        }} />
        {group.label}
        <span style={{
          fontSize: 11, fontWeight: 500,
          color: 'var(--text-tertiary)',
          marginLeft: 4,
        }}>
          {group.findings.length}
        </span>
        {pendingCount > 0 && pendingCount !== group.findings.length && (
          <span style={{
            fontSize: 10, fontWeight: 600,
            padding: '1px 6px', borderRadius: 999,
            background: 'var(--bg-elevated-3)',
            color: 'var(--text-tertiary)',
            marginLeft: 4,
          }}>
            {pendingCount} pending
          </span>
        )}
      </button>

      {!collapsed && (
        <div
          id={`group-${group.key}-body`}
          style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}
        >
          {group.findings.map((f) => (
            <FindingCard<F>
              key={f.id}
              finding={f}
              onApplyFix={onApplyFix ? () => onApplyFix(f.id) : undefined}
              onResolve={(r: Exclude<Resolution, 'pending'>) => onResolve(f.id, r)}
              applying={!!applyingFix?.[f.id]}
              resolving={resolvingId === f.id}
              renderCategoryPill={renderCategoryPill}
              renderPersonaPill={renderPersonaPill}
              renderLocationTag={renderLocationTag}
            />
          ))}
        </div>
      )}
    </section>
  );
}

// ── FindingList ────────────────────────────────────────────────────────

export function FindingList<F extends ResolvableFinding>({
  groups,
  emptyMessage,
  resolvedCount,
  showResolved,
  onToggleShowResolved,
  onApplyFix,
  onResolve,
  applyingFix,
  resolvingId,
  renderCategoryPill,
  renderPersonaPill,
  renderLocationTag,
}: FindingListProps<F>) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  return (
    <>
      {groups.length === 0 ? (
        <div style={{
          padding: 24, textAlign: 'center',
          fontSize: 13, color: 'var(--color-success, #22c55e)',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
        }}>
          <CheckCircle2 size={20} style={{ verticalAlign: 'middle', marginRight: 8 }} aria-hidden="true" />
          {emptyMessage}
        </div>
      ) : (
        groups.map((g) => (
          <GroupSection<F>
            key={g.key}
            group={g}
            collapsed={!!collapsed[g.key]}
            onToggle={() => toggle(g.key)}
            onApplyFix={onApplyFix}
            onResolve={onResolve}
            applyingFix={applyingFix}
            resolvingId={resolvingId}
            renderCategoryPill={renderCategoryPill}
            renderPersonaPill={renderPersonaPill}
            renderLocationTag={renderLocationTag}
          />
        ))
      )}

      {resolvedCount.total > 0 && (
        <button
          onClick={onToggleShowResolved}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            width: '100%', marginTop: 8,
            padding: '10px 14px',
            background: 'transparent',
            border: '1px dashed var(--separator)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-tertiary)',
            fontSize: 12,
            fontFamily: 'var(--font-sans)',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {showResolved ? '— Hide resolved' : '+ Show resolved'}
          <span style={{ color: 'var(--text-secondary)' }}>
            {resolvedCount.addressed > 0 && ` ${resolvedCount.addressed} addressed`}
            {resolvedCount.dismissed > 0 && ` · ${resolvedCount.dismissed} dismissed`}
            {resolvedCount['wont-fix'] > 0 && ` · ${resolvedCount['wont-fix']} won't fix`}
          </span>
        </button>
      )}
    </>
  );
}
