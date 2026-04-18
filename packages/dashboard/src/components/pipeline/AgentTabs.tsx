import React from 'react';

/**
 * Agent tabs — Hivemind pattern, inline styles only.
 *
 * Horizontal tab bar with agent name + cost.
 * Running: pulsing dot.
 * Selected: emphasized background + border.
 * Fix agents shown with different color (error).
 */

export interface AgentTabData {
  id: string;
  name: string;
  cost: number;
  status: 'running' | 'completed' | 'failed' | 'idle';
  isFix?: boolean;
}

export interface AgentTabsProps {
  agents: AgentTabData[];
  selectedAgent: string | null;
  onSelectAgent: (id: string) => void;
}

export function AgentTabs({ agents, selectedAgent, onSelectAgent }: AgentTabsProps) {
  if (agents.length <= 1) return null;

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: 4,
      padding: '6px 16px',
      background: 'var(--bg-panel)',
      borderBottom: '1px solid var(--border-default)',
      overflowX: 'auto',
      flexShrink: 0,
    }}>
      {agents.map((agent) => {
        const isSelected = agent.id === selectedAgent;
        const isRunning = agent.status === 'running';
        const isError = agent.status === 'failed';
        const isFix = agent.isFix;

        return (
          <button
            key={agent.id}
            onClick={() => onSelectAgent(agent.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 10px',
              borderRadius: 'var(--radius-sm)',
              fontSize: 12,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              fontFamily: 'var(--font-sans)',
              transition: 'all 0.15s ease',
              background: isSelected ? 'var(--bg-hover)' : 'transparent',
              border: isSelected ? '1px solid var(--border-default)' : '1px solid transparent',
              color: isSelected
                ? 'var(--text-primary)'
                : isFix
                  ? 'var(--color-warning)'
                  : 'var(--text-secondary)',
            }}
          >
            {/* Running pulsing dot */}
            {isRunning && (
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--color-success)',
                animation: 'ff-pulse 1.5s ease-in-out infinite',
                flexShrink: 0,
              }} />
            )}
            {/* Error dot */}
            {isError && (
              <span style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--color-error)',
                flexShrink: 0,
              }} />
            )}
            <span>{agent.name}</span>
            {/* Cost */}
            {agent.cost > 0 && (
              <span style={{
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-muted)',
              }}>
                ${agent.cost.toFixed(2)}
              </span>
            )}
          </button>
        );
      })}

      <style>{`
        @keyframes ff-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
    </div>
  );
}

export default AgentTabs;
