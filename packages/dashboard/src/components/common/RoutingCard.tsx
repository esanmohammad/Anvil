import { useEffect, useState } from 'react';
import { Map as MapIcon, AlertTriangle } from 'lucide-react';

export type RoutingFlow = 'build' | 'fix' | 'research' | 'plan' | 'review';

interface ChainEntry {
  model: string;
  tier: string;
  provider: string;
}

interface FlowStage {
  stage: string;
  chain: ChainEntry[];
  error?: string;
}

interface RoutingPayload {
  flows: Record<RoutingFlow, FlowStage[]>;
  stagePolicyPath: string;
  modelsYamlPath: string;
}

export interface RoutingCardProps {
  flow: RoutingFlow;
  ws: WebSocket | null;
  /** Compact mode renders as a single line — used on Plan / Review pages. */
  compact?: boolean;
}

const tierColor: Record<string, string> = {
  local: 'var(--text-tertiary)',
  cheap: 'var(--color-info)',
  premium: 'var(--accent)',
  unknown: 'var(--text-quaternary)',
};

export function RoutingCard({ flow, ws, compact = false }: RoutingCardProps) {
  const [payload, setPayload] = useState<RoutingPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    setLoading(true);
    const handler = (evt: MessageEvent) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'routing' && msg.payload) {
          setPayload(msg.payload as RoutingPayload);
          setLoading(false);
          setError(null);
        }
        if (msg.type === 'error' && typeof msg.payload?.message === 'string' && msg.payload.message.startsWith('Routing resolve failed')) {
          setError(msg.payload.message);
          setLoading(false);
        }
      } catch { /* ignore */ }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ action: 'get-routing' }));
    return () => ws.removeEventListener('message', handler);
  }, [ws]);

  const stages = payload?.flows[flow] ?? [];

  if (compact) {
    if (loading) return <CompactSkeleton />;
    if (error || stages.length === 0) {
      return (
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
          routing unavailable
        </span>
      );
    }
    const first = stages[0];
    const primary = first?.chain[0];
    if (!primary) {
      return (
        <span style={{ fontSize: 12, color: 'var(--color-warning)', fontFamily: 'var(--font-mono)' }}>
          {first?.error ?? 'no chain resolved'}
        </span>
      );
    }
    return (
      <span style={{ fontSize: 12, color: 'var(--text-secondary)', fontFamily: 'var(--font-mono)' }}>
        <span style={{ color: tierColor[primary.tier] ?? 'var(--text-secondary)' }}>●</span>{' '}
        {first.stage} → <strong style={{ color: 'var(--text-primary)' }}>{primary.model}</strong>
        <span style={{ color: 'var(--text-tertiary)', marginLeft: 6 }}>({primary.tier})</span>
      </span>
    );
  }

  return (
    <div style={{
      width: '100%',
      padding: 'var(--space-md)',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
      marginBottom: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 12,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <MapIcon size={14} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)' }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Routing — {flow}
          </span>
        </div>
        {payload?.stagePolicyPath && (
          <span style={{ fontSize: 11, color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)' }}>
            policy: ~/.anvil/stage-policy.yaml
          </span>
        )}
      </div>

      {loading && <RowSkeleton count={5} />}

      {error && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 12, color: 'var(--color-warning)',
          padding: '8px 0',
        }}>
          <AlertTriangle size={14} />
          {error}
        </div>
      )}

      {!loading && !error && stages.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
          No stages found for flow &quot;{flow}&quot;.
        </div>
      )}

      {!loading && !error && stages.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {stages.map((s) => (
            <RoutingRow key={s.stage} stage={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function RoutingRow({ stage }: { stage: FlowStage }) {
  const primary = stage.chain[0];
  const fallbacks = stage.chain.slice(1);

  if (stage.error || !primary) {
    return (
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        fontFamily: 'var(--font-mono)', fontSize: 12,
        color: 'var(--color-warning)',
      }}>
        <span style={{ minWidth: 130, color: 'var(--text-secondary)' }}>{stage.stage}</span>
        <span>→ {stage.error ?? 'no chain'}</span>
      </div>
    );
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '6px 8px',
      fontFamily: 'var(--font-mono)', fontSize: 12,
      color: 'var(--text-secondary)',
    }}>
      <span style={{ minWidth: 130, color: 'var(--text-tertiary)' }}>{stage.stage}</span>
      <span style={{ color: 'var(--text-tertiary)' }}>→</span>
      <span style={{ color: tierColor[primary.tier] ?? 'var(--text-secondary)' }}>●</span>
      <span style={{ color: 'var(--text-primary)' }}>{primary.model}</span>
      <span style={{ color: 'var(--text-tertiary)' }}>({primary.tier} · {primary.provider})</span>
      {fallbacks.length > 0 && (
        <span style={{ marginLeft: 'auto', color: 'var(--text-quaternary)', fontSize: 11 }}>
          +{fallbacks.length} fallback{fallbacks.length === 1 ? '' : 's'}
        </span>
      )}
    </div>
  );
}

function RowSkeleton({ count }: { count: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} style={{
          height: 24,
          background: 'var(--bg-elevated-3)',
          borderRadius: 'var(--radius-xs)',
          opacity: 0.4,
        }} />
      ))}
    </div>
  );
}

function CompactSkeleton() {
  return (
    <span style={{
      display: 'inline-block',
      width: 180, height: 14,
      background: 'var(--bg-elevated-3)',
      borderRadius: 'var(--radius-xs)',
      opacity: 0.4,
    }} />
  );
}

export default RoutingCard;
