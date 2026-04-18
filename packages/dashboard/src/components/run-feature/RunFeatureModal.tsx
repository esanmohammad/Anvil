import React, { useState, useRef, useEffect } from 'react';
import { ModelPicker } from '../pipeline/ModelPicker.js';
import type { ModelConfig } from '../pipeline/ModelPicker.js';
import { GitBranch } from 'lucide-react';

export interface RunFeatureModalProps {
  isOpen: boolean;
  projectName: string | null;
  ws?: WebSocket | null;
  onSubmit: (feature: string, options?: {
    skipClarify?: boolean;
    skipShip?: boolean;
    model?: string;
    models?: Record<string, string>;
    approvalRequired?: boolean;
    baseBranch?: string;
  }) => void;
  onClose: () => void;
}

export function RunFeatureModal({ isOpen, projectName, ws, onSubmit, onClose }: RunFeatureModalProps) {
  const [feature, setFeature] = useState('');
  const [skipClarify, setSkipClarify] = useState(false);
  const [skipShip, setSkipShip] = useState(false);
  const [approvalRequired, setApprovalRequired] = useState(false);
  const [modelConfig, setModelConfig] = useState<ModelConfig>({
    model: 'claude-sonnet-4',
    preset: 'balanced',
  });
  const [branches, setBranches] = useState<string[]>(['main']);
  const [baseBranch, setBaseBranch] = useState('main');
  const [loadingBranches, setLoadingBranches] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch branches when modal opens
  useEffect(() => {
    if (!isOpen || !ws || !projectName) return;
    setFeature('');
    setLoadingBranches(true);
    ws.send(JSON.stringify({ action: 'get-branches', project: projectName }));
    setTimeout(() => inputRef.current?.focus(), 100);
  }, [isOpen, ws, projectName]);

  // Listen for branch data
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'branches' && msg.payload) {
          setBranches(msg.payload.branches || ['main']);
          setBaseBranch(msg.payload.default || 'main');
          setLoadingBranches(false);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = feature.trim();
    if (!trimmed) return;
    onSubmit(trimmed, {
      skipClarify,
      skipShip,
      model: modelConfig.model,
      models: modelConfig.personaOverrides,
      approvalRequired,
      baseBranch,
    });
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.6)',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: 'var(--bg-panel)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          padding: 'var(--space-lg)',
          width: 520,
          maxWidth: '90vw',
          maxHeight: '85vh',
          overflow: 'auto',
        }}
      >
        <h2 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: 'var(--space-md)' }}>
          Run Feature
        </h2>

        {!projectName && (
          <div
            style={{
              padding: 'var(--space-sm) var(--space-md)',
              background: 'rgba(239,68,68,0.1)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-error)',
              fontSize: 'var(--text-sm)',
              marginBottom: 'var(--space-md)',
            }}
          >
            Please select a project first using the dropdown in the header.
          </div>
        )}

        <form onSubmit={handleSubmit}>
          {/* Feature description */}
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <label
              htmlFor="feature-input"
              style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--space-xs)' }}
            >
              Project: <strong>{projectName ?? 'None selected'}</strong>
            </label>
            <input
              ref={inputRef}
              id="feature-input"
              className="input"
              type="text"
              placeholder="Describe the feature to build..."
              value={feature}
              onChange={(e) => setFeature(e.target.value)}
              style={{ width: '100%' }}
              disabled={!projectName}
            />
          </div>

          {/* Base branch selector */}
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <label
              htmlFor="branch-select"
              style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 'var(--text-sm)', color: 'var(--text-secondary)',
                marginBottom: 'var(--space-xs)',
              }}
            >
              <GitBranch size={13} strokeWidth={1.75} />
              Base branch
            </label>
            <select
              id="branch-select"
              value={baseBranch}
              onChange={(e) => setBaseBranch(e.target.value)}
              disabled={loadingBranches}
              style={{
                width: '100%',
                height: 34,
                padding: '0 10px',
                background: 'var(--bg-card, var(--bg-elevated-2))',
                border: '1px solid var(--border-default, var(--separator))',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)',
                fontSize: 13,
                fontFamily: 'var(--font-mono)',
                cursor: loadingBranches ? 'wait' : 'pointer',
                appearance: 'auto',
              }}
            >
              {loadingBranches ? (
                <option>Loading branches...</option>
              ) : (
                branches.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))
              )}
            </select>
          </div>

          {/* Model picker */}
          <div style={{ marginBottom: 'var(--space-md)' }}>
            <ModelPicker value={modelConfig} onChange={setModelConfig} />
          </div>

          {/* Options */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-sm)', marginBottom: 'var(--space-lg)', fontSize: 'var(--text-sm)' }}>
            <div style={{ display: 'flex', gap: 'var(--space-md)' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={skipClarify}
                  onChange={(e) => setSkipClarify(e.target.checked)}
                />
                Skip clarify
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={skipShip}
                  onChange={(e) => setSkipShip(e.target.checked)}
                />
                Skip ship
              </label>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-xs)', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={approvalRequired}
                onChange={(e) => setApprovalRequired(e.target.checked)}
              />
              Require approval between stages
            </label>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--space-sm)' }}>
            <button
              type="button"
              onClick={onClose}
              style={{
                padding: 'var(--space-xs) var(--space-md)',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)',
                cursor: 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!feature.trim() || !projectName}
              style={{
                padding: 'var(--space-xs) var(--space-md)',
                background: feature.trim() && projectName ? 'var(--color-accent)' : 'var(--bg-card)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-sm)',
                color: feature.trim() && projectName ? '#fff' : 'var(--text-muted)',
                cursor: feature.trim() && projectName ? 'pointer' : 'not-allowed',
                fontWeight: 600,
              }}
            >
              Run
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default RunFeatureModal;
