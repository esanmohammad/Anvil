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
 * Per-section edit forms — Plan v2 shape.
 *
 * Each editor is a controlled component. The parent (PlanPage) holds
 * the draft value and the Save/Cancel buttons. Types mirror the v2
 * `Plan` interface in PlanPage.tsx.
 *
 * v2 is more structured than v1 — to keep the UI usable we expose the
 * primary field for each item (description, mustTouch path, contract
 * display fields). Auxiliary fields (acceptance criteria, blastRadius,
 * detection) get compact secondary controls.
 */

// ── Problem ─────────────────────────────────────────────────────────────

export interface ProblemDraft {
  statement: string;
  why_now: string;
  success_signals: string[];
}

export function ProblemEditor({
  value,
  onChange,
}: {
  value: ProblemDraft;
  onChange: (v: ProblemDraft) => void;
}) {
  return (
    <div>
      <FieldRow>
        <EditLabel>Statement (≥ 80 chars)</EditLabel>
        <TextArea
          rows={4}
          value={value.statement}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChange({ ...value, statement: e.target.value })}
          placeholder="Describe the problem in present tense, from the user's perspective…"
          aria-label="Problem statement"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Why now (≥ 40 chars)</EditLabel>
        <TextArea
          rows={2}
          value={value.why_now}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChange({ ...value, why_now: e.target.value })}
          placeholder="A deadline, escalation, incident, or strategic bet."
          aria-label="Why now"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Success signals (one per line)</EditLabel>
        <TextArea
          rows={3}
          value={listToLines(value.success_signals)}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChange({ ...value, success_signals: linesToList(e.target.value) })}
          placeholder="Observable post-ship signals (metric, support volume drop, …)"
          aria-label="Success signals"
        />
      </FieldRow>
    </div>
  );
}

// ── Scope ───────────────────────────────────────────────────────────────

export interface ScopeItemDraft {
  id: string;
  description: string;
  acceptance: string[];
}
export interface ScopeDraft {
  inScope: ScopeItemDraft[];
  outOfScope: ScopeItemDraft[];
}

function ScopeList({
  items, onChange, prefix,
}: {
  items: ScopeItemDraft[];
  onChange: (v: ScopeItemDraft[]) => void;
  prefix: string;
}) {
  const updateAt = (idx: number, patch: Partial<ScopeItemDraft>) => {
    onChange(items.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  };
  const removeAt = (idx: number) => onChange(items.filter((_, i) => i !== idx));
  const add = () => onChange([...items, { id: `${prefix}${items.length + 1}`, description: '', acceptance: [] }]);
  return (
    <div>
      {items.map((it, idx) => (
        <EntryCard key={idx} onRemove={() => removeAt(idx)}>
          <FieldRow>
            <EditLabel>ID</EditLabel>
            <TextInput
              value={it.id}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { id: e.target.value })}
              aria-label={`${prefix} item ${idx + 1} id`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Description</EditLabel>
            <TextArea
              rows={2}
              value={it.description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateAt(idx, { description: e.target.value })}
              aria-label={`${prefix} item ${idx + 1} description`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Acceptance (one per line)</EditLabel>
            <TextArea
              rows={2}
              value={listToLines(it.acceptance)}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateAt(idx, { acceptance: linesToList(e.target.value) })}
              placeholder="Given …, when …, then …"
              aria-label={`${prefix} item ${idx + 1} acceptance`}
            />
          </FieldRow>
        </EntryCard>
      ))}
      <IconButton label="Add item" onClick={add} />
    </div>
  );
}

export function ScopeEditor({
  value, onChange,
}: {
  value: ScopeDraft;
  onChange: (v: ScopeDraft) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
      <div>
        <EditLabel>In scope</EditLabel>
        <ScopeList items={value.inScope} prefix="s" onChange={(inScope) => onChange({ ...value, inScope })} />
      </div>
      <div>
        <EditLabel>Out of scope</EditLabel>
        <ScopeList items={value.outOfScope} prefix="o" onChange={(outOfScope) => onChange({ ...value, outOfScope })} />
      </div>
    </div>
  );
}

// ── Repos ───────────────────────────────────────────────────────────────

export interface FileClaimDraft { path: string; kind: 'new' | 'modified'; reason: string }
export interface SymbolClaimDraft {
  file: string;
  name: string;
  kind: 'function' | 'type' | 'class' | 'const' | 'interface' | 'enum';
  signature?: string;
}
export interface RepoDraft {
  name: string;
  changes: string;
  mustExist: FileClaimDraft[];
  mustTouch: FileClaimDraft[];
  mustNotBreak: string[];
  symbols: SymbolClaimDraft[];
}

