import React, { useState } from 'react';

/**
 * Model picker — lets user choose Claude model and presets.
 *
 * Presets: Lean ($), Balanced ($$), Smart ($$$)
 * Explicit models: claude-opus-4, claude-sonnet-4, claude-haiku-4-5
 * Per-persona overrides (advanced, expandable).
 */

export interface ModelConfig {
  model: string;
  preset?: 'lean' | 'balanced' | 'smart';
  personaOverrides?: Record<string, string>;
}

export interface ModelPickerProps {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
}

const PRESETS: { id: 'lean' | 'balanced' | 'smart'; label: string; cost: string; model: string }[] = [
  { id: 'lean', label: 'Lean', cost: '$', model: 'claude-haiku-4-5' },
  { id: 'balanced', label: 'Balanced', cost: '$$', model: 'claude-sonnet-4' },
  { id: 'smart', label: 'Smart', cost: '$$$', model: 'claude-opus-4' },
];

const MODELS = [
  { id: 'claude-opus-4', label: 'Claude Opus 4', tier: 3, context: '200k' },
  { id: 'claude-sonnet-4', label: 'Claude Sonnet 4', tier: 2, context: '200k' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 1, context: '200k' },
];

const PERSONAS = ['clarifier', 'analyst', 'architect', 'engineer', 'tester', 'lead', 'reviewer', 'shipper'];

export function ModelPicker({ value, onChange }: ModelPickerProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handlePreset = (preset: typeof PRESETS[number]) => {
    onChange({ model: preset.model, preset: preset.id, personaOverrides: value.personaOverrides });
  };

  const handleModelSelect = (model: string) => {
    onChange({ model, preset: undefined, personaOverrides: value.personaOverrides });
  };

  const handlePersonaOverride = (persona: string, model: string) => {
    const overrides = { ...(value.personaOverrides ?? {}), [persona]: model };
    if (!model) delete overrides[persona];
    onChange({ ...value, personaOverrides: Object.keys(overrides).length > 0 ? overrides : undefined });
  };

  return (
    <div style={{ fontSize: 'var(--text-sm)' }}>
      <label style={{ display: 'block', color: 'var(--text-secondary)', marginBottom: 'var(--space-xs)', fontSize: 'var(--text-xs)' }}>
        Model
      </label>

      {/* Preset buttons */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--space-sm)' }}>
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            onClick={() => handlePreset(preset)}
            style={{
              flex: 1,
              padding: '6px 10px',
              background: value.preset === preset.id ? 'var(--color-accent)' : 'var(--bg-card)',
              border: `1px solid ${value.preset === preset.id ? 'var(--color-accent)' : 'var(--border-default)'}`,
              borderRadius: 'var(--radius-sm)',
              color: value.preset === preset.id ? '#fff' : 'var(--text-primary)',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: value.preset === preset.id ? 600 : 400,
              textAlign: 'center',
            }}
          >
            {preset.label} <span style={{ opacity: 0.6 }}>{preset.cost}</span>
          </button>
        ))}
      </div>

      {/* Explicit model dropdown */}
      <select
        value={value.model}
        onChange={(e) => handleModelSelect(e.target.value)}
        style={{
          width: '100%',
          padding: '6px 8px',
          background: 'var(--bg-input)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-primary)',
          fontSize: '12px',
          fontFamily: 'var(--font-mono)',
          outline: 'none',
          cursor: 'pointer',
        }}
      >
        {MODELS.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label} ({m.context} ctx)
          </option>
        ))}
      </select>

      {/* Advanced: per-persona overrides */}
      <button
        type="button"
        onClick={() => setShowAdvanced(!showAdvanced)}
        style={{
          marginTop: 'var(--space-sm)',
          padding: 0,
          background: 'transparent',
          border: 'none',
          color: 'var(--text-muted)',
          fontSize: '11px',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
        }}
      >
        <span style={{
          transform: showAdvanced ? 'rotate(90deg)' : 'rotate(0deg)',
          transition: 'transform var(--transition-fast)',
          display: 'inline-block',
        }}>
          \u25B8
        </span>
        Per-persona overrides
      </button>

      {showAdvanced && (
        <div style={{
          marginTop: 'var(--space-xs)',
          padding: 'var(--space-sm)',
          background: 'var(--bg-root)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--border-default)',
        }}>
          {PERSONAS.map((persona) => (
            <div key={persona} style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 4,
            }}>
              <span style={{
                width: 80,
                fontSize: '11px',
                color: 'var(--text-secondary)',
                textTransform: 'capitalize',
              }}>
                {persona}
              </span>
              <select
                value={value.personaOverrides?.[persona] ?? ''}
                onChange={(e) => handlePersonaOverride(persona, e.target.value)}
                style={{
                  flex: 1,
                  padding: '2px 6px',
                  background: 'var(--bg-input)',
                  border: '1px solid var(--border-default)',
                  borderRadius: 'var(--radius-sm)',
                  color: 'var(--text-primary)',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  outline: 'none',
                }}
              >
                <option value="">Default ({value.model})</option>
                {MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default ModelPicker;
