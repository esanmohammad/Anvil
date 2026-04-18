// Terminal progress spinners and stage transitions

import pc from 'picocolors';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class StageProgress {
  private stages: string[];
  private current: number = -1;
  private startTimes: Map<number, number> = new Map();
  private completedStages: Map<number, { time: number; cost?: number; status: 'completed' | 'failed' | 'skipped' }> = new Map();
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame: number = 0;
  private pipelineStartTime: number = Date.now();

  constructor(stages: string[]) {
    this.stages = stages;
  }

  start(stageIndex: number): void {
    this.stopSpinner();
    this.current = stageIndex;
    this.startTimes.set(stageIndex, Date.now());

    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER_FRAMES.length;
      const frame = SPINNER_FRAMES[this.spinnerFrame];
      const elapsed = this.formatElapsed(Date.now() - this.startTimes.get(stageIndex)!);
      const stageLabel = this.stages[stageIndex] ?? `stage ${stageIndex}`;
      const progress = `${stageIndex + 1}/${this.stages.length}`;
      process.stderr.write(`\r${pc.cyan(frame)} ${stageLabel}... ${pc.dim(`(${progress}, ${elapsed})`)}`);
    }, 80);
  }

  complete(stageIndex: number, cost?: number): void {
    this.stopSpinner();
    const startTime = this.startTimes.get(stageIndex);
    const elapsed = startTime ? Date.now() - startTime : 0;
    this.completedStages.set(stageIndex, { time: elapsed, cost, status: 'completed' });

    const stageLabel = this.stages[stageIndex] ?? `stage ${stageIndex}`;
    const timeStr = this.formatElapsed(elapsed);
    const costStr = cost !== undefined ? ` ${pc.dim(`$${cost.toFixed(2)}`)}` : '';
    process.stderr.write(`\r${pc.green('✓')} ${stageLabel} ${pc.dim(timeStr)}${costStr}\n`);
  }

  fail(stageIndex: number, error: string): void {
    this.stopSpinner();
    const startTime = this.startTimes.get(stageIndex);
    const elapsed = startTime ? Date.now() - startTime : 0;
    this.completedStages.set(stageIndex, { time: elapsed, status: 'failed' });

    const stageLabel = this.stages[stageIndex] ?? `stage ${stageIndex}`;
    const timeStr = this.formatElapsed(elapsed);
    process.stderr.write(`\r${pc.red('✗')} ${stageLabel} ${pc.dim(timeStr)} ${pc.red(error)}\n`);
  }

  skip(stageIndex: number): void {
    this.completedStages.set(stageIndex, { time: 0, status: 'skipped' });
    const stageLabel = this.stages[stageIndex] ?? `stage ${stageIndex}`;
    process.stderr.write(`${pc.dim('⏭')} ${pc.dim(stageLabel)} ${pc.dim('skipped')}\n`);
  }

  summary(totalCost: number, totalTime: number): void {
    this.stopSpinner();
    const timeStr = this.formatElapsed(totalTime);
    const costStr = `$${totalCost.toFixed(2)}`;

    process.stderr.write('\n');
    process.stderr.write(`${pc.bold('Pipeline Complete')} ${pc.dim(`${timeStr}, ${costStr}`)}\n`);
    process.stderr.write('\n');

    for (let i = 0; i < this.stages.length; i++) {
      const info = this.completedStages.get(i);
      if (!info) continue;

      const stageLabel = this.stages[i].padEnd(20);
      if (info.status === 'skipped') {
        process.stderr.write(`  ${pc.dim('⏭')} ${pc.dim(stageLabel)}\n`);
      } else if (info.status === 'failed') {
        process.stderr.write(`  ${pc.red('✗')} ${pc.red(stageLabel)} ${pc.dim(this.formatElapsed(info.time))}\n`);
      } else {
        const costPart = info.cost !== undefined ? `  $${info.cost.toFixed(2)}` : '';
        process.stderr.write(`  ${pc.green('✓')} ${stageLabel} ${pc.dim(this.formatElapsed(info.time).padEnd(8))}${pc.dim(costPart)}\n`);
      }
    }
    process.stderr.write('\n');
  }

  private stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }
  }

  private formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }
}
