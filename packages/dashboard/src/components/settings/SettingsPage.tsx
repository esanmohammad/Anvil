import React, { useState, useEffect, useCallback } from 'react';
import { Settings, Key, DollarSign, GitBranch, Bell, AlertCircle, Check, X, RefreshCw, Pencil } from 'lucide-react';
import { ComingSoonPanel } from '../common/ComingSoonPanel.js';
import { TileSkeleton, useLoadingState } from '../common/Skeleton.js';

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

type TabId = 'providers' | 'budget' | 'hooks' | 'notifications';

const tabs: Array<{ id: TabId; label: string; icon: React.ComponentType<any>; comingSoon?: boolean }> = [
  { id: 'providers', label: 'Providers', icon: Key },
  { id: 'budget', label: 'Budget', icon: DollarSign, comingSoon: true },
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
  const { loading: providersLoading, error: providersError, loaded, errored } = useLoadingState();

  // Fetch data on mount
  useEffect(() => {
    if (!ws) return;
    ws.send(JSON.stringify({ action: 'get-providers' }));
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
          loaded();
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
          loaded();
        }
        if (msg.type === 'error' && typeof msg.payload?.message === 'string' && msg.payload.message.startsWith('discover-providers')) {
          errored(msg.payload.message);
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
        if (msg.type === 'auth-test-result' && msg.payload) {
          setTestingProvider(null);
          setTestResult((prev) => ({ ...prev, [msg.payload.provider]: msg.payload.success ? 'ok' : 'fail' }));
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, editingProvider, loaded, errored]);

  const handleSaveKey = useCallback((provider: string) => {
    if (!ws || !keyInput.trim()) return;
    // Don't fire a follow-up `get-providers` here — the server already
    // sends a fresh `providers` payload as the last step of its
    // `set-auth-key` handler. A second concurrent get-providers can race
    // the cache invalidation and clobber the fresh state with a stale
    // "Not set" snapshot, leaving the UI showing the wrong status.
    ws.send(JSON.stringify({ action: 'set-auth-key', provider, key: keyInput.trim() }));
    setEditingProvider(null);
    setKeyInput('');
  }, [ws, keyInput]);

  const handleTestConnection = useCallback((provider: string) => {
    if (!ws) return;
    setTestingProvider(provider);
    setTestResult((prev) => { const next = { ...prev }; delete next[provider]; return next; });
    ws.send(JSON.stringify({ action: 'test-auth', provider }));
  }, [ws]);

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
            loading={providersLoading}
            error={providersError}
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

        {/* -------- Budget (Coming Soon) -------- */}
        {activeTab === 'budget' && (
          <ComingSoonPanel
            icon={<DollarSign size={32} style={{ color: 'var(--text-tertiary)', marginBottom: 8 }} />}
            title="Budget"
            description="Per-run and daily spending caps, alert thresholds, and cost approval policy. Coming soon."
          />
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
  loading: boolean;
  error: string | null;
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
  loading,
  error,
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
  if (loading) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
        <section aria-label="Loading providers">
          <h3 style={sectionHeaderStyle}>CLI Tools</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <TileSkeleton />
            <TileSkeleton />
            <TileSkeleton />
          </div>
        </section>
        <section aria-label="Loading API providers">
          <h3 style={sectionHeaderStyle}>API Providers</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <TileSkeleton />
            <TileSkeleton />
          </div>
        </section>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{
        padding: 24, background: 'var(--bg-elevated-2)',
        border: '1px solid var(--color-error)', borderRadius: 'var(--radius-md)',
        textAlign: 'center', color: 'var(--color-error)', fontSize: 13,
        display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
      }}>
        <AlertCircle size={24} style={{ color: 'var(--color-error)' }} />
        <div>{error}</div>
      </div>
    );
  }

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
        <div>No providers configured.</div>
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

      {/* API Providers — live; status dot reflects whether the env var is loaded */}
      {apiProviders.length > 0 && (
        <section aria-label="API Providers">
          <h3 style={sectionHeaderStyle}>API Providers</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {apiProviders.map((p) => {
              const isEditing = editingProvider === p.name;
              const saveState = saveResult[p.name];
              const testState = testResult[p.name];
              const isTesting = testingProvider === p.name;
              return (
                <div key={p.name} style={{
                  display: 'flex', flexDirection: 'column', gap: 6,
                  padding: '10px 14px',
                  background: 'var(--bg-elevated-2)',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13,
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <ProviderStatusDot active={p.isAvailable} />
                    <span style={{ fontWeight: 500, color: 'var(--text-primary)', minWidth: 120 }}>
                      {p.displayName || p.name}
                    </span>
                    {p.envVar && (
                      <span style={{
                        fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)',
                      }}>
                        {p.envVar}
                      </span>
                    )}
                    {!p.isAvailable && !isEditing && (
                      <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                        Not set
                      </span>
                    )}
                    {p.capabilities && p.capabilities.length > 0 && (
                      <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                        {p.capabilities.map((cap) => (
                          <span key={cap} style={capabilityBadgeStyle}>{cap}</span>
                        ))}
                      </div>
                    )}
                    {!isEditing && p.envVar && (
                      <div style={{ display: 'flex', gap: 6, marginLeft: p.capabilities?.length ? 8 : 'auto' }}>
                        <button
                          onClick={() => { setEditingProvider(p.name); setKeyInput(''); }}
                          style={ghostBtnStyle}
                          aria-label={p.isAvailable ? `Replace ${p.envVar}` : `Set ${p.envVar}`}
                          title={p.isAvailable ? 'Replace key (overrides shell env)' : 'Add API key'}
                        >
                          {p.isAvailable ? <><Pencil size={11} /> Replace</> : <><Key size={11} /> Set key</>}
                        </button>
                        {p.isAvailable && (
                          <button
                            onClick={() => onTestConnection(p.name)}
                            disabled={isTesting}
                            style={{ ...ghostBtnStyle, opacity: isTesting ? 0.5 : 1 }}
                            title="Test API connectivity"
                          >
                            <RefreshCw size={11} className={isTesting ? 'spin' : ''} />
                            {isTesting ? 'Testing...' : 'Test'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Inline edit row */}
                  {isEditing && p.envVar && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center', paddingLeft: 20 }}>
                      <input
                        type="password"
                        value={keyInput}
                        onChange={(e) => setKeyInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') onSaveKey(p.name);
                          if (e.key === 'Escape') { setEditingProvider(null); setKeyInput(''); }
                        }}
                        placeholder={`Paste your ${p.envVar} value`}
                        autoFocus
                        spellCheck={false}
                        autoComplete="off"
                        style={{
                          flex: 1, padding: '6px 10px', fontSize: 12,
                          fontFamily: 'var(--font-mono)',
                          background: 'var(--bg-base)', color: 'var(--text-primary)',
                          border: '1px solid var(--separator)', borderRadius: 'var(--radius-xs)',
                          outline: 'none',
                        }}
                      />
                      <button
                        onClick={() => onSaveKey(p.name)}
                        disabled={!keyInput.trim()}
                        style={{ ...primaryBtnStyle, opacity: keyInput.trim() ? 1 : 0.4 }}
                      >
                        Save
                      </button>
                      <button
                        onClick={() => { setEditingProvider(null); setKeyInput(''); }}
                        style={ghostBtnStyle}
                      >
                        Cancel
                      </button>
                    </div>
                  )}

                  {/* Feedback row */}
                  {(saveState || testState) && (
                    <div style={{ paddingLeft: 20, fontSize: 11, display: 'flex', gap: 12 }}>
                      {saveState === 'saved' && (
                        <span style={{ color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Check size={11} /> Key saved to ~/.anvil/.env
                        </span>
                      )}
                      {saveState === 'error' && (
                        <span style={{ color: 'var(--color-error)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <X size={11} /> Failed to save key
                        </span>
                      )}
                      {testState === 'ok' && (
                        <span style={{ color: 'var(--color-success)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <Check size={11} /> Connection OK
                        </span>
                      )}
                      {testState === 'fail' && (
                        <span style={{ color: 'var(--color-error)', display: 'flex', alignItems: 'center', gap: 4 }}>
                          <X size={11} /> Connection failed — check key
                        </span>
                      )}
                    </div>
                  )}

                  {/* Setup hint when not set and not editing */}
                  {!p.isAvailable && !isEditing && p.setupHint && (
                    <div style={{
                      paddingLeft: 20, fontSize: 11, color: 'var(--text-tertiary)',
                    }}>
                      {p.setupHint}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

const ghostBtnStyle: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  padding: '4px 10px', fontSize: 11, fontWeight: 500,
  background: 'var(--bg-base)', color: 'var(--text-secondary)',
  border: '1px solid var(--separator)', borderRadius: 'var(--radius-xs)',
  cursor: 'pointer',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '4px 12px', fontSize: 11, fontWeight: 500,
  background: 'var(--accent)', color: '#fff',
  border: 'none', borderRadius: 'var(--radius-xs)',
  cursor: 'pointer',
};

export default SettingsPage;
