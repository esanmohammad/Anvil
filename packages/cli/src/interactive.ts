// Interactive mode — launched when `anvil` is run with no args

import { createInterface } from 'node:readline';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAnvilHome } from './home.js';
import pc from 'picocolors';

interface ProjectEntry {
  name: string;
  configPath: string;
}

function findProjects(): ProjectEntry[] {
  const home = getAnvilHome();
  const entries: ProjectEntry[] = [];

  const projectsDir = join(home, 'projects');
  if (existsSync(projectsDir)) {
    try {
      for (const name of readdirSync(projectsDir)) {
        if (name.startsWith('.')) continue;
        const yamlPath = join(projectsDir, name, 'factory.yaml');
        if (existsSync(yamlPath)) {
          entries.push({ name, configPath: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  // Legacy projects
  const legacyDir = join(home, 'projects');
  if (existsSync(legacyDir)) {
    try {
      for (const name of readdirSync(legacyDir)) {
        if (name.startsWith('.')) continue;
        if (entries.some((e) => e.name === name)) continue;
        const yamlPath = join(legacyDir, name, 'project.yaml');
        if (existsSync(yamlPath)) {
          entries.push({ name, configPath: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  return entries;
}

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

const ACTIONS = [
  { key: '1', label: 'Build feature', command: 'run' },
  { key: '2', label: 'Fix bug', command: 'fix' },
  { key: '3', label: 'Review changes', command: 'review' },
  { key: '4', label: 'Open dashboard', command: 'dashboard' },
  { key: '5', label: 'Check health', command: 'doctor' },
] as const;

export async function interactiveMode(): Promise<void> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  try {
    process.stderr.write('\n');
    process.stderr.write(pc.bold('Anvil') + pc.dim(' — AI-powered development pipeline') + '\n');
    process.stderr.write('\n');

    // List projects
    const projects = findProjects();
    if (projects.length === 0) {
      process.stderr.write(pc.yellow('No projects configured.') + '\n');
      process.stderr.write(`Run ${pc.cyan('anvil init')} to set up your first project.\n`);
      process.stderr.write('\n');
      rl.close();
      return;
    }

    process.stderr.write(pc.bold('Projects:') + '\n');
    for (let i = 0; i < projects.length; i++) {
      process.stderr.write(`  ${pc.cyan(String(i + 1))}. ${projects[i].name}\n`);
    }
    process.stderr.write('\n');

    // Pick project
    const projectAnswer = await ask(rl, `${pc.cyan('?')} Select project (1-${projects.length}): `);
    const projectIndex = parseInt(projectAnswer, 10) - 1;
    if (isNaN(projectIndex) || projectIndex < 0 || projectIndex >= projects.length) {
      const match = projects.find((p) => p.name === projectAnswer);
      if (!match) {
        process.stderr.write(pc.red('Invalid selection.') + '\n');
        rl.close();
        return;
      }
      var selectedProject = match.name;
    } else {
      var selectedProject = projects[projectIndex].name;
    }

    // Show actions
    process.stderr.write('\n');
    process.stderr.write(pc.bold('Actions:') + '\n');
    for (const action of ACTIONS) {
      process.stderr.write(`  ${pc.cyan(action.key)}. ${action.label}\n`);
    }
    process.stderr.write('\n');

    const actionAnswer = await ask(rl, `${pc.cyan('?')} Select action (1-${ACTIONS.length}): `);
    const actionIndex = parseInt(actionAnswer, 10) - 1;
    if (isNaN(actionIndex) || actionIndex < 0 || actionIndex >= ACTIONS.length) {
      process.stderr.write(pc.red('Invalid selection.') + '\n');
      rl.close();
      return;
    }

    const action = ACTIONS[actionIndex];

    // For commands that need a description, prompt for it
    if (action.command === 'run' || action.command === 'fix') {
      const descLabel = action.command === 'run' ? 'Feature description' : 'Bug description';
      const description = await ask(rl, `${pc.cyan('?')} ${descLabel}: `);
      if (!description) {
        process.stderr.write(pc.red('Description is required.') + '\n');
        rl.close();
        return;
      }

      rl.close();

      // Dispatch programmatically by importing and executing the command
      const { spawn } = await import('node:child_process');
      const args = [action.command, selectedProject, description];
      process.stderr.write(`\n${pc.dim(`> anvil ${args.join(' ')}`)}\n\n`);

      const child = spawn(process.argv[0], [...process.argv.slice(1, -1), ...args], {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
      child.on('close', (code) => process.exit(code ?? 0));
      return;
    }

    rl.close();

    // For simple commands
    if (action.command === 'review') {
      const { spawn } = await import('node:child_process');
      const args = ['review', selectedProject];
      process.stderr.write(`\n${pc.dim(`> anvil ${args.join(' ')}`)}\n\n`);
      const child = spawn(process.argv[0], [...process.argv.slice(1, -1), ...args], {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
      child.on('close', (code) => process.exit(code ?? 0));
    } else if (action.command === 'dashboard') {
      const { spawn } = await import('node:child_process');
      process.stderr.write(`\n${pc.dim('> anvil dashboard')}\n\n`);
      const child = spawn(process.argv[0], [...process.argv.slice(1, -1), 'dashboard'], {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
      child.on('close', (code) => process.exit(code ?? 0));
    } else if (action.command === 'doctor') {
      const { spawn } = await import('node:child_process');
      process.stderr.write(`\n${pc.dim('> anvil doctor')}\n\n`);
      const child = spawn(process.argv[0], [...process.argv.slice(1, -1), 'doctor'], {
        stdio: 'inherit',
        cwd: process.cwd(),
      });
      child.on('close', (code) => process.exit(code ?? 0));
    }
  } catch (err) {
    rl.close();
    if ((err as any)?.code === 'ERR_USE_AFTER_CLOSE') {
      process.stderr.write('\nCancelled.\n');
      return;
    }
    throw err;
  }
}
