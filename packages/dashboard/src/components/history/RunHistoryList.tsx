import React, { useState } from 'react';
import { RunRow } from './RunRow.js';
import { RunDetail } from './RunDetail.js';
import type { RunSummary } from './RunRow.js';
import type { PipelineStage } from '../../../server/types.js';

export interface RunHistoryListProps {
  runs: RunSummary[];
  getRunStages: (runId: string) => PipelineStage[];
  initialSelectedId?: string | null;
}

type StatusFilter = 'all' | 'completed' | 'failed';

export function RunHistoryList({ runs, getRunStages, initialSelectedId }: RunHistoryListProps) {
  const [selectedRun, setSelectedRun] = useState<string | null>(initialSelectedId ?? null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const selected = runs.find((r) => r.id === selectedRun);

  const filteredRuns = statusFilter === 'all'
    ? runs
    : runs.filter((r) => r.status === statusFilter);

  return (
    <div className="page-enter" style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      padding: 'var(--space-lg)',
    }}>
      <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 16 }}>History</h2>

      {/* Filter bar */}
      <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
        {(['all', 'completed', 'failed'] as StatusFilter[]).map((f) => (
          <button
            key={f}
            onClick={() => setStatusFilter(f)}
            className={`btn btn-sm ${statusFilter === f ? '' : 'btn-ghost'}`}
            style={statusFilter === f ? {
              background: 'var(--bg-elevated-3)', color: 'var(--text-primary)',
            } : {}}
          >
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)', alignSelf: 'center' }}>
          {filteredRuns.length} {filteredRuns.length === 1 ? 'run' : 'runs'}
        </span>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0, gap: 'var(--space-md)' }}>
        {/* Run list */}
        <div style={{ flex: 1, overflow: 'auto' }}>
          {filteredRuns.length === 0 ? (
            <div style={{
              padding: 'var(--space-2xl)', textAlign: 'center',
              color: 'var(--text-tertiary)', fontSize: 14,
            }}>
              {runs.length === 0
                ? 'Your feature history will build up here over time.'
                : 'No runs match this filter.'}
            </div>
          ) : (
            <div className="stagger">
              {filteredRuns.map((run) => (
                <RunRow key={run.id} run={run} isSelected={selectedRun === run.id} onClick={setSelectedRun} />
              ))}
            </div>
          )}
        </div>

        {/* Detail panel */}
        {selected && (
          <div style={{
            width: 400, overflow: 'auto',
            padding: 'var(--space-md)',
            borderLeft: '1px solid var(--separator)',
            background: 'var(--bg-elevated-1)',
            borderRadius: 'var(--radius-md)',
          }}>
            <RunDetail run={selected} stages={getRunStages(selected.id)} />
          </div>
        )}
      </div>
    </div>
  );
}

export default RunHistoryList;
