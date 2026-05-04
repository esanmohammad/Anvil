// Team-mode reviewer and audit panel for a paused pipeline run (Phase 7).
// Renders the resolved reviewer list with per-user status pills, a quorum
// indicator, an expandable audit timeline, and a reassignment control.

import React, { useMemo, useState } from 'react';
import {
  Users,
  CheckCircle2,
  XCircle,
  Clock,
  UserPlus,
} from 'lucide-react';

// Inline types mirror the server-side shapes (`server/pipeline-reviewers-types.ts`).
// We avoid a direct import to keep the client bundle free of Node-only deps.
export interface ReviewerApproval {
  user: string;
  action: 'approve' | 'reject';
  at: string;
  note?: string;
}

export interface ReviewerAssignment {
  runId: string;
  project: string;
  reviewers: string[];
  approvalsRequired: number;
  approvals: ReviewerApproval[];
  createdAt: string;
}

export type AuditEvent =
  | 'paused'
  | 'approved'
  | 'rejected'
  | 'modified'
  | 'reassigned'
  | 'escalated'
  | 'timed-out';

export interface AuditEntry {
  id: string;
  runId: string;
  project: string;
  event: AuditEvent;
  actor: string;
  at: string;
  details?: Record<string, unknown>;
}

export interface ReviewerPanelProps {
  assignment: ReviewerAssignment;
  audit: AuditEntry[];
  onReassign: (users: string[]) => void;
}

// ── Status derivation ────────────────────────────────────────────────────

type ReviewerStatus = 'pending' | 'approved' | 'rejected';

function reviewerStatus(
  user: string,
  approvals: ReviewerApproval[],
): ReviewerStatus {
  // Last vote wins (store.recordApproval replaces prior votes, but be safe).
  const userVotes = approvals.filter((a) => a.user === user);
  if (userVotes.length === 0) return 'pending';
  const last = userVotes[userVotes.length - 1]!;
  return last.action === 'approve' ? 'approved' : 'rejected';
}

function approveCount(a: ReviewerAssignment): number {
  const approvers = new Set(
    a.approvals.filter((v) => v.action === 'approve').map((v) => v.user),
  );
  return approvers.size;
}