// Plain "one path per line" textarea; kind is inferred per the section
// it lives in (mustTouch ⇒ modified, mustExist ⇒ new).
function pathsToText(claims: FileClaimDraft[]): string {
  return claims.map((c) => c.path).join('\n');
}
function textToPaths(text: string, kind: 'new' | 'modified'): FileClaimDraft[] {
  return linesToList(text).map((path) => ({ path, kind, reason: '' }));
}
function symbolsToText(syms: SymbolClaimDraft[]): string {
  return syms.map((s) => `${s.name}${s.file ? ` @ ${s.file}` : ''}`).join('\n');
}
function textToSymbols(text: string): SymbolClaimDraft[] {
  return linesToList(text).map((line) => {
    const [name, file] = line.split('@').map((s) => s.trim());
    return { name: name ?? line, file: file ?? '', kind: 'function' as const };
  });
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
  const removeAt = (idx: number) => onChange(value.filter((_, i) => i !== idx));
  const add = () => onChange([
    ...value,
    { name: 'new-repo', changes: '', mustExist: [], mustTouch: [], mustNotBreak: [], symbols: [] },
  ]);

  return (
    <div>
      {value.map((repo, idx) => (
        <EntryCard key={idx} onRemove={() => removeAt(idx)}>
          <FieldRow>
            <EditLabel>Name</EditLabel>
            <TextInput
              value={repo.name}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { name: e.target.value })}
              aria-label={`Repo ${idx + 1} name`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Changes</EditLabel>
            <TextArea
              rows={2}
              value={repo.changes}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateAt(idx, { changes: e.target.value })}
              aria-label={`Repo ${idx + 1} changes`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>mustTouch (modified — one path per line)</EditLabel>
            <TextArea
              rows={3}
              value={pathsToText(repo.mustTouch)}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                updateAt(idx, { mustTouch: textToPaths(e.target.value, 'modified') })}
              aria-label={`Repo ${idx + 1} mustTouch`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>mustExist (new — one path per line)</EditLabel>
            <TextArea
              rows={2}
              value={pathsToText(repo.mustExist)}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                updateAt(idx, { mustExist: textToPaths(e.target.value, 'new') })}
              aria-label={`Repo ${idx + 1} mustExist`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>mustNotBreak (public exports — one path per line)</EditLabel>
            <TextArea
              rows={2}
              value={listToLines(repo.mustNotBreak)}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                updateAt(idx, { mustNotBreak: linesToList(e.target.value) })}
              aria-label={`Repo ${idx + 1} mustNotBreak`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Symbols (one per line: name [ @ file ])</EditLabel>
            <TextArea
              rows={2}
              value={symbolsToText(repo.symbols)}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                updateAt(idx, { symbols: textToSymbols(e.target.value) })}
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

const CONTRACT_KINDS = ['http', 'grpc', 'kafka', 'db'] as const;
type ContractKind = typeof CONTRACT_KINDS[number];

// Open type that mirrors core-pipeline's PlanContract discriminated union.
// Editors collapse to a uniform shape for editing; serializer maps each
// kind to the right v2 fields when saving.
export interface ContractDraft {
  kind: ContractKind;
  // Shared:
  producer: string;
  consumers: string[];
  // HTTP:
  method?: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE';
  path?: string;
  status?: number[];
  // Kafka:
  topic?: string;
  schemaRef?: string;
  // gRPC:
  service?: string;
  rpcMethod?: string;
  // DB:
  table?: string;
}

export function ContractsEditor({
  value, onChange,
}: {
  value: ContractDraft[];
  onChange: (v: ContractDraft[]) => void;
}) {
  const updateAt = (idx: number, patch: Partial<ContractDraft>) => {
    onChange(value.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  };
  const removeAt = (idx: number) => onChange(value.filter((_, i) => i !== idx));
  const add = () => onChange([
    ...value,
    { kind: 'http', producer: '', consumers: [], method: 'GET', path: '/', status: [200] },
  ]);

  return (
    <div>
      {value.map((c, idx) => (
        <EntryCard key={idx} onRemove={() => removeAt(idx)}>
          <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 8, marginBottom: 10 }}>
            <div>
              <EditLabel>Kind</EditLabel>
              <SelectInput
                value={c.kind}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  updateAt(idx, { kind: e.target.value as ContractKind })}
                aria-label={`Contract ${idx + 1} kind`}
              >
                {CONTRACT_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
              </SelectInput>
            </div>
            <div>
              <EditLabel>Producer</EditLabel>
              <TextInput
                value={c.producer}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { producer: e.target.value })}
                aria-label={`Contract ${idx + 1} producer`}
              />
            </div>
          </div>
          {c.kind === 'http' && (
            <>
              <FieldRow>
                <EditLabel>Method · Path</EditLabel>
                <div style={{ display: 'flex', gap: 6 }}>
                  <SelectInput
                    value={c.method ?? 'GET'}
                    onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                      updateAt(idx, { method: e.target.value as ContractDraft['method'] })}
                    aria-label={`Contract ${idx + 1} method`}
                  >
                    {(['GET','POST','PUT','PATCH','DELETE'] as const).map((m) => <option key={m} value={m}>{m}</option>)}
                  </SelectInput>
                  <TextInput
                    value={c.path ?? ''}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { path: e.target.value })}
                    placeholder="/v1/foo/{id}"
                    aria-label={`Contract ${idx + 1} path`}
                  />
                </div>
              </FieldRow>
              <FieldRow>
                <EditLabel>Status codes (comma-separated)</EditLabel>
                <TextInput
                  value={(c.status ?? []).join(',')}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    updateAt(idx, {
                      status: e.target.value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
                    })}
                  aria-label={`Contract ${idx + 1} status`}
                />
              </FieldRow>
            </>
          )}
          {c.kind === 'kafka' && (
            <>
              <FieldRow>
                <EditLabel>Topic</EditLabel>
                <TextInput
                  value={c.topic ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { topic: e.target.value })}
                  aria-label={`Contract ${idx + 1} topic`}
                />
              </FieldRow>
              <FieldRow>
                <EditLabel>Schema ref</EditLabel>
                <TextInput
                  value={c.schemaRef ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { schemaRef: e.target.value })}
                  aria-label={`Contract ${idx + 1} schemaRef`}
                />
              </FieldRow>
            </>
          )}
          {c.kind === 'grpc' && (
            <>
              <FieldRow>
                <EditLabel>Service</EditLabel>
                <TextInput
                  value={c.service ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { service: e.target.value })}
                  aria-label={`Contract ${idx + 1} service`}
                />
              </FieldRow>
              <FieldRow>
                <EditLabel>Method</EditLabel>
                <TextInput
                  value={c.rpcMethod ?? ''}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { rpcMethod: e.target.value })}
                  aria-label={`Contract ${idx + 1} rpcMethod`}
                />
              </FieldRow>
            </>
          )}
          {c.kind === 'db' && (
            <FieldRow>
              <EditLabel>Table</EditLabel>
              <TextInput
                value={c.table ?? ''}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { table: e.target.value })}
                aria-label={`Contract ${idx + 1} table`}
              />
            </FieldRow>
          )}
          {c.kind !== 'db' && (
            <FieldRow>
              <EditLabel>Consumers (one per line)</EditLabel>
              <TextArea
                rows={2}
                value={listToLines(c.consumers)}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                  updateAt(idx, { consumers: linesToList(e.target.value) })}
                aria-label={`Contract ${idx + 1} consumers`}
              />
            </FieldRow>
          )}
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
  value, onChange,
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
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ ...value, notes: e.target.value })}
          aria-label="Architecture notes"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Mermaid diagram</EditLabel>
        <TextArea
          rows={6}
          value={value.mermaid}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange({ ...value, mermaid: e.target.value })}
          aria-label="Architecture mermaid"
          spellCheck={false}
        />
      </FieldRow>
    </div>
  );
}

