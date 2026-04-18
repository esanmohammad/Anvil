// Pipeline state machine

import type { PipelineState, PipelineEvent } from './types.js';
import { PIPELINE_STAGES } from './types.js';

export class PipelineStateMachine {
  private state: PipelineState;
  private listeners: ((event: PipelineEvent) => void)[] = [];

  constructor(initialStage: number = 0) {
    this.state = {
      currentStage: initialStage,
      status: 'pending',
      events: [],
    };
  }

  getState(): PipelineState {
    return { ...this.state, events: [...this.state.events] };
  }

  getCurrentStage(): number {
    return this.state.currentStage;
  }

  getStatus(): PipelineState['status'] {
    return this.state.status;
  }

  start(): void {
    if (this.state.status !== 'pending') {
      throw new Error(`Cannot start pipeline in state "${this.state.status}"`);
    }
    this.state.status = 'running';
    this.state.startedAt = new Date().toISOString();

    const stage = PIPELINE_STAGES[this.state.currentStage];
    this.emit({
      type: 'stage-start',
      stage: this.state.currentStage,
      stageName: stage?.name,
      timestamp: new Date().toISOString(),
    });
  }

  advance(): void {
    if (this.state.status !== 'running') {
      throw new Error(`Cannot advance pipeline in state "${this.state.status}"`);
    }

    const currentStage = PIPELINE_STAGES[this.state.currentStage];

    // Emit stage-complete for current stage
    this.emit({
      type: 'stage-complete',
      stage: this.state.currentStage,
      stageName: currentStage?.name,
      timestamp: new Date().toISOString(),
    });

    // If we're at the last stage, complete the pipeline
    if (this.state.currentStage >= PIPELINE_STAGES.length - 1) {
      this.state.status = 'completed';
      this.state.completedAt = new Date().toISOString();
      this.emit({
        type: 'pipeline-complete',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Move to next stage
    this.state.currentStage++;
    const nextStage = PIPELINE_STAGES[this.state.currentStage];
    this.emit({
      type: 'stage-start',
      stage: this.state.currentStage,
      stageName: nextStage?.name,
      timestamp: new Date().toISOString(),
    });
  }

  fail(error: string): void {
    if (this.state.status !== 'running') {
      throw new Error(`Cannot fail pipeline in state "${this.state.status}"`);
    }

    const currentStage = PIPELINE_STAGES[this.state.currentStage];
    this.state.status = 'failed';
    this.state.completedAt = new Date().toISOString();

    this.emit({
      type: 'stage-fail',
      stage: this.state.currentStage,
      stageName: currentStage?.name,
      error,
      timestamp: new Date().toISOString(),
    });

    this.emit({
      type: 'pipeline-fail',
      error,
      timestamp: new Date().toISOString(),
    });
  }

  skip(): void {
    if (this.state.status !== 'running') {
      throw new Error(`Cannot skip stage in state "${this.state.status}"`);
    }

    // If at last stage, complete the pipeline
    if (this.state.currentStage >= PIPELINE_STAGES.length - 1) {
      this.state.status = 'completed';
      this.state.completedAt = new Date().toISOString();
      this.emit({
        type: 'pipeline-complete',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Move to next stage
    this.state.currentStage++;
    const nextStage = PIPELINE_STAGES[this.state.currentStage];
    this.emit({
      type: 'stage-start',
      stage: this.state.currentStage,
      stageName: nextStage?.name,
      timestamp: new Date().toISOString(),
    });
  }

  cancel(): void {
    if (this.state.status === 'completed' || this.state.status === 'failed') {
      throw new Error(`Cannot cancel pipeline in state "${this.state.status}"`);
    }

    this.state.status = 'cancelled';
    this.state.completedAt = new Date().toISOString();
  }

  onEvent(listener: (event: PipelineEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: PipelineEvent): void {
    this.state.events.push(event);
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
