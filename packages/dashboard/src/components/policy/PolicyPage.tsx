import React, { useState } from 'react';
import { Shield, Check, AlertCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { Button } from '../ui/index.js';
import { POLICY_COPY } from './policy-copy.js';
import { usePolicy, type PipelineStage, type PolicyHook } from './usePolicy.js';

export interface PolicyPageProps {
  project: string | null;
  ws: WebSocket | null;
}

const STAGES: Array<{ id: PipelineStage; copy: { label: string; hint: string; recommended?: boolean } }> = [
  { id: 'plan', copy: POLICY_COPY.pauseAfter.plan },
  { id: 'implement', copy: POLICY_COPY.pauseAfter.implement },
  { id: 'review', copy: POLICY_COPY.pauseAfter.review },
  { id: 'test', copy: POLICY_COPY.pauseAfter.test },
  { id: 'ship', copy: POLICY_COPY.pauseAfter.ship },
];

export function PolicyPage({ project, ws }: PolicyPageProps) {
  const policy = usePolicy(ws, project);
  const [confirmOff, setConfirmOff] = useState(false);

  if (!project) {
    return (
      <div className="page-shell" style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
        <Shield size={32} style={{ opacity: 0.4 }} />
        <p style={{ marginTop: 8 }}>{POLICY_COPY.selectProjectPrompt}</p>
      </div>
    );
  }

  const isOn = policy.form.enabled;

  function onMasterToggle(v: boolean): void {
    if (!v && policy.form.enabled) {
      setConfirmOff(true);
      return;
    }
    policy.setEnabled(v);
  }

  function confirmTurnOff(): void {
    policy.setEnabled(false);
    setConfirmOff(false);
  }

  return (
    <div className="page-shell" style={{ padding: 24, maxWidth: 880, margin: '0 auto' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div>
          <h1 style={{ display: 'flex', alignItems: 'center', gap: 8, margin: 0 }}>
            <Shield size={20} /> {POLICY_COPY.pageTitle} — <span style={{ color: 'var(--accent)' }}>{project}</span>
          </h1>
          <p style={{ color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>{POLICY_COPY.pageSubtitle}</p>
        </div>
        <StatusPill on={isOn} />
      </header>

      {policy.status === 'error' && policy.error && (
        <div className="card" style={{ marginBottom: 12, padding: 12, borderColor: 'var(--color-error)' }}>
          <strong style={{ color: 'var(--color-error)' }}>{POLICY_COPY.toast.saveFailed}:</strong>{' '}
          <span>{policy.error}</span>
        </div>
      )}
      {policy.status === 'saved' && (
        <div className="card" style={{ marginBottom: 12, padding: 12, borderColor: 'var(--color-success)' }}>
          <Check size={14} style={{ verticalAlign: 'middle' }} /> {POLICY_COPY.toast.saved}
        </div>
      )}

      <MasterSwitchPanel value={isOn} onChange={onMasterToggle} />
      <PauseAfterPanel form={policy.form.pauseAfter} disabled={!isOn} onToggle={policy.togglePauseStage} />
      <AutoApprovePanel policy={policy} disabled={!isOn} />
      <CostPanel policy={policy} />
      <QAPanel policy={policy} />
      <NotificationsPanel policy={policy} />
      <PathRulesReadOnly effective={policy.effective} />

      <footer style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <Button variant="ghost" onClick={() => policy.reset()} disabled={!policy.dirty}>
          {POLICY_COPY.buttons.cancel}
        </Button>
        <Button variant="primary" onClick={() => policy.save()}
                disabled={!policy.dirty || policy.status === 'saving'}
                loading={policy.status === 'saving'}>
          {policy.status === 'saving' ? POLICY_COPY.buttons.saving : POLICY_COPY.buttons.save}
        </Button>
      </footer>

      {confirmOff && (
        <ConfirmationModal
          message={POLICY_COPY.master.confirmTurnOff(project)}
          onConfirm={confirmTurnOff}
          onCancel={() => setConfirmOff(false)}
        />
      )}
    </div>
  );
}

function StatusPill({ on }: { on: boolean }): React.ReactElement {
  const bg = on ? 'var(--color-success-soft, #d4f7d4)' : 'var(--bg-tertiary)';
  const fg = on ? 'var(--color-success)' : 'var(--text-tertiary)';
  return (
    <span style={{ background: bg, color: fg, padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}
          title={on ? POLICY_COPY.statusOnHint : POLICY_COPY.statusOffHint}>
      {on ? POLICY_COPY.statusOn : POLICY_COPY.statusOff}
    </span>
  );
}

function Panel({ title, description, children, dimmed }: {
  title: string;
  description?: string;
  children: React.ReactNode;
  dimmed?: boolean;
}): React.ReactElement {
  return (
    <section className="card" style={{ marginBottom: 12, padding: 16, opacity: dimmed ? 0.55 : 1 }}>
      <h3 style={{ margin: '0 0 4px 0', fontSize: 15 }}>{title}</h3>
      {description && (
        <p style={{ margin: '0 0 12px 0', color: 'var(--text-secondary)', fontSize: 13 }}>{description}</p>
      )}
      {children}
    </section>
  );
}

function MasterSwitchPanel({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }): React.ReactElement {
  return (
    <section className="card" style={{ marginBottom: 12, padding: 16 }}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)}
               style={{ marginTop: 4 }} />
        <span>
          <strong>{POLICY_COPY.master.label}</strong>
          <p style={{ margin: '4px 0 0 0', color: 'var(--text-secondary)', fontSize: 13 }}>
            {value ? POLICY_COPY.master.on : POLICY_COPY.master.off}
          </p>
        </span>
      </label>
    </section>
  );
}

function PauseAfterPanel({ form, disabled, onToggle }: {
  form: PipelineStage[];
  disabled: boolean;
  onToggle: (s: PipelineStage) => void;
}): React.ReactElement {
  return (
    <Panel title={POLICY_COPY.pauseAfter.title} description={POLICY_COPY.pauseAfter.description} dimmed={disabled}>
      {STAGES.map((s) => (
        <label key={s.id} style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '6px 0', cursor: disabled ? 'not-allowed' : 'pointer' }}>
          <input type="checkbox" checked={form.includes(s.id)} disabled={disabled}
                 onChange={() => onToggle(s.id)} style={{ marginTop: 4 }} />
          <span>
            <strong>{s.copy.label}</strong>
            {s.copy.recommended && (
              <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--color-success)', fontWeight: 600 }}>
                [recommended]
              </span>
            )}
            <p style={{ margin: '2px 0 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>{s.copy.hint}</p>
          </span>
        </label>
      ))}
      {!disabled && form.length === 0 && (
        <p style={{ margin: '8px 0 0 0', color: 'var(--color-warning)', fontSize: 12 }}>
          <AlertCircle size={12} style={{ verticalAlign: 'middle' }} /> {POLICY_COPY.pauseAfter.emptyHint}
        </p>
      )}
    </Panel>
  );
}

function AutoApprovePanel({ policy, disabled }: { policy: PolicyHook; disabled: boolean }): React.ReactElement {
  return (
    <Panel title={POLICY_COPY.autoApprove.title} description={POLICY_COPY.autoApprove.description} dimmed={disabled}>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>{POLICY_COPY.autoApprove.riskLabel}:</label>
        <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
          {(['low', 'med', 'never'] as const).map((r) => (
            <label key={r} style={{ display: 'flex', gap: 4, fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer' }}>
              <input type="radio" checked={policy.form.autoApproveIfRisk === r} disabled={disabled}
                     onChange={() => policy.setAutoApproveRisk(r)} />
              {POLICY_COPY.autoApprove.riskOptions[r]}
            </label>
          ))}
        </div>
        <p style={{ margin: '4px 0 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>{POLICY_COPY.autoApprove.riskHint}</p>
      </div>
      <div>
        <label style={{ fontSize: 13, fontWeight: 600 }}>
          {POLICY_COPY.autoApprove.confidenceLabel}: {policy.form.autoApproveIfConfidence.toFixed(2)}
        </label>
        <input type="range" min={0} max={1} step={0.01} disabled={disabled}
               value={policy.form.autoApproveIfConfidence}
               onChange={(e) => policy.setAutoApproveConfidence(Number(e.target.value))}
               style={{ width: '100%', marginTop: 4 }} />
        <p style={{ margin: '4px 0 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>{POLICY_COPY.autoApprove.confidenceHint}</p>
      </div>
    </Panel>
  );
}

function CostPanel({ policy }: { policy: PolicyHook }): React.ReactElement {
  const [showPerStage, setShowPerStage] = useState(false);
  const stage = policy.form.cost.perStage;
  return (
    <Panel title={POLICY_COPY.cost.title}>
      <div style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>{POLICY_COPY.cost.onBreachLabel}</label>
        <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
          {(['ask', 'auto-reject', 'auto-approve'] as const).map((b) => (
            <label key={b} style={{ display: 'flex', gap: 4, fontSize: 13, cursor: 'pointer' }}>
              <input type="radio" checked={policy.form.cost.onBreach === b}
                     onChange={() => policy.setCost({ onBreach: b })} />
              {POLICY_COPY.cost.onBreachOptions[b]}
            </label>
          ))}
        </div>
      </div>
      <NumberRow label={POLICY_COPY.cost.perRun} value={policy.form.cost.perRun}
                 onChange={(v) => policy.setCost({ perRun: v })} step={0.01} min={0} />
      <NumberRow label={POLICY_COPY.cost.perDay} value={policy.form.cost.perProjectDaily}
                 onChange={(v) => policy.setCost({ perProjectDaily: v })} step={0.01} min={0} />
      <NumberRow label={POLICY_COPY.cost.autoApproveBelow} value={policy.form.cost.autoApproveBelow}
                 onChange={(v) => policy.setCost({ autoApproveBelow: v })} step={0.01} min={0}
                 hint={POLICY_COPY.cost.autoApproveBelowHint} />
      <NumberRow label={POLICY_COPY.cost.grace} value={policy.form.cost.graceWindowSeconds}
                 onChange={(v) => policy.setCost({ graceWindowSeconds: v })} step={1} min={10} max={600}
                 hint={POLICY_COPY.cost.graceHint} />
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowPerStage((s) => !s)}>
        {showPerStage ? <ChevronDown size={12} /> : <ChevronRight size={12} />} {POLICY_COPY.cost.perStage}
      </button>
      {showPerStage && (
        <div style={{ marginTop: 8 }}>
          {STAGES.map((s) => (
            <NumberRow key={s.id} label={s.copy.label} value={stage[s.id] ?? null}
                       onChange={(v) => policy.setCost({
                         perStage: v == null
                           ? Object.fromEntries(Object.entries(stage).filter(([k]) => k !== s.id)) as Partial<Record<PipelineStage, number>>
                           : { ...stage, [s.id]: v },
                       })}
                       step={0.01} min={0} />
          ))}
        </div>
      )}
    </Panel>
  );
}

function QAPanel({ policy }: { policy: PolicyHook }): React.ReactElement {
  return (
    <Panel title={POLICY_COPY.qa.title}>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, cursor: 'pointer' }}>
        <input type="checkbox" checked={policy.form.qa.enabled}
               onChange={(e) => policy.setQA({ enabled: e.target.checked })} style={{ marginTop: 4 }} />
        <span>
          <strong>{POLICY_COPY.qa.enableLabel}</strong>
          <p style={{ margin: '2px 0 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>{POLICY_COPY.qa.enableHint}</p>
        </span>
      </label>
      <div style={{ marginTop: 12, opacity: policy.form.qa.enabled ? 1 : 0.55 }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>
          {POLICY_COPY.qa.maxLabel}: {policy.form.qa.maxQuestionsPerStage}
        </label>
        <input type="range" min={0} max={20} step={1} disabled={!policy.form.qa.enabled}
               value={policy.form.qa.maxQuestionsPerStage}
               onChange={(e) => policy.setQA({ maxQuestionsPerStage: Number(e.target.value) })}
               style={{ width: '100%', marginTop: 4 }} />
        <p style={{ margin: '4px 0 0 0', color: 'var(--text-secondary)', fontSize: 12 }}>{POLICY_COPY.qa.maxHint}</p>
      </div>
      <p style={{ margin: '12px 0 0 0', fontSize: 12, color: 'var(--text-tertiary)' }}>{POLICY_COPY.qa.scope}</p>
    </Panel>
  );
}

function NotificationsPanel({ policy }: { policy: PolicyHook }): React.ReactElement {
  return (
    <Panel title={POLICY_COPY.notifications.title}>
      <div style={{ display: 'flex', gap: 16 }}>
        <label style={{ display: 'flex', gap: 6, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={policy.form.notifications.slack}
                 onChange={(e) => policy.setNotifications({ slack: e.target.checked })} />
          {POLICY_COPY.notifications.slack}
        </label>
        <label style={{ display: 'flex', gap: 6, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={policy.form.notifications.email}
                 onChange={(e) => policy.setNotifications({ email: e.target.checked })} />
          {POLICY_COPY.notifications.email}
        </label>
      </div>
      <NumberRow label={POLICY_COPY.notifications.timeoutLabel} value={policy.form.notifications.timeoutHours}
                 onChange={(v) => policy.setNotifications({ timeoutHours: v })}
                 step={0.25} min={0.25} max={168}
                 hint={POLICY_COPY.notifications.timeoutHint} />
    </Panel>
  );
}

function PathRulesReadOnly({ effective }: { effective: Record<string, unknown> | null }): React.ReactElement {
  const paths = Array.isArray((effective as any)?.paths) ? ((effective as any).paths as Array<any>) : [];
  return (
    <Panel title={POLICY_COPY.paths.title} description={POLICY_COPY.paths.description}>
      <code style={{ display: 'block', padding: 6, background: 'var(--bg-tertiary)', borderRadius: 4, fontSize: 12, marginBottom: 8 }}>
        {POLICY_COPY.paths.pathHint}
      </code>
      {paths.length === 0 ? (
        <p style={{ color: 'var(--text-tertiary)', fontSize: 12, margin: 0 }}>{POLICY_COPY.paths.empty}</p>
      ) : (
        <ul style={{ paddingLeft: 16, margin: 0 }}>
          {paths.map((p, i) => (
            <li key={i} style={{ fontSize: 12, marginBottom: 4 }}>
              <code>{p.match}</code>
              {p.autoApprove && <span style={{ color: 'var(--color-success)', marginLeft: 8 }}>auto-approve</span>}
              {Array.isArray(p.pauseAfter) && p.pauseAfter.length > 0 && (
                <span style={{ marginLeft: 8 }}>pause after [{p.pauseAfter.join(', ')}]</span>
              )}
              {Array.isArray(p.reviewers) && p.reviewers.length > 0 && (
                <span style={{ marginLeft: 8, color: 'var(--text-tertiary)' }}>reviewers: {p.reviewers.join(', ')}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

function NumberRow({ label, value, onChange, step, min, max, hint }: {
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  step?: number;
  min?: number;
  max?: number;
  hint?: string;
}): React.ReactElement {
  return (
    <div style={{ marginBottom: 8 }}>
      <label style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', fontSize: 13 }}>
        <span>{label}</span>
        <input type="number" value={value ?? ''} step={step} min={min} max={max}
               onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
               style={{ width: 110, padding: '4px 6px', fontSize: 13 }} />
      </label>
      {hint && <p style={{ margin: '2px 0 0 0', color: 'var(--text-secondary)', fontSize: 11 }}>{hint}</p>}
    </div>
  );
}

function ConfirmationModal({ message, onConfirm, onCancel }: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}): React.ReactElement {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onCancel}>
      <div className="card" style={{ padding: 20, maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
        <p style={{ margin: 0 }}>{message}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>Turn off</Button>
        </div>
      </div>
    </div>
  );
}

export default PolicyPage;
