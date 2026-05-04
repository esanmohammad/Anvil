/**
 * Pipeline notifications — Phase 5 of core-pipeline consolidation.
 *
 * Lifted from `orchestrator.ts:319-340`. Slack webhook notifications
 * for pipeline-start / pipeline-complete / pipeline-fail. Always
 * non-blocking — pipeline never fails because of a notification.
 */

export type PipelineNotificationEvent =
  | 'pipeline-start'
  | 'pipeline-complete'
  | 'pipeline-fail';

export interface PipelineNotificationData {
  project: string;
  feature: string;
  cost?: number;
  prUrls?: string[];
  error?: string;
  duration?: string;
  runId?: string;
}

export async function sendPipelineNotification(
  _project: string,
  event: PipelineNotificationEvent,
  data: PipelineNotificationData,
): Promise<void> {
  const webhookUrl = process.env.ANVIL_SLACK_WEBHOOK;
  if (!webhookUrl) return; // No webhook — skip silently.

  try {
    const { sendSlackNotification } = await import('../notifications/slack.js');
    await sendSlackNotification(webhookUrl, event, data);
  } catch {
    /* never fail the pipeline because of a notification */
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}
