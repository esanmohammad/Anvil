/**
 * Minimal `StepRegistry` — Phase 1 scaffold.
 *
 * Phases 4 + 5 use this to compose the cli pipeline by ID. Order is
 * registration-sequence + insertBefore/insertAfter ops.
 */

import type { Step, StepRegistry } from './types.js';

export class InMemoryStepRegistry implements StepRegistry {
  private readonly ordered: Step<unknown, unknown>[] = [];

  register(step: Step<unknown, unknown>): void {
    this.assertUnique(step.id);
    this.ordered.push(step);
  }

  insertBefore(targetId: string, step: Step<unknown, unknown>): void {
    this.assertUnique(step.id);
    const idx = this.indexOf(targetId);
    this.ordered.splice(idx, 0, step);
  }

  insertAfter(targetId: string, step: Step<unknown, unknown>): void {
    this.assertUnique(step.id);
    const idx = this.indexOf(targetId);
    this.ordered.splice(idx + 1, 0, step);
  }

  replace(targetId: string, step: Step<unknown, unknown>): void {
    const idx = this.indexOf(targetId);
    if (step.id !== targetId) this.assertUnique(step.id);
    this.ordered.splice(idx, 1, step);
  }

  remove(targetId: string): void {
    const idx = this.indexOf(targetId);
    this.ordered.splice(idx, 1);
  }

  steps(): readonly Step<unknown, unknown>[] {
    return this.ordered.slice();
  }

  private indexOf(id: string): number {
    const idx = this.ordered.findIndex((s) => s.id === id);
    if (idx < 0) {
      throw new Error(`StepRegistry: no step with id "${id}"`);
    }
    return idx;
  }

  private assertUnique(id: string): void {
    if (this.ordered.some((s) => s.id === id)) {
      throw new Error(`StepRegistry: duplicate step id "${id}"`);
    }
  }
}
