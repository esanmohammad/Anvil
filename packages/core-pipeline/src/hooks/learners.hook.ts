/**
 * Learners hook — wires cli's previously-dead `autoLearnHook` into the bus.
 *
 * The cli's `cli/src/memory/learners/index.ts` exports `autoLearnHook(event,
 * project)` but nobody on the cli side ever called it. Phase 3 makes that
 * call site real: any subscriber that registers an `onLearnEvent` callback
 * here gets fired on `step:completed`, `step:failed`, and
 * `pipeline:completed` — the legacy event types `autoLearnHook` switches on.
 *
 * core-pipeline does NOT import from cli (cli depends on core-pipeline,
 * not the other way around). Instead the cli wires its `autoLearnHook` as
 * the callback at run start.
 */

import type { EventBus, EventListener, PipelineEvent } from '../types.js';

export interface LearnersHookOptions {
  /** Project name forwarded to the callback. */
  project: string;
  /** Callback invoked once per relevant event. */
  onLearnEvent: (event: PipelineEvent, project: string) => void | Promise<void>;
  /** Override priority. Default 50 (after audit, before dashboard). */
  priority?: number;
}

export interface LearnersHookHandle {
  unsubscribe: () => void;
  /** Number of events forwarded to the callback. */
  readonly invocationCount: number;
}

const HOOKS: ReadonlyArray<PipelineEvent['hook']> = [
  'step:completed',
  'step:failed',
  'pipeline:completed',
  'pipeline:failed',
];

export function attachLearnersHook(bus: EventBus, opts: LearnersHookOptions): LearnersHookHandle {
  const priority = opts.priority ?? 50;
  let invocationCount = 0;

  const listener: EventListener = async (event) => {
    invocationCount += 1;
    await opts.onLearnEvent(event, opts.project);
  };

  const offs = HOOKS.map((hook) => bus.on(hook, listener, { priority }));

  return {
    unsubscribe: () => {
      for (const off of offs) off();
    },
    get invocationCount() {
      return invocationCount;
    },
  };
}
