import React from 'react';
import {
  EditLabel,
  TextInput,
  NumberInput,
  TextArea,
  SelectInput,
  IconButton,
  FieldRow,
  EntryCard,
  linesToList,
  listToLines,
} from './inputs.js';

/**
 * Per-section edit forms.
 *
 * Each editor is a controlled component — it owns no state, only calls
 * `onChange(nextValue)` when its inputs change. The parent (PlanPage) holds
 * the draft value and the Save/Cancel buttons.
 *
 * Types mirror the `Plan` interface in PlanPage.tsx.
 */

// ── Problem ─────────────────────────────────────────────────────────────

export function ProblemEditor({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <TextArea
      rows={4}
      value={value}
      onChange={(e: any) => onChange(e.target.value)}
      placeholder="Describe the problem…"
      aria-label="Problem"
    />
  );
}

// ── Scope ───────────────────────────────────────────────────────────────

export interface ScopeDraft {
  inScope: string[];
  outOfScope: string[];
}

export function ScopeEditor({
  value,
  onChange,
}: {
  value: ScopeDraft;
  onChange: (v: ScopeDraft) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div>
        <EditLabel>In scope (one per line)</EditLabel>
        <TextArea
          rows={5}
          value={listToLines(value.inScope)}
          onChange={(e: any) =>
            onChange({ ...value, inScope: linesToList(e.target.value) })
          }
          aria-label="In scope"
        />
      </div>
      <div>
        <EditLabel>Out of scope (one per line)</EditLabel>
        <TextArea
          rows={5}
          value={listToLines(value.outOfScope)}
          onChange={(e: any) =>
            onChange({ ...value, outOfScope: linesToList(e.target.value) })
          }
          aria-label="Out of scope"
        />
      </div>
    </div>
  );
}

// ── Repos ───────────────────────────────────────────────────────────────

export interface RepoDraft {
  name: string;
  changes: string;
  files: string[];
  symbols: string[];
}

