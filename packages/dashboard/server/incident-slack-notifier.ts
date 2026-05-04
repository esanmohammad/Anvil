/**
 * incident-slack-notifier — fire-and-forget Slack incoming-webhook poster
 * for Anvil's bug-to-test replay feature.
 *
 * Two notification types are supported:
 *
 *  1. `notifyLowConfidenceReplay` — sent after a replay attempt lands in
 *     `low-confidence` or `unreproducible` state (or otherwise warrants a
 *     human eyeball on the confidence signal). Emits a yellow/red attachment
 *     with the incident title, severity pill, the replay's pre/post-fix
 *     statuses, and a "Review in Anvil" link.
 *
 *  2. `notifyBindOverride` — sent when a human uses `anvil incidents
 *     override-bind` to modify an incident-bound test. Emits a red attachment
 *     naming the user, their reason, and the affected test file.
 *
 * Both entry points are fully no-op if no webhook URL is configured, and
 * never throw — delivery failures are returned on the result object so the
 * caller can decide whether to surface them. Slack incoming-webhooks are
 * fire-and-forget by design; we do NOT retry, but we do enforce an 8-second
 * timeout so the caller can't hang forever.
 *
 * No new npm dependencies are required — this module uses `node:https` only.
 */

import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import type { IncidentRecord, ReplayAttempt } from './incident-types.js';

// ── Public API ───────────────────────────────────────────────────────────

export interface SlackNotifyOptions {
  /** Incoming-webhook URL. If absent, we fall back to `ANVIL_SLACK_WEBHOOK_URL`. */
  webhookUrl?: string;
  /** Display-only channel hint (Slack decides routing from the webhook itself). */
  channel?: string;
  /** Optional base URL for the Anvil dashboard; used to build review links. */
  anvilBaseUrl?: string;
}

export interface SlackNotifyResult {
  sent: boolean;
  error?: string;
}

/** 8s timeout — incoming-webhooks are fast; if they're not, the network is wedged. */
const SLACK_TIMEOUT_MS = 8_000;

// Slack attachment color conventions.
const COLOR_RED = '#d73a49';
const COLOR_YELLOW = '#f6a623';
const COLOR_BLUE = '#1e88e5';

// ── notifyLowConfidenceReplay ────────────────────────────────────────────

export async function notifyLowConfidenceReplay(
  incident: IncidentRecord,
  attempt: ReplayAttempt,
  opts?: SlackNotifyOptions,
): Promise<SlackNotifyResult> {
  const webhookUrl = resolveWebhookUrl(opts);
  if (!webhookUrl) return { sent: false };

  const color = pickColorForAttempt(attempt);
  const severityPill = severityPillText(incident.severity);
  const confidenceText = confidenceLabel(attempt.confidence);
  const preFixText = stepResultText(attempt.preFixResult);
  const postFixText = stepResultText(attempt.postFixResult);

  const incidentLink = linkFor(incident.url, `${incident.source}:${incident.externalId}`);
  const reviewInAnvil = reviewLink(opts, incident.id, attempt.id);

  const fallbackLines = [
    `Anvil replay needs a look — ${incident.title}`,
    `Incident ${incident.id} (${incident.severity.toUpperCase()})`,
    `Replay ${attempt.id} · status=${attempt.status} · confidence=${attempt.confidence}`,
    `Pre-fix: ${preFixText}`,
    `Post-fix: ${postFixText}`,
  ];

  const payload = {
    text: `Anvil replay needs a look — ${truncate(incident.title, 180)}`,
    attachments: [
      {
        color,
        fallback: fallbackLines.join(' · '),
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: truncate(`Replay needs review — ${incident.title}`, 150),
              emoji: true,
            },
          },
          {
            type: 'section',
            fields: [
              kvField('Incident', `${incidentLink} · ${severityPill}`),
              kvField('Status', `\`${attempt.status}\``),
              kvField('Confidence', confidenceText),
              kvField('Source', `\`${incident.source}\``),
              kvField('Pre-fix', preFixText),
              kvField('Post-fix', postFixText),
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Project \`${attempt.project}\` · Spec \`${attempt.specSlug}\` v${attempt.specVersion} · Replay \`${attempt.id}\``,
              },
            ],
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Review in Anvil', emoji: true },
                url: reviewInAnvil,
                style: attempt.confidence === 'low' ? 'danger' : 'primary',
              },
            ],
          },
        ],
      },
    ],
  };

  return postToSlack(webhookUrl, payload);
}

// ── notifyBindOverride ───────────────────────────────────────────────────

