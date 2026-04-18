// CLI command: anvil migrate <project>
// Detect schema changes and generate database migrations via agent

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';
import { findProject } from '../project/loader.js';
import { getFFDirs } from '../home.js';
import { execSync } from 'node:child_process';

const SCHEMA_PATTERNS = [
  '*.prisma',
  '**/models/*.py',
  '**/entities/*.ts',
  '**/schema.*',
  '*.sql',
  '**/migrations/**',
  '**/models.py',
  '**/model.ts',
  '**/model.js',
  '**/entity.ts',
  '**/*.entity.ts',
  '**/schema.prisma',
  '**/alembic/**',
  '**/knexfile.*',
];

const SCHEMA_EXTENSIONS = new Set([
  '.prisma',
  '.sql',
  '.entity.ts',
  '.model.ts',
  '.model.js',
  '.model.py',
]);

function isSchemaFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();

  // Direct extension match
  for (const ext of SCHEMA_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }

  // Path-based patterns
  if (lower.includes('/models/') || lower.includes('/entities/')) return true;
  if (lower.includes('/schema.') || lower.includes('/schema/')) return true;
  if (lower.includes('.prisma')) return true;
  if (lower.includes('/alembic/')) return true;
  if (lower.match(/models\.py$/)) return true;

  return false;
}

function detectFramework(changedFiles: string[]): string | null {
  for (const f of changedFiles) {
    if (f.endsWith('.prisma')) return 'prisma';
    if (f.includes('/alembic/') || f.includes('models.py')) return 'alembic';
    if (f.includes('knexfile')) return 'knex';
    if (f.endsWith('.entity.ts')) return 'typeorm';
  }
  return null;
}

function findExistingMigrations(repoDir: string): string[] {
  const migrationDirs = [
    'prisma/migrations',
    'alembic/versions',
    'migrations',
    'db/migrations',
    'src/migrations',
    'database/migrations',
  ];

  const found: string[] = [];
  for (const dir of migrationDirs) {
    const fullPath = join(repoDir, dir);
    if (existsSync(fullPath)) {
      try {
        const entries = readdirSync(fullPath, { recursive: false });
        // Return the dir and count for context
        found.push(`${dir}/ (${entries.length} entries)`);
      } catch {
        // skip
      }
    }
  }
  return found;
}