export function ReposEditor({
  value,
  onChange,
}: {
  value: RepoDraft[];
  onChange: (v: RepoDraft[]) => void;
}) {
  const updateAt = (idx: number, patch: Partial<RepoDraft>) => {
    const next = value.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onChange(next);
  };
  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };
  const add = () => {
    onChange([
      ...value,
      { name: 'new-repo', changes: '', files: [], symbols: [] },
    ]);
  };

  return (
    <div>
      {value.map((repo, idx) => (
        <EntryCard key={idx} onRemove={() => removeAt(idx)}>
          <FieldRow>
            <EditLabel>Name</EditLabel>
            <TextInput
              value={repo.name}
              readOnly
              aria-label={`Repo ${idx + 1} name`}
              style={{ background: 'var(--bg-elevated-2)', color: 'var(--text-tertiary)' }}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Changes</EditLabel>
            <TextArea
              rows={3}
              value={repo.changes}
              onChange={(e: any) => updateAt(idx, { changes: e.target.value })}
              aria-label={`Repo ${idx + 1} changes`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Files (one per line)</EditLabel>
            <TextArea
              rows={3}
              value={listToLines(repo.files)}
              onChange={(e: any) =>
                updateAt(idx, { files: linesToList(e.target.value) })
              }
              aria-label={`Repo ${idx + 1} files`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Symbols (one per line)</EditLabel>
            <TextArea
              rows={3}
              value={listToLines(repo.symbols)}
              onChange={(e: any) =>
                updateAt(idx, { symbols: linesToList(e.target.value) })
              }
              aria-label={`Repo ${idx + 1} symbols`}
            />
          </FieldRow>
        </EntryCard>
      ))}
      <IconButton label="Add repo entry" onClick={add} />
    </div>
  );
}

// ── Contracts ───────────────────────────────────────────────────────────

const CONTRACT_KINDS = ['http', 'grpc', 'kafka', 'db', 'other'] as const;

export interface ContractDraft {
  kind: string;
  name: string;
  producer: string;
  consumers: string[];
  description: string;
}

export function ContractsEditor({
  value,
  onChange,
}: {
  value: ContractDraft[];
  onChange: (v: ContractDraft[]) => void;
}) {
  const updateAt = (idx: number, patch: Partial<ContractDraft>) => {
    onChange(value.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };
  const add = () => {
    onChange([
      ...value,
      { kind: 'http', name: '', producer: '', consumers: [], description: '' },
    ]);
  };

  return (
    <div>
      {value.map((c, idx) => (
        <EntryCard key={idx} onRemove={() => removeAt(idx)}>
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, marginBottom: 10 }}>
            <div>
              <EditLabel>Kind</EditLabel>
              <SelectInput
                value={c.kind}
                onChange={(e: any) => updateAt(idx, { kind: e.target.value })}
                aria-label={`Contract ${idx + 1} kind`}
              >
                {CONTRACT_KINDS.map((k) => (
                  <option key={k} value={k}>{k}</option>
                ))}
              </SelectInput>
            </div>
            <div>
              <EditLabel>Name</EditLabel>
              <TextInput
                value={c.name}
                onChange={(e: any) => updateAt(idx, { name: e.target.value })}
                aria-label={`Contract ${idx + 1} name`}
              />
            </div>
          </div>
          <FieldRow>
            <EditLabel>Producer</EditLabel>
            <TextInput
              value={c.producer}
              onChange={(e: any) => updateAt(idx, { producer: e.target.value })}
              aria-label={`Contract ${idx + 1} producer`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Consumers (one per line)</EditLabel>
            <TextArea
              rows={2}
              value={listToLines(c.consumers)}
              onChange={(e: any) =>
                updateAt(idx, { consumers: linesToList(e.target.value) })
              }
              aria-label={`Contract ${idx + 1} consumers`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Description</EditLabel>
            <TextArea
              rows={2}
              value={c.description}
              onChange={(e: any) => updateAt(idx, { description: e.target.value })}
              aria-label={`Contract ${idx + 1} description`}
            />
          </FieldRow>
        </EntryCard>
      ))}
      <IconButton label="Add contract entry" onClick={add} />
    </div>
  );
}

// ── Architecture ────────────────────────────────────────────────────────

export interface ArchitectureDraft {
  notes: string;
  mermaid: string;
}

export function ArchitectureEditor({
  value,
  onChange,
}: {
  value: ArchitectureDraft;
  onChange: (v: ArchitectureDraft) => void;
}) {
  return (
    <div>
      <FieldRow>
        <EditLabel>Notes</EditLabel>
        <TextArea
          rows={3}
          value={value.notes}
          onChange={(e: any) => onChange({ ...value, notes: e.target.value })}
          aria-label="Architecture notes"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Mermaid diagram</EditLabel>
        <TextArea
          rows={6}
          value={value.mermaid}
          onChange={(e: any) => onChange({ ...value, mermaid: e.target.value })}
          aria-label="Architecture mermaid"
          spellCheck={false}
        />
      </FieldRow>
    </div>
  );
}

// ── Risks ───────────────────────────────────────────────────────────────

const RISK_SEVERITIES = ['low', 'med', 'high'] as const;

export interface RiskDraft {
  title: string;
  severity: 'low' | 'med' | 'high';
  mitigation: string;
}

export function RisksEditor({
  value,
  onChange,
}: {
  value: RiskDraft[];
  onChange: (v: RiskDraft[]) => void;
}) {
  const updateAt = (idx: number, patch: Partial<RiskDraft>) => {
    onChange(value.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const removeAt = (idx: number) => {
    onChange(value.filter((_, i) => i !== idx));
  };
  const add = () => {
    onChange([...value, { title: '', severity: 'low', mitigation: '' }]);
  };

  return (
    <div>
      {value.map((r, idx) => (
        <EntryCard key={idx} onRemove={() => removeAt(idx)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px', gap: 8, marginBottom: 10 }}>
            <div>
              <EditLabel>Title</EditLabel>
              <TextInput
                value={r.title}
                onChange={(e: any) => updateAt(idx, { title: e.target.value })}
                aria-label={`Risk ${idx + 1} title`}
              />
            </div>
            <div>
              <EditLabel>Severity</EditLabel>
              <SelectInput
                value={r.severity}
                onChange={(e: any) =>
                  updateAt(idx, { severity: e.target.value as RiskDraft['severity'] })
                }
                aria-label={`Risk ${idx + 1} severity`}
              >
                {RISK_SEVERITIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </SelectInput>
            </div>
          </div>
          <FieldRow>
            <EditLabel>Mitigation</EditLabel>
            <TextArea
              rows={2}
              value={r.mitigation}
              onChange={(e: any) => updateAt(idx, { mitigation: e.target.value })}
              aria-label={`Risk ${idx + 1} mitigation`}
            />
          </FieldRow>
        </EntryCard>
      ))}
      <IconButton label="Add risk entry" onClick={add} />
    </div>
  );
}

// ── Rollout ─────────────────────────────────────────────────────────────

export interface RolloutDraft {
  strategy: string;
  flags: string[];
  order: string[];
  rollback: string;
}

export function RolloutEditor({
  value,
  onChange,
}: {
  value: RolloutDraft;
  onChange: (v: RolloutDraft) => void;
}) {
  return (
    <div>
      <FieldRow>
        <EditLabel>Strategy</EditLabel>
        <TextArea
          rows={3}
          value={value.strategy}
          onChange={(e: any) => onChange({ ...value, strategy: e.target.value })}
          aria-label="Rollout strategy"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Flags (one per line)</EditLabel>
        <TextArea
          rows={3}
          value={listToLines(value.flags)}
          onChange={(e: any) =>
            onChange({ ...value, flags: linesToList(e.target.value) })
          }
          aria-label="Rollout flags"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Order (one per line)</EditLabel>
        <TextArea
          rows={3}
          value={listToLines(value.order)}
          onChange={(e: any) =>
            onChange({ ...value, order: linesToList(e.target.value) })
          }
          aria-label="Rollout order"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Rollback</EditLabel>
        <TextArea
          rows={2}
          value={value.rollback}
          onChange={(e: any) => onChange({ ...value, rollback: e.target.value })}
          aria-label="Rollout rollback"
        />
      </FieldRow>
    </div>
  );
}

// ── Tests ───────────────────────────────────────────────────────────────

export interface TestsDraft {
  unit: string[];
  integration: string[];
  manual: string[];
}

export function TestsEditor({
  value,
  onChange,
}: {
  value: TestsDraft;
  onChange: (v: TestsDraft) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      <div>
        <EditLabel>Unit (one per line)</EditLabel>
        <TextArea
          rows={5}
          value={listToLines(value.unit)}
          onChange={(e: any) =>
            onChange({ ...value, unit: linesToList(e.target.value) })
          }
          aria-label="Unit tests"
        />
      </div>
      <div>
        <EditLabel>Integration (one per line)</EditLabel>
        <TextArea
          rows={5}
          value={listToLines(value.integration)}
          onChange={(e: any) =>
            onChange({ ...value, integration: linesToList(e.target.value) })
          }
          aria-label="Integration tests"
        />
      </div>
      <div>
        <EditLabel>Manual (one per line)</EditLabel>
        <TextArea
          rows={5}
          value={listToLines(value.manual)}
          onChange={(e: any) =>
            onChange({ ...value, manual: linesToList(e.target.value) })
          }
          aria-label="Manual tests"
        />
      </div>
    </div>
  );
}

// ── Estimate ────────────────────────────────────────────────────────────

export interface EstimateDraft {
  usd: number;
  minutes: number;
  prs: number;
}

export function EstimateEditor({
  value,
  onChange,
}: {
  value: EstimateDraft;
  onChange: (v: EstimateDraft) => void;
}) {
  const onNum = (key: keyof EstimateDraft) =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = Number(e.target.value);
      onChange({ ...value, [key]: Number.isFinite(n) ? n : 0 });
    };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
      <div>
        <EditLabel htmlFor="estimate-usd">USD</EditLabel>
        <NumberInput
          id="estimate-usd"
          step={0.01}
          min={0}
          value={value.usd}
          onChange={onNum('usd')}
        />
      </div>
      <div>
        <EditLabel htmlFor="estimate-minutes">Minutes</EditLabel>
        <NumberInput
          id="estimate-minutes"
          step={1}
          min={0}
          value={value.minutes}
          onChange={onNum('minutes')}
        />
      </div>
      <div>
        <EditLabel htmlFor="estimate-prs">Pull requests</EditLabel>
        <NumberInput
          id="estimate-prs"
          step={1}
          min={0}
          value={value.prs}
          onChange={onNum('prs')}
        />
      </div>
    </div>
  );
}
