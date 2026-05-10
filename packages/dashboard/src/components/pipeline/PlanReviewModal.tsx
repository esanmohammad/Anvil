// Full-screen modal for inspecting a paused pipeline run and deciding how to
// resolve the pause: approve / modify / re-plan with note / cancel.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X,
  ChevronDown,
  ChevronRight,
  Check,
  AlertTriangle,
  FileText,
  Clock,
  Users,
  DollarSign,
  Pencil,
  Send,
  XCircle,
} from 'lucide-react';
import { PlanRiskPanel } from './PlanRiskPanel.js';
import type { PausedRunData, ResumeDecision } from './pipeline-ui-types.js';

export interface PlanReviewModalProps {
  data: PausedRunData;
  /**
   * Markdown artifact emitted by the just-paused stage. Pre-fills the
   * "Edit artifact" textarea so the reviewer can tweak the output and
   * resume with the edited copy. Optional — when missing, the edit panel
   * stays empty (still functional, just less helpful).
   */
  currentArtifact?: string;
  /**
   * All pipeline stages in order. Used to populate the rerun-from
   * dropdown — the reviewer picks one prior stage to roll back to.
   * Stages with index > currentStageIndex are filtered out client-side.
   */
  pipelineStages?: ReadonlyArray<{ name: string; label: string }>;
  /** Index of the just-paused stage. Caps the rerun-from dropdown. */
  currentStageIndex?: number;
  /**
   * Q&A history for the just-paused stage — when present, render a
   * collapsed disclosure above the artifact summary so the reviewer
   * has full context for what the agent built and why.
   */
  stageQuestions?: ReadonlyArray<{ index: number; text: string; answer?: string }>;
  onResolve: (decision: ResumeDecision) => void;
  onClose: () => void;
}

type InlinePanel = 'approveNote' | 'modify' | 'iterate' | 'replan' | 'confirmCancel' | null;

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return iso;
  const diff = Date.now() - then;
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function remainingTime(iso: string): { text: string; expired: boolean } {
  const until = new Date(iso).getTime();
  const diff = until - Date.now();
  if (isNaN(until)) return { text: iso, expired: false };
  if (diff <= 0) return { text: 'expired', expired: true };
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return { text: `${sec}s`, expired: false };
  const min = Math.floor(sec / 60);
  if (min < 60) return { text: `${min}m ${sec % 60}s`, expired: false };
  const h = Math.floor(min / 60);
  return { text: `${h}h ${min % 60}m`, expired: false };
}

function initial(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase();
}

