// Terminal progress display for pipeline

import pc from 'picocolors';
import type { CostEntry } from '../run/types.js';
import { PIPELINE_STAGES } from './types.js';

export class PipelineDisplay {
  private stageStatuses: Map<number, 'pending' | 'running' | 'completed' | 'failed' | 'skipped'>;
  private startTime: number;
  private parallelProgress: Map<string, string> = new Map();

  constructor() {
    this.startTime = Date.now();
    this.stageStatuses = new Map();
    for (const stage of PIPELINE_STAGES) {
      this.stageStatuses.set(stage.index, 'pending');
    }
  }

  onStageStart(stageIndex: number, _stageName: string): void {
    this.stageStatuses.set(stageIndex, 'running');
  }

  onStageComplete(stageIndex: number, _stageName: string): void {
    this.stageStatuses.set(stageIndex, 'completed');
  }

  onStageFail(stageIndex: number, _stageName: string, _error: string): void {
    this.stageStatuses.set(stageIndex, 'failed');
  }

  onStageSkip(stageIndex: number, _stageName: string): void {
    this.stageStatuses.set(stageIndex, 'skipped');
  }

  onParallelProgress(stageIndex: number, project: string, status: string): void {
    this.parallelProgress.set(`${stageIndex}:${project}`, status);
  }

  renderCurrentState(): string {
    const lines: string[] = [];
    const elapsed = this.getElapsedTime();

    lines.push(pc.bold(`Pipeline Progress`) + pc.dim(` (${elapsed})`));
    lines.push('');

    for (const stage of PIPELINE_STAGES) {
      const status = this.stageStatuses.get(stage.index) ?? 'pending';
      const icon = this.getStageIcon(status);
      const name = stage.name;

      let line: string;
      if (status === 'running') {
        line = `  ${icon} ${pc.cyan(name)}`;
      } else if (status === 'completed') {
        line = `  ${icon} ${pc.green(name)}`;
      } else if (status === 'failed') {
        line = `  ${icon} ${pc.red(name)}`;
      } else if (status === 'skipped') {
        line = `  ${icon} ${pc.dim(name)}`;
      } else {
        line = `  ${icon} ${pc.dim(name)}`;
      }

      lines.push(line);
    }

    return lines.join('\n');
  }

  renderSummary(totalCost: CostEntry, prUrls?: string[]): string {
    const lines: string[] = [];
    const elapsed = this.getElapsedTime();

    lines.push('');
    lines.push(pc.bold('Pipeline Summary'));
    lines.push(`  Duration: ${elapsed}`);
    lines.push(
      `  Cost: $${totalCost.estimatedCost.toFixed(4)} (${totalCost.inputTokens} in / ${totalCost.outputTokens} out)`,
    );

    if (prUrls && prUrls.length > 0) {
      lines.push('  Pull Requests:');
      for (const url of prUrls) {
        lines.push(`    - ${url}`);
      }
    }

    return lines.join('\n');
  }

  private getElapsedTime(): string {
    const elapsed = Date.now() - this.startTime;
    const totalSeconds = Math.floor(elapsed / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;

    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  private getStageIcon(status: string): string {
    switch (status) {
      case 'completed':
        return pc.green('\u2713');
      case 'failed':
        return pc.red('\u2717');
      case 'running':
        return pc.cyan('\u231B');
      case 'skipped':
        return pc.dim('\u23ED');
      case 'pending':
      default:
        return pc.dim('\u00B7');
    }
  }
}
