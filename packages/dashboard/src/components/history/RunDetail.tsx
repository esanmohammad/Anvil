import React, { useState } from 'react';
import { RotateCcw, Undo2 } from 'lucide-react';
import { RunTimeline } from './RunTimeline.js';
import { Badge } from '../ui/Badge.js';
import { MarkdownRenderer } from '../output/MarkdownRenderer.js';
import type { RunSummary } from './RunRow.js';
import type { PipelineStage } from '../../../server/types.js';

export interface RunDetailProps {
  run: RunSummary;
  stages: PipelineStage[];
  ws?: WebSocket | null;
}

export function RunDetail({ run, stages, ws }: RunDetailProps) {
  const [showReplayPicker, setShowReplayPicker] = useState(false);
  const [showRollbackConfirm, setShowRollbackConfirm] = useState(false);

  const duration = run.durationMs ?? ((run.completedAt ?? Date.now()) - run.startedAt);
  const durationLabel = duration < 60000 ? `${Math.round(duration / 1000)}s` : `${Math.round(duration / 60000)}m`;

  // Use stageDetails from run if available, fall back to stages prop
  const stageList = run.stageDetails && run.stageDetails.length > 0
    ? run.stageDetails
    : stages.map((s) => ({ name: s.name, label: s.name, status: s.status, cost: 0, startedAt: null, completedAt: null, error: null }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-md)' }}>
      {/* Header */}
      <div>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <h3 style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: 4 }}>{run.feature}</h3>
          <div style={{ display: 'flex', gap: 'var(--space-xs)', position: 'relative' }}>
            {/* Replay button */}
            <button
              onClick={() => setShowReplayPicker(!showReplayPicker)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', fontSize: 12, fontWeight: 500,
                background: 'var(--bg-hover)', color: 'var(--text-secondary)',
                border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              <RotateCcw size={12} />
              Replay
            </button>
            {/* Rollback button */}
            <button
              onClick={() => setShowRollbackConfirm(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '5px 12px', fontSize: 12, fontWeight: 500,
                background: 'var(--bg-hover)', color: 'var(--color-error)',
                border: '1px solid var(--border-default)', borderRadius: 'var(--radius-sm)',
                cursor: 'pointer',
              }}
            >
              <Undo2 size={12} />
              Rollback
            </button>

            {/* Replay stage picker dropdown */}
            {showReplayPicker && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20,
                minWidth: 180, padding: '6px 0',
                background: 'var(--bg-elevated-2)', border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)', boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
              }}>
                <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>Replay from stage:</div>
                {stageList.map((stage, i) => (
                  <button
                    key={i}
                    onClick={() => {
                      if (ws) {
                        ws.send(JSON.stringify({ action: 'resume', runId: run.id, fromStage: stage.name }));
                      }
                      setShowReplayPicker(false);
                    }}
                    style={{
                      display: 'block', width: '100%', textAlign: 'left',
                      padding: '6px 12px', fontSize: 12,
                      background: 'none', border: 'none', color: 'var(--text-secondary)',
                      cursor: 'pointer', fontFamily: 'var(--font-sans)',
                    }}
                    onMouseEnter={(e) => { (e.target as HTMLElement).style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={(e) => { (e.target as HTMLElement).style.background = 'none'; }}
                  >
                    {stage.label || stage.name}
                  </button>
                ))}
              </div>
            )}

            {/* Rollback confirmation dialog */}
            {showRollbackConfirm && (
              <div style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 20,
                minWidth: 220, padding: '12px 16px',
                background: 'var(--bg-elevated-2)', border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)', boxShadow: '0 4px 12px rgba(0,0,0,0.2)',
              }}>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 10, fontWeight: 500 }}>
                  Rollback this run?
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginBottom: 12, lineHeight: 1.5 }}>
                  This will attempt to undo changes made by this run.
                </div>
                <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                  <button
                    onClick={() => setShowRollbackConfirm(false)}
                    style={{
                      padding: '5px 12px', fontSize: 12,
                      background: 'none', border: '1px solid var(--border-default)',
                      borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', cursor: 'pointer',
                    }}
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      if (ws) {
                        ws.send(JSON.stringify({ action: 'rollback-run', runId: run.id }));
                      }
                      setShowRollbackConfirm(false);
                    }}
                    style={{
                      padding: '5px 12px', fontSize: 12, fontWeight: 500,
                      background: 'var(--color-error)', color: '#fff', border: 'none',
                      borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    }}
                  >
                    Rollback
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-sm)', fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', flexWrap: 'wrap', alignItems: 'center' }}>
          <Badge variant={run.status === 'completed' ? 'success' : run.status === 'failed' ? 'error' : 'primary'}>
            {run.status}
          </Badge>
          <span>{run.project}</span>
          {run.model && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)' }}>{run.model}</span>}
          <span>{durationLabel}</span>
          <span>{new Date(run.startedAt).toLocaleString()}</span>
        </div>
      </div>

      {/* Cost summary */}
      {run.totalCost != null && run.totalCost > 0 && (
        <div style={{
          display: 'flex', gap: 'var(--space-md)', padding: 'var(--space-sm) var(--space-md)',
          background: 'var(--bg-hover)', borderRadius: 'var(--radius-md)', alignItems: 'center',
        }}>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 2 }}>Total Cost</div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, fontFamily: 'var(--font-mono)', color: 'var(--color-success)' }}>
              ${run.totalCost.toFixed(4)}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 2 }}>Stages</div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
              {run.completedStages}/{run.stages}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 2 }}>Duration</div>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>{durationLabel}</div>
          </div>
          {run.prUrls && run.prUrls.length > 0 && (
            <div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 2 }}>PRs</div>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--color-accent)' }}>
                {run.prUrls.length}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Timeline */}
      <div>
        <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 'var(--space-xs)' }}>Timeline</h4>
        <RunTimeline stages={stages.length > 0 ? stages : stageList.map((s) => ({
          name: s.label || s.name,
          status: s.status as PipelineStage['status'],
          progress: s.status === 'completed' ? 100 : 0,
        }))} />
      </div>

      {/* Repositories */}
      {run.repos.length > 0 && (
        <div>
          <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 'var(--space-xs)' }}>Repositories</h4>
          <div style={{ display: 'flex', gap: 'var(--space-xs)', flexWrap: 'wrap' }}>
            {run.repos.map((r) => (
              <span key={r} style={{ fontSize: 'var(--text-xs)', fontFamily: 'var(--font-mono)', background: 'var(--bg-hover)', padding: '2px 8px', borderRadius: 'var(--radius-sm)' }}>
                {r}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Stages with cost breakdown */}
      <div>
        <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 'var(--space-xs)' }}>Stages</h4>
        {stageList.map((stage, i) => (
          <div key={i} style={{
            display: 'flex', gap: 'var(--space-sm)', padding: 'var(--space-xs) 0',
            fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--border-default)',
            alignItems: 'center',
          }}>
            <Badge variant={stage.status === 'completed' ? 'success' : stage.status === 'failed' ? 'error' : stage.status === 'running' ? 'primary' : 'neutral'}>
              {stage.status}
            </Badge>
            <span style={{ flex: 1, textTransform: 'capitalize' }}>{stage.label || stage.name}</span>
            {stage.cost > 0 && (
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                ${stage.cost.toFixed(4)}
              </span>
            )}
            {stage.error && (
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-error)', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {stage.error}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Output (for quick actions: fix/research) */}
      {run.output && (
        <div>
          <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 'var(--space-xs)' }}>Output</h4>
          <div style={{
            maxHeight: 600,
            overflow: 'auto',
            padding: 'var(--space-sm)',
            background: 'var(--bg-root)',
            borderRadius: 'var(--radius-sm)',
            border: '1px solid var(--border-default)',
            lineHeight: 1.6,
            color: 'var(--text-secondary)',
            fontSize: 'var(--text-xs)',
          }}>
            <MarkdownRenderer content={run.output} />
          </div>
        </div>
      )}

      {/* PRs */}
      {run.prUrls && run.prUrls.length > 0 && (
        <div>
          <h4 style={{ fontSize: 'var(--text-sm)', fontWeight: 500, marginBottom: 'var(--space-xs)' }}>Pull Requests</h4>
          {run.prUrls.map((url) => {
            const match = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
            const label = match ? `${match[1]}#${match[2]}` : url;
            return (
              <a
                key={url}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: 'block', padding: '4px 0', fontSize: 'var(--text-xs)',
                  fontFamily: 'var(--font-mono)', color: 'var(--color-accent)',
                  textDecoration: 'none',
                }}
              >
                {label}
              </a>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default RunDetail;
