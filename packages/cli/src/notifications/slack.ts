// Slack webhook notifications for pipeline events

export type PipelineNotificationEvent = 'pipeline-start' | 'pipeline-complete' | 'pipeline-fail';

export interface SlackNotificationData {
  project: string;
  feature: string;
  cost?: number;
  prUrls?: string[];
  error?: string;
  duration?: string;
  runId?: string;
}

function buildSlackPayload(
  event: PipelineNotificationEvent,
  data: SlackNotificationData,
): Record<string, unknown> {
  const emoji = event === 'pipeline-complete' ? ':white_check_mark:'
    : event === 'pipeline-fail' ? ':x:'
    : ':hammer_and_wrench:';

  const title = event === 'pipeline-complete' ? 'Pipeline Complete'
    : event === 'pipeline-fail' ? 'Pipeline Failed'
    : 'Pipeline Started';

  const color = event === 'pipeline-complete' ? '#22c55e'
    : event === 'pipeline-fail' ? '#ef4444'
    : '#3b82f6';

  const fields: Array<{ type: string; text: string }> = [
    { type: 'mrkdwn', text: `*Project:* ${data.project}` },
    { type: 'mrkdwn', text: `*Feature:* ${data.feature}` },
  ];

  if (data.cost !== undefined) {
    fields.push({ type: 'mrkdwn', text: `*Cost:* $${data.cost.toFixed(2)}` });
  }
  if (data.duration) {
    fields.push({ type: 'mrkdwn', text: `*Duration:* ${data.duration}` });
  }
  if (data.error) {
    fields.push({ type: 'mrkdwn', text: `*Error:* ${data.error.slice(0, 200)}` });
  }

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${emoji} *${title}*` },
    },
    {
      type: 'section',
      fields,
    },
  ];

  if (data.prUrls && data.prUrls.length > 0) {
    const prLinks = data.prUrls.map((url) => `<${url}|PR>`).join(' | ');
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Pull Requests:* ${prLinks}` },
    });
  }

  blocks.push({
    type: 'context',
    elements: [
      { type: 'mrkdwn', text: `_Sent by Anvil${data.runId ? ` (run: ${data.runId.slice(0, 8)})` : ''}_` },
    ],
  });

  return {
    attachments: [{ color, blocks }],
  };
}

export async function sendSlackNotification(
  webhookUrl: string,
  event: PipelineNotificationEvent,
  data: SlackNotificationData,
): Promise<void> {
  const payload = buildSlackPayload(event, data);

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      console.error(`Slack notification failed: ${response.status} ${text.slice(0, 100)}`);
    }
  } catch (err) {
    console.error(`Slack notification error: ${err instanceof Error ? err.message : err}`);
  }
}
