// CLI command: anvil live — real-time terminal dashboard for pipeline progress

import { Command } from 'commander';
import { existsSync, readFileSync, watchFile, unwatchFile, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';

// ---------------------------------------------------------------------------
// State types (mirrors what the orchestrator writes to ~/.anvil/state.json)
// ---------------------------------------------------------------------------

interface StageState {
  name: string;
  status: string;
  cost?: number;
  durationMs?: number;
}

interface DashboardState {
  activePipeline?: {
    runId: string;
    project: string;
    feature: string;
    status: 'running' | 'completed' | 'failed' | 'cancelled';
    currentStage: number;
    stages: StageState[];
    startedAt: string;
    cost: { inputTokens: number; outputTokens: number; estimatedCost: number };
    pendingApproval?: { stage: number } | null;
  };
  lastUpdated: string;
}

// ---------------------------------------------------------------------------
// Spinner frames
// ---------------------------------------------------------------------------

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  const totalSecs = Math.floor(ms / 1000);
  if (totalSecs < 60) return `${totalSecs}s`;
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

function formatCost(cost: number): string {
  return `$${cost.toFixed(2)}`;
}

function pad(str: string, len: number): string {
  // Strip ANSI for length calculation
  const stripped = str.replace(/\x1B\[[0-9;]*m/g, '');
  const diff = len - stripped.length;
  return diff > 0 ? str + ' '.repeat(diff) : str;
}

function readState(stateFile: string): DashboardState | null {
  try {
    if (!existsSync(stateFile)) return null;
    const raw = readFileSync(stateFile, 'utf-8');
    return JSON.parse(raw) as DashboardState;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const BOX_WIDTH = 52;

function hLine(left: string, fill: string, right: string): string {
  return left + fill.repeat(BOX_WIDTH) + right;
}

function boxLine(content: string): string {
  return '│' + pad('  ' + content, BOX_WIDTH) + '│';
}

function emptyLine(): string {
  return '│' + ' '.repeat(BOX_WIDTH) + '│';
}

function render(state: DashboardState | null, spinnerIdx: number): string {
  const lines: string[] = [];

  if (!state?.activePipeline) {
    lines.push('');
    lines.push(hLine('┌', '─', '┐'));
    lines.push(boxLine(pc.bold('Anvil Live Dashboard')));
    lines.push(hLine('├', '─', '┤'));
    lines.push(emptyLine());
    lines.push(boxLine(pc.dim('No active pipeline.')));
    lines.push(boxLine(pc.dim('Waiting for state.json...')));
    lines.push(emptyLine());
    lines.push(boxLine(pc.dim('[q] quit')));
    lines.push(hLine('└', '─', '┘'));
    lines.push('');
    return lines.join('\n');
  }

  const p = state.activePipeline;
  const elapsed = Date.now() - new Date(p.startedAt).getTime();
  const spinner = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length];
  const totalCost = p.cost.estimatedCost;

  // Header
  lines.push('');
  lines.push(hLine('┌', '─', '┐'));
  lines.push(boxLine(pc.bold('Anvil Live Dashboard')));
  lines.push(boxLine(
    `Project: ${pc.cyan(p.project)}  Run: ${pc.dim(p.runId.slice(0, 7))}`,
  ));
  lines.push(boxLine(`Feature: ${pc.white(p.feature.slice(0, 36))}`));
  lines.push(hLine('├', '─', '┤'));
  lines.push(emptyLine());

  // Overall status line
  const statusIcon =
    p.status === 'running' ? pc.yellow(spinner) :
    p.status === 'completed' ? pc.green('✓') :
    p.status === 'failed' ? pc.red('✗') :
    pc.red('⊘');
  const statusLabel =
    p.status === 'running' ? 'Building...' :
    p.status === 'completed' ? 'Completed' :
    p.status === 'failed' ? 'Failed' :
    'Cancelled';
  lines.push(boxLine(
    `${statusIcon} ${pc.bold(statusLabel)}` +
    `              ${formatDuration(elapsed)}  ${formatCost(totalCost)}`,
  ));
  lines.push(emptyLine());

  // Stage list
  for (let i = 0; i < p.stages.length; i++) {
    const stage = p.stages[i];
    let icon: string;
    let nameStr: string;
    let suffix = '';

    if (stage.status === 'completed' || stage.status === 'done') {
      icon = pc.green('✓');
      nameStr = pc.white(stage.name);
      if (stage.durationMs) suffix += `  ${formatDuration(stage.durationMs)}`;
      if (stage.cost != null) suffix += `  ${formatCost(stage.cost)}`;
    } else if (stage.status === 'running' || stage.status === 'in-progress') {
      icon = pc.yellow(spinner);
      nameStr = pc.yellow(stage.name);
      if (stage.durationMs) suffix += `  ${formatDuration(stage.durationMs)}`;
      if (stage.cost != null) suffix += `  ${formatCost(stage.cost)}`;
    } else if (stage.status === 'failed') {
      icon = pc.red('✗');
      nameStr = pc.red(stage.name);
    } else {
      // pending / queued
      icon = pc.dim('·');
      nameStr = pc.dim(stage.name);
    }

    lines.push(boxLine(`${icon} ${pad(nameStr, 24)}${suffix}`));
  }

  lines.push(emptyLine());

  // Footer: totals
  lines.push(boxLine(
    `Cost: ${pc.bold(formatCost(totalCost))} │ Elapsed: ${pc.bold(formatDuration(elapsed))}`,
  ));
  lines.push(emptyLine());

  // Approval gate
  if (p.pendingApproval) {
    lines.push(boxLine(
      pc.yellow(`⚠  Approval needed for stage ${p.stages[p.pendingApproval.stage]?.name ?? p.pendingApproval.stage}`),
    ));
    lines.push(emptyLine());
  }

  // Controls
  const controls: string[] = ['[q] quit'];
  if (p.pendingApproval) controls.unshift('[a] approve');
  if (p.status === 'running') controls.splice(controls.length - 1, 0, '[c] cancel');
  lines.push(boxLine(pc.dim(controls.join('  '))));
  lines.push(hLine('└', '─', '┘'));
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Interaction helpers: write signals to state or user-messages file
// ---------------------------------------------------------------------------

function writeUserSignal(stateDir: string, signal: 'approve' | 'cancel'): void {
  const msgFile = join(stateDir, 'user-messages.jsonl');
  const entry = JSON.stringify({ signal, timestamp: new Date().toISOString() });
  try {
    const { appendFileSync: afs } = require('node:fs') as typeof import('node:fs');
    afs(msgFile, entry + '\n');
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Command definition
// ---------------------------------------------------------------------------

export const tuiCommand = new Command('live')
  .description('Live dashboard — watch pipeline progress in the terminal')
  .argument('[project]', 'Project name')
  .option('--refresh <ms>', 'Refresh interval in ms', '1000')
  .action(async (_project: string | undefined, opts: { refresh: string }) => {
    const anvilDir = join(homedir(), '.anvil');
    const stateFile = join(anvilDir, 'state.json');
    const refreshMs = Math.max(200, parseInt(opts.refresh, 10) || 1000);

    let spinnerIdx = 0;
    let running = true;

    // --- Keyboard input (raw mode) -----------------------------------------

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;

    if (typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.setEncoding('utf-8');

    const cleanup = (): void => {
      running = false;
      if (typeof stdin.setRawMode === 'function') {
        stdin.setRawMode(wasRaw ?? false);
      }
      stdin.pause();
      unwatchFile(stateFile);
      // Show cursor, clear alternate screen artifacts
      process.stdout.write('\x1B[?25h');
    };

    stdin.on('data', (key: string) => {
      // Ctrl+C
      if (key === '\u0003') {
        cleanup();
        process.exit(0);
      }
      if (key === 'q' || key === 'Q') {
        cleanup();
        process.exit(0);
      }
      if (key === 'a' || key === 'A') {
        const state = readState(stateFile);
        if (state?.activePipeline?.pendingApproval) {
          writeUserSignal(anvilDir, 'approve');
        }
      }
      if (key === 'c' || key === 'C') {
        const state = readState(stateFile);
        if (state?.activePipeline?.status === 'running') {
          writeUserSignal(anvilDir, 'cancel');
        }
      }
    });

    // --- Render loop --------------------------------------------------------

    // Hide cursor for cleaner display
    process.stdout.write('\x1B[?25l');

    const tick = (): void => {
      if (!running) return;
      const state = readState(stateFile);

      // Clear screen + move cursor home
      process.stdout.write('\x1B[2J\x1B[H');
      process.stdout.write(render(state, spinnerIdx));

      spinnerIdx = (spinnerIdx + 1) % SPINNER_FRAMES.length;

      // Auto-exit when pipeline completes
      if (
        state?.activePipeline &&
        (state.activePipeline.status === 'completed' ||
         state.activePipeline.status === 'failed' ||
         state.activePipeline.status === 'cancelled')
      ) {
        // Show final frame for a moment then exit
        setTimeout(() => {
          cleanup();
          const exitStatus = state.activePipeline!.status;
          if (exitStatus === 'completed') {
            process.stdout.write(pc.green('\n  ✓ Pipeline completed.\n\n'));
          } else if (exitStatus === 'failed') {
            process.stdout.write(pc.red('\n  ✗ Pipeline failed.\n\n'));
          } else {
            process.stdout.write(pc.yellow('\n  ⊘ Pipeline cancelled.\n\n'));
          }
          process.exit(exitStatus === 'completed' ? 0 : 1);
        }, 1500);
        running = false; // Stop further ticks
      }
    };

    // Initial render
    tick();

    // Interval-based refresh (more reliable than watchFile alone)
    const interval = setInterval(() => {
      if (running) tick();
      else clearInterval(interval);
    }, refreshMs);

    // Also watch for immediate file changes
    watchFile(stateFile, { interval: Math.min(refreshMs, 500) }, () => {
      if (running) tick();
    });
  });
