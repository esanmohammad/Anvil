import React, { useMemo, useCallback, useState } from 'react';
import { LiveOutputPanel } from './LiveOutputPanel.js';
import type { OutputChunk } from '../../../server/types.js';

export interface OutputContainerProps {
  chunks: OutputChunk[];
  allChunks: OutputChunk[];
  activeRepo: string | null;
  activeStage: string | null;
  onSelectRepo: (repo: string | null) => void;
  onSelectStage: (stage: string | null) => void;
  onClear: () => void;
}

export function OutputContainer({ chunks, allChunks, activeRepo, activeStage, onSelectRepo, onSelectStage, onClear }: OutputContainerProps) {
  const [autoScroll, setAutoScroll] = useState(true);
  const [searchResults, setSearchResults] = useState<number | undefined>();

  const availableRepos = useMemo(() => [...new Set(allChunks.map((c) => c.repo))], [allChunks]);
  const availableStages = useMemo(() => [...new Set(allChunks.filter((c) => !activeRepo || c.repo === activeRepo).map((c) => c.stage))], [allChunks, activeRepo]);

  const handleSearch = useCallback((query: string) => {
    if (!query) { setSearchResults(undefined); return; }
    const lower = query.toLowerCase();
    setSearchResults(chunks.filter((c) => c.content.toLowerCase().includes(lower)).length);
  }, [chunks]);

  return (
    <LiveOutputPanel
      chunks={chunks}
      autoScroll={autoScroll}
      onToggleAutoScroll={setAutoScroll}
      activeRepo={activeRepo}
      activeStage={activeStage}
      onSelectRepo={onSelectRepo}
      onSelectStage={onSelectStage}
      availableRepos={availableRepos}
      availableStages={availableStages}
      onSearch={handleSearch}
      searchResults={searchResults}
      onClear={onClear}
    />
  );
}

export default OutputContainer;
