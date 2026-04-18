// CLI command: anvil learn
// Post-merge learning loop — analyzes merged PRs to extract reusable learnings

import { Command } from 'commander';
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';
import { findProject } from '../project/loader.js';
import { getAnvilDirs } from '../home.js';

interface PRData {
  number: number;
  title: string;
  body: string;
  url: string;
  reviews: Array<{ body: string; state: string; comments?: Array<{ body: string; path?: string; line?: number }> }>;
  comments: Array<{ body: string; author?: { login: string } }>;
  labels: Array<{ name: string }>;
}

interface Learning {
  id: string;
  type: 'convention' | 'pattern' | 'anti-pattern' | 'preference';
  description: string;
  source: string; // PR URL
  extractedAt: string;
  project: string;
  confidence: 'high' | 'medium' | 'low';
  tags: string[];
}

function ghExec(args: string): string {
  try {
    return execSync(`gh ${args}`, { encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 }).trim();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`gh command failed: ${msg}`);
  }
}

function fetchPR(url: string): PRData {
  const raw = ghExec(`pr view ${url} --json number,title,body,reviews,comments,url,labels`);
  return JSON.parse(raw) as PRData;
}

function fetchMergedPRs(repoPath: string, limit: number): PRData[] {
  try {
    const raw = ghExec(
      `pr list --repo ${repoPath} --state merged --limit ${limit} --json number,title,body,reviews,comments,url,labels --label anvil`,
    );
    return JSON.parse(raw) as PRData[];
  } catch {
    return [];
  }
}

function fetchPRDiff(prUrl: string): string {
  try {
    return ghExec(`pr diff ${prUrl}`);
  } catch {
    return '';
  }
}

function extractReviewFeedback(pr: PRData): string[] {
  const feedback: string[] = [];

  // Extract review bodies (especially change requests)
  for (const review of pr.reviews ?? []) {
    if (review.state === 'CHANGES_REQUESTED' || review.state === 'COMMENTED') {
      if (review.body?.trim()) {
        feedback.push(`[Review ${review.state}]: ${review.body}`);
      }
      for (const comment of review.comments ?? []) {
        if (comment.body?.trim()) {
          const location = comment.path ? ` (${comment.path}:${comment.line ?? '?'})` : '';
          feedback.push(`[Inline comment${location}]: ${comment.body}`);
        }
      }
    }
  }

  // Extract PR-level comments
  for (const comment of pr.comments ?? []) {
    if (comment.body?.trim()) {
      feedback.push(`[Comment by ${comment.author?.login ?? 'unknown'}]: ${comment.body}`);
    }
  }

  return feedback;
}

function buildLearningPrompt(pr: PRData, feedback: string[], diff: string): string {
  const truncatedDiff = diff.length > 10_000 ? diff.slice(0, 10_000) + '\n... (diff truncated)' : diff;

  return [
    `PR: ${pr.title} (${pr.url})`,
    '',
    '--- Review Feedback ---',
    ...feedback,
    '',
    '--- Relevant Diff ---',
    truncatedDiff,
  ].join('\n');
}

function parseLearningsFromOutput(output: string, prUrl: string, projectName: string): Learning[] {
  const learnings: Learning[] = [];
  const now = new Date().toISOString();

  // Parse structured output — expect lines like:
  // [convention] description here
  // [pattern] description here
  // [anti-pattern] description here
  const linePattern = /^\[(?<type>convention|pattern|anti-pattern|preference)\]\s*(?<desc>.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = linePattern.exec(output)) !== null) {
    const type = match.groups!.type as Learning['type'];
    const description = match.groups!.desc.trim();
    if (!description) continue;

    learnings.push({
      id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      description,
      source: prUrl,
      extractedAt: now,
      project: projectName,
      confidence: 'medium',
      tags: [],
    });
  }

  // If no structured output found, treat the whole output as a single learning
  if (learnings.length === 0 && output.trim()) {
    learnings.push({
      id: `learn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'convention',
      description: output.trim().slice(0, 500),
      source: prUrl,
      extractedAt: now,
      project: projectName,
      confidence: 'low',
      tags: [],
    });
  }

  return learnings;
}

function spawnAgent(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const projectPrompt =
      'You are analyzing PR review feedback to extract reusable learnings for future AI-generated code. ' +
      'Extract patterns, conventions, and anti-patterns from the review comments and code changes. ' +
      'Output each learning on its own line in the format: [type] description\n' +
      'Where type is one of: convention, pattern, anti-pattern, preference\n' +
      'Be specific and actionable. Focus on what reviewers corrected or suggested.';

    const child = spawn('claude', ['-p', `${projectPrompt}\n\n${prompt}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`Agent exited with code ${code}: ${stderr}`));
      }
    });

    child.on('error', (err) => {
      reject(err);
    });
  });
}

