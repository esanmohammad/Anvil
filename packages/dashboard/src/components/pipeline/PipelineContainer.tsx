import React from 'react';
import { RotateCcw, Play } from 'lucide-react';
import { StageChips } from './StageChips.js';
import type { StageChipData } from './StageChips.js';
import { OutputPanel } from '../output/OutputPanel.js';
import type { ActivityEntry } from '../output/ActivityLine.js';
import type { ChangeEntry } from '../output/OutputPanel.js';
import { usePipelineState } from './usePipelineState.js';

// ---------------------------------------------------------------------------
// Raw content cleaner
// ---------------------------------------------------------------------------

function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (/^\s*[\[{]/.test(t) && /[\]}]\s*,?\s*$/.test(t)) return true;
  if (/^\s*"[^"]+"\s*:/.test(t)) return true;
  if (/^\s*(?:find|ls|grep|head|tail|cat|echo|cd|mkdir|rm|cp|mv|git|npm|npx|node|curl)\s/.test(t)) return true;
  if (/^\/[^\s]+$/.test(t)) return true;
  return false;
}

function cleanRawContent(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) return '';
  let cleaned = trimmed.replace(/```(?:json|javascript|typescript|js|ts|bash|shell|sh)?\n[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/^\s*\{[\s\S]*?\}\s*$/gm, '');
  const lines = cleaned.split('\n');
  const filtered = lines.filter((line) => !isNoiseLine(line));
  cleaned = filtered.join('\n').trim();
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  return cleaned;
}

/**
 * Full pipeline container — Two-column layout.
 *
 * Left panel (280px): Vertical stage list + repo breakdown
 * Right panel (flex): Conversation-style output + tabs
 */

export interface RepoState {
  repoName: string;
  agentId: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
  cost: number;
  error: string | null;
}

export interface PipelineStageData {
  name: string;
  rawName?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
  progress: number;
  startedAt?: number;
  completedAt?: number;
  cost?: number;
  perRepo?: boolean;
  repos?: RepoState[];
}

export interface PipelineData {
  runId: string;
  project: string;
  feature?: string;
  currentStage: number;
  overallProgress: number;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'paused' | 'cancelled';
  stages: PipelineStageData[];
  totalCost?: number;
  pendingApproval?: { stage: number; stageName: string } | null;
  model?: string;
  modelPerStage?: Record<number, string>;
  repoNames?: string[];
  waitingForInput?: boolean;
}

export interface AgentTabData {
  id: string;
  name: string;
  cost: number;
  status: 'running' | 'completed' | 'failed' | 'idle';
  isFix?: boolean;
}

export interface PipelineContainerProps {
  pipelineData: PipelineData | null;
  activities: ActivityEntry[];
  rawOutput: string;
  changes: ChangeEntry[];
  agents?: AgentTabData[];
  onStop?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onRunAgain?: () => void;
  onSendInput?: (agentIdOrText: string, text?: string) => void;
  onApproveGate?: (stage: number) => void;
}

export function PipelineContainer({
  pipelineData,
  activities,
  rawOutput,
  changes,
  agents: _agents = [],
  onStop: _onStop,
  onResume,
  onRetry,
  onRunAgain: _onRunAgain,
  onSendInput,
  onApproveGate,
}: PipelineContainerProps) {
  const { selectedStage, setSelectedStage } = usePipelineState();
  const [userSelected, setUserSelected] = React.useState(false);

  const status = (pipelineData?.status ?? 'idle') as PipelineData['status'];
  const isRunning = status === 'running' || status === 'paused';
  const isWaiting = pipelineData?.waitingForInput === true;
  const currentStage = pipelineData?.currentStage ?? 0;

  const runId = pipelineData?.runId;
  React.useEffect(() => { setUserSelected(false); }, [runId]);

  React.useEffect(() => {
    if (!userSelected && isRunning) setSelectedStage(currentStage);
  }, [currentStage, isRunning, userSelected, setSelectedStage]);

  // Build stage chips data
  const modelPerStage = pipelineData?.modelPerStage;
  const stageChips: StageChipData[] = (pipelineData?.stages ?? []).map((s, idx) => ({
    name: s.name,
    status: s.status === 'waiting' ? 'running' : s.status,
    cost: s.cost,
    modelLabel: modelPerStage?.[idx],
  }));

  const inputPlaceholder = isWaiting
    ? 'Answer the questions above...'
    : currentStage === 0
      ? 'Answer question...'
      : isRunning
        ? 'Send input...'
        : 'Resume session...';

  const [selectedRepo, setSelectedRepo] = React.useState<string | null>(null);

  // Current stage's per-repo data
  const activeStageData = pipelineData?.stages?.[selectedStage ?? currentStage];
  const activeRepos = activeStageData?.repos ?? [];

  // Filter activities by selected stage
  const selectedStageData = selectedStage != null ? pipelineData?.stages?.[selectedStage] : null;
  const selectedStageRaw = selectedStageData?.rawName ?? selectedStageData?.name ?? null;

  let filteredActivities = activities;
  let filteredRaw = rawOutput;
  let filteredChanges = changes;

  if (selectedStage != null && selectedStageRaw) {
    const byName = activities.filter(
      (a) => a.stage === selectedStageRaw || a.stage?.startsWith(selectedStageRaw + ':'),
    );

    if (byName.length > 0) {
      filteredActivities = byName;
    } else {
      const stageStart = selectedStageData?.startedAt;
      const stageEnd = selectedStageData?.completedAt;
      const nextStageStart = pipelineData?.stages?.[selectedStage + 1]?.startedAt;
      if (stageStart) {
        const tsEnd = stageEnd ?? nextStageStart ?? Date.now() + 999999;
        filteredActivities = activities.filter(
          (a) => a.timestamp >= stageStart && a.timestamp <= tsEnd,
        );
      } else {
        filteredActivities = [];
      }
    }

    const hasParsedQuestions = filteredActivities.some((a) => a.kind === 'clarify-question');
    if (hasParsedQuestions) {
      // Once interactive Q&A starts, hide the agent's exploration noise
      // (text output, thinking, tool calls) — show only the conversation flow
      filteredActivities = filteredActivities.filter(
        (a) => a.kind === 'clarify-question' || a.kind === 'clarify-ack' || a.kind === 'user-message',
      );
    }

    const rawKinds = new Set(['text', 'clarify-question', 'user-message', 'clarify-ack']);
    filteredRaw = filteredActivities
      .filter((a) => rawKinds.has(a.kind))
      .map((a) => {
        if (a.kind === 'user-message') return `> ${a.content || a.summary}`;
        return cleanRawContent(a.content || a.summary);
      })
      .filter((t) => t.length > 0)
      .join('\n\n');
    filteredChanges = changes.filter((c) => {
      if (filteredActivities.length === 0) return false;
      const minTs = filteredActivities[0].timestamp;
      const maxTs = filteredActivities[filteredActivities.length - 1].timestamp;
      return c.timestamp >= minTs && c.timestamp <= maxTs;
    });
  }

  if (selectedRepo) {
    filteredActivities = filteredActivities.filter((a) => a.repo === selectedRepo);
    filteredRaw = filteredActivities.map((a) => a.summary).join('\n');
  }

  const pendingApproval = pipelineData?.pendingApproval;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      overflow: 'hidden',
    }}>
      {/* Approval gate banner */}
      {pendingApproval && (
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          background: 'rgba(var(--color-warning-rgb, 234,179,8), 0.12)',
          borderBottom: '1px solid rgba(var(--color-warning-rgb, 234,179,8), 0.25)',
          flexShrink: 0,
        }}>
          <span style={{
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-warning)',
            fontFamily: 'var(--font-sans)',
          }}>
            Stage {pendingApproval.stage + 1} ({pendingApproval.stageName}) is waiting for approval
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              onClick={() => onApproveGate?.(pendingApproval.stage)}
              style={{
                height: 28,
                padding: '0 14px',
                background: 'var(--color-success, #22c55e)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'var(--font-sans)',
                cursor: 'pointer',
              }}
            >
              Approve
            </button>
            <button
              onClick={() => _onStop?.()}
              style={{
                height: 28,
                padding: '0 14px',
                background: 'var(--color-error, #ef4444)',
                color: '#fff',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                fontSize: 12,
                fontWeight: 500,
                fontFamily: 'var(--font-sans)',
                cursor: 'pointer',
              }}
            >
              Reject
            </button>
          </div>
        </div>
      )}

      {/* Main two-column layout */}
      <div style={{
        display: 'flex',
        flex: 1,
        overflow: 'hidden',
      }}>
      {/* Left panel — Stage list */}
      {stageChips.length > 0 && (
        <div style={{
          width: 260,
          flexShrink: 0,
          borderRight: '1px solid var(--separator)',
          background: 'var(--bg-elevated-1)',
          overflow: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}>
          <StageChips
            stages={stageChips}
            currentStage={currentStage}
            selectedStage={selectedStage}
            onStageSelect={(idx) => {
              setSelectedStage(idx);
              setUserSelected(true);
              setSelectedRepo(null);
            }}
          />

          {/* Resume/Retry banner for terminal states */}
          {!isRunning && (status === 'failed' || status === 'cancelled' || status === 'completed') && (onResume || onRetry) && (
            <div style={{
              padding: '12px 16px',
              borderTop: '1px solid var(--separator)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}>
              <div style={{
                fontSize: 12,
                color: status === 'failed' ? 'var(--color-error)' : status === 'cancelled' ? 'var(--color-warning)' : 'var(--accent)',
                fontWeight: 500,
              }}>
                {status === 'failed' ? 'Pipeline failed' : status === 'cancelled' ? 'Pipeline stopped' : 'Pipeline completed'}
              </div>
              {(status === 'failed' || status === 'cancelled') && onResume && (
                <button
                  onClick={onResume}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', fontSize: 12, fontWeight: 500,
                    background: 'rgba(52,211,153,0.1)', color: 'var(--accent)',
                    border: '1px solid rgba(52,211,153,0.2)',
                    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <Play size={12} />
                  Resume from failed step
                </button>
              )}
              {onRetry && (
                <button
                  onClick={onRetry}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '6px 12px', fontSize: 12, fontWeight: 500,
                    background: 'var(--bg-elevated-2)', color: 'var(--text-secondary)',
                    border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  <RotateCcw size={12} />
                  Restart from scratch
                </button>
              )}
            </div>
          )}

          {/* Repo breakdown below stages */}
          {activeRepos.length > 1 && (
            <div style={{
              padding: '8px 8px',
              borderTop: '1px solid var(--separator)',
            }}>
              {activeRepos.map((r) => (
                <button
                  key={r.repoName}
                  onClick={() => setSelectedRepo(selectedRepo === r.repoName ? null : r.repoName)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    padding: '5px 8px',
                    background: selectedRepo === r.repoName ? 'var(--accent-subtle)' : 'transparent',
                    border: 'none',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 12,
                    color: 'var(--text-secondary)',
                    textAlign: 'left',
                    transition: 'background var(--duration-fast) var(--ease-default)',
                  }}
                >
                  <span style={{
                    width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                    background: r.status === 'completed' ? 'var(--color-success)'
                      : r.status === 'running' ? 'var(--color-warning)'
                      : r.status === 'failed' ? 'var(--color-error)'
                      : 'var(--bg-elevated-4)',
                    ...(r.status === 'running' ? { animation: 'pulse 2s ease-in-out infinite' } : {}),
                  }} />
                  <span style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 11 }}>{r.repoName}</span>
                  {r.status === 'completed' && (
                    <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                      {'\u2713'}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Right panel — Conversation output */}
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <OutputPanel
          key={`${selectedStage ?? 'all'}-${selectedRepo ?? 'all'}`}
          activities={filteredActivities}
          rawOutput={filteredRaw}
          changes={filteredChanges}
          isRunning={isRunning}
          onSendInput={onSendInput}
          inputPlaceholder={inputPlaceholder}
        />
      </div>
      </div>
    </div>
  );
}

export default PipelineContainer;
