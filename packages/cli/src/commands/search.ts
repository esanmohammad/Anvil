import { Command } from 'commander';
import pc from 'picocolors';
import { error } from '../logger.js';

export const searchCommand = new Command('search')
  .description('Search the project knowledge base')
  .argument('<project>', 'Project name')
  .argument('<query>', 'Search query')
  .option('--repo <name>', 'Filter to specific repo')
  .option('--limit <n>', 'Max results', '10')
  .option('--method <m>', 'Search method: hybrid, vector, bm25', 'hybrid')
  .option('--format <fmt>', 'Output format: table, json, paths', 'table')
  .action(async (project, query, opts) => {
    try {
      const { getRetriever } = await import('../knowledge/indexer.js');
      const retriever = await getRetriever(project);

      const results = await retriever.retrieve(query, {
        repos: opts.repo ? [opts.repo] : undefined,
        maxChunks: parseInt(opts.limit, 10),
      });

      if (results.chunks.length === 0) {
        console.log(pc.yellow('No results found.'));
        return;
      }

      const format = opts.format;

      if (format === 'json') {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      if (format === 'paths') {
        for (const sc of results.chunks) {
          console.log(sc.chunk.filePath);
        }
        return;
      }

      // Default: table format
      console.log('');
      console.log(pc.bold(`Search results for: ${pc.cyan(query)}`));
      console.log(pc.dim(`Project: ${project} | Method: ${opts.method} | Results: ${results.chunks.length}`));
      console.log('');

      // Header
      const colFile = 'File'.padEnd(40);
      const colEntity = 'Entity'.padEnd(25);
      const colScore = 'Score'.padEnd(8);
      const colPreview = 'Preview';
      console.log(pc.bold(`  ${colFile} ${colEntity} ${colScore} ${colPreview}`));
      console.log(pc.dim(`  ${'─'.repeat(40)} ${'─'.repeat(25)} ${'─'.repeat(8)} ${'─'.repeat(30)}`));

      for (const sc of results.chunks) {
        const filePath = (sc.chunk.filePath || '').slice(-38).padEnd(40);
        const entity = (sc.chunk.entityName || sc.chunk.entityType || '').slice(0, 23).padEnd(25);
        const score = (sc.score != null ? sc.score.toFixed(3) : '—').padEnd(8);
        const preview = (sc.chunk.content || '').replace(/\n/g, ' ').slice(0, 50);

        console.log(`  ${pc.white(filePath)} ${pc.cyan(entity)} ${pc.yellow(score)} ${pc.dim(preview)}`);
      }

      console.log('');
      console.log(pc.dim(`Total: ${results.chunks.length} results | Tokens: ${results.totalTokens ?? '—'}`));
      console.log('');
    } catch (err: any) {
      error(`Search failed: ${err.message}`);
      process.exitCode = 1;
    }
  });
