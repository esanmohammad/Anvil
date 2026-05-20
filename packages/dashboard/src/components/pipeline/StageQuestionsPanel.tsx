import React, { useState } from 'react';
import { MessageSquare, Check, Pencil } from 'lucide-react';

export interface StageQuestion {
  index: number;
  text: string;
  answer?: string;
  answeredAt?: string;
}

export interface StageQuestionsPanelProps {
  stageIndex: number;
  stageName: string;
  questions: StageQuestion[];
  repoName?: string | null;
  ws: WebSocket | null;
  /** When true, panel is in compact "history" mode (collapsed by default). */
  historyMode?: boolean;
}

/**
 * Renders the agent's Q&A questions for a planning stage. Each
 * unanswered question gets a textarea + Submit; answered questions
 * collapse into a "✓ Answered" row with an Edit affordance.
 *
 * After every question is answered, the panel transitions into
 * read-only history view (the agent has resumed).
 */
export function StageQuestionsPanel({
  stageIndex,
  stageName,
  questions,
  repoName = null,
  ws,
  historyMode = false,
}: StageQuestionsPanelProps): React.ReactElement | null {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [editing, setEditing] = useState<Record<number, boolean>>({});
  const [submitting, setSubmitting] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState(!historyMode);

  if (!questions || questions.length === 0) return null;
  const allAnswered = questions.every((q) => q.answer);
  const remaining = questions.filter((q) => !q.answer).length;

  function submit(qIdx: number): void {
    const text = drafts[qIdx];
    if (!ws || !text || !text.trim()) return;
    setSubmitting((s) => ({ ...s, [qIdx]: true }));
    try {
      ws.send(JSON.stringify({
        action: 'provide-stage-answer',
        stageIndex,
        repoName: repoName ?? undefined,
        questionIndex: qIdx,
        text: text.trim(),
      }));
      setEditing((e) => ({ ...e, [qIdx]: false }));
    } catch {
      setSubmitting((s) => ({ ...s, [qIdx]: false }));
    }
  }

  function submitAll(): void {
    for (const q of questions) {
      if (!q.answer && drafts[q.index]?.trim()) submit(q.index);
    }
  }

  if (historyMode && !expanded) {
    return (
      <button type="button" className="btn btn-ghost btn-sm"
              onClick={() => setExpanded(true)}
              style={{ marginTop: 8 }}>
        <MessageSquare size={12} /> Q&amp;A history ({questions.length} {questions.length === 1 ? 'question' : 'questions'})
      </button>
    );
  }

  return (
    <div className="card" style={{ padding: 12, marginTop: 8, background: 'var(--bg-tertiary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <MessageSquare size={14} />
        <strong style={{ fontSize: 13 }}>
          {historyMode
            ? `Q&A history — ${stageName}${repoName ? ` (${repoName})` : ''}`
            : allAnswered
              ? `All answered — agent resuming ${stageName}${repoName ? ` (${repoName})` : ''}…`
              : `Agent has questions before producing the ${stageName} artifact (${remaining} remaining)`}
        </strong>
        {historyMode && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded(false)} style={{ marginLeft: 'auto' }}>
            Collapse
          </button>
        )}
      </div>
      {questions.map((q) => {
        const isAnswered = !!q.answer;
        const isEditing = editing[q.index] || (!isAnswered && !historyMode);
        return (
          <div key={q.index} style={{ marginBottom: 10, padding: 8, borderLeft: '2px solid var(--separator)' }}>
            <p style={{ margin: 0, fontWeight: 600, fontSize: 13 }}>
              Question {q.index + 1} of {questions.length}
            </p>
            <p style={{ margin: '4px 0 6px 0', fontSize: 13 }}>{q.text}</p>
            {isAnswered && !isEditing ? (
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                <Check size={14} style={{ color: 'var(--color-success)', flexShrink: 0, marginTop: 2 }} />
                <p style={{ margin: 0, fontSize: 13, color: 'var(--text-secondary)', flex: 1 }}>{q.answer}</p>
                {!historyMode && !allAnswered && (
                  <button type="button" className="btn btn-ghost btn-sm"
                          onClick={() => {
                            setDrafts((d) => ({ ...d, [q.index]: q.answer ?? '' }));
                            setEditing((e) => ({ ...e, [q.index]: true }));
                          }}>
                    <Pencil size={12} /> Edit
                  </button>
                )}
              </div>
            ) : (
              <>
                <textarea
                  value={drafts[q.index] ?? ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [q.index]: e.target.value }))}
                  rows={2}
                  placeholder="Type your answer…"
                  style={{
                    width: '100%', padding: 6, fontSize: 13, fontFamily: 'inherit',
                    background: 'var(--bg-elevated-2)', border: '1px solid var(--separator)',
                    borderRadius: 4,
                  }}
                />
                <div style={{ display: 'flex', gap: 6, marginTop: 4, justifyContent: 'flex-end' }}>
                  <button type="button" className="btn btn-primary btn-sm"
                          onClick={() => submit(q.index)}
                          disabled={!drafts[q.index]?.trim() || submitting[q.index]}>
                    {submitting[q.index] ? 'Sending…' : 'Submit'}
                  </button>
                </div>
              </>
            )}
          </div>
        );
      })}
      {!historyMode && !allAnswered && questions.filter((q) => !q.answer).length > 1 && (
        <div style={{ marginTop: 6, textAlign: 'right' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={submitAll}
                  disabled={questions.some((q) => !q.answer && !drafts[q.index]?.trim())}>
            Submit all answers
          </button>
        </div>
      )}
    </div>
  );
}

export default StageQuestionsPanel;
