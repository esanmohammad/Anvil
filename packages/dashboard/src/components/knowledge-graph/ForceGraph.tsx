import React, { useRef, useCallback, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import type { GraphData, GraphNode, GraphLink } from './graph-utils';
import { typeLabel } from './graph-utils';

export interface ForceGraphProps {
  data: GraphData;
  width: number;
  height: number;
  level: 'project' | 'repo';
  onNodeClick?: (node: GraphNode) => void;
  selectedNodeId?: string | null;
  searchQuery?: string;
}

export function ForceGraph({
  data,
  width,
  height,
  level,
  onNodeClick,
  selectedNodeId,
  searchQuery,
}: ForceGraphProps) {
  const graphRef = useRef<any>(null);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);
  const [highlightNodes, setHighlightNodes] = useState<Set<string>>(new Set());
  const [highlightLinks, setHighlightLinks] = useState<Set<any>>(new Set());

  // Build neighbor maps for hover highlighting
  const neighborMap = useRef(new Map<string, Set<string>>());
  const linkSet = useRef(new Set<any>());

  useEffect(() => {
    const map = new Map<string, Set<string>>();
    const lSet = new Set<any>();
    for (const link of data.links) {
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
      if (!map.has(src)) map.set(src, new Set());
      if (!map.has(tgt)) map.set(tgt, new Set());
      map.get(src)!.add(tgt);
      map.get(tgt)!.add(src);
      lSet.add(link);
    }
    neighborMap.current = map;
    linkSet.current = lSet;
  }, [data]);

  // Search highlighting
  const searchLower = searchQuery?.toLowerCase() ?? '';

  // Auto-zoom to fit on data change
  useEffect(() => {
    const timer = setTimeout(() => {
      graphRef.current?.zoomToFit(400, 40);
    }, 500);
    return () => clearTimeout(timer);
  }, [data]);

  const handleNodeHover = useCallback((node: any) => {
    const id = node?.id ?? null;
    setHoveredNode(id);

    if (!id) {
      setHighlightNodes(new Set());
      setHighlightLinks(new Set());
      return;
    }

    const neighbors = neighborMap.current.get(id) ?? new Set();
    const hNodes = new Set([id, ...neighbors]);
    const hLinks = new Set<any>();

    for (const link of linkSet.current) {
      const src = typeof link.source === 'object' ? (link.source as any).id : link.source;
      const tgt = typeof link.target === 'object' ? (link.target as any).id : link.target;
      if (src === id || tgt === id) hLinks.add(link);
    }

    setHighlightNodes(hNodes);
    setHighlightLinks(hLinks);
  }, []);

  const handleNodeClick = useCallback((node: any) => {
    if (onNodeClick) onNodeClick(node as GraphNode);
  }, [onNodeClick]);

  const nodeCanvasObject = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const id = node.id as string;
    const label = node.label ?? id;
    const isHighlighted = highlightNodes.size > 0 ? highlightNodes.has(id) : true;
    const isHovered = hoveredNode === id;
    const isSelected = selectedNodeId === id;
    const isSearchMatch = searchLower && label.toLowerCase().includes(searchLower);
    const isProject = level === 'project';

    const size = node.val ?? 4;
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    // Dimming for non-highlighted nodes
    const alpha = highlightNodes.size > 0 && !isHighlighted ? 0.1 : 1;

    ctx.save();
    ctx.globalAlpha = alpha;

    // Draw node
    const color = node.color ?? '#6b7280';

    if (isProject) {
      // Repo nodes: large circles with text inside
      ctx.beginPath();
      ctx.arc(x, y, size, 0, 2 * Math.PI);
      ctx.fillStyle = isHovered || isSelected ? lightenColor(color, 0.3) : color;
      ctx.fill();
      if (isHovered || isSelected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      // Label inside
      const fontSize = Math.max(10, size / 3);
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(label, x, y);
    } else {
      // Repo-level nodes: small circles
      const r = Math.max(2, size / (globalScale > 2 ? 1 : 2));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fillStyle = isSearchMatch ? '#fbbf24' : isHovered || isSelected ? lightenColor(color, 0.3) : color;
      ctx.fill();

      if (isHovered || isSelected) {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      // Label on hover or when zoomed in
      if ((isHovered || isSelected || globalScale > 3) && label) {
        const fontSize = Math.max(3, 10 / globalScale);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = isSearchMatch ? '#fbbf24' : 'rgba(255,255,255,0.85)';
        ctx.fillText(label, x, y + r + 2 / globalScale);
      }
    }

    ctx.restore();
  }, [hoveredNode, highlightNodes, selectedNodeId, searchLower, level]);

  const linkCanvasObject = useCallback((link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const isHighlighted = highlightLinks.size > 0 ? highlightLinks.has(link) : true;
    const alpha = highlightLinks.size > 0 && !isHighlighted ? 0.03 : 0.4;

    const src = link.source;
    const tgt = link.target;
    if (!src || !tgt || typeof src.x !== 'number') return;

    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = link.color ?? '#4b5563';
    ctx.lineWidth = (link.width ?? 0.5) / globalScale;

    ctx.beginPath();
    ctx.moveTo(src.x, src.y);
    ctx.lineTo(tgt.x, tgt.y);
    ctx.stroke();

    // Draw label on project-level edges
    if (level === 'project' && link.label && globalScale > 0.5) {
      const midX = (src.x + tgt.x) / 2;
      const midY = (src.y + tgt.y) / 2;
      const fontSize = Math.max(3, 8 / globalScale);
      ctx.font = `${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.fillText(link.label, midX, midY);
    }

    ctx.restore();
  }, [highlightLinks, level]);

  return (
    <ForceGraph2D
      ref={graphRef}
      graphData={data}
      width={width}
      height={height}
      backgroundColor="#0f0f1a"
      nodeCanvasObject={nodeCanvasObject}
      linkCanvasObject={linkCanvasObject}
      onNodeHover={handleNodeHover}
      onNodeClick={handleNodeClick}
      nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
        const size = node.val ?? 4;
        ctx.beginPath();
        ctx.arc(node.x, node.y, size + 2, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      }}

      cooldownTicks={200}
      d3AlphaDecay={0.015}
      d3VelocityDecay={level === 'project' ? 0.4 : 0.25}
      d3Force="charge"
      d3ForceStrength={level === 'project' ? -200 : -30}
      linkDirectionalParticles={level === 'project' ? 2 : 0}
      linkDirectionalParticleWidth={2}
      linkDirectionalParticleSpeed={0.005}
      onEngineStop={() => {
        // Zoom to fit after layout settles
        graphRef.current?.zoomToFit(400, 40);
      }}
    />
  );
}

// Node detail panel shown when a node is clicked
export function NodeDetailPanel({
  node,
  onClose,
  onDrillIn,
}: {
  node: GraphNode;
  onClose: () => void;
  onDrillIn?: (repoName: string) => void;
}) {
  return (
    <div style={{
      position: 'absolute', top: 0, right: 0,
      width: 300, height: '100%',
      background: 'var(--bg-elevated-2)',
      borderLeft: '1px solid var(--separator)',
      padding: 16, overflow: 'auto',
      zIndex: 20,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text-primary)' }}>
          {node.label}
        </div>
        <button onClick={onClose} style={{
          background: 'none', border: 'none', color: 'var(--text-tertiary)',
          cursor: 'pointer', fontSize: 16, padding: '2px 6px',
        }}>×</button>
      </div>

      <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <span style={{ color: 'var(--text-tertiary)' }}>Type:</span>{' '}
          <span style={{
            padding: '1px 6px', borderRadius: 3, fontSize: 11,
            background: node.color ? node.color + '22' : 'var(--bg-base)',
            color: node.color ?? 'var(--text-secondary)',
          }}>
            {typeLabel(node.type)}
          </span>
        </div>

        {node.repo && (
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Repo:</span> {node.repo}
          </div>
        )}

        {node.file && (
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>File:</span>{' '}
            <code style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{node.file}</code>
          </div>
        )}

        {node.degree !== undefined && node.degree > 0 && (
          <div>
            <span style={{ color: 'var(--text-tertiary)' }}>Connections:</span> {node.degree}
          </div>
        )}

        {node.__level === 'project' && onDrillIn && (
          <button
            onClick={() => onDrillIn(node.id)}
            style={{
              marginTop: 8, padding: '6px 12px', fontSize: 12, fontWeight: 500,
              background: 'var(--color-accent)', color: 'white',
              border: 'none', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
            }}
          >
            Explore {node.label} →
          </button>
        )}
      </div>
    </div>
  );
}

function lightenColor(hex: string, amount: number): string {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amount));
  const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amount));
  const b = Math.min(255, (num & 0xff) + Math.round(255 * amount));
  return `rgb(${r},${g},${b})`;
}
