// Auto-learn hook — Section C.5

import type { PipelineEvent } from '../../pipeline/types.js';
import { recordFixPattern } from './fix-pattern.js';
import { recordSuccess } from './success.js';
import { recordApproach } from './approach.js';

export { recordFixPattern } from './fix-pattern.js';
export { recordSuccess } from './success.js';
export { recordApproach } from './approach.js';
export { detectPollution } from './pollution-detector.js';

/**
 * Hook into pipeline events to auto-learn memories.
 * Call this with each pipeline event.
 */
export function autoLearnHook(event: PipelineEvent, project: string): void {
  switch (event.type) {
    case 'pipeline-complete':
      recordSuccess(
        event.stageName ?? 'pipeline',
        project,
        `Pipeline completed successfully at stage ${event.stage ?? 'final'}`,
      );
      break;

    case 'stage-fail':
      if (event.error && event.stageName) {
        recordApproach(
          event.stageName,
          project,
          `Stage ${event.stageName} failed`,
          event.error,
        );
      }
      break;

    default:
      break;
  }
}
