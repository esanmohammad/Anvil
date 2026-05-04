import React from 'react';
import { DollarSign } from 'lucide-react';
import { ComingSoonPanel } from '../common/ComingSoonPanel.js';

export interface CostBreachHistoryPageProps {
  project: string | null;
  ws: WebSocket | null;
}

export function CostBreachHistoryPage(_props: CostBreachHistoryPageProps) {
  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)',
      maxWidth: 900,
      margin: '0 auto',
      width: '100%',
    }}>
      <ComingSoonPanel
        icon={<DollarSign size={32} style={{ color: 'var(--text-tertiary)', marginBottom: 8 }} />}
        title="Cost Breaches"
        description="Review pipeline runs that exceeded their budget. Coming soon."
      />
    </div>
  );
}

export default CostBreachHistoryPage;
