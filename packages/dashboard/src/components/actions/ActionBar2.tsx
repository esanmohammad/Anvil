import React, { useState } from 'react';

/**
 * Quick actions bar — Phase 6 from Hivemind parity plan.
 *
 * Action types: Build Feature, Fix Bug, Review Code, Research Spike.
 * Each has its own tab, description textarea, and submit button.
 */

export type QuickActionType = 'run-pipeline' | 'run-fix' | 'run-review' | 'run-spike';

export interface QuickAction {
  type: QuickActionType;
  description: string;
  project: string;
  options?: Record<string, unknown>;
}

export interface ActionBar2Props {
  projectName: string | null;
  onAction: (action: QuickAction) => void;
  disabled?: boolean;
}

const ACTION_TABS: { id: QuickActionType; label: string; icon: string; placeholder: string }[] = [
  { id: 'run-pipeline', label: 'Build', icon: '\u2728', placeholder: 'Describe the feature to build...' },
  { id: 'run-fix', label: 'Fix', icon: '\u{1F527}', placeholder: 'Describe the bug to fix...' },
  { id: 'run-review', label: 'Review', icon: '\u{1F440}', placeholder: 'What to review (PR URL or description)...' },
  { id: 'run-spike', label: 'Spike', icon: '\u{1F50D}', placeholder: 'What to research (read-only)...' },
];

export function ActionBar2({ projectName, onAction, disabled }: ActionBar2Props) {
  const [activeTab, setActiveTab] = useState<QuickActionType>('run-pipeline');
  const [description, setDescription] = useState('');

  const currentTab = ACTION_TABS.find((t) => t.id === activeTab)!;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = description.trim();
    if (!trimmed || !projectName) return;
    onAction({ type: activeTab, description: trimmed, project: projectName });
    setDescription('');
  };

  return (
    <div style={{
      background: 'var(--bg-panel)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      {/* Tabs */}
      <div style={{
        display: 'flex',
        borderBottom: '1px solid var(--border-default)',
      }}>
        {ACTION_TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1,
              padding: '6px 8px',
              background: activeTab === tab.id ? 'var(--bg-card)' : 'transparent',
              border: 'none',
              borderBottom: activeTab === tab.id ? '2px solid var(--color-accent)' : '2px solid transparent',
              color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-muted)',
              fontSize: '11px',
              fontWeight: activeTab === tab.id ? 600 : 400,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 4,
            }}
          >
            <span>{tab.icon}</span>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Input area */}
      <form onSubmit={handleSubmit} style={{ padding: 'var(--space-sm)' }}>
        <textarea
          placeholder={currentTab.placeholder}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={disabled || !projectName}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmit(e);
            }
          }}
          style={{
            width: '100%',
            minHeight: 60,
            resize: 'vertical',
            background: 'var(--bg-input)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-sm)',
            padding: 'var(--space-sm)',
            color: 'var(--text-primary)',
            fontSize: '12px',
            fontFamily: 'var(--font-sans)',
            outline: 'none',
          }}
        />
        {!projectName && (
          <div style={{ fontSize: '10px', color: 'var(--color-error)', marginTop: 4 }}>
            Select a project first
          </div>
        )}
      </form>
    </div>
  );
}

export default ActionBar2;