// ── Risks ───────────────────────────────────────────────────────────────

const RISK_SEVERITIES = ['low', 'med', 'high'] as const;
const BLAST_RADIUS_VALUES = ['one-repo', 'cross-repo', 'data-loss', 'auth-bypass'] as const;

export interface RiskDraft {
  id: string;
  title: string;
  severity: 'low' | 'med' | 'high';
  blastRadius: 'one-repo' | 'cross-repo' | 'data-loss' | 'auth-bypass';
  mitigation: string;
  detection: string;
}

export function RisksEditor({
  value, onChange,
}: {
  value: RiskDraft[];
  onChange: (v: RiskDraft[]) => void;
}) {
  const updateAt = (idx: number, patch: Partial<RiskDraft>) => {
    onChange(value.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const removeAt = (idx: number) => onChange(value.filter((_, i) => i !== idx));
  const add = () => onChange([
    ...value,
    { id: `r${value.length + 1}`, title: '', severity: 'low', blastRadius: 'one-repo', mitigation: '', detection: '' },
  ]);
  return (
    <div>
      {value.map((r, idx) => (
        <EntryCard key={idx} onRemove={() => removeAt(idx)}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 100px 130px', gap: 8, marginBottom: 10 }}>
            <div>
              <EditLabel>Title</EditLabel>
              <TextInput
                value={r.title}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { title: e.target.value })}
                aria-label={`Risk ${idx + 1} title`}
              />
            </div>
            <div>
              <EditLabel>Severity</EditLabel>
              <SelectInput
                value={r.severity}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  updateAt(idx, { severity: e.target.value as RiskDraft['severity'] })}
                aria-label={`Risk ${idx + 1} severity`}
              >
                {RISK_SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </SelectInput>
            </div>
            <div>
              <EditLabel>Blast radius</EditLabel>
              <SelectInput
                value={r.blastRadius}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  updateAt(idx, { blastRadius: e.target.value as RiskDraft['blastRadius'] })}
                aria-label={`Risk ${idx + 1} blast radius`}
              >
                {BLAST_RADIUS_VALUES.map((b) => <option key={b} value={b}>{b}</option>)}
              </SelectInput>
            </div>
          </div>
          <FieldRow>
            <EditLabel>Mitigation</EditLabel>
            <TextArea
              rows={2}
              value={r.mitigation}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateAt(idx, { mitigation: e.target.value })}
              aria-label={`Risk ${idx + 1} mitigation`}
            />
          </FieldRow>
          <FieldRow>
            <EditLabel>Detection (how would prod observability catch this?)</EditLabel>
            <TextArea
              rows={2}
              value={r.detection}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateAt(idx, { detection: e.target.value })}
              aria-label={`Risk ${idx + 1} detection`}
            />
          </FieldRow>
        </EntryCard>
      ))}
      <IconButton label="Add risk entry" onClick={add} />
    </div>
  );
}