function formatRelative(iso: string, now: number = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const diff = Math.max(0, now - t);
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ── Icon/color config ────────────────────────────────────────────────────

const statusConfig: Record<
  ReviewerStatus,
  { label: string; color: string; bg: string; Icon: typeof Clock }
> = {
  pending: {
    label: 'pending',
    color: 'var(--text-tertiary)',
    bg: 'var(--bg-elevated-2)',
    Icon: Clock,
  },
  approved: {
    label: 'approved',
    color: 'var(--color-success)',
    bg: 'rgba(111, 175, 138, 0.12)',
    Icon: CheckCircle2,
  },
  rejected: {
    label: 'rejected',
    color: 'var(--color-error)',
    bg: 'rgba(201, 115, 115, 0.12)',
    Icon: XCircle,
  },
};

const eventConfig: Record<
  AuditEvent,
  { color: string; Icon: typeof Clock }
> = {
  paused: { color: 'var(--color-warning)', Icon: Clock },
  approved: { color: 'var(--color-success)', Icon: CheckCircle2 },
  rejected: { color: 'var(--color-error)', Icon: XCircle },
  modified: { color: 'var(--text-secondary)', Icon: UserPlus },
  reassigned: { color: 'var(--text-secondary)', Icon: UserPlus },
  escalated: { color: 'var(--color-warning)', Icon: UserPlus },
  'timed-out': { color: 'var(--text-tertiary)', Icon: Clock },
};

// ── Component ────────────────────────────────────────────────────────────

export function ReviewerPanel({
  assignment,
  audit,
  onReassign,
}: ReviewerPanelProps) {
  const [reassignInput, setReassignInput] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const approved = approveCount(assignment);
  const quorumMet = approved >= assignment.approvalsRequired
    && !assignment.approvals.some((a) => a.action === 'reject');

  const sortedAudit = useMemo(
    () => [...audit].sort((a, b) => b.at.localeCompare(a.at)),
    [audit],
  );

  function toggleExpanded(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function submitReassign(): void {
    const users = reassignInput
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (users.length === 0) return;
    onReassign(users);
    setReassignInput('');
  }

  return (
    <section
      aria-label="Reviewers and audit log"
      style={{
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        padding: 14,
        marginBottom: 12,
        fontFamily: 'var(--font-sans)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {/* Header: reviewer list + quorum */}
      <div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
          }}
        >
          <Users
            size={14}
            strokeWidth={1.75}
            style={{ color: 'var(--text-secondary)' }}
            aria-hidden="true"
          />
          <span
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: 0.5,
              color: 'var(--text-tertiary)',
              fontWeight: 600,
            }}
          >
            Reviewers
          </span>
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              color: quorumMet ? 'var(--color-success)' : 'var(--text-secondary)',
              fontWeight: 600,
            }}
            aria-live="polite"
          >
            {approved} of {assignment.approvalsRequired} approvals
            {quorumMet ? ' (quorum met)' : ''}
          </span>
        </div>

        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
          }}
        >
          {assignment.reviewers.map((user) => {
            const status = reviewerStatus(user, assignment.approvals);
            const cfg = statusConfig[status];
            const Icon = cfg.Icon;
            return (
              <li
                key={user}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '4px 10px',
                  background: cfg.bg,
                  border: '1px solid var(--separator)',
                  borderRadius: 'var(--radius-full)',
                  fontSize: 12,
                }}
                title={`${user} — ${cfg.label}`}
              >
                <Icon
                  size={12}
                  strokeWidth={1.75}
                  style={{ color: cfg.color }}
                  aria-hidden="true"
                />
                <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                  {user}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    color: cfg.color,
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {cfg.label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Reassign control */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingTop: 8,
          borderTop: '1px solid var(--separator)',
        }}
      >
        <UserPlus
          size={14}
          strokeWidth={1.75}
          style={{ color: 'var(--text-secondary)' }}
          aria-hidden="true"
        />
        <input
          type="text"
          value={reassignInput}
          onChange={(e) => setReassignInput(e.target.value)}
          placeholder="reassign to: @alice, @bob"
          aria-label="Reassign reviewers (comma-separated usernames)"
          style={{
            flex: 1,
            padding: '5px 8px',
            background: 'var(--bg-elevated-1)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 12,
            fontFamily: 'var(--font-sans)',
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submitReassign();
          }}
        />
        <button
          type="button"
          onClick={submitReassign}
          disabled={reassignInput.trim().length === 0}
          style={{
            padding: '5px 12px',
            background: 'var(--bg-elevated-3)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-primary)',
            fontSize: 12,
            fontWeight: 600,
            cursor: reassignInput.trim().length === 0 ? 'not-allowed' : 'pointer',
            opacity: reassignInput.trim().length === 0 ? 0.6 : 1,
          }}
        >
          Reassign
        </button>
      </div>

      {/* Audit timeline */}
      <div>
        <div
          style={{
            fontSize: 10,
            textTransform: 'uppercase',
            letterSpacing: 0.5,
            color: 'var(--text-tertiary)',
            marginBottom: 6,
            fontWeight: 600,
          }}
        >
          Audit timeline
        </div>
        {sortedAudit.length === 0 ? (
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-tertiary)',
              fontStyle: 'italic',
            }}
          >
            No audit entries yet.
          </div>
        ) : (
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {sortedAudit.map((entry) => {
              const cfg = eventConfig[entry.event];
              const Icon = cfg.Icon;
              const isExpanded = expanded.has(entry.id);
              const hasDetails = entry.details
                && Object.keys(entry.details).length > 0;
              return (
                <li
                  key={entry.id}
                  style={{
                    padding: '6px 8px',
                    background: 'var(--bg-elevated-1)',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: 12,
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      cursor: hasDetails ? 'pointer' : 'default',
                    }}
                    onClick={() => hasDetails && toggleExpanded(entry.id)}
                  >
                    <Icon
                      size={12}
                      strokeWidth={1.75}
                      style={{ color: cfg.color, flexShrink: 0 }}
                      aria-hidden="true"
                    />
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                        color: cfg.color,
                        fontWeight: 700,
                        minWidth: 70,
                      }}
                    >
                      {entry.event}
                    </span>
                    <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                      {entry.actor}
                    </span>
                    <span
                      style={{
                        marginLeft: 'auto',
                        color: 'var(--text-tertiary)',
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                      }}
                      title={entry.at}
                    >
                      {formatRelative(entry.at)}
                    </span>
                  </div>
                  {hasDetails && isExpanded && (
                    <pre
                      style={{
                        margin: '6px 0 0 20px',
                        padding: 8,
                        background: 'var(--bg-elevated-3)',
                        border: '1px solid var(--separator)',
                        borderRadius: 'var(--radius-sm)',
                        fontFamily: 'var(--font-mono)',
                        fontSize: 11,
                        color: 'var(--text-secondary)',
                        overflow: 'auto',
                        whiteSpace: 'pre-wrap',
                      }}
                    >
                      {JSON.stringify(entry.details, null, 2)}
                    </pre>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

export default ReviewerPanel;
