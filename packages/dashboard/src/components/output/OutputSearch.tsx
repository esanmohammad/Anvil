import React, { useState } from 'react';

export interface OutputSearchProps {
  onSearch: (query: string) => void;
  resultCount?: number;
}

export function OutputSearch({ onSearch, resultCount }: OutputSearchProps) {
  const [query, setQuery] = useState('');

  return (
    <div style={{ display: 'flex', gap: 'var(--space-sm)', alignItems: 'center' }}>
      <input
        className="input"
        placeholder="Search output..."
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          onSearch(e.target.value);
        }}
        style={{ maxWidth: 240 }}
      />
      {resultCount != null && query && (
        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {resultCount} match{resultCount !== 1 ? 'es' : ''}
        </span>
      )}
    </div>
  );
}

export default OutputSearch;
