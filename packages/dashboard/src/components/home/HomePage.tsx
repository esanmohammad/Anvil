import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Hammer, Bug, Search, ChevronDown, ArrowRight, AlertTriangle, GitBranch } from 'lucide-react';

export type ActionMode = 'build' | 'fix' | 'research';

export interface HomePageProps {
  projects: Array<{
    name: string;
    title: string;
    owner: string;
    lifecycle: string;
    repoCount: number;
    repos?: Array<{ name: string; language: string }>;
  }>;
  features: Array<{
    slug: string;
    project: string;
    description: string;
    status: string;
    totalCost: number;
    updatedAt: string;
  }>;
  selectedProject: string | null;
  onSelectProject: (name: string) => void;
  onStartFeature: (feature: string, options: {
    project: string;
    model: string;
    provider?: string;
    skipClarify?: boolean;
    skipShip?: boolean;
    baseBranch?: string;
  }) => void;
  onQuickAction?: (action: { type: string; description: string; project: string; model: string }) => void;
  onResumeFeature?: (project: string, slug: string) => void;
  availableModels?: {
    providers: Array<{
      name: string;
      available: boolean;
      models: string[];
      tier: string;
      envVar?: string;
    }>;
    defaultModel: string;
  } | null;
  ws?: WebSocket | null;
}

const modeConfig: Array<{
  id: ActionMode;
  label: string;
  icon: React.ComponentType<{ size?: number; strokeWidth?: number }>;
  placeholder: string;
  actionType: string;
}> = [
  { id: 'build', label: 'Build', icon: Hammer, placeholder: 'Describe your feature, bug fix, or research question...', actionType: 'run-pipeline' },
  { id: 'fix', label: 'Fix', icon: Bug, placeholder: 'Describe the bug to fix...', actionType: 'run-fix' },
  { id: 'research', label: 'Research', icon: Search, placeholder: 'What to research or explore...', actionType: 'run-spike' },
];

function relativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ---------------------------------------------------------------------------
// Custom dropdown component
// ---------------------------------------------------------------------------
interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
  suffix?: string;
  group?: string;
}