export function PlanReviewModal({
  data,
  currentArtifact,
  pipelineStages,
  currentStageIndex,
  stageQuestions,
  onResolve,
  onClose,
}: PlanReviewModalProps) {
  const { pause, riskScore, planSummary, touchedFiles, predictedDiff, tokenCostEstimate } = data;

  const [summaryOpen, setSummaryOpen] = useState(true);
  const [filesOpen, setFilesOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [inline, setInline] = useState<InlinePanel>(null);

  const [modifyText, setModifyText] = useState(currentArtifact ?? '');
  const [modifyError, setModifyError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [approveNote, setApproveNote] = useState('');
  // Rerun target — defaults to the just-paused stage so "Rerun + note"
  // means "redo this stage with my feedback" without forcing a click.
  const [rerunTarget, setRerunTarget] = useState<number>(
    typeof currentStageIndex === 'number' ? currentStageIndex : 0,
  );

  const approveRef = useRef<HTMLButtonElement>(null);

  // Countdown tick
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!pause.timeoutAt) return;
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [pause.timeoutAt]);

  // Keyboard: Esc closes, "A" focuses+clicks approve (unless typing).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (!typing && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        approveRef.current?.focus();
        approveRef.current?.click();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const validateModify = useCallback(() => {
    try {
      JSON.parse(modifyText);
      setModifyError(null);
      return true;
    } catch (e) {
      setModifyError(e instanceof Error ? e.message : 'Invalid JSON');
      return false;
    }
  }, [modifyText]);

  const handleSaveModify = useCallback(() => {
    // The textarea was pre-filled with the just-paused stage's artifact
    // (markdown). Sending it back replaces the on-disk + in-memory copy
    // before the next stage runs.
    if (!modifyText.trim()) {
      setModifyError('Edited artifact cannot be empty.');
      return;
    }
    setModifyError(null);
    onResolve({ action: 'modify-artifact', editedArtifact: modifyText });
  }, [modifyText, onResolve]);

  const handleSubmitReplan = useCallback(() => {
    const trimmed = note.trim();
    if (!trimmed) return;
    onResolve({ action: 'rerun-from', note: trimmed, rerunFromStage: rerunTarget });
  }, [note, rerunTarget, onResolve]);

  const [iterateNote, setIterateNote] = useState('');
  const handleSubmitIterate = useCallback(() => {
    const trimmed = iterateNote.trim();
    if (!trimmed) return;
    onResolve({ action: 'iterate-with-note', note: trimmed });
  }, [iterateNote, onResolve]);

  const handleApproveWithNote = useCallback(() => {
    const trimmed = approveNote.trim();
    if (!trimmed) {
      onResolve({ action: 'approve' });
    } else {
      onResolve({ action: 'approve-with-note', note: trimmed });
    }
  }, [approveNote, onResolve]);

  const handleConfirmCancel = useCallback(() => {
    onResolve({ action: 'cancel' });
  }, [onResolve]);

  const runIdShort = useMemo(() => pause.runId.slice(0, 8), [pause.runId]);
  const remaining = pause.timeoutAt ? remainingTime(pause.timeoutAt) : null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Review paused pipeline run"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(0, 0, 0, 0.55)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-lg)',
        fontFamily: 'var(--font-sans)',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: 'min(1120px, 100%)',
          maxHeight: '90vh',
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-elevated-1)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-lg)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px',
          borderBottom: '1px solid var(--separator)',
          background: 'var(--bg-elevated-2)',
          flexShrink: 0,
        }}>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '2px 10px',
            background: 'var(--bg-elevated-3)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-full)',
            fontSize: 11, fontWeight: 600,
            color: 'var(--text-secondary)',
            textTransform: 'uppercase', letterSpacing: 0.3,
          }}>
            {pause.stage}
          </span>
          <span style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--text-tertiary)',
          }}>
            run:{runIdShort}
          </span>
          <span style={{
            fontSize: 12, color: 'var(--text-secondary)',
          }}>
            paused {relativeTime(pause.pausedAt)}
          </span>
          <span style={{
            fontSize: 12, color: 'var(--text-tertiary)',
          }}>
            · {pause.reason}
          </span>
          <button
            onClick={onClose}
            aria-label="Close modal"
            style={{
              marginLeft: 'auto',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28,
              background: 'transparent',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            <X size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        {/* Body */}
        <div style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '3fr 2fr',
          gap: 0,
          overflow: 'hidden',
          minHeight: 0,
        }}>
          {/* Left column */}
          <div style={{
            padding: 16,
            overflowY: 'auto',
            borderRight: '1px solid var(--separator)',
            minWidth: 0,
          }}>
            {riskScore && <PlanRiskPanel risk={riskScore} />}

            {stageQuestions && stageQuestions.length > 0 && (
              <Collapsible
                title="Q&A from this stage"
                open={false}
                onToggle={() => { /* parent state too small to bother — local */ }}
                icon={<FileText size={14} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />}
                count={`${stageQuestions.filter((q) => q.answer).length}/${stageQuestions.length} answered`}
              >
                <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  {stageQuestions.map((q) => (
                    <div key={q.index} style={{ marginBottom: 8 }}>
                      <p style={{ margin: 0, fontWeight: 600 }}>Q: {q.text}</p>
                      <p style={{ margin: 0 }}>A: {q.answer ?? <em>(no answer)</em>}</p>
                    </div>
                  ))}
                </div>
              </Collapsible>
            )}

            <Collapsible
              title="Plan summary"
              open={summaryOpen}
              onToggle={() => setSummaryOpen((v) => !v)}
              icon={<FileText size={14} strokeWidth={1.75} style={{ color: 'var(--accent)' }} aria-hidden="true" />}
              count={planSummary ? `${planSummary.length} chars` : 'empty'}
            >
              <pre style={{
                margin: 0,
                fontFamily: 'var(--font-sans)',
                fontSize: 12,
                lineHeight: 1.55,
                whiteSpace: 'pre-wrap',
                color: 'var(--text-secondary)',
              }}>
                {planSummary || 'No plan summary provided.'}
              </pre>
            </Collapsible>

            <Collapsible
              title="Touched files"
              open={filesOpen}
              onToggle={() => setFilesOpen((v) => !v)}
              icon={<FileText size={14} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />}
              count={`${touchedFiles?.length ?? 0}`}
            >
              {(touchedFiles?.length ?? 0) === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No files listed.</span>
              ) : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {touchedFiles!.map((f) => (
                    <li
                      key={f}
                      style={{
                        padding: '3px 0',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 12,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      {f}
                    </li>
                  ))}
                </ul>
              )}
            </Collapsible>

            <Collapsible
              title="Predicted diff"
              open={diffOpen}
              onToggle={() => setDiffOpen((v) => !v)}
              icon={<FileText size={14} strokeWidth={1.75} style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />}
              count={predictedDiff ? `${predictedDiff.split('\n').length} lines` : 'none'}
            >
              {predictedDiff ? (
                <pre style={{
                  margin: 0,
                  padding: 10,
                  background: 'var(--bg-base)',
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-sm)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  lineHeight: 1.5,
                  color: 'var(--text-secondary)',
                  overflow: 'auto',
                  maxHeight: 400,
                  whiteSpace: 'pre',
                }}>
                  {predictedDiff}
                </pre>
              ) : (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  Dry-run output unavailable.
                </span>
              )}
            </Collapsible>
          </div>

          {/* Right column */}
          <div style={{
            padding: 16,
            overflowY: 'auto',
            display: 'flex', flexDirection: 'column', gap: 12,
            background: 'var(--bg-elevated-1)',
            minWidth: 0,
          }}>
            {/* Cost card */}
            {tokenCostEstimate && (
              <div style={{
                padding: 12,
                background: 'var(--bg-elevated-2)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-md)',
              }}>
                <div style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
                  color: 'var(--text-tertiary)',
                  marginBottom: 6,
                }}>
                  <DollarSign size={11} strokeWidth={1.75} aria-hidden="true" />
                  Estimated cost
                </div>
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 8,
                }}>
                  <span style={{
                    fontSize: 20, fontWeight: 700,
                    color: 'var(--text-primary)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    ${tokenCostEstimate.usd.toFixed(2)}
                  </span>
                  <span style={{
                    fontSize: 11,
                    color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                  }}>
                    {tokenCostEstimate.inTokens.toLocaleString()} in · {tokenCostEstimate.outTokens.toLocaleString()} out
                  </span>
                </div>
              </div>
            )}

            {/* Reviewers */}
            <div style={{
              padding: 12,
              background: 'var(--bg-elevated-2)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5,
                color: 'var(--text-tertiary)',
                marginBottom: 8,
              }}>
                <Users size={11} strokeWidth={1.75} aria-hidden="true" />
                Reviewers ({pause.reviewers.length})
              </div>
              {pause.reviewers.length === 0 ? (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                  No reviewers assigned.
                </span>
              ) : (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {pause.reviewers.map((r) => (
                    <div
                      key={r}
                      title={r}
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '3px 10px 3px 3px',
                        background: 'var(--bg-elevated-3)',
                        borderRadius: 'var(--radius-full)',
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                      }}
                    >
                      <span style={{
                        width: 20, height: 20, borderRadius: 'var(--radius-full)',
                        background: 'var(--accent)',
                        color: 'var(--text-inverse)',
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, fontWeight: 700,
                      }}>
                        {initial(r)}
                      </span>
                      {r}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Timeout countdown */}
            {remaining && (
              <div
                role="timer"
                aria-label="Pause timeout countdown"
                style={{
                  padding: '8px 12px',
                  background: remaining.expired ? 'rgba(201, 115, 115, 0.10)' : 'var(--bg-elevated-2)',
                  border: `1px solid ${remaining.expired ? 'var(--color-error)' : 'var(--separator)'}`,
                  borderRadius: 'var(--radius-md)',
                  display: 'flex', alignItems: 'center', gap: 8,
                  fontSize: 12,
                  color: remaining.expired ? 'var(--color-error)' : 'var(--text-secondary)',
                }}
              >
                <Clock size={12} strokeWidth={1.75} aria-hidden="true" />
                <span>Timeout</span>
                <span style={{
                  marginLeft: 'auto',
                  fontFamily: 'var(--font-mono)', fontWeight: 600,
                }}>
                  {remaining.text}
                </span>
              </div>
            )}

            {/* Action stack */}
            <div style={{
              display: 'flex', flexDirection: 'column', gap: 8,
              marginTop: 'auto',
            }}>
              <button
                ref={approveRef}
                onClick={() => onResolve({ action: 'approve' })}
                aria-label="Approve plan (A)"
                style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                  gap: 6,
                  height: 40, padding: '0 16px',
                  background: 'var(--color-success)',
                  color: 'var(--text-inverse)',
                  border: 'none',
                  borderRadius: 'var(--radius-sm)',
                  fontSize: 13, fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <Check size={14} strokeWidth={2.25} aria-hidden="true" />
                Approve
                <span style={{
                  marginLeft: 6,
                  fontSize: 10, opacity: 0.7,
                  padding: '1px 5px',
                  borderRadius: 3,
                  background: 'rgba(0,0,0,0.18)',
                  fontFamily: 'var(--font-mono)',
                }}>A</span>
              </button>

              <button
                onClick={() => setInline((v) => v === 'approveNote' ? null : 'approveNote')}
                aria-expanded={inline === 'approveNote'}
                style={actionBtnStyle('secondary')}
              >
                <Send size={13} strokeWidth={1.75} aria-hidden="true" />
                Approve with note
              </button>

              {inline === 'approveNote' && (
                <div style={inlinePanelStyle()}>
                  <div style={{
                    fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6,
                  }}>
                    The note is injected at the top of the next stage's user prompt as guidance.
                  </div>
                  <textarea
                    value={approveNote}
                    onChange={(e) => setApproveNote(e.target.value)}
                    rows={4}
                    placeholder="e.g. Watch out for the existing CheckoutPage flow when wiring the adoption form."
                    aria-label="Note for next stage"
                    style={{
                      width: '100%',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--separator)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 8,
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 13,
                      outline: 'none',
                      resize: 'vertical',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      onClick={handleApproveWithNote}
                      disabled={!approveNote.trim()}
                      style={{
                        ...actionBtnStyle('primary', 32),
                        opacity: approveNote.trim() ? 1 : 0.55,
                        cursor: approveNote.trim() ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Approve & resume
                    </button>
                    <button
                      onClick={() => setInline(null)}
                      style={actionBtnStyle('ghost', 32)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => setInline((v) => v === 'modify' ? null : 'modify')}
                aria-expanded={inline === 'modify'}
                style={actionBtnStyle('secondary')}
              >
                <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
                Modify plan
              </button>

              {inline === 'modify' && (
                <div style={inlinePanelStyle()}>
                  <div style={{
                    fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6,
                  }}>
                    Edit the artifact this stage produced. Your edits replace the on-disk version before the next stage runs.
                  </div>
                  <textarea
                    value={modifyText}
                    onChange={(e) => {
                      setModifyText(e.target.value);
                      if (modifyError) setModifyError(null);
                    }}
                    spellCheck={false}
                    rows={16}
                    aria-label="Edit artifact markdown"
                    aria-invalid={!!modifyError}
                    style={{
                      width: '100%',
                      background: 'var(--bg-base)',
                      border: `1px solid ${modifyError ? 'var(--color-error)' : 'var(--separator)'}`,
                      borderRadius: 'var(--radius-sm)',
                      padding: 8,
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-mono)',
                      fontSize: 12,
                      outline: 'none',
                      resize: 'vertical',
                    }}
                  />
                  {modifyError && (
                    <div style={{
                      marginTop: 4,
                      fontSize: 11, color: 'var(--color-error)',
                      fontFamily: 'var(--font-mono)',
                    }}>
                      {modifyError}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      onClick={handleSaveModify}
                      style={actionBtnStyle('primary', 32)}
                    >
                      Save & resume
                    </button>
                    <button
                      onClick={() => setInline(null)}
                      style={actionBtnStyle('ghost', 32)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => setInline((v) => v === 'iterate' ? null : 'iterate')}
                aria-expanded={inline === 'iterate'}
                style={actionBtnStyle('secondary')}
              >
                <Pencil size={13} strokeWidth={1.75} aria-hidden="true" />
                Iterate with note (refine this stage)
              </button>

              {inline === 'iterate' && (
                <div style={inlinePanelStyle()}>
                  <div style={{
                    fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6,
                  }}>
                    Re-run the {pause.stage} stage with your feedback. Working-tree state is preserved — the agent reads what's already there and applies your note.
                  </div>
                  <textarea
                    value={iterateNote}
                    onChange={(e) => setIterateNote(e.target.value)}
                    rows={5}
                    placeholder="e.g. Also add error handling for the case where adoption fails after a partial commit."
                    aria-label="Iteration feedback"
                    style={{
                      width: '100%',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--separator)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 8,
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 13,
                      outline: 'none',
                      resize: 'vertical',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      onClick={handleSubmitIterate}
                      disabled={!iterateNote.trim()}
                      style={{
                        ...actionBtnStyle('primary', 32),
                        opacity: iterateNote.trim() ? 1 : 0.55,
                        cursor: iterateNote.trim() ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Apply &amp; rerun stage
                    </button>
                    <button
                      onClick={() => setInline(null)}
                      style={actionBtnStyle('ghost', 32)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => setInline((v) => v === 'replan' ? null : 'replan')}
                aria-expanded={inline === 'replan'}
                style={actionBtnStyle('secondary')}
              >
                <Send size={13} strokeWidth={1.75} aria-hidden="true" />
                Rerun from earlier stage
              </button>

              {inline === 'replan' && (
                <div style={inlinePanelStyle()}>
                  <div style={{
                    fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6,
                  }}>
                    Roll the pipeline back to a prior stage and replay it with your feedback.
                  </div>
                  {pipelineStages && pipelineStages.length > 0 && (
                    <label style={{
                      display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8,
                    }}>
                      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                        Roll back to stage
                      </span>
                      <select
                        value={rerunTarget}
                        onChange={(e) => setRerunTarget(Number(e.target.value))}
                        aria-label="Rerun-from stage"
                        style={{
                          background: 'var(--bg-base)',
                          border: '1px solid var(--separator)',
                          borderRadius: 'var(--radius-sm)',
                          padding: '6px 8px',
                          color: 'var(--text-primary)',
                          fontFamily: 'var(--font-sans)',
                          fontSize: 13,
                          outline: 'none',
                        }}
                      >
                        {pipelineStages
                          .map((s, idx) => ({ s, idx }))
                          .filter(({ idx }) => typeof currentStageIndex !== 'number' || idx <= currentStageIndex)
                          .map(({ s, idx }) => (
                            <option key={s.name} value={idx}>
                              {idx + 1}. {s.label}{idx === currentStageIndex ? ' (current)' : ''}
                            </option>
                          ))}
                      </select>
                    </label>
                  )}
                  <textarea
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                    rows={5}
                    placeholder="e.g. The analyst missed PII handling for adopter records — redo with that constraint."
                    aria-label="Note for rerun"
                    style={{
                      width: '100%',
                      background: 'var(--bg-base)',
                      border: '1px solid var(--separator)',
                      borderRadius: 'var(--radius-sm)',
                      padding: 8,
                      color: 'var(--text-primary)',
                      fontFamily: 'var(--font-sans)',
                      fontSize: 13,
                      outline: 'none',
                      resize: 'vertical',
                    }}
                  />
                  <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                    <button
                      onClick={handleSubmitReplan}
                      disabled={!note.trim()}
                      style={{
                        ...actionBtnStyle('primary', 32),
                        opacity: note.trim() ? 1 : 0.55,
                        cursor: note.trim() ? 'pointer' : 'not-allowed',
                      }}
                    >
                      Rerun stage
                    </button>
                    <button
                      onClick={() => setInline(null)}
                      style={actionBtnStyle('ghost', 32)}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <button
                onClick={() => setInline((v) => v === 'confirmCancel' ? null : 'confirmCancel')}
                aria-expanded={inline === 'confirmCancel'}
                style={actionBtnStyle('destructive')}
              >
                <XCircle size={13} strokeWidth={1.75} aria-hidden="true" />
                Cancel run
              </button>

              {inline === 'confirmCancel' && (
                <div
                  role="alertdialog"
                  aria-label="Confirm run cancellation"
                  style={{
                    ...inlinePanelStyle(),
                    borderColor: 'var(--color-error)',
                    background: 'rgba(201, 115, 115, 0.06)',
                  }}
                >
                  <div style={{
                    display: 'flex', alignItems: 'flex-start', gap: 6,
                    fontSize: 12, color: 'var(--text-primary)',
                    marginBottom: 10, lineHeight: 1.4,
                  }}>
                    <AlertTriangle
                      size={13}
                      strokeWidth={2}
                      style={{ color: 'var(--color-error)', flexShrink: 0, marginTop: 2 }}
                      aria-hidden="true"
                    />
                    <span>
                      This will cancel the run. Any work already performed is preserved;
                      subsequent stages will not execute.
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button
                      onClick={handleConfirmCancel}
                      style={{
                        ...actionBtnStyle('destructive', 32),
                        background: 'var(--color-error)',
                        color: 'var(--text-inverse)',
                        border: 'none',
                      }}
                    >
                      Confirm cancel
                    </button>
                    <button
                      onClick={() => setInline(null)}
                      style={actionBtnStyle('ghost', 32)}
                    >
                      Keep running
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────

function Collapsible({
  title,
  icon,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  count?: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <section style={{
      marginBottom: 10,
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        aria-expanded={open}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          width: '100%', padding: '8px 12px',
          background: 'transparent', border: 'none',
          color: 'var(--text-primary)',
          fontSize: 13, fontWeight: 600,
          cursor: 'pointer', textAlign: 'left',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
        {icon}
        {title}
        {count !== undefined && (
          <span style={{
            marginLeft: 'auto',
            fontSize: 11, fontWeight: 400,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
          }}>
            {count}
          </span>
        )}
      </button>
      {open && (
        <div style={{ padding: '0 12px 12px' }}>
          {children}
        </div>
      )}
    </section>
  );
}

function actionBtnStyle(
  variant: 'primary' | 'secondary' | 'ghost' | 'destructive',
  height = 38,
): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    gap: 6,
    height, padding: '0 14px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 13, fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  };
  if (variant === 'primary') return {
    ...base,
    background: 'var(--accent)',
    color: 'var(--text-inverse)',
    border: 'none',
  };
  if (variant === 'ghost') return {
    ...base,
    background: 'transparent',
    color: 'var(--text-secondary)',
    border: '1px solid var(--separator)',
  };
  if (variant === 'destructive') return {
    ...base,
    background: 'transparent',
    color: 'var(--color-error)',
    border: '1px solid rgba(201, 115, 115, 0.4)',
  };
  return {
    ...base,
    background: 'var(--bg-elevated-2)',
    color: 'var(--text-primary)',
    border: '1px solid var(--separator)',
  };
}

function inlinePanelStyle(): React.CSSProperties {
  return {
    padding: 10,
    background: 'var(--bg-elevated-2)',
    border: '1px solid var(--separator)',
    borderRadius: 'var(--radius-sm)',
  };
}

export default PlanReviewModal;