// ── Rollout ─────────────────────────────────────────────────────────────

const ROLLOUT_STRATEGIES = ['feature-flag', 'canary', 'blue-green', 'direct'] as const;

export interface RolloutDraft {
  strategy: 'feature-flag' | 'canary' | 'blue-green' | 'direct';
  flags: string[];
  order: string[];
  rollback: { command: string; verify: string };
}

export function RolloutEditor({
  value, onChange,
}: {
  value: RolloutDraft;
  onChange: (v: RolloutDraft) => void;
}) {
  return (
    <div>
      <FieldRow>
        <EditLabel>Strategy</EditLabel>
        <SelectInput
          value={value.strategy}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
            onChange({ ...value, strategy: e.target.value as RolloutDraft['strategy'] })}
          aria-label="Rollout strategy"
        >
          {ROLLOUT_STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
        </SelectInput>
      </FieldRow>
      <FieldRow>
        <EditLabel>Flags (one per line)</EditLabel>
        <TextArea
          rows={2}
          value={listToLines(value.flags)}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChange({ ...value, flags: linesToList(e.target.value) })}
          aria-label="Rollout flags"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Order (one repo per line)</EditLabel>
        <TextArea
          rows={2}
          value={listToLines(value.order)}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChange({ ...value, order: linesToList(e.target.value) })}
          aria-label="Rollout order"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Rollback command</EditLabel>
        <TextInput
          value={value.rollback.command}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onChange({ ...value, rollback: { ...value.rollback, command: e.target.value } })}
          placeholder="kubectl rollout undo deployment/foo"
          aria-label="Rollback command"
        />
      </FieldRow>
      <FieldRow>
        <EditLabel>Rollback verify</EditLabel>
        <TextInput
          value={value.rollback.verify}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            onChange({ ...value, rollback: { ...value.rollback, verify: e.target.value } })}
          placeholder="curl -sf https://… | jq .ok"
          aria-label="Rollback verify"
        />
      </FieldRow>
    </div>
  );
}

// ── Tests ───────────────────────────────────────────────────────────────

export interface TestCaseSpecDraft {
  id: string;
  acceptanceRef: string;
  file: string;
  name: string;
  given: string;
  when: string;
  then: string;
}
export interface ManualStepDraft { id: string; description: string; expected: string }
export interface TestsDraft {
  unit: TestCaseSpecDraft[];
  integration: TestCaseSpecDraft[];
  manual: ManualStepDraft[];
}