export async function notifyBindOverride(
  boundTest: { filePath: string; incidentId: string; replayId: string },
  user: string,
  reason: string,
  opts?: SlackNotifyOptions,
): Promise<SlackNotifyResult> {
  const webhookUrl = resolveWebhookUrl(opts);
  if (!webhookUrl) return { sent: false };

  const incidentLink = anvilIncidentLink(opts, boundTest.incidentId);

  const fallback = [
    `Anvil bind override by ${user}`,
    `Incident ${boundTest.incidentId}`,
    `File ${boundTest.filePath}`,
    `Reason: ${reason}`,
  ].join(' · ');

  const payload = {
    text: `Anvil bind override by ${user} on ${boundTest.filePath}`,
    attachments: [
      {
        color: COLOR_RED,
        fallback,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: 'Bound test override',
              emoji: true,
            },
          },
          {
            type: 'section',
            fields: [
              kvField('User', `\`${user}\``),
              kvField('Incident', incidentLink),
              kvField('Replay', `\`${boundTest.replayId}\``),
              kvField('Test file', `\`${boundTest.filePath}\``),
            ],
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Reason:* ${truncate(reason, 2000)}`,
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: 'Overrides are recorded in the append-only Anvil audit log.',
              },
            ],
          },
        ],
      },
    ],
  };

  return postToSlack(webhookUrl, payload);
}

// ── Payload helpers ──────────────────────────────────────────────────────

interface KVField {
  type: 'mrkdwn';
  text: string;
}

function kvField(label: string, value: string): KVField {
  return { type: 'mrkdwn', text: `*${label}*\n${value}` };
}

function severityPillText(sev: IncidentRecord['severity']): string {
  const upper = sev.toUpperCase();
  switch (sev) {
    case 'p1':
      return `:red_circle: *${upper}*`;
    case 'p2':
      return `:large_orange_circle: *${upper}*`;
    case 'p3':
      return `:large_yellow_circle: *${upper}*`;
    case 'p4':
      return `:large_blue_circle: *${upper}*`;
    default:
      return `:grey_question: *${upper}*`;
  }
}

function confidenceLabel(c: ReplayAttempt['confidence']): string {
  switch (c) {
    case 'high':
      return ':white_check_mark: *high*';
    case 'med':
      return ':warning: *med*';
    case 'low':
    default:
      return ':octagonal_sign: *low*';
  }
}

function stepResultText(step: ReplayAttempt['preFixResult']): string {
  if (!step) return '_(not run)_';
  const icon = step.pass ? ':white_check_mark:' : ':x:';
  const commit = step.commit ? ` \`${step.commit.slice(0, 7)}\`` : '';
  const failure = step.failure ? ` — ${truncate(step.failure, 160)}` : '';
  return `${icon}${commit} (${step.durationMs}ms)${failure}`;
}

function pickColorForAttempt(attempt: ReplayAttempt): string {
  if (attempt.confidence === 'low' || attempt.status === 'unreproducible') return COLOR_RED;
  if (attempt.confidence === 'med' || attempt.status === 'low-confidence') return COLOR_YELLOW;
  return COLOR_BLUE;
}

function linkFor(url: string | undefined, label: string): string {
  if (!url) return `\`${label}\``;
  const safe = escapeSlackAngleBrackets(url);
  return `<${safe}|${label}>`;
}

function reviewLink(
  opts: SlackNotifyOptions | undefined,
  incidentId: string,
  replayId: string,
): string {
  const base = resolveAnvilBaseUrl(opts);
  return `${base}/incidents/${encodeURIComponent(incidentId)}?replay=${encodeURIComponent(replayId)}`;
}

function anvilIncidentLink(opts: SlackNotifyOptions | undefined, incidentId: string): string {
  const base = resolveAnvilBaseUrl(opts);
  const url = `${base}/incidents/${encodeURIComponent(incidentId)}`;
  return `<${escapeSlackAngleBrackets(url)}|${incidentId}>`;
}

function resolveAnvilBaseUrl(opts: SlackNotifyOptions | undefined): string {
  if (opts?.anvilBaseUrl && opts.anvilBaseUrl.trim().length > 0) {
    return opts.anvilBaseUrl.replace(/\/+$/, '');
  }
  const envBase = process.env.ANVIL_DASHBOARD_URL;
  if (envBase && envBase.trim().length > 0) return envBase.replace(/\/+$/, '');
  return 'https://anvil.local';
}

function escapeSlackAngleBrackets(s: string): string {
  return s.replace(/</g, '%3C').replace(/>/g, '%3E');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

// ── Transport ────────────────────────────────────────────────────────────

function resolveWebhookUrl(opts?: SlackNotifyOptions): string | undefined {
  const url = opts?.webhookUrl ?? process.env.ANVIL_SLACK_WEBHOOK_URL;
  if (typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

async function postToSlack(webhookUrl: string, payload: unknown): Promise<SlackNotifyResult> {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch (err) {
    return { sent: false, error: `Invalid webhook URL: ${errorMessage(err)}` };
  }
  if (parsed.protocol !== 'https:') {
    return { sent: false, error: `Refusing non-https webhook (${parsed.protocol})` };
  }

  const body = JSON.stringify(payload);

  return new Promise<SlackNotifyResult>((resolve) => {
    let settled = false;
    const settle = (r: SlackNotifyResult): void => {
      if (settled) return;
      settled = true;
      resolve(r);
    };

    const req = httpsRequest(
      {
        method: 'POST',
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: parsed.pathname + parsed.search,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'anvil-slack-notifier/1.0',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) {
            settle({ sent: true });
            return;
          }
          const text = Buffer.concat(chunks).toString('utf-8');
          settle({
            sent: false,
            error: `Slack responded ${status}: ${truncate(text.replace(/\s+/g, ' '), 200)}`,
          });
        });
        res.on('error', (err) => {
          settle({ sent: false, error: `Response error: ${errorMessage(err)}` });
        });
      },
    );

    req.setTimeout(SLACK_TIMEOUT_MS, () => {
      req.destroy(new Error(`timed out after ${SLACK_TIMEOUT_MS}ms`));
    });
    req.on('error', (err) => {
      settle({ sent: false, error: `Request error: ${errorMessage(err)}` });
    });

    req.write(body);
    req.end();
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