function saveLearnings(
  learnings: Learning[],
  projectName: string,
  dryRun: boolean,
): { learningsPath: string; conventionPath: string | null } {
  const anvilHome = join(homedir(), '.anvil');
  const memoryDir = join(anvilHome, 'memory', projectName);
  const learningsPath = join(memoryDir, 'learnings.jsonl');

  if (!dryRun) {
    if (!existsSync(memoryDir)) {
      mkdirSync(memoryDir, { recursive: true });
    }

    for (const learning of learnings) {
      appendFileSync(learningsPath, JSON.stringify(learning) + '\n', 'utf-8');
    }
  }

  // Write convention rules for convention-type learnings
  const conventionLearnings = learnings.filter((l) => l.type === 'convention' || l.type === 'pattern');
  let conventionPath: string | null = null;

  if (conventionLearnings.length > 0) {
    const rulesDir = join(anvilHome, 'conventions', 'rules');
    const dateStr = new Date().toISOString().slice(0, 10);
    conventionPath = join(rulesDir, `learned-${dateStr}.md`);

    if (!dryRun) {
      if (!existsSync(rulesDir)) {
        mkdirSync(rulesDir, { recursive: true });
      }

      const lines = [
        '---',
        `# Auto-generated from PR review feedback on ${dateStr}`,
        `project: ${projectName}`,
        '---',
        '',
        '# Learned Conventions',
        '',
      ];

      for (const l of conventionLearnings) {
        lines.push(`## ${l.type}: ${l.description.slice(0, 80)}`);
        lines.push('');
        lines.push(l.description);
        lines.push('');
        lines.push(`_Source: ${l.source}_`);
        lines.push('');
      }

      appendFileSync(conventionPath, lines.join('\n') + '\n', 'utf-8');
    }
  }

  return { learningsPath, conventionPath };
}

export const learnCommand = new Command('learn')
  .description('Extract learnings from merged PRs and review feedback')
  .argument('[project]', 'Project name')
  .option('--pr <url>', 'Learn from a specific PR')
  .option('--recent <n>', 'Learn from N most recent merged PRs', '5')
  .option('--dry-run', 'Show learnings without saving')
  .action(async (projectName: string | undefined, opts: { pr?: string; recent?: string; dryRun?: boolean }) => {
    const anvilDirs = getAnvilDirs();
    const dryRun = opts.dryRun ?? false;
    const recentLimit = parseInt(opts.recent ?? '5', 10);

    if (dryRun) {
      warn('Dry run mode — learnings will not be saved');
    }

    // Collect PRs to analyze
    const prsToAnalyze: PRData[] = [];

    if (opts.pr) {
      // Single PR mode
      info(`Fetching PR: ${opts.pr}`);
      try {
        const pr = fetchPR(opts.pr);
        prsToAnalyze.push(pr);
        success(`Loaded PR #${pr.number}: ${pr.title}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to fetch PR: ${msg}`);
        process.exit(1);
        return;
      }
    } else {
      // Multi-PR mode — requires a project
      if (!projectName) {
        error('Project name is required when not using --pr. Usage: anvil learn <project>');
        process.exit(1);
        return;
      }

      let project;
      try {
        project = await findProject(anvilDirs.projects, projectName);
      } catch {
        error(`Project "${projectName}" not found. Run "anvil project list" to see available projects.`);
        process.exit(1);
        return;
      }

      info(`Scanning ${project.repos.length} repo(s) for recent Anvil-generated merged PRs...`);

      for (const repo of project.repos) {
        const repoPath = repo.github;
        info(`  Checking ${repo.name}...`);
        const prs = fetchMergedPRs(repoPath, recentLimit);
        if (prs.length > 0) {
          info(`    Found ${prs.length} merged PR(s) with "anvil" label`);
          prsToAnalyze.push(...prs);
        }
      }
    }

    if (prsToAnalyze.length === 0) {
      info('No PRs found to analyze.');
      process.exit(0);
      return;
    }

    info(`Analyzing ${prsToAnalyze.length} PR(s) for learnings...`);

    const resolvedProject = projectName ?? 'unknown';
    let totalLearnings = 0;

    for (const pr of prsToAnalyze) {
      const feedback = extractReviewFeedback(pr);

      if (feedback.length === 0) {
        info(`  PR #${pr.number}: No review feedback found, skipping`);
        continue;
      }

      info(`  PR #${pr.number}: ${feedback.length} feedback item(s), fetching diff...`);
      const diff = fetchPRDiff(pr.url);
      const prompt = buildLearningPrompt(pr, feedback, diff);

      try {
        const output = await spawnAgent(prompt);
        const learnings = parseLearningsFromOutput(output, pr.url, resolvedProject);

        if (learnings.length > 0) {
          if (dryRun) {
            console.log('');
            console.log(pc.bold(`  Learnings from PR #${pr.number}:`));
            for (const l of learnings) {
              const typeColor =
                l.type === 'anti-pattern'
                  ? pc.red
                  : l.type === 'convention'
                    ? pc.green
                    : l.type === 'pattern'
                      ? pc.blue
                      : pc.yellow;
              console.log(`    ${typeColor(`[${l.type}]`)} ${l.description}`);
            }
          } else {
            const { learningsPath, conventionPath } = saveLearnings(learnings, resolvedProject, dryRun);
            success(`  PR #${pr.number}: Extracted ${learnings.length} learning(s) -> ${learningsPath}`);
            if (conventionPath) {
              info(`    Convention rules updated: ${conventionPath}`);
            }
          }
          totalLearnings += learnings.length;
        } else {
          info(`  PR #${pr.number}: No actionable learnings extracted`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`  PR #${pr.number}: Agent failed — ${msg}`);
      }
    }

    // Summary
    console.log('');
    console.log(pc.bold('Learn Summary'));
    console.log(pc.dim('─'.repeat(40)));
    console.log(`  PRs analyzed:       ${prsToAnalyze.length}`);
    console.log(`  Learnings extracted: ${totalLearnings}`);

    if (totalLearnings > 0 && !dryRun) {
      success(`Extracted ${totalLearnings} learnings from ${prsToAnalyze.length} PR(s)`);
    } else if (totalLearnings === 0) {
      info('No learnings extracted — PRs may not have review feedback');
    }
  });
