// Rich boxed pipeline summary output

import pc from 'picocolors';
import type { CostEntry } from '../run/types.js';

export interface StageSummary {
  name: string;
  status: 'completed' | 'failed' | 'skipped';
  duration: number;  // ms
  cost: number;
}

export interface PipelineSummaryData {
  feature: string;
  project: string;
  runId: string;
  duration: number;  // ms
  totalCost: CostEntry;
  stages: StageSummary[];
  prUrls: string[];
  sandboxUrl?: string;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function pad(str: string, width: number): string {
  // Strip ANSI codes for length calculation
  const plainLen = str.replace(/\x1B\[\d+m/g, '').length;
  const needed = width - plainLen;
  return needed > 0 ? str + ' '.repeat(needed) : str;
}

export function printPipelineSummary(data: PipelineSummaryData): void {
  const WIDTH = 50;
  const HR = '─'.repeat(WIDTH);
  const out = process.stderr;

  out.write('\n');
  out.write(pc.dim(`┌${HR}┐`) + '\n');
  out.write(pc.dim('│') + pad(pc.bold('  Anvil Pipeline Complete'), WIDTH) + pc.dim('│') + '\n');
  out.write(pc.dim(`├${HR}┤`) + '\n');

  // Feature & project
  out.write(pc.dim('│') + pad(`  Feature: ${data.feature.slice(0, 36)}`, WIDTH) + pc.dim('│') + '\n');
  out.write(pc.dim('│') + pad(`  Project: ${data.project}`, WIDTH) + pc.dim('│') + '\n');
  out.write(pc.dim('│') + pad(`  Duration: ${formatDuration(data.duration)}`, WIDTH) + pc.dim('│') + '\n');
  out.write(pc.dim('│') + pad(`  Cost: $${data.totalCost.estimatedCost.toFixed(2)}`, WIDTH) + pc.dim('│') + '\n');
  out.write(pc.dim('│') + pad('', WIDTH) + pc.dim('│') + '\n');

  // Stages
  out.write(pc.dim('│') + pad('  Stages:', WIDTH) + pc.dim('│') + '\n');
  for (const stage of data.stages) {
    let icon: string;
    if (stage.status === 'completed') icon = pc.green('✓');
    else if (stage.status === 'failed') icon = pc.red('✗');
    else icon = pc.dim('⏭');

    const name = stage.name.padEnd(16);
    const dur = formatDuration(stage.duration).padEnd(8);
    const cost = stage.cost > 0 ? `$${stage.cost.toFixed(2)}` : '';
    out.write(pc.dim('│') + pad(`    ${icon} ${name} ${dur} ${cost}`, WIDTH) + pc.dim('│') + '\n');
  }

  // PR URLs
  if (data.prUrls.length > 0) {
    out.write(pc.dim('│') + pad('', WIDTH) + pc.dim('│') + '\n');
    out.write(pc.dim('│') + pad('  PRs Created:', WIDTH) + pc.dim('│') + '\n');
    for (const url of data.prUrls) {
      out.write(pc.dim('│') + pad(`    → ${url.slice(0, 42)}`, WIDTH) + pc.dim('│') + '\n');
    }
  }

  // Sandbox URL
  if (data.sandboxUrl) {
    out.write(pc.dim('│') + pad(`  Sandbox: ${data.sandboxUrl.slice(0, 36)}`, WIDTH) + pc.dim('│') + '\n');
  }

  out.write(pc.dim(`└${HR}┘`) + '\n');
  out.write('\n');
}
