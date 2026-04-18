import React, { useState } from 'react';

/**
 * Model picker — lets user choose Claude model and presets.
 *
 * Presets: Lean ($), Balanced ($$), Smart ($$$)
 * Models are passed in via props from the provider registry — no hardcoded IDs.
 * Per-persona overrides (advanced, expandable).
 */

export interface ModelOption {
  id: string;
  label: string;
  tier?: 'fast' | 'balanced' | 'powerful';
}

export interface ModelConfig {
  model: string;
  preset?: 'lean' | 'balanced' | 'smart';
  personaOverrides?: Record<string, string>;
}

export interface ModelPickerProps {
  value: ModelConfig;
  onChange: (config: ModelConfig) => void;
  /** Available models from provider registry. Falls back to empty if not provided. */
  models?: ModelOption[];
}

/** Map presets to provider registry tier names */
const PRESET_TO_TIER: Record<string, string> = {
  lean: 'fast',
  balanced: 'balanced',
  smart: 'powerful',
};

const PRESETS: { id: 'lean' | 'balanced' | 'smart'; label: string; cost: string }[] = [
  { id: 'lean', label: 'Lean', cost: '$' },
  { id: 'balanced', label: 'Balanced', cost: '$$' },
  { id: 'smart', label: 'Smart', cost: '$$$' },
];

const PERSONAS = ['clarifier', 'analyst', 'architect', 'engineer', 'tester', 'lead', 'reviewer', 'shipper'];

export function ModelPicker({ value, onChange, models = [] }: ModelPickerProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const handlePreset = (preset: typeof PRESETS[number]) => {
    // Find the best model matching this preset's tier
    const targetTier = PRESET_TO_TIER[preset.id];
    const match = models.find(m => m.tier === targetTier) ?? models[0];
    if (match) {
      onChange({ model: match.id, preset: preset.id, personaOverrides: value.personaOverrides });
    }
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
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
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
                {models.map((m) => (
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
