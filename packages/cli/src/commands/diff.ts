// CLI command: anvil diff [project]
// Intelligent pre-commit code review that understands the project's
// knowledge base, conventions, and invariants.

import { Command } from 'commander';
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';

// ── Types ─────────────────────────────────────────────────────────────────

interface Finding {
  severity: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  description: string;
  suggestedFix?: string;
}

interface RepoChanges {
  name: string;
  path: string;
  stat: string;
  diff: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const ANVIL_HOME = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
const MAX_DIFF_CHARS = 50_000;

function git(args: string, cwd: string): string {
  try {
    return execSync(args, { cwd, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return '';
  }
}

function loadFactoryConfig(project: string): Record<string, unknown> | null {
  const paths = [
    join(ANVIL_HOME, 'projects', project, 'factory.yaml'),
    join(ANVIL_HOME, 'projects', project, 'factory.yaml'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        // Lightweight YAML-ish parse — pull out what we need without a YAML dep.
        // For full fidelity the real loader should be used, but we stay self-contained.
        const raw = readFileSync(p, 'utf-8');
        return { _raw: raw, _path: p };
      } catch { /* ignore */ }
    }
  }
  return null;
}

function extractInvariants(rawYaml: string): string[] {
  const invariants: string[] = [];
  const lines = rawYaml.split('\n');
  let inInvariants = false;
  for (const line of lines) {
    if (/^\s+invariants:\s*$/.test(line)) {
      inInvariants = true;
      continue;
    }
    if (inInvariants) {
      const match = line.match(/^\s+-\s+"?(.+?)"?\s*$/);
      if (match) {
        invariants.push(match[1]);
      } else if (/^\s+\S/.test(line) && !line.match(/^\s+-/)) {
        inInvariants = false;
      }
    }
  }
  return invariants;
}

function loadConventionRules(): string[] {
  const rulesDir = join(ANVIL_HOME, 'conventions', 'rules');
  if (!existsSync(rulesDir)) return [];
  try {
    return readdirSync(rulesDir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => {
        try {
          return readFileSync(join(rulesDir, f), 'utf-8');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function resolveWorkspaceRepos(project: string): Array<{ name: string; path: string }> {
  const workspaceRoot =
    process.env.ANVIL_WORKSPACE_ROOT ||
    process.env.FF_WORKSPACE_ROOT ||
    join(homedir(), 'workspace');
  const wsDir = join(workspaceRoot, project);

  if (!existsSync(wsDir)) return [];

  try {
    return readdirSync(wsDir)
      .filter((entry) => {
        const full = join(wsDir, entry);
        try {
          return existsSync(join(full, '.git'));
        } catch {
          return false;
        }
      })
      .map((name) => ({ name, path: join(wsDir, name) }));
  } catch {
    return [];
  }
}

function loadKBContext(project: string, changedFiles: string[]): string {
  const kbDir = join(ANVIL_HOME, 'knowledge-base', project);
  if (!existsSync(kbDir)) return '';

  // Try to load relevant GRAPH_REPORT.md files
  const chunks: string[] = [];
  try {
    const repos = readdirSync(kbDir);
    for (const repo of repos) {
      const reportPath = join(kbDir, repo, 'GRAPH_REPORT.md');
      if (existsSync(reportPath)) {
        try {
          const content = readFileSync(reportPath, 'utf-8');
          // Only include if reasonably sized
          if (content.length < 10_000) {
            chunks.push(`## KB: ${repo}\n${content}`);
          } else {
            // Include just the first section as summary
            const firstSection = content.slice(0, 3000);
            chunks.push(`## KB: ${repo} (summary)\n${firstSection}\n...`);
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }

  return chunks.join('\n\n');
}

function getAgentBinary(): string {
  return process.env.ANVIL_AGENT_CMD || process.env.CLAUDE_BIN || 'claude';
}

function parseFindings(agentOutput: string): Finding[] {
  const findings: Finding[] = [];

  // Strategy 1: Try JSON block extraction
  const jsonBlockMatch = agentOutput.match(/```json\s*\n([\s\S]*?)```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of arr) {
        if (item.severity && item.description) {
          findings.push({
            severity: normalizeSeverity(item.severity),
            file: item.file || item.filePath || item.path,
            line: item.line || item.lineNumber,
            description: item.description || item.message,
            suggestedFix: item.suggestedFix || item.fix || item.suggestion,
          });
        }
      }
      if (findings.length > 0) return findings;
    } catch { /* fall through to pattern matching */ }
  }

  // Strategy 2: Pattern-based extraction from markdown output
  const patterns = [
    { regex: /\*\*ERROR\*\*:?\s*(.+)/gi, severity: 'error' as const },
    { regex: /\*\*WARNING\*\*:?\s*(.+)/gi, severity: 'warning' as const },
    { regex: /\*\*INFO\*\*:?\s*(.+)/gi, severity: 'info' as const },
  ];

  for (const { regex, severity } of patterns) {
    let match;
    while ((match = regex.exec(agentOutput)) !== null) {
      const raw = match[1].trim();
      // Try to extract file:line from the description
      const fileLineMatch = raw.match(/`?([^\s`]+\.\w+)(?::(\d+))?`?\s*[-—:]\s*(.+)/);
      if (fileLineMatch) {
        findings.push({
          severity,
          file: fileLineMatch[1],
          line: fileLineMatch[2] ? parseInt(fileLineMatch[2], 10) : undefined,
          description: fileLineMatch[3],
        });
      } else {
        findings.push({ severity, description: raw });
      }
    }
  }

  // Strategy 3: Bullet-point findings with severity prefix
  if (findings.length === 0) {
    const bulletPattern = /[-*]\s*\[?(error|warning|info)\]?\s*[-—:]\s*(.+)/gi;
    let match;
    while ((match = bulletPattern.exec(agentOutput)) !== null) {
      findings.push({
        severity: normalizeSeverity(match[1]),
        description: match[2].trim(),
      });
    }
  }

  // If still nothing and output is non-empty, treat the whole output as a single info
  if (findings.length === 0 && agentOutput.trim().length > 0) {
    findings.push({
      severity: 'info',
      description: 'Review completed — see raw output for details.',
    });
  }

  return findings;
}

function normalizeSeverity(s: string): Finding['severity'] {
  const lower = s.toLowerCase();
  if (lower.includes('error') || lower === 'critical' || lower === 'high') return 'error';
  if (lower.includes('warn') || lower === 'medium') return 'warning';
  return 'info';
}

const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, error: 2 };

function filterBySeverity(findings: Finding[], minSeverity: string): Finding[] {
  const minRank = SEVERITY_RANK[minSeverity] ?? 1;
  return findings.filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= minRank);
}

// ── Formatters ────────────────────────────────────────────────────────────

function formatText(findings: Finding[]): string {
  const lines: string[] = [];
  const icons = { error: pc.red('\u2717'), warning: pc.yellow('\u26A0'), info: pc.blue('\u2139') };
  const colors = {
    error: pc.red,
    warning: pc.yellow,
    info: pc.blue,
  };

  for (const f of findings) {
    const icon = icons[f.severity];
    const color = colors[f.severity];
    const location = f.file ? ` ${pc.dim(f.file)}${f.line ? `:${f.line}` : ''}` : '';
    lines.push(`  ${icon} ${color(f.severity.toUpperCase())}${location}`);
    lines.push(`    ${f.description}`);
    if (f.suggestedFix) {
      lines.push(`    ${pc.dim('Fix:')} ${f.suggestedFix}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatJson(findings: Finding[]): string {
  return JSON.stringify(findings, null, 2);
}

function formatMarkdown(findings: Finding[]): string {
  const lines: string[] = ['# Diff Review Findings', ''];
  const icons = { error: ':x:', warning: ':warning:', info: ':information_source:' };

  for (const f of findings) {
    const icon = icons[f.severity];
    const location = f.file ? ` \`${f.file}${f.line ? `:${f.line}` : ''}\`` : '';
    lines.push(`- ${icon} **${f.severity.toUpperCase()}**${location}: ${f.description}`);
    if (f.suggestedFix) {
      lines.push(`  - *Fix:* ${f.suggestedFix}`);
    }
  }

  return lines.join('\n');
}

function formatSummary(findings: Finding[]): string {
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const total = findings.length;
  return `Found ${total} issue${total !== 1 ? 's' : ''} (${counts.error} error${counts.error !== 1 ? 's' : ''}, ${counts.warning} warning${counts.warning !== 1 ? 's' : ''}, ${counts.info} info)`;
}

// ── Agent Interaction ─────────────────────────────────────────────────────

function runAgent(projectPrompt: string, userPrompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const bin = getAgentBinary();
    const args = ['-p', userPrompt, '--output-format', 'stream-json', '--verbose'];

    const proc = spawn(bin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let output = '';
    let buffer = '';

    proc.stdout.on('data', (data: Buffer) => {
      const chunk = data.toString();
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg.type === 'assistant' && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === 'text' && block.text) {
                output += block.text;
              }
            }
          } else if (msg.type === 'result') {
            if (msg.result) output = msg.result;
          }
        } catch { /* skip non-JSON lines */ }
      }
    });

    proc.stderr.on('data', () => {
      // Discard stderr noise from the agent
    });

    proc.on('close', (code) => {
      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const msg = JSON.parse(buffer.trim());
          if (msg.type === 'result' && msg.result) output = msg.result;
        } catch { /* ignore */ }
      }
      if (code !== 0 && !output) {
        reject(new Error(`Agent exited with code ${code}`));
      } else {
        resolve(output);
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn agent: ${err.message}`));
    });

    // Write project prompt via stdin, then close
    proc.stdin.write(projectPrompt);
    proc.stdin.end();
  });
}

// ── Command Definition ────────────────────────────────────────────────────

export const diffCommand = new Command('diff')
  .description('Intelligent code review of your changes before shipping')
  .argument('[project]', 'Project name')
  .option('--against <branch>', 'Compare against branch', 'main')
  .option('--severity <level>', 'Minimum severity: info, warning, error', 'warning')
  .option('--format <fmt>', 'Output format: text, json, markdown', 'text')
  .option('--conventions', 'Also check against convention rules')
  .option('--fix', 'Attempt to auto-fix issues found')
  .action(async (project: string | undefined, opts: Record<string, unknown>) => {
    const against = (opts.against as string) || 'main';
    const minSeverity = (opts.severity as string) || 'warning';
    const format = (opts.format as string) || 'text';
    const includeConventions = Boolean(opts.conventions);
    const autoFix = Boolean(opts.fix);

    // ── 1. Resolve project / repos ──────────────────────────────────────

    let repos: Array<{ name: string; path: string }> = [];

    if (project) {
      repos = resolveWorkspaceRepos(project);
      if (repos.length === 0) {
        // Fall back: maybe CWD is the repo itself
        const cwd = process.cwd();
        if (existsSync(join(cwd, '.git'))) {
          repos = [{ name: project, path: cwd }];
        } else {
          error(`No repos found for project "${project}". Ensure workspace exists or run from a git repo.`);
          process.exit(1);
          return;
        }
      }
    } else {
      // No project provided — use CWD as a single repo
      const cwd = process.cwd();
      if (!existsSync(join(cwd, '.git'))) {
        error('Not in a git repository. Provide a project name or run from a git repo.');
        process.exit(1);
        return;
      }
      repos = [{ name: 'current', path: cwd }];
    }

    // ── 2. Gather diffs across repos ────────────────────────────────────

    const changesPerRepo: RepoChanges[] = [];

    for (const repo of repos) {
      const stat = git(`git diff --stat ${against}...HEAD`, repo.path);
      const diff = git(`git diff ${against}...HEAD`, repo.path);

      // Also include staged but uncommitted changes
      const stagedDiff = git('git diff --cached', repo.path);
      const combinedDiff = [diff, stagedDiff].filter(Boolean).join('\n');

      if (!combinedDiff) continue;

      changesPerRepo.push({
        name: repo.name,
        path: repo.path,
        stat: stat || '(staged changes)',
        diff: combinedDiff,
      });
    }

    if (changesPerRepo.length === 0) {
      info(`No changes found against ${against}. Nothing to review.`);
      process.exit(0);
      return;
    }

    info(`Found changes in ${changesPerRepo.length} repo(s) against ${pc.bold(against)}`);
    for (const r of changesPerRepo) {
      console.error(`  ${pc.dim('-')} ${r.name}`);
    }

    // ── 3. Load project context ─────────────────────────────────────────

    let invariants: string[] = [];
    let conventionRules: string[] = [];
    let kbContext = '';

    if (project) {
      const config = loadFactoryConfig(project);
      if (config?._raw) {
        invariants = extractInvariants(config._raw as string);
        if (invariants.length > 0) {
          info(`Loaded ${invariants.length} domain invariant(s)`);
        }
      }

      // KB context
      const allChangedFiles = changesPerRepo.flatMap((r) =>
        r.stat
          .split('\n')
          .map((l) => l.trim().split(/\s+/)[0])
          .filter(Boolean),
      );
      kbContext = loadKBContext(project, allChangedFiles);
      if (kbContext) {
        info(`Loaded knowledge base context for "${project}"`);
      }
    }

    if (includeConventions) {
      conventionRules = loadConventionRules();
      if (conventionRules.length > 0) {
        info(`Loaded ${conventionRules.length} convention rule(s)`);
      } else {
        warn('No convention rules found in ~/.anvil/conventions/rules/');
      }
    }

    // ── 4. Build the review prompt ──────────────────────────────────────

    const projectPrompt = [
      'You are a senior code reviewer.',
      'Review the following diff against the project\'s conventions and invariants.',
      'For each issue found, output a structured finding with:',
      '  - severity (error, warning, or info)',
      '  - file path',
      '  - line number (if applicable)',
      '  - description',
      '  - suggested fix',
      '',
      'Output findings as a JSON array inside a ```json block.',
      'Each element: { "severity": "error|warning|info", "file": "path", "line": number|null, "description": "...", "suggestedFix": "..." }',
      '',
      'If there are no issues, output an empty JSON array: ```json\n[]\n```',
      '',
      'Be precise and actionable. Focus on:',
      '- Bugs and logic errors',
      '- Security issues',
      '- Performance problems',
      '- Convention violations',
      '- Invariant violations',
      'Do NOT flag trivial style issues unless they violate explicit conventions.',
    ].join('\n');

    const promptParts: string[] = [];

    // Diffs (capped)
    for (const repo of changesPerRepo) {
      let diff = repo.diff;
      if (diff.length > MAX_DIFF_CHARS) {
        diff = diff.slice(0, MAX_DIFF_CHARS) + '\n\n... [diff truncated at 50,000 chars]';
      }
      promptParts.push(`## Repository: ${repo.name}\n\n### Changed files\n\`\`\`\n${repo.stat}\n\`\`\`\n\n### Diff\n\`\`\`diff\n${diff}\n\`\`\``);
    }

    // Invariants
    if (invariants.length > 0) {
      promptParts.push(
        `## Domain Invariants\nThe following invariants MUST be respected. Flag any violation as an error.\n${invariants.map((inv) => `- ${inv}`).join('\n')}`,
      );
    }

    // Convention rules
    if (conventionRules.length > 0) {
      promptParts.push(
        `## Convention Rules\n${conventionRules.join('\n\n---\n\n')}`,
      );
    }

    // KB context
    if (kbContext) {
      promptParts.push(
        `## Knowledge Base Context\n${kbContext}`,
      );
    }

    const userPrompt = promptParts.join('\n\n---\n\n');

    // ── 5. Run the review agent ─────────────────────────────────────────

    info('Running review agent...');
    let agentOutput: string;
    try {
      agentOutput = await runAgent(projectPrompt, userPrompt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      error(`Agent failed: ${msg}`);
      process.exit(1);
      return;
    }

    if (!agentOutput.trim()) {
      warn('Agent returned empty output.');
      process.exit(0);
      return;
    }

    // ── 6. Parse & filter findings ──────────────────────────────────────

    let findings = parseFindings(agentOutput);
    findings = filterBySeverity(findings, minSeverity);

    // ── 7. Format and display ───────────────────────────────────────────

    console.log('');

    if (findings.length === 0) {
      success('No issues found at or above the configured severity threshold.');
    } else {
      switch (format) {
        case 'json':
          console.log(formatJson(findings));
          break;
        case 'markdown':
          console.log(formatMarkdown(findings));
          break;
        case 'text':
        default:
          console.log(formatText(findings));
          break;
      }
    }

    // Summary line
    const summaryLine = formatSummary(findings);
    const hasErrors = findings.some((f) => f.severity === 'error');

    if (hasErrors) {
      error(summaryLine);
    } else if (findings.some((f) => f.severity === 'warning')) {
      warn(summaryLine);
    } else {
      success(summaryLine);
    }

    // ── 8. Auto-fix ─────────────────────────────────────────────────────

    if (autoFix && findings.length > 0) {
      const fixableFindings = findings.filter((f) => f.suggestedFix);
      if (fixableFindings.length === 0) {
        info('No findings have suggested fixes to apply.');
      } else {
        info(`Attempting auto-fix for ${fixableFindings.length} finding(s)...`);

        const fixInstructions = fixableFindings
          .map((f, i) => {
            const location = f.file ? `File: ${f.file}${f.line ? `:${f.line}` : ''}` : 'No file specified';
            return `${i + 1}. [${f.severity.toUpperCase()}] ${location}\n   Issue: ${f.description}\n   Fix: ${f.suggestedFix}`;
          })
          .join('\n\n');

        const fixProjectPrompt = [
          'You are a senior software engineer.',
          'Apply the following fixes to the codebase. Only change what is necessary.',
          'For each fix, edit the file directly. Do not explain — just apply the changes.',
        ].join('\n');

        const fixUserPrompt = `Apply these fixes:\n\n${fixInstructions}`;

        try {
          // Run fix agent in each affected repo
          for (const repo of changesPerRepo) {
            const affectedFindings = fixableFindings.filter(
              (f) => !f.file || repo.stat.includes(f.file),
            );
            if (affectedFindings.length === 0) continue;

            info(`Fixing ${affectedFindings.length} issue(s) in ${repo.name}...`);

            const bin = getAgentBinary();
            execSync(
              `${bin} -p ${JSON.stringify(fixUserPrompt)} --allowedTools "Edit,Write" --verbose`,
              { cwd: repo.path, encoding: 'utf-8', stdio: 'pipe' },
            );

            success(`Fixes applied in ${repo.name}`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          warn(`Auto-fix encountered issues: ${msg}`);
        }
      }
    }

    // ── 9. Exit code ────────────────────────────────────────────────────

    process.exit(hasErrors ? 1 : 0);
  });
