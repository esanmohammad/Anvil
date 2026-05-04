/**
 * pipeline-notifier — Slack (+ optional SMTP) notifications for pipeline
 * pauses, resumes, and cost breaches. Fire-and-forget: public functions
 * never throw, never await retries.
 *
 * NOTE: the SMTP path is a deliberate stub for environments that set
 * `ANVIL_SMTP_URL`. It speaks a very small subset of RFC 5321 over plain TCP
 * (no TLS, no auth). Teams wiring real email should swap this for
 * `nodemailer`.
 */

import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import { createConnection } from 'node:net';
import type { Socket } from 'node:net';

// ── Types ────────────────────────────────────────────────────────────────
//
// The PauseState shape is carried here directly so this module can compile
// even if `pipeline-pause-types.ts` is still landing in a parallel PR.

type PauseStage = 'plan' | 'implement' | 'review' | 'test' | 'ship';
type PauseStatus = 'paused-awaiting-user' | 'resumed' | 'cancelled' | 'timed-out';

export interface PauseState {
  runId: string;
  project: string;
  stage: PauseStage;
  reason: string;
  matchedRules: string[];
  reviewers: string[];
  pausedAt: string;
  timeoutAt?: string;
  status: PauseStatus;
}

export interface CostBreachInput {
  runId: string;
  project: string;
  currentUsd: number;
  limitUsd: number;
  projectedUsd: number;
  graceEndsAt: string;
  topSpenders: Array<{ stage: string; usd: number }>;
  approvalBaseUrl?: string;
}

// ── Constants ────────────────────────────────────────────────────────────

const SLACK_TIMEOUT_MS = 8_000;
const SMTP_TIMEOUT_MS = 10_000;

const COLOR_RED = '#d73a49';
const COLOR_YELLOW = '#f6a623';
const COLOR_GREEN = '#2cbe4e';

// ── Public API — Slack ───────────────────────────────────────────────────

/**
 * Notify Slack that a pipeline has paused awaiting review.
 *
 * If `approvalBaseUrl` is provided, the Approve button hits
 *   `${approvalBaseUrl}/api/pipeline/approve?token=...`
 * otherwise it links to the dashboard pause detail page.
 */
export async function notifyPipelinePaused(
  pause: PauseState,
  approvalBaseUrl?: string,
  approvalToken?: string,
): Promise<void> {
  const webhookUrl = resolveSlackWebhookUrl();
  if (!webhookUrl) return;

  const dashboardUrl = buildDashboardPauseUrl(pause.runId);
  const approveUrl =
    approvalBaseUrl && approvalToken
      ? buildApprovalUrl(approvalBaseUrl, approvalToken)
      : dashboardUrl;

  const timeoutCountdown = formatTimeoutCountdown(pause.timeoutAt);
  const riskTier = inferRiskTier(pause);
  const title = `Pipeline paused — ${pause.project} / ${pause.stage}`;

  const fallback = [
    `Pipeline paused: ${pause.project}/${pause.stage}`,
    `Reason: ${pause.reason}`,
    `Risk: ${riskTier}`,
    timeoutCountdown ? `Times out in ${timeoutCountdown}` : 'No timeout',
  ].join(' · ');

  const payload = {
    text: `:pause_button: ${title}`,
    attachments: [
      {
        color: COLOR_YELLOW,
        fallback,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: truncate(`:pause_button: ${title}`, 150),
              emoji: true,
            },
          },
          {
            type: 'section',
            fields: [
              kvField('Run', `\`${pause.runId}\``),
              kvField('Stage', `\`${pause.stage}\``),
              kvField('Risk tier', `*${riskTier}*`),
              kvField('Reviewers', pause.reviewers.length ? pause.reviewers.map((r) => `\`${r}\``).join(', ') : '_(none)_'),
              kvField('Reason', truncate(pause.reason, 300)),
              kvField(
                'Times out',
                timeoutCountdown ? `in *${timeoutCountdown}*` : '_no timeout_',
              ),
            ],
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Matched rules: ${pause.matchedRules.length ? pause.matchedRules.map((r) => `\`${r}\``).join(' ') : '_(none)_'}`,
              },
            ],
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Approve', emoji: true },
                url: approveUrl,
                style: 'primary',
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Review in dashboard', emoji: true },
                url: dashboardUrl,
              },
            ],
          },
        ],
      },
    ],
  };

  await postToSlack(webhookUrl, payload);
}

/** Short "resumed" notification — no buttons. */
export async function notifyPipelineResumed(pause: PauseState): Promise<void> {
  const webhookUrl = resolveSlackWebhookUrl();
  if (!webhookUrl) return;

  const verb =
    pause.status === 'resumed'
      ? 'resumed'
      : pause.status === 'cancelled'
        ? 'cancelled'
        : pause.status === 'timed-out'
          ? 'timed out'
          : 'updated';

  const payload = {
    text: `:arrow_forward: Pipeline ${verb} — ${pause.project}/${pause.stage} (\`${pause.runId}\`)`,
    attachments: [
      {
        color: pause.status === 'resumed' ? COLOR_GREEN : COLOR_YELLOW,
        fallback: `Pipeline ${verb}: ${pause.project}/${pause.stage} ${pause.runId}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Pipeline ${verb}* — \`${pause.project}\` / \`${pause.stage}\` · run \`${pause.runId}\``,
            },
          },
        ],
      },
    ],
  };

  await postToSlack(webhookUrl, payload);
}

