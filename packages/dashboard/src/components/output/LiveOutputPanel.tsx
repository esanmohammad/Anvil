import React from 'react';
import { OutputRenderer } from './OutputRenderer.js';
import { OutputSearch } from './OutputSearch.js';
import { RepoBreadcrumbs } from './RepoBreadcrumbs.js';
import type { OutputChunk } from '../../../server/types.js';

export interface LiveOutputPanelProps {
  chunks: OutputChunk[];
  autoScroll: boolean;
  onToggleAutoScroll: (val: boolean) => void;
  activeRepo: string | null;
  activeStage: string | null;
  onSelectRepo: (repo: string | null) => void;
  onSelectStage: (stage: string | null) => void;
  availableRepos: string[];
  availableStages: string[];
  onSearch: (query: string) => void;
  searchResults?: number;
  onClear: () => void;
}

export function LiveOutputPanel({
  chunks, autoScroll, onToggleAutoScroll,
  activeRepo, activeStage, onSelectRepo, onSelectStage,
  availableRepos, availableStages,
  onSearch, searchResults, onClear,
}: LiveOutputPanelProps) {
  const [searchQuery, setSearchQuery] = React.useState('');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 'var(--space-sm)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600 }}>Live Output</h2>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
          <label style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={autoScroll} onChange={(e) => onToggleAutoScroll(e.target.checked)} />
            Auto-scroll
          </label>
          <button className="btn btn-ghost btn-sm" onClick={onClear}>Clear</button>
        </div>
      </div>
      <RepoBreadcrumbs
        repo={activeRepo} stage={activeStage}
        onSelectRepo={onSelectRepo} onSelectStage={onSelectStage}
        availableRepos={availableRepos} availableStages={availableStages}
      />
      <OutputSearch
        onSearch={(q) => { setSearchQuery(q); onSearch(q); }}
        resultCount={searchResults}
      />
      <div style={{ flex: 1, minHeight: 0 }}>
        <OutputRenderer chunks={chunks} autoScroll={autoScroll} searchQuery={searchQuery} />
      </div>
    </div>
  );
}

export default LiveOutputPanel;