function TestCaseList({
  items, onChange, prefix,
}: {
  items: TestCaseSpecDraft[];
  onChange: (v: TestCaseSpecDraft[]) => void;
  prefix: string;
}) {
  const updateAt = (idx: number, patch: Partial<TestCaseSpecDraft>) => {
    onChange(items.map((t, i) => (i === idx ? { ...t, ...patch } : t)));
  };
  const removeAt = (idx: number) => onChange(items.filter((_, i) => i !== idx));
  const add = () => onChange([
    ...items,
    { id: `${prefix}${items.length + 1}`, acceptanceRef: '', file: '', name: '', given: '', when: '', then: '' },
  ]);
  return (
    <div>
      {items.map((t, idx) => (
        <EntryCard key={idx} onRemove={() => removeAt(idx)}>
          <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr 1fr', gap: 8 }}>
            <TextInput value={t.id} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { id: e.target.value })} aria-label="id" placeholder="id" />
            <TextInput value={t.acceptanceRef} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { acceptanceRef: e.target.value })} aria-label="acceptanceRef" placeholder="acceptanceRef" />
            <TextInput value={t.name} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { name: e.target.value })} aria-label="test name" placeholder="test function name" />
          </div>
          <FieldRow>
            <TextInput value={t.file} onChange={(e: React.ChangeEvent<HTMLInputElement>) => updateAt(idx, { file: e.target.value })} aria-label="file" placeholder="path/to/test_file" />
          </FieldRow>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
            <TextArea rows={2} value={t.given} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateAt(idx, { given: e.target.value })} aria-label="given" placeholder="given" />
            <TextArea rows={2} value={t.when} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateAt(idx, { when: e.target.value })} aria-label="when" placeholder="when" />
            <TextArea rows={2} value={t.then} onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateAt(idx, { then: e.target.value })} aria-label="then" placeholder="then" />
          </div>
        </EntryCard>
      ))}
      <IconButton label="Add test case" onClick={add} />
    </div>
  );
}

export function TestsEditor({
  value, onChange,
}: {
  value: TestsDraft;
  onChange: (v: TestsDraft) => void;
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}>
      <div>
        <EditLabel>Unit</EditLabel>
        <TestCaseList items={value.unit} prefix="u" onChange={(unit) => onChange({ ...value, unit })} />
      </div>
      <div>
        <EditLabel>Integration</EditLabel>
        <TestCaseList items={value.integration} prefix="i" onChange={(integration) => onChange({ ...value, integration })} />
      </div>
      <div>
        <EditLabel>Manual (one per line — description)</EditLabel>
        <TextArea
          rows={3}
          value={listToLines(value.manual.map((m) => m.description))}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChange({
              ...value,
              manual: linesToList(e.target.value).map((d, i) => ({ id: `m${i + 1}`, description: d, expected: '' })),
            })}
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
  calibratedFrom: string[];
}

export function EstimateEditor({
  value, onChange,
}: {
  value: EstimateDraft;
  onChange: (v: EstimateDraft) => void;
}) {
  const onNum = (key: 'usd' | 'minutes' | 'prs') =>
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const n = Number(e.target.value);
      onChange({ ...value, [key]: Number.isFinite(n) ? n : 0 });
    };

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <div>
          <EditLabel htmlFor="estimate-usd">USD</EditLabel>
          <NumberInput id="estimate-usd" step={0.01} min={0} value={value.usd} onChange={onNum('usd')} />
        </div>
        <div>
          <EditLabel htmlFor="estimate-minutes">Minutes</EditLabel>
          <NumberInput id="estimate-minutes" step={1} min={0} value={value.minutes} onChange={onNum('minutes')} />
        </div>
        <div>
          <EditLabel htmlFor="estimate-prs">Pull requests</EditLabel>
          <NumberInput id="estimate-prs" step={1} min={0} value={value.prs} onChange={onNum('prs')} />
        </div>
      </div>
      <FieldRow>
        <EditLabel>Calibrated from (plan-learnings slugs, one per line)</EditLabel>
        <TextArea
          rows={2}
          value={listToLines(value.calibratedFrom)}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
            onChange({ ...value, calibratedFrom: linesToList(e.target.value) })}
          aria-label="Estimate calibration anchors"
        />
      </FieldRow>
    </div>
  );
}