/**
 * Notify Slack that a run has breached its cost limit. Offers Raise / Reject
 * buttons — when `approvalBaseUrl` is set, they hit the approval endpoint
 * with action-scoped tokens supplied by the caller.
 */
export async function notifyCostBreach(input: CostBreachInput & {
  raiseToken?: string;
  rejectToken?: string;
}): Promise<void> {
  const webhookUrl = resolveSlackWebhookUrl();
  if (!webhookUrl) return;

  const dashboardUrl = buildDashboardRunUrl(input.runId);
  const raiseUrl =
    input.approvalBaseUrl && input.raiseToken
      ? buildApprovalUrl(input.approvalBaseUrl, input.raiseToken)
      : dashboardUrl;
  const rejectUrl =
    input.approvalBaseUrl && input.rejectToken
      ? buildApprovalUrl(input.approvalBaseUrl, input.rejectToken)
      : dashboardUrl;

  const overBy = Math.max(0, input.currentUsd - input.limitUsd);
  const spenders = input.topSpenders
    .slice(0, 5)
    .map((s) => `\`${s.stage}\` $${s.usd.toFixed(2)}`)
    .join(' · ') || '_(none reported)_';

  const graceCountdown = formatTimeoutCountdown(input.graceEndsAt) ?? 'expired';

  const payload = {
    text: `:moneybag: Cost limit breached — ${input.project}`,
    attachments: [
      {
        color: COLOR_RED,
        fallback: `Cost breach ${input.project}: $${input.currentUsd.toFixed(2)} / $${input.limitUsd.toFixed(2)}`,
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: truncate(`:moneybag: Cost limit breached — ${input.project}`, 150),
              emoji: true,
            },
          },
          {
            type: 'section',
            fields: [
              kvField('Run', `\`${input.runId}\``),
              kvField('Current', `*$${input.currentUsd.toFixed(2)}*`),
              kvField('Limit', `$${input.limitUsd.toFixed(2)}`),
              kvField('Over by', `*$${overBy.toFixed(2)}*`),
              kvField('Projected', `$${input.projectedUsd.toFixed(2)}`),
              kvField('Grace ends', `in *${graceCountdown}*`),
            ],
          },
          {
            type: 'context',
            elements: [
              { type: 'mrkdwn', text: `Top spenders: ${spenders}` },
            ],
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Raise limit', emoji: true },
                url: raiseUrl,
                style: 'primary',
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Reject (halt run)', emoji: true },
                url: rejectUrl,
                style: 'danger',
              },
            ],
          },
        ],
      },
    ],
  };

  await postToSlack(webhookUrl, payload);
}

// ── Public API — Email (stub) ────────────────────────────────────────────

/**
 * Minimal SMTP send. No-op unless `ANVIL_SMTP_URL` is set.
 * Swallows all errors — callers never see a thrown exception.
 *
 * URL format:  smtp://host:port   (no TLS, no auth — stub only)
 */
