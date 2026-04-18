import { Command } from 'commander';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';

// ── Minimal config reading (same pattern as setup.ts) ──────────────────────

interface RepoEntry {
  name: string;
  path: string;
  language: string;
}

interface KnowledgeConfig {
  embedding?: { provider?: string; model?: string; dimensions?: number };
  chunking?: { max_tokens?: number; context_enrichment?: string };
  retrieval?: { max_chunks?: number; max_tokens?: number };
  auto_index?: boolean;
}

interface ProjectConfig {
  project: string;
  workspace?: string;
  repos: RepoEntry[];
  knowledge?: KnowledgeConfig;
}

function getAnvilHome(): string {
  return process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
}

function findProjectConfigs(): Array<{ name: string; configPath: string }> {
  const home = getAnvilHome();
  const entries: Array<{ name: string; configPath: string }> = [];

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

function parseConfig(configPath: string): ProjectConfig | null {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const lines = raw.split('\n');

    let project = '';
    let workspace: string | undefined;
    const repos: RepoEntry[] = [];
    const knowledge: KnowledgeConfig = {};

    let currentRepo: Partial<RepoEntry> | null = null;
    let inRepos = false;
    let section = '';
    let subSection = '';

    const flushRepo = () => {
      if (currentRepo && currentRepo.name) {
        // Resolve repo path relative to workspace
        let repoPath = currentRepo.path || `./${currentRepo.name}`;
        if (workspace && !repoPath.startsWith('/')) {
          repoPath = join(workspace, repoPath);
        }
        repos.push({
          name: currentRepo.name,
          path: repoPath,
          language: currentRepo.language || '',
        });
      }
      currentRepo = null;
    };

    for (const line of lines) {
      const stripped = line.trimEnd();
      if (/^\s*#/.test(stripped) || /^\s*$/.test(stripped)) continue;
      const indent = stripped.length - stripped.trimStart().length;

      if (indent === 0) {
        flushRepo();
        inRepos = false;
        section = '';
        subSection = '';

        const scalar = stripped.match(/^(\w[\w_-]*):\s+(.+)$/);
        if (scalar) {
          const val = scalar[2].replace(/^["']|["']$/g, '').trim();
          if (scalar[1] === 'project' || scalar[1] === 'project') project = val;
          else if (scalar[1] === 'workspace') workspace = val.replace(/^~/, homedir());
        }

        if (/^repos:\s*$/.test(stripped)) inRepos = true;
        if (/^knowledge:\s*$/.test(stripped)) section = 'knowledge';
        continue;
      }

      if (inRepos) {
        const repoStart = stripped.match(/^\s{2,4}-\s+name:\s+(.+)/);
        if (repoStart) {
          flushRepo();
          currentRepo = { name: repoStart[1].trim() };
          continue;
        }

        if (currentRepo) {
          const kv = stripped.match(/^\s{4,8}(\w[\w_-]*):\s+(.+)$/);
          if (kv) {
            const val = kv[2].replace(/^["']|["']$/g, '').trim();
            if (kv[1] === 'path') currentRepo.path = val;
            else if (kv[1] === 'language') currentRepo.language = val;
          }
        }
      }

      // knowledge section
      if (section === 'knowledge') {
        const blockMatch = stripped.match(/^\s{2}(\w[\w_-]*):\s*$/);
        if (blockMatch) {
          subSection = blockMatch[1];
          if (subSection === 'embedding') knowledge.embedding = knowledge.embedding || {};
          else if (subSection === 'chunking') knowledge.chunking = knowledge.chunking || {};
          else if (subSection === 'retrieval') knowledge.retrieval = knowledge.retrieval || {};
          continue;
        }

        const kvMatch = stripped.match(/^\s{2,4}(\w[\w_-]*):\s+(.+)$/);
        if (kvMatch) {
          const key = kvMatch[1];
          const val = kvMatch[2].replace(/^["']|["']$/g, '').trim();

          if (!subSection && key === 'auto_index') {
            knowledge.auto_index = val === 'true';
          } else if (subSection === 'embedding') {
            if (!knowledge.embedding) knowledge.embedding = {};
            if (key === 'provider') knowledge.embedding.provider = val;
            else if (key === 'model') knowledge.embedding.model = val;
            else if (key === 'dimensions') knowledge.embedding.dimensions = parseInt(val, 10);
          } else if (subSection === 'chunking') {
            if (!knowledge.chunking) knowledge.chunking = {};
            if (key === 'max_tokens') knowledge.chunking.max_tokens = parseInt(val, 10);
            else if (key === 'context_enrichment') knowledge.chunking.context_enrichment = val;
          } else if (subSection === 'retrieval') {
            if (!knowledge.retrieval) knowledge.retrieval = {};
            if (key === 'max_chunks') knowledge.retrieval.max_chunks = parseInt(val, 10);
            else if (key === 'max_tokens') knowledge.retrieval.max_tokens = parseInt(val, 10);
          }
        }
      }
    }

    flushRepo();

    return {
      project: project || 'unknown',
      workspace,
      repos,
      knowledge: Object.keys(knowledge).length > 0 ? knowledge : undefined,
    };
  } catch {
    return null;
  }
}

// ── Command definition ─────────────────────────────────────────────────────

export const indexCommand = new Command('index')
  .description('Build semantic knowledge index for a project')
  .argument('[project]', 'Project name')
  .option('--full', 'Force full re-index')
  .option('--embedding <provider>', 'Embedding provider: codestral, voyage, openai, ollama')
  .option('--stats', 'Show current index statistics')
  .option('--dry-run', 'Show what would be indexed without actually indexing')
  .action(async (projectName, opts) => {
    const { createInterface } = await import('node:readline');

    // If --stats with a project, show index stats and exit
    if (opts.stats) {
      if (!projectName) {
        error('--stats requires a project name: anvil index <project> --stats');
        process.exitCode = 1;
        return;
      }

      try {
        const { KnowledgeIndexer } = await import('../knowledge/indexer.js');
        const indexer = new KnowledgeIndexer();
        const stats = await indexer.getStats(projectName);
        console.log('');
        console.log(pc.bold(`Index statistics for ${pc.cyan(projectName)}:`));
        console.log(`  Chunks:          ${stats.totalChunks}`);
        console.log(`  Cross-repo edges: ${stats.crossRepoEdges}`);
        console.log(`  Embedding provider: ${stats.embeddingProvider}`);
        console.log(`  Last indexed:    ${stats.lastIndexed || '(never)'}`);
        console.log(`  Duration:        ${stats.indexDurationMs ? (stats.indexDurationMs / 1000).toFixed(1) + 's' : '(unknown)'}`);
        console.log('');
      } catch (err: any) {
        error(`Failed to load index stats: ${err.message}`);
        process.exitCode = 1;
      }
      return;
    }

    // Find project configs
    const configs = findProjectConfigs();

    if (configs.length === 0) {
      error('No projects configured. Run "anvil init" first.');
      process.exitCode = 1;
      return;
    }

    // If no project arg, prompt user
    if (!projectName) {
      console.log('');
      console.log(pc.bold('Available projects:'));
      configs.forEach((c, i) => {
        console.log(`  ${i + 1}. ${c.name}`);
      });
      console.log('');

      const rl = createInterface({ input: process.stdin, output: process.stdout });
      projectName = await new Promise<string>((resolve, reject) => {
        rl.question('Select a project (number or name): ', (answer) => {
          rl.close();
          const num = parseInt(answer, 10);
          if (num >= 1 && num <= configs.length) {
            resolve(configs[num - 1].name);
          } else {
            const match = configs.find((c) => c.name === answer.trim());
            if (match) resolve(match.name);
            else reject(new Error(`Unknown project: ${answer}`));
          }
        });
      });
    }

    // Load project config
    const match = configs.find((c) => c.name === projectName);
    if (!match) {
      error(`Project "${projectName}" not found.`);
      console.error(`Available: ${configs.map((c) => c.name).join(', ') || '(none)'}`);
      process.exitCode = 1;
      return;
    }

    const config = parseConfig(match.configPath);
    if (!config) {
      error(`Failed to parse config at ${match.configPath}`);
      process.exitCode = 1;
      return;
    }

    // Determine embedding provider
    const knowledgeConfig = config.knowledge || {};
    let embeddingProvider = knowledgeConfig.embedding?.provider || 'auto';
    if (opts.embedding) {
      embeddingProvider = opts.embedding;
    }

    // Dry run — show what would be indexed
    if (opts.dryRun) {
      console.log('');
      console.log(pc.bold(`Dry run — would index project: ${pc.cyan(projectName)}`));
      console.log('');
      console.log(pc.bold('Repositories:'));
      for (const repo of config.repos) {
        const lang = repo.language ? pc.dim(` (${repo.language})`) : '';
        console.log(`  - ${repo.name}${lang}  ${pc.dim(repo.path)}`);
      }
      console.log('');
      console.log(`  Embedding provider: ${pc.cyan(embeddingProvider)}`);
      console.log(`  Chunk max tokens:   ${knowledgeConfig.chunking?.max_tokens || 512}`);
      console.log(`  Context enrichment: ${knowledgeConfig.chunking?.context_enrichment || 'parent'}`);
      console.log(`  Estimated chunks:   ${config.repos.length * 200}–${config.repos.length * 800} (varies by repo size)`);
      console.log('');
      return;
    }

    // Run indexer
    info(`Indexing project "${projectName}" with ${embeddingProvider} embeddings...`);
    const startTime = Date.now();

    try {
      const { KnowledgeIndexer } = await import('../knowledge/indexer.js');
      const { loadKnowledgeConfig } = await import('../knowledge/config.js');

      const kConfig = loadKnowledgeConfig(projectName);

      if (opts.embedding) {
        kConfig.embedding.provider = opts.embedding;
      }

      const indexer = new KnowledgeIndexer();
      const result = await indexer.indexProject(projectName, config.repos, kConfig, {
        onProgress: (msg: string) => {
          process.stderr.write(`  ${pc.dim(msg)}\n`);
        },
      });

      const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log('');
      success(`Indexing complete for ${pc.cyan(projectName)}`);
      console.log('');
      console.log(`  Chunks indexed:    ${result.totalChunks}`);
      console.log(`  Cross-repo edges:  ${result.crossRepoEdges}`);
      console.log(`  Duration:          ${durationSec}s`);
      console.log(`  Embedding provider: ${kConfig.embedding.provider}`);
      console.log('');
    } catch (err: any) {
      error(`Indexing failed: ${err.message}`);
      process.exitCode = 1;
    }
  });
