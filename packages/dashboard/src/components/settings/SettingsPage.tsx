import React, { useState, useEffect, useCallback } from 'react';
import { Settings, Key, DollarSign, GitBranch, Bell, Check, AlertTriangle } from 'lucide-react';

export interface SettingsPageProps {
  project: string | null;
  ws: WebSocket | null;
}

interface ProviderInfo {
  name: string;
  displayName?: string;
  type?: 'cli' | 'api';
  envVar?: string;
  binary?: string;
  available?: boolean;
  version?: string;
  isSet?: boolean;        // backward compat (old auth-status shape)
  maskedKey?: string;     // backward compat (old auth-status shape)
  capabilities?: string[];
  setupHint?: string;
  tier?: string;
}

interface BudgetInfo {
  maxPerRun: number;
  maxPerDay: number;
  alertAt: number;
  todaySpent: number;
}

const BUDGET_DEFAULTS: BudgetInfo = {
  maxPerRun: 100,
  maxPerDay: 200,
  alertAt: 80,
  todaySpent: 0,
};

type TabId = 'providers' | 'budget' | 'hooks' | 'notifications';

const tabs: Array<{ id: TabId; label: string; icon: React.ComponentType<any>; comingSoon?: boolean }> = [
  { id: 'providers', label: 'Providers', icon: Key },
  { id: 'budget', label: 'Budget', icon: DollarSign },
  { id: 'hooks', label: 'Hooks', icon: GitBranch, comingSoon: true },
  { id: 'notifications', label: 'Notifications', icon: Bell, comingSoon: true },
];