export async function sendEmailIfConfigured(
  to: string[],
  subject: string,
  body: string,
): Promise<void> {
  const url = (process.env.ANVIL_SMTP_URL ?? '').trim();
  if (!url) return;
  if (!Array.isArray(to) || to.length === 0) return;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    logSwallowed('email', `invalid ANVIL_SMTP_URL: ${errorMessage(err)}`);
    return;
  }
  const host = parsed.hostname;
  const port = Number(parsed.port || '25');
  const from = (process.env.ANVIL_SMTP_FROM ?? 'anvil@localhost').trim();

  try {
    await smtpSendPlain({ host, port, from, to, subject, body });
  } catch (err) {
    logSwallowed('email', errorMessage(err));
  }
}

// ── Internal: SMTP stub ──────────────────────────────────────────────────

interface SmtpSendArgs {
  host: string;
  port: number;
  from: string;
  to: string[];
  subject: string;
  body: string;
}

/**
 * Tiny SMTP client: CONNECT → EHLO → MAIL FROM → RCPT TO → DATA → QUIT.
 * Hand-rolled so we stay dep-free; good enough for local/dev relays. Not
 * for production — see nodemailer.
 */
function smtpSendPlain(args: SmtpSendArgs): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const socket: Socket = createConnection({ host: args.host, port: args.port });
    socket.setEncoding('utf-8');
    socket.setTimeout(SMTP_TIMEOUT_MS);

    const rcpts = [...args.to];
    type Step =
      | 'greet'
      | 'ehlo'
      | 'mailFrom'
      | 'rcptTo'
      | 'data'
      | 'dataBody'
      | 'quit';
    let step: Step = 'greet';

    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      if (err) reject(err);
      else resolve();
    };

    const write = (line: string): void => {
      socket.write(`${line}\r\n`);
    };

    const expect = (line: string, codePrefix: string): boolean => {
      // SMTP reply lines begin with a 3-digit status code.
      return line.startsWith(codePrefix);
    };

    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      // Process complete lines terminated by CRLF.
      let idx: number;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleLine(line);
      }
    });

    const handleLine = (line: string): void => {
      // Multi-line replies: "250-XXX" continues, "250 XXX" terminates.
      if (/^\d{3}-/.test(line)) return;

      switch (step) {
        case 'greet':
          if (!expect(line, '2')) return finish(new Error(`greet failed: ${line}`));
          step = 'ehlo';
          write(`EHLO anvil`);
          return;
        case 'ehlo':
          if (!expect(line, '2')) return finish(new Error(`EHLO failed: ${line}`));
          step = 'mailFrom';
          write(`MAIL FROM:<${args.from}>`);
          return;
        case 'mailFrom':
          if (!expect(line, '2')) return finish(new Error(`MAIL FROM failed: ${line}`));
          step = 'rcptTo';
          write(`RCPT TO:<${rcpts[0]}>`);
          return;
        case 'rcptTo': {
          if (!expect(line, '2')) return finish(new Error(`RCPT TO failed: ${line}`));
          rcpts.shift();
          if (rcpts.length > 0) {
            write(`RCPT TO:<${rcpts[0]}>`);
            return;
          }
          step = 'data';
          write('DATA');
          return;
        }
        case 'data': {
          if (!expect(line, '3')) return finish(new Error(`DATA failed: ${line}`));
          step = 'dataBody';
          const msg =
            `From: ${args.from}\r\n` +
            `To: ${args.to.join(', ')}\r\n` +
            `Subject: ${sanitizeHeader(args.subject)}\r\n` +
            `MIME-Version: 1.0\r\n` +
            `Content-Type: text/plain; charset=utf-8\r\n` +
            `\r\n` +
            dotStuff(args.body) +
            `\r\n.`;
          write(msg);
          return;
        }
        case 'dataBody':
          if (!expect(line, '2')) return finish(new Error(`DATA body failed: ${line}`));
          step = 'quit';
          write('QUIT');
          return;
        case 'quit':
          finish();
          return;
      }
    };

    socket.on('timeout', () => finish(new Error(`SMTP timed out after ${SMTP_TIMEOUT_MS}ms`)));
    socket.on('error', (err) => finish(err));
    socket.on('close', () => {
      if (!settled) finish(new Error('SMTP connection closed unexpectedly'));
    });
  });
}