export const migrateCommand = new Command('migrate')
  .description('Detect schema changes and generate database migrations')
  .argument('<project>', 'Project name')
  .option('--against <branch>', 'Diff against branch', 'main')
  .option('--framework <fw>', 'Migration framework: prisma, alembic, knex, golang-migrate, typeorm')
  .option('--dry-run', 'Show detected changes without generating migrations')
  .action(
    async (
      projectName: string,
      opts: { against: string; framework?: string; dryRun?: boolean },
    ) => {
      try {
        const anvilDirs = getFFDirs();

        // 1. Resolve project and its repos
        let project;
        try {
          project = await findProject(anvilDirs.projects, projectName);
        } catch {
          // Also try projects dir
          try {
            const { findAndResolve } = await import('../project/loader.js');
            project = await findAndResolve(anvilDirs.projects, projectName);
          } catch {
            error(
              `Project "${projectName}" not found. Run "anvil project list" to see available projects.`,
            );
            process.exitCode = 1;
            return;
          }
        }

        info(`Scanning project "${projectName}" for schema changes against ${pc.cyan(opts.against)}...`);

        const allSchemaFiles: { repo: string; file: string; diff: string }[] = [];
        const repoDirs: { name: string; path: string }[] = [];

        // 2. For each repo, find changed schema files
        for (const repo of project.repos) {
          const repoDir =
            join(anvilDirs.workspaces, projectName, repo.name);
          const fallbackDir = join(anvilDirs.workspaces, repo.name);
          const actualDir = existsSync(repoDir) ? repoDir : existsSync(fallbackDir) ? fallbackDir : null;

          if (!actualDir || !existsSync(join(actualDir, '.git'))) {
            warn(`Repo "${repo.name}" not found in workspaces — skipping`);
            continue;
          }

          repoDirs.push({ name: repo.name, path: actualDir });

          // Get changed files
          let changedFilesRaw: string;
          try {
            changedFilesRaw = execSync(
              `git diff ${opts.against}...HEAD --name-only`,
              { cwd: actualDir, stdio: 'pipe', timeout: 15_000 },
            ).toString().trim();
          } catch {
            // May not have the against branch — try simple diff
            try {
              changedFilesRaw = execSync(
                `git diff HEAD --name-only`,
                { cwd: actualDir, stdio: 'pipe', timeout: 15_000 },
              ).toString().trim();
            } catch {
              warn(`Could not diff repo "${repo.name}" — skipping`);
              continue;
            }
          }

          if (!changedFilesRaw) continue;

          const changedFiles = changedFilesRaw.split('\n').filter(Boolean);
          const schemaFiles = changedFiles.filter(isSchemaFile);

          for (const file of schemaFiles) {
            // Get the actual diff content
            let diff = '';
            try {
              diff = execSync(
                `git diff ${opts.against}...HEAD -- "${file}"`,
                { cwd: actualDir, stdio: 'pipe', timeout: 15_000 },
              ).toString();
            } catch {
              try {
                diff = execSync(
                  `git diff HEAD -- "${file}"`,
                  { cwd: actualDir, stdio: 'pipe', timeout: 15_000 },
                ).toString();
              } catch {
                // Could not get diff
              }
            }

            allSchemaFiles.push({ repo: repo.name, file, diff });
          }
        }

        // 3. Report findings
        if (allSchemaFiles.length === 0) {
          info('No schema changes detected.');
          if (opts.dryRun) return;
          info(
            pc.dim('Hint: ensure your feature branch has schema changes compared to the target branch.'),
          );
          return;
        }

        console.log('');
        info(pc.bold(`Found ${allSchemaFiles.length} schema file(s) with changes:`));
        for (const sf of allSchemaFiles) {
          console.log(`  ${pc.cyan(sf.repo)}/${sf.file}`);
        }
        console.log('');

        // 4. Detect or use specified framework
        const detectedFramework =
          opts.framework ||
          detectFramework(allSchemaFiles.map((sf) => sf.file)) ||
          'unknown';

        info(`Migration framework: ${pc.bold(detectedFramework)}`);

        // Show existing migrations for context
        for (const rd of repoDirs) {
          const existing = findExistingMigrations(rd.path);
          if (existing.length > 0) {
            info(`Existing migrations in ${rd.name}: ${existing.join(', ')}`);
          }
        }

        // 5. Dry run — stop here
        if (opts.dryRun) {
          console.log('');
          info(pc.yellow('Dry run — no migrations generated.'));
          console.log('');
          info('Schema diffs:');
          for (const sf of allSchemaFiles) {
            console.log(pc.bold(`\n--- ${sf.repo}/${sf.file} ---`));
            console.log(pc.dim(sf.diff.slice(0, 2000)));
            if (sf.diff.length > 2000) {
              console.log(pc.dim(`... (${sf.diff.length - 2000} more characters)`));
            }
          }
          return;
        }

        // 6. Build prompt and spawn agent to generate migrations
        const schemaDiffs = allSchemaFiles
          .map(
            (sf) =>
              `### ${sf.repo}/${sf.file}\n\`\`\`diff\n${sf.diff}\n\`\`\``,
          )
          .join('\n\n');

        const existingMigrationInfo = repoDirs
          .map((rd) => {
            const existing = findExistingMigrations(rd.path);
            return existing.length > 0
              ? `${rd.name}: ${existing.join(', ')}`
              : null;
          })
          .filter(Boolean)
          .join('\n');

        const projectPrompt = [
          'You are a database migration expert.',
          'Analyze the schema changes and generate the appropriate migration files.',
          `Migration framework: ${detectedFramework}`,
          'Follow the existing migration naming conventions and patterns in the repo.',
          'Generate ONLY the migration files — do not modify schema/model files.',
        ].join('\n');

        const userPrompt = [
          `## Schema Changes\n\n${schemaDiffs}`,
          existingMigrationInfo
            ? `\n## Existing Migrations\n${existingMigrationInfo}`
            : '',
          `\n## Instructions`,
          `Generate migration file(s) for the ${detectedFramework} framework.`,
          'Use the same naming conventions as existing migrations.',
          'Include both up and down migrations where applicable.',
        ]
          .filter(Boolean)
          .join('\n');

        info('Spawning agent to generate migrations...');

        // Spawn claude with the migration prompt
        const targetDir = repoDirs[0]?.path || process.cwd();

        const bin = process.env.ANVIL_AGENT_CMD ?? process.env.FF_AGENT_CMD ?? process.env.CLAUDE_BIN ?? 'claude';
        const agentProcess = spawn(
          bin,
          [
            '-p',
            userPrompt,
            '--output-format',
            'stream-json',
            '--verbose',
          ],
          {
            cwd: targetDir,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              CLAUDE_SYSTEM_PROMPT: projectPrompt,
            },
          },
        );

        let stdout = '';
        let stderr = '';

        agentProcess.stdout.on('data', (data: Buffer) => {
          const chunk = data.toString();
          stdout += chunk;

          // Stream progress indicators from NDJSON
          for (const line of chunk.split('\n').filter(Boolean)) {
            try {
              const event = JSON.parse(line);
              if (event.type === 'assistant' && event.message?.content) {
                for (const block of event.message.content) {
                  if (block.type === 'text' && block.text) {
                    // Show truncated progress
                    const preview = block.text.slice(0, 120).replace(/\n/g, ' ');
                    info(pc.dim(preview));
                  }
                }
              }
            } catch {
              // Not valid JSON line — skip
            }
          }
        });

        agentProcess.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });

        const exitCode = await new Promise<number>((resolve) => {
          agentProcess.on('close', (code) => resolve(code ?? 1));
          agentProcess.on('error', (err) => {
            error(`Failed to spawn agent: ${err.message}`);
            resolve(1);
          });
        });

        if (exitCode !== 0) {
          error(`Agent exited with code ${exitCode}`);
          if (stderr) {
            warn(stderr.slice(0, 500));
          }
          process.exitCode = 1;
          return;
        }

        // 7. Count generated files by checking git status
        let generatedCount = 0;
        for (const rd of repoDirs) {
          try {
            const status = execSync('git status --porcelain', {
              cwd: rd.path,
              stdio: 'pipe',
              timeout: 10_000,
            }).toString().trim();

            const newFiles = status
              .split('\n')
              .filter((line) => line.startsWith('?') || line.startsWith('A'))
              .filter((line) => line.toLowerCase().includes('migrat'));

            generatedCount += newFiles.length;

            if (newFiles.length > 0) {
              info(`New migration files in ${rd.name}:`);
              for (const f of newFiles) {
                console.log(`  ${pc.green('+')} ${f.trim()}`);
              }
            }
          } catch {
            // skip
          }
        }

        console.log('');
        success(`Generated ${generatedCount} migration file${generatedCount !== 1 ? 's' : ''}`);
      } catch (err) {
        error(err instanceof Error ? err.message : String(err));
        process.exitCode = 1;
      }
    },
  );