export function SettingsPage({ project, ws }: SettingsPageProps) {
  const [activeTab, setActiveTab] = useState<TabId>('providers');

  // Provider state
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [testingProvider, setTestingProvider] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, 'ok' | 'fail'>>({});

  // Budget state
  const [budget, setBudget] = useState<BudgetInfo>(BUDGET_DEFAULTS);
  const [editingBudget, setEditingBudget] = useState(false);
  const [budgetDraft, setBudgetDraft] = useState<BudgetInfo>(BUDGET_DEFAULTS);
  const [budgetSaved, setBudgetSaved] = useState(false);
  const [alertFired, setAlertFired] = useState(false);

  // Fetch data on mount
  useEffect(() => {
    if (!ws) return;
    ws.send(JSON.stringify({ action: 'get-providers' }));
    if (project) {
      ws.send(JSON.stringify({ action: 'get-budget-status', project }));
    }
  }, [ws, project]);

  // Save feedback state
  const [saveResult, setSaveResult] = useState<Record<string, 'saved' | 'error'>>({});

  // Listen for messages
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'providers' && msg.payload) {
          setProviders(msg.payload.providers || []);
        }
        // Backward compat: old auth-status shape (hasKey/isSet, no type field)
        if (msg.type === 'auth-status' && msg.payload) {
          const legacy = (msg.payload.providers || []).map((p: Record<string, unknown>) => ({
            ...p,
            type: 'api' as const,
            available: !!(p.hasKey ?? p.isSet),
          }));
          setProviders((prev) => {
            // Merge: prefer existing providers data, fill in legacy API providers if missing
            const byName = new Map(prev.map((x) => [x.name, x]));
            for (const lp of legacy) {
              if (!byName.has(lp.name)) byName.set(lp.name, lp);
            }
            return Array.from(byName.values());
          });
        }
        if (msg.type === 'auth-key-saved' && msg.payload) {
          setSaveResult((prev) => ({ ...prev, [msg.payload.provider]: 'saved' }));
          setTimeout(() => setSaveResult((prev) => { const next = { ...prev }; delete next[msg.payload.provider]; return next; }), 3000);
        }
        if (msg.type === 'error' && msg.payload?.message?.includes('save key')) {
          // Show error feedback for the provider being edited
          if (editingProvider) {
            setSaveResult((prev) => ({ ...prev, [editingProvider]: 'error' }));
            setTimeout(() => setSaveResult((prev) => { const next = { ...prev }; delete next[editingProvider!]; return next; }), 5000);
          }
        }
        if (msg.type === 'budget-status' && msg.payload) {
          const b = msg.payload;
          const info: BudgetInfo = {
            maxPerRun: b.maxPerRun ?? BUDGET_DEFAULTS.maxPerRun,
            maxPerDay: b.maxPerDay ?? BUDGET_DEFAULTS.maxPerDay,
            alertAt: b.alertAt ?? BUDGET_DEFAULTS.alertAt,
            todaySpent: b.todaySpent ?? 0,
          };
          setBudget(info);
          setBudgetDraft(info);
        }
        if (msg.type === 'budget-saved') {
          setBudgetSaved(true);
          setTimeout(() => setBudgetSaved(false), 2000);
        }
        if (msg.type === 'auth-test-result' && msg.payload) {
          setTestingProvider(null);
          setTestResult((prev) => ({ ...prev, [msg.payload.provider]: msg.payload.success ? 'ok' : 'fail' }));
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, editingProvider]);

  // Budget alert — fire browser notification when spending exceeds alertAt
  useEffect(() => {
    if (alertFired) return;
    if (budget.todaySpent >= budget.alertAt && budget.alertAt > 0) {
      setAlertFired(true);
      fireBudgetAlert(budget);
    }
  }, [budget.todaySpent, budget.alertAt, alertFired]);

  const handleSaveKey = useCallback((provider: string) => {
    if (!ws || !keyInput.trim()) return;
    ws.send(JSON.stringify({ action: 'set-auth-key', provider, key: keyInput.trim() }));
    setEditingProvider(null);
    setKeyInput('');
    ws.send(JSON.stringify({ action: 'get-providers' }));
  }, [ws, keyInput]);

  const handleTestConnection = useCallback((provider: string) => {
    if (!ws) return;
    setTestingProvider(provider);
    setTestResult((prev) => { const next = { ...prev }; delete next[provider]; return next; });
    ws.send(JSON.stringify({ action: 'test-auth', provider }));
  }, [ws]);

  const handleSaveBudget = useCallback(() => {
    if (!ws || !project) return;
    ws.send(JSON.stringify({
      action: 'set-budget',
      project,
      maxPerRun: budgetDraft.maxPerRun,
      maxPerDay: budgetDraft.maxPerDay,
      alertAt: budgetDraft.alertAt,
    }));
    setBudget({ ...budgetDraft, todaySpent: budget.todaySpent });
    setEditingBudget(false);
    setAlertFired(false); // Reset alert so new threshold takes effect
  }, [ws, project, budgetDraft, budget.todaySpent]);

  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)',
      maxWidth: 900,
      margin: '0 auto',
      height: '100%',
      display: 'flex',
      flexDirection: 'column',
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        marginBottom: 20, flexShrink: 0,
      }}>
        <Settings size={20} style={{ color: 'var(--accent)' }} />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Settings</h2>
        {project && (
          <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>
        )}
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 0,
        borderBottom: '1px solid var(--separator)',
        marginBottom: 20, flexShrink: 0,
      }}>
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          const disabled = !!tab.comingSoon;
          return (
            <button
              key={tab.id}
              onClick={() => !disabled && setActiveTab(tab.id)}
              disabled={disabled}
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '8px 16px',
                background: 'none',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--accent)' : '2px solid transparent',
                color: disabled ? 'var(--text-tertiary)' : isActive ? 'var(--accent)' : 'var(--text-secondary)',
                fontSize: 13,
                fontWeight: isActive ? 600 : 400,
                fontFamily: 'var(--font-sans)',
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled ? 0.55 : 1,
                transition: 'color var(--duration-fast) var(--ease-default), border-color var(--duration-fast) var(--ease-default)',
                marginBottom: -1,
              }}
            >
              <Icon size={14} strokeWidth={1.75} />
              {tab.label}
              {disabled && (
                <span style={{
                  padding: '1px 6px', fontSize: 9, fontWeight: 500,
                  background: 'var(--bg-elevated-3)', color: 'var(--text-tertiary)',
                  borderRadius: 'var(--radius-full)',
                }}>
                  Soon
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {/* -------- Providers -------- */}
        {activeTab === 'providers' && (
          <ProvidersTab
            providers={providers}
            editingProvider={editingProvider}
            setEditingProvider={setEditingProvider}
            keyInput={keyInput}
            setKeyInput={setKeyInput}
            testingProvider={testingProvider}
            testResult={testResult}
            saveResult={saveResult}
            onSaveKey={handleSaveKey}
            onTestConnection={handleTestConnection}
          />
        )}

        {/* -------- Budget -------- */}
        {activeTab === 'budget' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {/* Source info */}
            <div style={{
              fontSize: 11, color: 'var(--text-tertiary)', padding: '6px 12px',
              background: 'var(--bg-base)', borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--separator)',
            }}>
              Budget is configured in <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>factory.yaml</code> under the <code style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>budget:</code> section. Changes saved here are written back to the YAML.
            </div>

            {/* Config display */}
            <div style={{
              padding: 16,
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                marginBottom: 16,
              }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>
                  Budget Configuration
                </span>
                {!editingBudget ? (
                  <button onClick={() => setEditingBudget(true)} style={smallButtonStyle}>
                    Edit
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button onClick={handleSaveBudget} style={primaryBtnStyle}>
                      {budgetSaved ? 'Saved!' : 'Save'}
                    </button>
                    <button onClick={() => { setEditingBudget(false); setBudgetDraft(budget); }} style={smallButtonStyle}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                <BudgetField
                  label="Max per run"
                  value={editingBudget ? budgetDraft.maxPerRun : budget.maxPerRun}
                  editing={editingBudget}
                  onChange={(v) => setBudgetDraft((d) => ({ ...d, maxPerRun: v }))}
                  prefix="$"
                />
                <BudgetField
                  label="Max per day"
                  value={editingBudget ? budgetDraft.maxPerDay : budget.maxPerDay}
                  editing={editingBudget}
                  onChange={(v) => setBudgetDraft((d) => ({ ...d, maxPerDay: v }))}
                  prefix="$"
                />
                <BudgetField
                  label="Alert at (browser)"
                  value={editingBudget ? budgetDraft.alertAt : budget.alertAt}
                  editing={editingBudget}
                  onChange={(v) => setBudgetDraft((d) => ({ ...d, alertAt: v }))}
                  prefix="$"
                />
              </div>
            </div>

            {/* Today's spending bar */}
            <div>
              <div style={{
                display: 'flex', justifyContent: 'space-between', marginBottom: 6,
                fontSize: 12, color: 'var(--text-tertiary)',
              }}>
                <span>Today&apos;s spending</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  ${budget.todaySpent.toFixed(2)} / ${budget.maxPerDay.toFixed(2)}
                </span>
              </div>
              <div style={{
                height: 8, background: 'var(--bg-elevated-3)',
                borderRadius: 'var(--radius-full)', overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min((budget.todaySpent / budget.maxPerDay) * 100, 100)}%`,
                  background: budget.todaySpent >= budget.alertAt
                    ? budget.todaySpent >= budget.maxPerDay ? 'var(--color-error, #ef4444)' : 'var(--color-warning)'
                    : 'var(--accent)',
                  borderRadius: 'var(--radius-full)',
                  transition: 'width var(--duration-slow) ease-out',
                }} />
              </div>
              {budget.todaySpent >= budget.alertAt && budget.todaySpent < budget.maxPerDay && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginTop: 8,
                  fontSize: 12, color: 'var(--color-warning)',
                }}>
                  <AlertTriangle size={14} />
                  Spending reached ${budget.todaySpent.toFixed(2)} — alert threshold is ${budget.alertAt.toFixed(2)}
                </div>
              )}
              {budget.todaySpent >= budget.maxPerDay && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6, marginTop: 8,
                  fontSize: 12, color: 'var(--color-error, #ef4444)',
                }}>
                  <AlertTriangle size={14} />
                  Daily budget exceeded! Pipeline runs will be blocked.
                </div>
              )}
            </div>

            {/* Run budget limit */}
            <div>
              <div style={{
                display: 'flex', justifyContent: 'space-between', marginBottom: 6,
                fontSize: 12, color: 'var(--text-tertiary)',
              }}>
                <span>Run budget limit</span>
                <span style={{ fontFamily: 'var(--font-mono)' }}>
                  ${budget.maxPerRun.toFixed(2)} per run
                </span>
              </div>
              <div style={{
                height: 8, background: 'var(--bg-elevated-3)',
                borderRadius: 'var(--radius-full)', overflow: 'hidden',
              }}>
                <div style={{
                  height: '100%',
                  width: '100%',
                  background: 'var(--accent)',
                  borderRadius: 'var(--radius-full)',
                  opacity: 0.4,
                }} />
              </div>
            </div>

            {/* Test alert button */}
            <div>
              <button
                onClick={() => fireBudgetAlert({ ...budget, todaySpent: budget.alertAt })}
                style={smallButtonStyle}
              >
                <Bell size={14} strokeWidth={1.75} />
                Test Browser Alert
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 8 }}>
                Sends a browser notification to test the alert
              </span>
            </div>
          </div>
        )}

        {/* -------- Hooks (Coming Soon) -------- */}
        {activeTab === 'hooks' && (
          <ComingSoonPanel
            icon={<GitBranch size={32} style={{ color: 'var(--text-tertiary)', marginBottom: 8 }} />}
            title="Git Hooks"
            description="Pre-push validation, post-merge auto-indexing, and custom hook scripts for your repositories."
          />
        )}

        {/* -------- Notifications (Coming Soon) -------- */}
        {activeTab === 'notifications' && (
          <ComingSoonPanel
            icon={<Bell size={32} style={{ color: 'var(--text-tertiary)', marginBottom: 8 }} />}
            title="Notifications"
            description="Slack webhooks, email alerts, and custom notification rules for pipeline events."
          />
        )}
      </div>
    </div>
  );
}

/* ---------- Providers tab ---------- */

const sectionHeaderStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 500,
  color: 'var(--text-quaternary)',
  textTransform: 'uppercase',
  letterSpacing: 0.5,
  marginBottom: 8,
};

const capabilityBadgeStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 7px',
  fontSize: 10,
  fontWeight: 500,
  background: 'var(--bg-elevated-3)',
  color: 'var(--text-tertiary)',
  borderRadius: 'var(--radius-full)',
  lineHeight: '16px',
};

const statusDotStyle = (active: boolean): React.CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: active ? 'var(--color-success)' : 'var(--color-error)',
  flexShrink: 0,
});

function ProviderStatusDot({ active }: { active: boolean }) {
  return (
    <span
      role="img"
      aria-label={active ? 'Available' : 'Not available'}
      style={statusDotStyle(active)}
    />
  );
}

interface ProvidersTabProps {
  providers: ProviderInfo[];
  editingProvider: string | null;
  setEditingProvider: (name: string | null) => void;
  keyInput: string;
  setKeyInput: (value: string) => void;
  testingProvider: string | null;
  testResult: Record<string, 'ok' | 'fail'>;
  saveResult: Record<string, 'saved' | 'error'>;
  onSaveKey: (provider: string) => void;
  onTestConnection: (provider: string) => void;
}

function ProvidersTab({
  providers,
  editingProvider,
  setEditingProvider,
  keyInput,
  setKeyInput,
  testingProvider,
  testResult,
  saveResult,
  onSaveKey,
  onTestConnection,
}: ProvidersTabProps) {
  // Normalize: determine isAvailable from either new or old shape
  const normalize = (p: ProviderInfo) => ({
    ...p,
    isAvailable: p.available ?? p.isSet ?? false,
    providerType: p.type ?? 'api',
  });

  const all = providers.map(normalize);
  const cliProviders = all.filter((p) => p.providerType === 'cli');
  const apiProviders = all.filter((p) => p.providerType === 'api');

  if (providers.length === 0) {
    return (
      <div style={{
        padding: 24, background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)',
        textAlign: 'center', color: 'var(--text-tertiary)', fontSize: 13,
      }}>
        <Key size={24} style={{ color: 'var(--text-tertiary)', marginBottom: 8 }} />
        <div>No providers detected. Make sure the dashboard server is running.</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* CLI Tools section */}
      {cliProviders.length > 0 && (
        <section aria-label="CLI Tools">
          <h3 style={sectionHeaderStyle}>CLI Tools</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {cliProviders.map((p) => (
              <div
                key={p.name}
                style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '10px 14px',
                  background: 'var(--bg-elevated-2)',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                }}
              >
                <ProviderStatusDot active={p.isAvailable} />
                <span style={{ fontWeight: 500, color: 'var(--text-primary)', minWidth: 120 }}>
                  {p.displayName || p.name}
                </span>
                {p.isAvailable && p.version ? (
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)',
                  }}>
                    v{p.version.replace(/^v/i, '')}
                  </span>
                ) : !p.isAvailable ? (
                  <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                    Not installed
                  </span>
                ) : null}
                {p.capabilities && p.capabilities.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                    {p.capabilities.map((cap) => (
                      <span key={cap} style={capabilityBadgeStyle}>{cap}</span>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {/* Show setup hints for unavailable CLI tools */}
            {cliProviders.filter((p) => !p.isAvailable && p.setupHint).map((p) => (
              <div key={`${p.name}-hint`} style={{
                padding: '6px 14px 6px 34px',
                fontSize: 11,
                color: 'var(--text-tertiary)',
                fontFamily: 'var(--font-mono)',
              }}>
                {p.setupHint}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* API Providers — Coming Soon teaser for MVP2 */}
      {apiProviders.length > 0 && (
        <section aria-label="API Providers">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <h3 style={{ ...sectionHeaderStyle, marginBottom: 0 }}>API Providers</h3>
            <span style={{
              padding: '1px 8px', fontSize: 9, fontWeight: 600,
              background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.15), rgba(59, 130, 246, 0.15))',
              color: 'var(--accent)',
              borderRadius: 'var(--radius-full)',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
            }}>
              MVP 2
            </span>
          </div>
          <div style={{
            padding: '16px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            opacity: 0.7,
          }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 14 }}>
              {apiProviders.map((p) => (
                <div
                  key={p.name}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12,
                    padding: '8px 12px',
                    background: 'var(--bg-base)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 13,
                  }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%',
                    background: 'var(--text-tertiary)', opacity: 0.4,
                    flexShrink: 0,
                  }} />
                  <span style={{ fontWeight: 500, color: 'var(--text-secondary)', minWidth: 120 }}>
                    {p.displayName || p.name}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)',
                  }}>
                    {p.envVar || ''}
                  </span>
                  {p.capabilities && p.capabilities.length > 0 && (
                    <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                      {p.capabilities.map((cap) => (
                        <span key={cap} style={{ ...capabilityBadgeStyle, opacity: 0.6 }}>{cap}</span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div style={{
              fontSize: 12, color: 'var(--text-tertiary)', lineHeight: 1.6,
              padding: '10px 12px',
              background: 'var(--bg-base)',
              borderRadius: 'var(--radius-sm)',
              border: '1px dashed var(--separator)',
            }}>
              Configure API keys for OpenAI, Gemini, OpenRouter, and Ollama to use any model
              as a pipeline agent. Coming in MVP 2 alongside multi-provider orchestration.
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

/* ---------- Budget browser alert ---------- */

function fireBudgetAlert(budget: BudgetInfo) {
  const title = 'Anvil — Budget Alert';
  const body = `Daily spending reached $${budget.todaySpent.toFixed(2)} (alert threshold: $${budget.alertAt.toFixed(2)}, daily limit: $${budget.maxPerDay.toFixed(2)})`;

  // Try Notification API first
  if ('Notification' in window) {
    if (Notification.permission === 'granted') {
      new Notification(title, { body, icon: '/favicon.ico', tag: 'budget-alert' });
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          new Notification(title, { body, icon: '/favicon.ico', tag: 'budget-alert' });
        } else {
          // Fall back to window.alert
          (window as any).alert(`${title}\n\n${body}`);
        }
      });
      return; // Don't fall through while permission is being requested
    } else {
      // Permission denied — use window.alert
      (window as any).alert(`${title}\n\n${body}`);
    }
  } else {
    // No Notification API — use window.alert
    (window as any).alert(`${title}\n\n${body}`);
  }
}

/* ---------- Coming Soon panel ---------- */

function ComingSoonPanel({ icon, title, description }: {
  icon: React.ReactNode; title: string; description: string;
}) {
  return (
    <div style={{
      padding: 40, background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)', borderRadius: 'var(--radius-md)',
      textAlign: 'center',
    }}>
      {icon}
      <div style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 }}>
        {title}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text-tertiary)', maxWidth: 400, margin: '0 auto', lineHeight: 1.6, marginBottom: 16 }}>
        {description}
      </div>
      <span style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '6px 16px', fontSize: 12, fontWeight: 500,
        background: 'var(--bg-elevated-3)', color: 'var(--text-tertiary)',
        borderRadius: 'var(--radius-full)',
      }}>
        Coming Soon
      </span>
    </div>
  );
}

/* ---------- Sub-components ---------- */

function BudgetField({
  label, value, editing, onChange, prefix,
}: {
  label: string; value: number; editing: boolean;
  onChange: (v: number) => void; prefix?: string;
}) {
  return (
    <div style={{
      padding: 12, background: 'var(--bg-base)',
      borderRadius: 'var(--radius-sm)', textAlign: 'center',
    }}>
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6 }}>{label}</div>
      {editing ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
          {prefix && <span style={{ fontSize: 14, color: 'var(--text-tertiary)' }}>{prefix}</span>}
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
            style={{
              width: 80, height: 28, textAlign: 'center',
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--accent)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontSize: 16, fontWeight: 600, fontFamily: 'var(--font-mono)',
              outline: 'none',
            }}
          />
        </div>
      ) : (
        <div style={{
          fontSize: 20, fontWeight: 700, fontFamily: 'var(--font-mono)',
          color: 'var(--text-primary)',
        }}>
          {prefix}{value.toFixed(0)}
        </div>
      )}
    </div>
  );
}

/* ---------- Shared styles ---------- */

const smallButtonStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '5px 12px', fontSize: 12, fontWeight: 500,
  background: 'var(--bg-elevated-2)',
  color: 'var(--text-secondary)',
  border: '1px solid var(--separator)',
  borderRadius: 'var(--radius-sm)',
  cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
  transition: 'all var(--duration-fast) var(--ease-default)',
};

const primaryBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 16px', fontSize: 12, fontWeight: 600,
  background: 'var(--accent)', color: '#fff', border: 'none',
  borderRadius: 'var(--radius-sm)', cursor: 'pointer',
  fontFamily: 'var(--font-sans)',
};

export default SettingsPage;