function dotStuff(body: string): string {
  // RFC 5321 §4.5.2 — any line starting with "." must be doubled.
  return body.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
}

function sanitizeHeader(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').trim();
}

// ── Internal: Slack helpers ──────────────────────────────────────────────

interface KVField {
  type: 'mrkdwn';
  text: string;
}

function kvField(label: string, value: string): KVField {
  return { type: 'mrkdwn', text: `*${label}*\n${value}` };
}

function resolveSlackWebhookUrl(): string | undefined {
  const url = process.env.ANVIL_SLACK_WEBHOOK_URL;
  if (typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed;
}

function resolveDashboardBaseUrl(): string {
  const envBase = process.env.ANVIL_DASHBOARD_URL;
  if (envBase && envBase.trim().length > 0) return envBase.replace(/\/+$/, '');
  return 'https://anvil.local';
}

function buildDashboardPauseUrl(runId: string): string {
  return `${resolveDashboardBaseUrl()}/pipeline/pauses/${encodeURIComponent(runId)}`;
}

function buildDashboardRunUrl(runId: string): string {
  return `${resolveDashboardBaseUrl()}/pipeline/runs/${encodeURIComponent(runId)}`;
}

function buildApprovalUrl(base: string, token: string): string {
  const trimmed = base.replace(/\/+$/, '');
  return `${trimmed}/api/pipeline/approve?token=${encodeURIComponent(token)}`;
}

function formatTimeoutCountdown(isoTimestamp: string | undefined): string | null {
  if (!isoTimestamp) return null;
  const ts = Date.parse(isoTimestamp);
  if (Number.isNaN(ts)) return null;
  const deltaMs = ts - Date.now();
  if (deltaMs <= 0) return null;
  const mins = Math.round(deltaMs / 60_000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours}h` : `${hours}h ${rem}m`;
}

function inferRiskTier(pause: PauseState): string {
  // Best-effort — matchedRules often carry a tier hint like `risk:high`.
  const hint = pause.matchedRules.find((r) => /^risk:/i.test(r));
  if (hint) return hint.split(':')[1]?.toLowerCase() ?? 'unknown';
  // Fallback mapping by stage.
  if (pause.stage === 'ship') return 'high';
  if (pause.stage === 'review' || pause.stage === 'test') return 'medium';
  return 'low';
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function logSwallowed(channel: string, detail: string): void {
  // Keep quiet in the common "no webhook configured" case; log otherwise.
  // eslint-disable-next-line no-console
  console.warn(`[pipeline-notifier:${channel}] delivery failed: ${detail}`);
}

// ── Internal: Slack transport ────────────────────────────────────────────

async function postToSlack(webhookUrl: string, payload: unknown): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(webhookUrl);
  } catch (err) {
    logSwallowed('slack', `invalid webhook URL: ${errorMessage(err)}`);
    return;
  }
  if (parsed.protocol !== 'https:') {
    logSwallowed('slack', `refusing non-https webhook (${parsed.protocol})`);
    return;
  }

  const body = JSON.stringify(payload);

  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      resolve();
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
          'User-Agent': 'anvil-pipeline-notifier/1.0',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const text = Buffer.concat(chunks).toString('utf-8');
            logSwallowed(
              'slack',
              `status ${status}: ${truncate(text.replace(/\s+/g, ' '), 200)}`,
            );
          }
          done();
        });
        res.on('error', (err) => {
          logSwallowed('slack', `response error: ${errorMessage(err)}`);
          done();
        });
      },
    );

    req.setTimeout(SLACK_TIMEOUT_MS, () => {
      req.destroy(new Error(`timed out after ${SLACK_TIMEOUT_MS}ms`));
    });
    req.on('error', (err) => {
      logSwallowed('slack', `request error: ${errorMessage(err)}`);
      done();
    });

    req.write(body);
    req.end();
  });
}
