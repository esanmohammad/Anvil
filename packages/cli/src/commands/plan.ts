// CLI command: anvil plan <project> "<feature>" — architecture-first planning

import { Command } from 'commander';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import pc from 'picocolors';
import { info, success, error } from '../logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveBinary(): string {
  return (
    process.env.ANVIL_AGENT_CMD ??
    process.env.FF_AGENT_CMD ??
    process.env.CLAUDE_BIN ??
    'claude'
  );
}

function loadFactoryConfig(project: string): Record<string, unknown> | null {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try {
        return { _raw: readFileSync(p, 'utf-8'), _path: p };
      } catch { /* ignore */ }
    }
  }
  return null;
}

function extractDomainContext(rawConfig: string): string {
  // Extract known domain-context sections from factory.yaml
  const sections: string[] = [];
  const sectionNames = ['invariants', 'sharp_edges', 'critical_flows', 'domain', 'constraints', 'architecture'];

  let currentSection = '';
  let capturing = false;

  for (const line of rawConfig.split('\n')) {
    const sectionMatch = line.match(/^(\w[\w_-]*):/);
    if (sectionMatch) {
      const name = sectionMatch[1];
      if (sectionNames.includes(name)) {
        capturing = true;
        currentSection = line + '\n';
      } else {
        if (capturing && currentSection) {
          sections.push(currentSection.trim());
        }
        capturing = false;
        currentSection = '';
      }
    } else if (capturing) {
      currentSection += line + '\n';
    }
  }
  if (capturing && currentSection) {
    sections.push(currentSection.trim());
  }

  return sections.join('\n\n');
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

export const planCommand = new Command('plan')
  .description('Generate an architecture plan before running a full pipeline')
  .argument('<project>', 'Project name')
  .argument('<feature>', 'Feature description')
  .option('-o, --output <path>', 'Output plan file path', './anvil-plan.md')
  .option('--model <model>', 'Model to use for planning')
  .action(async (project: string, feature: string, opts: Record<string, unknown>) => {
    const outputPath = (opts.output as string) || './anvil-plan.md';
    const model = opts.model as string | undefined;

    info(`Planning architecture for project "${pc.bold(project)}"`);
    info(`Feature: ${feature}`);

    // 1. Load project config (factory.yaml)
    const config = loadFactoryConfig(project);
    let domainContext = '';
    if (config?._raw) {
      domainContext = extractDomainContext(config._raw as string);
      if (domainContext) {
        info(`Loaded domain context from ${config._path}`);
      }
    }

    // 2. Load KB context (graceful fallback)
    let kbContext = '';
    try {
      const { loadKnowledgeGraph } = await import('../context/knowledge-graph.js');
      const kb = await loadKnowledgeGraph(project, feature);
      if (kb) {
        kbContext = kb.slice(0, 12000);
        info(`[knowledge-base] KB available (${kb.length} chars)`);
      }
    } catch {
      // KB not available — continue without it
    }

    // 3. Load architect persona prompt (graceful fallback)
    let personaPrompt = '';
    try {
      const { loadPersonaPrompt } = await import('../personas/loader.js');
      personaPrompt = await loadPersonaPrompt('architect');
      info('Loaded architect persona prompt');
    } catch {
      // Persona not available — use inline fallback
      personaPrompt = `You are a senior software architect. You analyze requirements, design projects, and create detailed implementation plans. You consider scalability, maintainability, security, and developer experience in your designs.`;
    }

    // 4. Build prompts
    const projectPrompt = `${personaPrompt}

${kbContext ? `\n## Relevant Knowledge Base Context\n\n${kbContext}\n` : ''}
${domainContext ? `\n## Domain Context (from project config)\n\n${domainContext}\n` : ''}

You are creating an architecture plan for the "${project}" project. Your output should be a well-structured markdown document that can be saved and used as a reference for implementation.

Output format requirements:
- Use structured markdown with clear headings
- Include specific file paths, API endpoints, and database schema changes where applicable
- Be concrete and actionable — avoid vague statements
- Include a risk assessment section
- Include an estimated complexity rating (S/M/L/XL)`;

    const userPrompt = `Create a detailed implementation plan for the following feature:

**Feature:** ${feature}

**Project:** ${project}

Include the following sections:

1. **Summary** — One paragraph overview of the change
2. **Affected Repositories & Files** — List every repo and file that needs to change, with the type of change (new, modify, delete)
3. **Architecture Changes** — Component diagrams, data flow changes, new services or modules
4. **API Changes** — New or modified endpoints, request/response schemas, breaking changes
5. **Database Changes** — Schema migrations, new tables/columns, index changes
6. **Implementation Steps** — Ordered list of implementation tasks with dependencies
7. **Test Strategy** — What to test, testing approach for each layer (unit, integration, e2e)
8. **Risks & Mitigations** — What could go wrong and how to handle it
9. **Estimated Complexity** — S/M/L/XL with justification

Be specific and actionable. Reference actual file paths and code patterns from the codebase where possible.`;

    // 5. Spawn agent
    info('Spawning planning agent...');
    console.error('');

    const bin = resolveBinary();
    const args: string[] = [
      '-p', userPrompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--project-prompt', projectPrompt,
    ];

    if (model) {
      args.push('--model', model);
    }

    // Use workspace dir if available, otherwise cwd
    const workspaceRoot = process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace');
    const workspaceDir = join(workspaceRoot, project);
    const cwd = existsSync(workspaceDir) ? workspaceDir : process.cwd();

    if (existsSync(workspaceDir)) {
      info(`Using workspace: ${workspaceDir}`);
    }

    const child = spawn(bin, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    // Close stdin — non-interactive
    child.stdin?.end();

    const result = await parseStreamResult(child);

    // 6. Write output to file
    if (result.output) {
      try {
        writeFileSync(outputPath, result.output, 'utf-8');
        console.error('');
        success(`Plan saved to ${pc.bold(outputPath)}`);
      } catch (err) {
        error(`Failed to write plan: ${err instanceof Error ? err.message : String(err)}`);
        // Still show the output even if file write fails
        console.error('');
        console.error(result.output);
      }
    } else {
      error('Agent produced no output.');
      process.exit(1);
      return;
    }

    // 7. Show summary
    if (result.costUsd > 0) {
      console.error(`  Cost: $${result.costUsd.toFixed(4)} (${result.inputTokens} in / ${result.outputTokens} out)`);
    }
    if (result.durationMs > 0) {
      console.error(`  Duration: ${(result.durationMs / 1000).toFixed(1)}s`);
    }

    console.error('');
    info(`To execute: ${pc.dim(`anvil run ${project} "${feature}" --answers ${outputPath}`)}`);

    process.exit(0);
  });
