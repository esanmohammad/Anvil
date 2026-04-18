// anvil share — export a pipeline run as a shareable HTML report

import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getAnvilDirs } from '../home.js';
import { success, error, info } from '../logger.js';
import pc from 'picocolors';

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

interface RunData {
  id: string;
  project: string;
  feature: string;
  status: string;
  stages: Array<{
    name: string;
    status: string;
    cost?: { estimatedCost: number };
    startedAt?: string;
    completedAt?: string;
  }>;
  totalCost?: { estimatedCost: number; inputTokens: number; outputTokens: number };
  prUrls?: string[];
  createdAt: string;
}

function findRunRecord(runId: string): RunData | null {
  const dirs = getAnvilDirs();
  const runsDir = dirs.runs;

  if (!existsSync(runsDir)) return null;

  // Search in runs index
  const indexPath = join(runsDir, 'index.jsonl');
  if (existsSync(indexPath)) {
    try {
      const lines = readFileSync(indexPath, 'utf-8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (record.id === runId) return record;
        } catch { /* skip */ }
      }
    } catch { /* ignore */ }
  }

  // Search in project subdirectories
  try {
    for (const projectDir of readdirSync(runsDir)) {
      const projectPath = join(runsDir, projectDir);
      const runPath = join(projectPath, runId);
      const recordPath = join(runPath, 'record.json');
      if (existsSync(recordPath)) {
        return JSON.parse(readFileSync(recordPath, 'utf-8'));
      }
    }
  } catch { /* ignore */ }

  return null;
}

function loadArtifacts(runId: string, project: string): Record<string, string> {
  const dirs = getAnvilDirs();
  const artifacts: Record<string, string> = {};

  const runDir = join(dirs.runs, project, runId);
  if (!existsSync(runDir)) return artifacts;

  try {
    for (const file of readdirSync(runDir)) {
      if (file.endsWith('.md') || file.endsWith('.txt')) {
        try {
          artifacts[file] = readFileSync(join(runDir, file), 'utf-8');
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  return artifacts;
}

function generateHtml(run: RunData, artifacts: Record<string, string>): string {
  const totalCost = run.totalCost?.estimatedCost?.toFixed(2) ?? '0.00';
  const status = run.status === 'completed' ? '&#x2713; Completed' : '&#x2717; ' + run.status;
  const statusColor = run.status === 'completed' ? '#22c55e' : '#ef4444';

  const stagesHtml = (run.stages ?? []).map((stage) => {
    const icon = stage.status === 'completed' ? '&#x2713;' : stage.status === 'failed' ? '&#x2717;' : '&#x23ED;';
    const color = stage.status === 'completed' ? '#22c55e' : stage.status === 'failed' ? '#ef4444' : '#9ca3af';
    const cost = stage.cost?.estimatedCost?.toFixed(2) ?? '-';
    return `<tr><td style="color:${color}">${icon}</td><td>${escapeHtml(stage.name)}</td><td>$${cost}</td></tr>`;
  }).join('\n');

  const artifactsHtml = Object.entries(artifacts).map(([name, content]) => {
    return `<details class="artifact">
      <summary>${escapeHtml(name)}</summary>
      <pre>${escapeHtml(content.slice(0, 10000))}</pre>
    </details>`;
  }).join('\n');

  const prHtml = (run.prUrls ?? []).map((url) =>
    `<li><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></li>`
  ).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Anvil Report — ${escapeHtml(run.feature)}</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-project, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; max-width: 800px; margin: 0 auto; padding: 2rem; }
  .header { border-bottom: 2px solid #334155; padding-bottom: 1.5rem; margin-bottom: 1.5rem; }
  .header h1 { font-size: 1.5rem; color: #f8fafc; }
  .header .brand { color: #60a5fa; font-size: 0.875rem; margin-bottom: 0.5rem; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; margin: 1rem 0; }
  .meta dt { color: #94a3b8; font-size: 0.875rem; }
  .meta dd { font-size: 1rem; margin-bottom: 0.5rem; }
  .status { color: ${statusColor}; font-weight: bold; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th { text-align: left; color: #94a3b8; padding: 0.5rem; border-bottom: 1px solid #334155; font-size: 0.875rem; }
  td { padding: 0.5rem; border-bottom: 1px solid #1e293b; }
  .artifact { margin: 0.5rem 0; }
  .artifact summary { cursor: pointer; padding: 0.5rem; background: #1e293b; border-radius: 4px; }
  .artifact summary:hover { background: #334155; }
  .artifact pre { padding: 1rem; background: #1e293b; border-radius: 0 0 4px 4px; overflow-x: auto; font-size: 0.8rem; line-height: 1.4; max-height: 400px; overflow-y: auto; }
  .prs a { color: #60a5fa; }
  .footer { margin-top: 2rem; padding-top: 1rem; border-top: 1px solid #334155; color: #64748b; font-size: 0.75rem; }
  h2 { margin: 1.5rem 0 0.75rem; font-size: 1.1rem; color: #f8fafc; }
</style>
</head>
<body>
  <div class="header">
    <div class="brand">Anvil Pipeline Report</div>
    <h1>${escapeHtml(run.feature)}</h1>
  </div>

  <dl class="meta">
    <dt>Project</dt><dd>${escapeHtml(run.project)}</dd>
    <dt>Status</dt><dd class="status">${status}</dd>
    <dt>Total Cost</dt><dd>$${totalCost}</dd>
    <dt>Run ID</dt><dd>${escapeHtml(run.id)}</dd>
    <dt>Created</dt><dd>${escapeHtml(run.createdAt ?? '')}</dd>
  </dl>

  <h2>Pipeline Stages</h2>
  <table>
    <thead><tr><th></th><th>Stage</th><th>Cost</th></tr></thead>
    <tbody>${stagesHtml}</tbody>
  </table>

  ${prHtml ? `<h2>Pull Requests</h2><ul class="prs">${prHtml}</ul>` : ''}

  ${artifactsHtml ? `<h2>Artifacts</h2>${artifactsHtml}` : ''}

  <div class="footer">
    Generated by Anvil &mdash; From sentence to shipped feature.
  </div>
</body>
</html>`;
}

export const shareCommand = new Command('share')
  .description('Export a pipeline run as a shareable HTML report')
  .argument('<runId>', 'The run ID to export')
  .option('-o, --output <path>', 'Output path', './anvil-report.html')
  .action(async (runId: string, opts: { output: string }) => {
    const run = findRunRecord(runId);
    if (!run) {
      error(`Run "${runId}" not found.`);
      process.exitCode = 1;
      return;
    }

    const artifacts = loadArtifacts(runId, run.project);
    const html = generateHtml(run, artifacts);

    writeFileSync(opts.output, html, 'utf-8');
    success(`Report saved to ${opts.output}`);
    info(`Open in browser: file://${join(process.cwd(), opts.output)}`);
  });