function CustomDropdown({
  value,
  options,
  onChange,
  placeholder,
  minWidth = 100,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  minWidth?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [open]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setOpen(false);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      setOpen((o) => !o);
    }
  }, []);

  const selected = options.find((o) => o.value === value);
  const groups = useMemo(() => {
    const map = new Map<string, DropdownOption[]>();
    for (const opt of options) {
      const group = opt.group ?? '';
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(opt);
    }
    return map;
  }, [options]);

  return (
    <div ref={ref} style={{ position: 'relative', minWidth }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        onKeyDown={handleKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          height: 32,
          padding: '0 28px 0 12px',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-secondary)',
          fontSize: 12,
          fontFamily: 'var(--font-sans)',
          cursor: 'pointer',
          outline: 'none',
          whiteSpace: 'nowrap',
          transition: 'border-color var(--duration-fast) var(--ease-default)',
          width: '100%',
        }}
      >
        {selected?.label ?? placeholder ?? 'Select...'}
        <ChevronDown
          size={12}
          strokeWidth={2}
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-tertiary)',
            pointerEvents: 'none',
          }}
        />
      </button>
      {open && (
        <div
          role="listbox"
          aria-label="Options"
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            minWidth: 180,
            marginTop: 4,
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            boxShadow: 'var(--shadow-lg)',
            zIndex: 100,
            maxHeight: 280,
            overflowY: 'auto',
            padding: '4px 0',
          }}
        >
          {Array.from(groups.entries()).map(([groupName, groupOptions]) => (
            <div key={groupName}>
              {groupName && (
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    color: 'var(--text-tertiary)',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    padding: '6px 12px 2px',
                  }}
                >
                  {groupName}
                </div>
              )}
              {groupOptions.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={opt.value === value}
                  aria-disabled={opt.disabled}
                  onClick={() => {
                    if (!opt.disabled) {
                      onChange(opt.value);
                      setOpen(false);
                    }
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '6px 12px',
                    background: opt.value === value ? 'var(--accent-muted)' : 'transparent',
                    border: 'none',
                    color: opt.disabled ? 'var(--text-tertiary)' : 'var(--text-primary)',
                    fontSize: 12,
                    fontFamily: 'var(--font-sans)',
                    cursor: opt.disabled ? 'not-allowed' : 'pointer',
                    textAlign: 'left',
                    opacity: opt.disabled ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!opt.disabled) e.currentTarget.style.background = 'var(--bg-elevated-3)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = opt.value === value ? 'var(--accent-muted)' : 'transparent';
                  }}
                >
                  <span>{opt.label}</span>
                  {opt.suffix && (
                    <span style={{ fontSize: 10, color: 'var(--text-tertiary)', marginLeft: 8 }}>
                      {opt.suffix}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const statusColors: Record<string, string> = {
  'in-progress': 'var(--color-warning)',
  completed: 'var(--color-success)',
  failed: 'var(--color-error)',
};

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function HomePage({
  projects,
  features,
  selectedProject,
  onSelectProject,
  onStartFeature,
  onQuickAction,
  onResumeFeature,
  availableModels,
  ws,
}: HomePageProps) {
  const [text, setText] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [actionMode, setActionMode] = useState<ActionMode>('build');
  const [budget, setBudget] = useState<{ used: number; limit: number } | null>(null);
  const [branches, setBranches] = useState<string[]>(['main']);
  const [baseBranch, setBaseBranch] = useState('main');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Set default model when availableModels arrives
  useEffect(() => {
    if (availableModels?.defaultModel && !selectedModel) {
      setSelectedModel(availableModels.defaultModel);
    }
  }, [availableModels, selectedModel]);

  // Fetch budget status and branches when project changes
  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !selectedProject) return;
    const handler = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'budget-status' && msg.payload) {
          const p = msg.payload;
          if (p.maxPerDay || p.dailyLimit) {
            setBudget({ used: p.todaySpent ?? p.dailyUsed ?? 0, limit: p.maxPerDay ?? p.dailyLimit ?? 200 });
          }
        }
        if (msg.type === 'branches' && msg.payload) {
          setBranches(msg.payload.branches || ['main']);
          setBaseBranch(msg.payload.default || 'main');
        }
      } catch { /* ignore non-JSON */ }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ action: 'get-budget-status', project: selectedProject }));
    ws.send(JSON.stringify({ action: 'get-branches', project: selectedProject }));
    return () => ws.removeEventListener('message', handler);
  }, [ws, selectedProject]);

  // Derive provider from selected model
  const selectedProvider = useMemo(() => {
    if (!availableModels || !selectedModel) return null;
    for (const p of availableModels.providers) {
      if (p.models.includes(selectedModel)) return p;
    }
    return null;
  }, [availableModels, selectedModel]);

  const providerUnavailable = selectedProvider ? !selectedProvider.available : false;

  const currentMode = modeConfig.find((m) => m.id === actionMode)!;
  const canSubmit = selectedProject && text.trim().length > 0 && selectedModel && !providerUnavailable;

  // Build model dropdown options — CLI providers active, API providers shown as MVP2
  const modelOptions: DropdownOption[] = useMemo(() => {
    if (!availableModels) return [];
    const opts: DropdownOption[] = [];
    for (const provider of availableModels.providers) {
      const isCli = provider.tier === 'agentic' || provider.name === 'claude' || provider.name === 'gemini-cli';
      for (const model of provider.models) {
        opts.push({
          value: model,
          label: model,
          group: isCli ? provider.name : `${provider.name} (MVP 2)`,
          disabled: isCli ? !provider.available : true,
          suffix: !isCli ? 'coming soon' : !provider.available ? 'not installed' : undefined,
        });
      }
    }
    return opts;
  }, [availableModels]);

  // Build mode dropdown options
  const modeOptions: DropdownOption[] = modeConfig.map((m) => ({
    value: m.id,
    label: m.label,
  }));

  // Build project dropdown options
  const projectOptions: DropdownOption[] = projects.map((p) => ({
    value: p.name,
    label: p.title || p.name,
  }));

  // Build branch dropdown options
  const branchOptions: DropdownOption[] = branches.map((b) => ({
    value: b,
    label: b,
  }));

  const handleSubmit = useCallback(() => {
    if (!canSubmit) return;
    const trimmed = text.trim();

    if (actionMode === 'build') {
      onStartFeature(trimmed, {
        project: selectedProject!,
        model: selectedModel,
        provider: selectedProvider?.name,
        baseBranch,
      });
    } else if (onQuickAction) {
      onQuickAction({
        type: currentMode.actionType,
        description: trimmed,
        project: selectedProject!,
        model: selectedModel,
      });
    }
    setText('');
  }, [canSubmit, text, actionMode, selectedProject, selectedModel, selectedProvider, onStartFeature, onQuickAction, currentMode]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canSubmit) {
        e.preventDefault();
        handleSubmit();
      }
    },
    [canSubmit, handleSubmit],
  );

  const recentFeatures = useMemo(
    () => features
      .slice()
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      .slice(0, 5),
    [features],
  );

  const inProgressFeatures = useMemo(
    () => features.filter((f) => f.status === 'in-progress'),
    [features],
  );

  // Empty state — no projects configured
  if (projects.length === 0) {
    return (
      <div className="page-enter" style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        padding: '80px 24px 48px',
        maxWidth: 720,
        margin: '0 auto',
        width: '100%',
      }}>
        <div style={{
          textAlign: 'center',
          padding: '48px 24px',
          color: 'var(--text-tertiary)',
          fontSize: 14,
        }}>
          <p style={{ marginBottom: 12, fontSize: 20, color: 'var(--text-primary)', fontWeight: 700 }}>
            Welcome to Anvil
          </p>
          <p style={{ fontSize: 13, marginBottom: 20, color: 'var(--text-secondary)' }}>
            Create a project by adding a{' '}
            <code style={{
              fontFamily: 'var(--font-mono)',
              background: 'var(--bg-elevated-2)',
              padding: '2px 6px',
              borderRadius: 4,
              fontSize: 12,
            }}>
              factory.yaml
            </code>{' '}
            file:
          </p>
          <pre style={{
            textAlign: 'left',
            display: 'inline-block',
            padding: '16px 20px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            fontSize: 12,
            lineHeight: 1.7,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-secondary)',
          }}>
{`~/.anvil/projects/<name>/factory.yaml

version: 1
project: my-project
title: My Project
workspace: /path/to/repos

repos:
  - name: backend
    path: ./backend
    language: go
  - name: frontend
    path: ./frontend
    language: typescript

budget:
  max_per_run: 100
  max_per_day: 200
  alert_at: 80`}
          </pre>
        </div>
      </div>
    );
  }

  return (
    <div className="page-enter" style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '64px 24px 48px',
      maxWidth: 720,
      margin: '0 auto',
      width: '100%',
    }}>
      {/* Heading */}
      <h1 style={{
        fontSize: 24,
        fontWeight: 700,
        color: 'var(--text-primary)',
        marginBottom: 24,
        letterSpacing: '-0.02em',
        fontFamily: 'var(--font-sans)',
        textAlign: 'center',
      }}>
        What are you building?
      </h1>

      {/* Textarea */}
      <div style={{ width: '100%', marginBottom: 12 }}>
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={currentMode.placeholder}
          rows={4}
          aria-label="Describe your feature"
          style={{
            width: '100%',
            minHeight: 120,
            padding: '16px 20px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            color: 'var(--text-primary)',
            fontSize: 14,
            fontFamily: 'var(--font-sans)',
            lineHeight: 1.6,
            outline: 'none',
            resize: 'vertical',
            transition: 'border-color var(--duration-fast) var(--ease-default), box-shadow var(--duration-fast) var(--ease-default)',
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'var(--accent)';
            e.currentTarget.style.boxShadow = '0 0 0 3px var(--accent-subtle), var(--shadow-glow)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'var(--separator)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        />
      </div>

      {/* Selectors row */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        marginBottom: 12,
        flexWrap: 'wrap',
      }}>
        {/* Mode dropdown */}
        <CustomDropdown
          value={actionMode}
          options={modeOptions}
          onChange={(v) => setActionMode(v as ActionMode)}
          minWidth={90}
        />

        {/* Model dropdown */}
        {modelOptions.length > 0 ? (
          <CustomDropdown
            value={selectedModel}
            options={modelOptions}
            onChange={setSelectedModel}
            placeholder="Model..."
            minWidth={160}
          />
        ) : (
          <div style={{
            height: 32,
            padding: '0 12px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-tertiary)',
            fontSize: 12,
            fontFamily: 'var(--font-sans)',
            display: 'flex',
            alignItems: 'center',
          }}>
            Loading models...
          </div>
        )}

        {/* Project dropdown */}
        <CustomDropdown
          value={selectedProject ?? ''}
          options={projectOptions}
          onChange={onSelectProject}
          placeholder="Project..."
          minWidth={120}
        />

        {/* Branch dropdown */}
        {selectedProject && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <GitBranch size={12} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)', flexShrink: 0 }} />
            <CustomDropdown
              value={baseBranch}
              options={branchOptions}
              onChange={setBaseBranch}
              placeholder="Branch..."
              minWidth={100}
            />
          </div>
        )}

        {/* Spacer pushes button right */}
        <div style={{ flex: 1 }} />

        {/* Submit button */}
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          aria-label="Start feature"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            height: 32,
            padding: '0 16px',
            background: canSubmit ? 'var(--accent)' : 'var(--bg-elevated-3)',
            color: canSubmit ? 'var(--text-inverse)' : 'var(--text-tertiary)',
            border: 'none',
            borderRadius: 'var(--radius-sm)',
            fontSize: 13,
            fontWeight: 500,
            fontFamily: 'var(--font-sans)',
            cursor: canSubmit ? 'pointer' : 'not-allowed',
            transition: 'all var(--duration-fast) var(--ease-default)',
            whiteSpace: 'nowrap',
          }}
        >
          <kbd style={{
            fontSize: 11,
            opacity: 0.8,
            fontFamily: 'var(--font-sans)',
          }}>
            {'\u2318'} Enter
          </kbd>
          <ArrowRight size={14} strokeWidth={2} />
        </button>
      </div>

      {/* Missing provider warning */}
      {providerUnavailable && selectedProvider && (
        <div
          role="alert"
          style={{
            width: '100%',
            padding: '10px 14px',
            background: 'rgba(251,191,36,0.08)',
            border: '1px solid rgba(251,191,36,0.25)',
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            alignItems: 'flex-start',
            gap: 10,
            marginBottom: 12,
          }}
        >
          <AlertTriangle size={16} strokeWidth={1.75} style={{ color: 'var(--color-warning)', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <strong>{selectedProvider.name}</strong> API key not configured.
            {selectedProvider.envVar && (
              <span style={{ color: 'var(--text-tertiary)' }}> ({selectedProvider.envVar})</span>
            )}
            <br />
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              Go to <strong>Settings</strong> to add it.
            </span>
          </div>
        </div>
      )}

      {/* Budget indicator */}
      {budget && (
        <div style={{ width: '100%', marginBottom: 16 }}>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 4,
          }}>
            <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
              Today: ${budget.used.toFixed(2)} / ${budget.limit.toFixed(2)}
            </span>
          </div>
          <div style={{
            height: 3,
            background: 'var(--bg-elevated-3)',
            borderRadius: 'var(--radius-full)',
            overflow: 'hidden',
          }}>
            <div style={{
              height: '100%',
              width: `${Math.min((budget.used / budget.limit) * 100, 100)}%`,
              background: budget.used / budget.limit > 0.9 ? 'var(--color-error)' : budget.used / budget.limit > 0.7 ? 'var(--color-warning)' : 'var(--accent)',
              borderRadius: 'var(--radius-full)',
              transition: 'width var(--duration-slow) ease-out',
            }} />
          </div>
        </div>
      )}

      {/* Continue — in-progress features */}
      {inProgressFeatures.length > 0 && (
        <div style={{ width: '100%', marginBottom: 24, marginTop: 16 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-tertiary)',
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            Continue
          </div>
          <div className="stagger" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {inProgressFeatures.slice(0, 3).map((f) => (
              <button
                key={f.slug}
                type="button"
                onClick={() => onResumeFeature?.(f.project, f.slug)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  width: '100%',
                  padding: '8px 12px',
                  background: 'var(--bg-elevated-2)',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontFamily: 'var(--font-sans)',
                  color: 'var(--text-primary)',
                  fontSize: 13,
                  transition: 'all var(--duration-fast) var(--ease-default)',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--separator)';
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: 'var(--color-warning)',
                  flexShrink: 0,
                  animation: 'pulse 2s ease-in-out infinite',
                }} />
                <span style={{ flex: 1, fontWeight: 500 }}>{f.slug}</span>
                <span style={{
                  fontSize: 11,
                  color: 'var(--text-tertiary)',
                  padding: '1px 8px',
                  borderRadius: 'var(--radius-xs)',
                  background: 'var(--bg-elevated-3)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {f.project}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {relativeTime(f.updatedAt)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Recent features — compact list */}
      {recentFeatures.length > 0 && (
        <div style={{ width: '100%', marginTop: inProgressFeatures.length > 0 ? 0 : 24 }}>
          <div style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--text-tertiary)',
            marginBottom: 8,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
          }}>
            Recent
          </div>
          <div className="stagger" style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {recentFeatures.map((f) => {
              const statusColor = statusColors[f.status] ?? 'var(--text-tertiary)';
              return (
                <button
                  key={`${f.project}-${f.slug}`}
                  type="button"
                  onClick={() => onResumeFeature?.(f.project, f.slug)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    width: '100%',
                    padding: '7px 12px',
                    background: 'transparent',
                    border: '1px solid transparent',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    fontFamily: 'var(--font-sans)',
                    color: 'var(--text-primary)',
                    fontSize: 13,
                    transition: 'all var(--duration-fast) var(--ease-default)',
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-elevated-2)';
                    e.currentTarget.style.borderColor = 'var(--separator)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.borderColor = 'transparent';
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%',
                    background: statusColor,
                    flexShrink: 0,
                  }} />
                  <span style={{ flex: 1, fontWeight: 500 }}>{f.slug}</span>
                  <span style={{
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    padding: '1px 6px',
                    borderRadius: 'var(--radius-xs)',
                    background: 'var(--bg-elevated-3)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {f.project}
                  </span>
                  <span style={{
                    fontSize: 11,
                    color: statusColor,
                    textTransform: 'capitalize',
                    minWidth: 64,
                  }}>
                    {f.status.replace('-', ' ')}
                  </span>
                  {f.totalCost > 0 && (
                    <span style={{
                      fontSize: 11,
                      fontFamily: 'var(--font-mono)',
                      color: 'var(--text-tertiary)',
                      minWidth: 40,
                      textAlign: 'right',
                    }}>
                      ${f.totalCost.toFixed(2)}
                    </span>
                  )}
                  <span style={{
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    minWidth: 52,
                    textAlign: 'right',
                  }}>
                    {relativeTime(f.updatedAt)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

export default HomePage;
