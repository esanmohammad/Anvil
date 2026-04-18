import React from 'react';
import { Badge } from '../ui/Badge.js';

export interface CriticalFlow {
  id: string;
  name: string;
  description: string;
  repos: string[];
  status: 'healthy' | 'degraded' | 'broken';
}

export interface CriticalFlowListProps {
  flows: CriticalFlow[];
}

export function CriticalFlowList({ flows }: CriticalFlowListProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-xs)' }}>
      <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600, marginBottom: 'var(--space-xs)' }}>Critical Flows</h3>
      {flows.map((flow) => (
        <div key={flow.id} className="card" style={{ padding: 'var(--space-sm)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-sm)', marginBottom: 4 }}>
            <Badge variant={flow.status === 'healthy' ? 'success' : flow.status === 'broken' ? 'error' : 'warning'}>
              {flow.status}
            </Badge>
            <span style={{ fontWeight: 500, fontSize: 'var(--text-sm)' }}>{flow.name}</span>
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 4 }}>{flow.description}</div>
          <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
            {flow.repos.map((r) => (
              <span key={r} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)', background: 'var(--bg-hover)', padding: '1px 6px', borderRadius: 'var(--radius-sm)' }}>
                {r}
              </span>
            ))}
          </div>
        </div>
      ))}
      {flows.length === 0 && <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No critical flows defined</span>}
    </div>
  );
}

export default CriticalFlowList;
