// CLI command: anvil test-gen [project] — generate tests for changed files

import { Command } from 'commander';
import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Source file extensions worth generating tests for. */
const SOURCE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.kt', '.rb',
  '.swift', '.c', '.cpp', '.cs',
]);

/** Files / patterns to skip even if they have a source extension. */
const SKIP_PATTERNS = [
  /\.d\.ts$/,
  /\.config\./,
  /\.spec\./,
  /\.test\./,
  /__tests__\//,
  /node_modules\//,
  /dist\//,
  /build\//,
];

function isSourceFile(path: string): boolean {
  const ext = path.slice(path.lastIndexOf('.'));
  if (!SOURCE_EXTS.has(ext)) return false;
  return !SKIP_PATTERNS.some((re) => re.test(path));
}

function getChangedFiles(against: string, cwd: string): string[] {
  try {
    const raw = execSync(`git diff --name-only ${against}...HEAD`, {
      cwd,
      encoding: 'utf-8',
      stdio: 'pipe',
    }).trim();
    if (!raw) return [];
    return raw.split('\n').filter(Boolean);
  } catch {
    // Fallback: diff against working tree
    try {
      const raw = execSync(`git diff --name-only ${against}`, {
        cwd,
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim();
      if (!raw) return [];
      return raw.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

function findNearbyTests(filePath: string, cwd: string): string | undefined {
  const dir = filePath.substring(0, filePath.lastIndexOf('/'));
  const base = filePath.substring(filePath.lastIndexOf('/') + 1).replace(/\.\w+$/, '');

  // Common test file naming patterns
  const candidates = [
    join(dir, `${base}.test.ts`),
    join(dir, `${base}.spec.ts`),
    join(dir, `${base}.test.tsx`),
    join(dir, `${base}.spec.tsx`),
    join(dir, `${base}_test.go`),
    join(dir, `${base}_test.py`),
    join(dir, '__tests__', `${base}.test.ts`),
    join(dir, '__tests__', `${base}.test.tsx`),
    join(dir, 'tests', `test_${base}.py`),
  ];

  for (const candidate of candidates) {
    const full = join(cwd, candidate);
    if (existsSync(full)) {
      try {
        return readFileSync(full, 'utf-8');
      } catch {
        /* skip */
      }
    }
  }
  return undefined;
}

function resolveBinary(): string {
  return (
    process.env.ANVIL_AGENT_CMD ??
    process.env.FF_AGENT_CMD ??
    process.env.CLAUDE_BIN ??
    'claude'
  );
}

function loadProjectConfig(project: string): Record<string, unknown> | null {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8');
        // Simple YAML key extraction — avoid full parser dependency
        const config: Record<string, unknown> = {};
        for (const line of raw.split('\n')) {
          const match = line.match(/^(\w[\w_-]*):\s*(.+)/);
          if (match) config[match[1]] = match[2].trim();
        }
        return config;
      } catch { /* ignore */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Stream-JSON result parser
// ---------------------------------------------------------------------------

interface StreamResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
}

function parseStreamResult(child: ReturnType<typeof spawn>): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let output = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let durationMs = 0;

    child.stdout?.on('data', (chunk: Buffer) => {
      const data = chunk.toString();
      process.stdout.write(data);

      buffer += data;
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
            inputTokens = msg.usage?.input_tokens ?? 0;
            outputTokens = msg.usage?.output_tokens ?? 0;
            costUsd = msg.total_cost_usd ?? 0;
            durationMs = msg.duration_ms ?? 0;
          }
        } catch { /* skip non-JSON */ }
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
    });

    child.on('close', (code) => {
      resolve({ output, inputTokens, outputTokens, costUsd, durationMs });
    });

    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Command
// ---------------------------------------------------------------------------

export const testGenCommand = new Command('test-gen')
  .description('Generate tests for changed files')
  .argument('[project]', 'Project name')
  .option('--files <paths...>', 'Specific files to generate tests for')
  .option('--against <branch>', 'Diff against branch to find changed files', 'main')
  .option('--type <type>', 'Test type: unit, integration, e2e', 'unit')
  .option('--framework <fw>', 'Test framework hint: jest, vitest, pytest, go-test')
  .option('--dry-run', 'Show what would be generated without running')
  .action(async (project: string | undefined, opts: Record<string, unknown>) => {
    const cwd = process.cwd();
    const testType = (opts.type as string) || 'unit';
    const framework = opts.framework as string | undefined;
    const against = (opts.against as string) || 'main';
    const dryRun = opts.dryRun === true;

    // 1. Determine changed files
    let changedFiles: string[];
    if (opts.files) {
      changedFiles = opts.files as string[];
    } else {
      info(`Finding changed files against ${pc.bold(against)}...`);
      changedFiles = getChangedFiles(against, cwd);
    }

    // 2. Filter to source files
    const sourceFiles = changedFiles.filter(isSourceFile);

    if (sourceFiles.length === 0) {
      warn('No source files found to generate tests for.');
      if (changedFiles.length > 0) {
        info(`Found ${changedFiles.length} changed file(s), but none are testable source files.`);
      }
      process.exit(0);
      return;
    }

    info(`Found ${pc.bold(String(sourceFiles.length))} source file(s) to generate tests for:`);
    for (const f of sourceFiles) {
      console.error(`  ${pc.dim('-')} ${f}`);
    }

    // 3. Dry run — just show the plan
    if (dryRun) {
      console.error('');
      console.error(pc.bold('Dry run — would generate tests for:'));
      for (const f of sourceFiles) {
        console.error(`  ${f}`);
      }
      console.error('');
      console.error(`  Test type:  ${testType}`);
      console.error(`  Framework:  ${framework ?? 'auto-detect'}`);
      process.exit(0);
      return;
    }

    // 4. Read source file contents
    const fileContents: Array<{ path: string; content: string; existingTest?: string }> = [];
    for (const f of sourceFiles) {
      const fullPath = join(cwd, f);
      if (!existsSync(fullPath)) {
        warn(`File not found: ${f} (may have been deleted)`);
        continue;
      }
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const existingTest = findNearbyTests(f, cwd);
        fileContents.push({ path: f, content, existingTest });
      } catch (err) {
        warn(`Could not read ${f}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (fileContents.length === 0) {
      error('No readable source files found.');
      process.exit(1);
      return;
    }

    // 5. Load project config (optional)
    let projectContext = '';
    if (project) {
      const config = loadProjectConfig(project);
      if (config) {
        projectContext = `\nProject config: ${JSON.stringify(config, null, 2)}`;
      }
    }

    // 6. Try loading KB context (graceful fallback)
    let kbContext = '';
    try {
      const { loadKnowledgeGraph } = await import('../context/knowledge-graph.js');
      const kb = await loadKnowledgeGraph(
        project ?? 'default',
        sourceFiles.join(' '),
      );
      if (kb) {
        kbContext = `\n\nRelevant knowledge base context:\n${kb.slice(0, 8000)}`;
      }
    } catch {
      // KB not available — that's fine
    }

    // 7. Build prompts
    const projectPrompt = `You are a test engineer. Generate comprehensive ${testType} tests for the provided source files.${framework ? ` Use the ${framework} test framework.` : ' Auto-detect the appropriate test framework based on the project structure.'} Follow existing test patterns in the codebase. Write tests that cover: happy path, edge cases, error handling, and boundary conditions.

Rules:
- Write test files directly to the filesystem using the tools available to you.
- Name test files following the project's existing conventions (e.g., *.test.ts, *.spec.ts, *_test.go, test_*.py).
- If an existing test file is provided as a reference, follow its style and patterns.
- Do NOT modify the source files — only create/update test files.
- Make tests self-contained and runnable.
- Include clear test descriptions.${projectContext}${kbContext}`;

    let userPrompt = `Generate ${testType} tests for the following ${fileContents.length} source file(s):\n\n`;

    for (const { path, content, existingTest } of fileContents) {
      userPrompt += `--- File: ${path} ---\n\`\`\`\n${content}\n\`\`\`\n\n`;
      if (existingTest) {
        userPrompt += `--- Existing test pattern (reference) ---\n\`\`\`\n${existingTest.slice(0, 3000)}\n\`\`\`\n\n`;
      }
    }

    userPrompt += `Write the test files now. Create one test file per source file.`;

    // 8. Spawn agent
    info('Spawning test generation agent...');
    console.error('');

    const bin = resolveBinary();
    const args: string[] = [
      '-p', userPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--project-prompt', projectPrompt,
    ];

    const child = spawn(bin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Close stdin — non-interactive
    child.stdin?.end();

    const result = await parseStreamResult(child);

    // 9. Summary
    console.error('');
    success(`Test generation complete for ${pc.bold(String(fileContents.length))} file(s)`);
    if (result.costUsd > 0) {
      console.error(`  Cost: $${result.costUsd.toFixed(4)} (${result.inputTokens} in / ${result.outputTokens} out)`);
    }
    if (result.durationMs > 0) {
      console.error(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    }

    // 10. Optionally run tests to verify
    if (project) {
      const config = loadProjectConfig(project);
      const testCmd = config?.testCommand as string | undefined;
      if (testCmd) {
        console.error('');
        info(`Running test command: ${pc.dim(testCmd)}`);
        try {
          execSync(testCmd, { cwd, stdio: 'inherit' });
          success('All tests passed!');
        } catch {
          warn('Some tests failed — review the generated tests and fix as needed.');
        }
      }
    }

    process.exit(0);
  });
