import React, { useRef, useMemo } from 'react';
import { ActivityItem } from './ActivityItem.js';
import type { ActivityEntry } from '../../../server/types.js';

export interface ActivityFeedProps {
  entries: ActivityEntry[];
  itemHeight?: number;
  overscan?: number;
}

/**
 * Simple virtualized activity feed.
 * Renders only visible items + overscan buffer.
 */
export function ActivityFeed({ entries, itemHeight = 40, overscan = 10 }: ActivityFeedProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = React.useState(0);
  const [containerHeight, setContainerHeight] = React.useState(600);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    setContainerHeight(el.clientHeight);
    const observer = new ResizeObserver(() => setContainerHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { visibleEntries, startIndex, totalHeight, offsetY } = useMemo(() => {
    const totalH = entries.length * itemHeight;
    const startIdx = Math.max(0, Math.floor(scrollTop / itemHeight) - overscan);
    const endIdx = Math.min(entries.length, Math.ceil((scrollTop + containerHeight) / itemHeight) + overscan);
    return {
      visibleEntries: entries.slice(startIdx, endIdx),
      startIndex: startIdx,
      totalHeight: totalH,
      offsetY: startIdx * itemHeight,
    };
  }, [entries, scrollTop, containerHeight, itemHeight, overscan]);

  return (
    <div
      ref={containerRef}
      className="activity-feed"
      style={{ height: '100%', overflow: 'auto' }}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
          {visibleEntries.map((entry, i) => (
            <ActivityItem
              key={entry.id}
              entry={entry}
              style={{ height: itemHeight }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default ActivityFeed;
