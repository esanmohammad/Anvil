/**
 * `ReviewerControl` — pure state machine for reviewer-driven pipeline
 * control: in-flight review notes, post-stage artifact edits, and
 * rerun-from / iterate-with-note requests.
 *
 * Lives in dashboard because reviewer feedback is a dashboard-only UX
 * (the cli has no equivalent pause UI). The runner constructs one and
 * delegates state-only operations here; mutations that touch
 * `state.stages[]`, persist artifacts, or broadcast WS events stay on
 * the runner so this class has no dependencies on FS / WS / state.
 */

export interface ConsumedRerunRequest {
  targetIndex: number;
  note: string | null;
  mode: 'rerun-from' | 'iterate';
}

export class ReviewerControl {
  // ── Review note slot (after-stage hook → next stage's user prompt) ──
  /**
   * Note from the most recent reviewer pause. The pipeline loop calls
   * `armForCurrentStage()` at stage entry to lift it onto
   * `currentStageReviewNote` (so per-repo fanout sees the same value).
   */
  private pendingReviewNote: string | null = null;
  private currentStageReviewNote: string | null = null;

  /** Stash a reviewer's feedback note for the next stage. */
  setReviewNote(note: string | null): void {
    const trimmed = note?.trim() ?? '';
    this.pendingReviewNote = trimmed.length > 0 ? trimmed : null;
  }

  /** Move the most recent pause note onto the current stage. No-op when none. */
  armForCurrentStage(): void {
    if (this.pendingReviewNote) {
      this.currentStageReviewNote = this.pendingReviewNote;
      this.pendingReviewNote = null;
    }
  }

  /** Clear the per-stage review note so it doesn't bleed into the next stage. */
  clearForCurrentStage(): void {
    this.currentStageReviewNote = null;
  }

  /** Read the active review note (for prompt builders). Does NOT clear. */
  peekReviewNote(): string | null {
    return this.currentStageReviewNote;
  }

  // ── Artifact override (Phase B — modify-artifact) ────────────────────

  /**
   * Reviewer-edited artifact for the just-completed stage. The pipeline
   * loop reads this AFTER the after-stage hook returns and uses it as
   * the `prevArtifact` for the next stage.
   */
  private prevArtifactOverride: string | null = null;

  /** Set the override; the runner persists + broadcasts separately. */
  setArtifactOverride(edited: string): void {
    this.prevArtifactOverride = edited;
  }

  /** Read-and-clear the artifact override. Returns null when unset. */
  consumeArtifactOverride(): string | null {
    const v = this.prevArtifactOverride;
    this.prevArtifactOverride = null;
    return v;
  }

  // ── Rerun-from + Iterate-with-note (Phases C & F) ───────────────────

  private pendingRerunFromStage: number | null = null;
  private rerunFromNote: string | null = null;
  private pendingRerunMode: 'rerun-from' | 'iterate' | null = null;

  /**
   * Reviewer asked to roll the pipeline back to `targetIndex` and
   * replay with `note` as failure context.
   */
  requestRerunFromStage(targetIndex: number, totalStages: number, note: string | null): void {
    if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= totalStages) {
      return;
    }
    this.pendingRerunFromStage = targetIndex;
    this.pendingRerunMode = 'rerun-from';
    const trimmed = note?.trim() ?? '';
    this.rerunFromNote = trimmed.length > 0 ? trimmed : null;
  }

  /**
   * Reviewer wants to refine the just-paused stage's output with feedback —
   * keep working-tree state, keep manifest, frame the note as reviewer
   * feedback (not retry). The loop will reset just THIS stage.
   */
  iterateCurrentStageWithNote(
    currentStageIndex: number,
    totalStages: number,
    note: string | null,
  ): void {
    if (!Number.isInteger(currentStageIndex) || currentStageIndex < 0 || currentStageIndex >= totalStages) {
      return;
    }
    this.pendingRerunFromStage = currentStageIndex;
    this.pendingRerunMode = 'iterate';
    const trimmed = note?.trim() ?? '';
    this.rerunFromNote = trimmed.length > 0 ? trimmed : null;
  }

  /** Read-and-clear the pending rerun request. */
  consumeRerunRequest(): ConsumedRerunRequest | null {
    if (this.pendingRerunFromStage === null || this.pendingRerunMode === null) return null;
    const v: ConsumedRerunRequest = {
      targetIndex: this.pendingRerunFromStage,
      note: this.rerunFromNote,
      mode: this.pendingRerunMode,
    };
    this.pendingRerunFromStage = null;
    this.rerunFromNote = null;
    this.pendingRerunMode = null;
    return v;
  }
}
