// Enhanced learn command — Wave 9, Section E
// Full sweep: CI configs, test patterns, run history, rule generation

import { Command } from 'commander';
import { join } from 'node:path';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { findProject } from '../project/loader.js';
import { getFFDirs } from '../home.js';
import { error, success, info } from '../logger.js';
import { scanCiConfigs } from '../learn/ci-scanner.js';
import { scanTestPatterns } from '../learn/test-scanner.js';
import { analyzePastRuns } from '../learn/run-analyzer.js';
import { generateRules } from '../learn/rule-generator.js';
import { IndexReader } from '../run/index-reader.js';
import { extractConventions } from '../conventions/extractor.js';
import pc from 'picocolors';

export const learnEnhancedCommand = new Command('learn')
  .description('Learn conventions from a project codebase (enhanced full sweep)')
  .argument('<project>', 'The project to learn from')
  .option('--skip-ci', 'Skip CI config scanning')
  .option('--skip-tests', 'Skip test pattern scanning')
  .option('--skip-runs', 'Skip past run analysis')
  .action(async (projectName: string, opts: Record<string, unknown>) => {
    const anvilDirs = getFFDirs();

    // 1. Validate project
    let project;
    try {
      project = await findProject(anvilDirs.projects, projectName);
    } catch {
      error(`Project "${projectName}" not found. Run "ff project list" to see available projects.`);
      process.exit(1);
      return;
    }

    info(`Learning from project "${projectName}" (${project.repos.length} repos)`);

    const repoPaths = project.repos.map((r) => r.github);

    // 2. Extract basic conventions (existing Wave 4 functionality)
    info('Extracting coding conventions...');
    try {
      extractConventions(projectName, repoPaths);
      success('Coding conventions extracted');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      info(`Convention extraction skipped: ${msg}`);
    }

    // 3. Scan CI configs
    const allCiConfigs = [];
    if (!opts.skipCi) {
      info('Scanning CI configurations...');
      for (const repoPath of repoPaths) {
        const configs = scanCiConfigs(repoPath);
        allCiConfigs.push(...configs);
      }
      success(`Found ${allCiConfigs.length} CI config(s)`);
    }

    // 4. Scan test patterns
    const allTestPatterns = [];
    if (!opts.skipTests) {
      info('Scanning test patterns...');
      for (const repoPath of repoPaths) {
        const pattern = scanTestPatterns(repoPath);
        if (pattern.totalTestFiles > 0) {
          allTestPatterns.push(pattern);
        }
      }
      success(`Analyzed test patterns from ${allTestPatterns.length} repo(s)`);
    }

    // 5. Analyze past runs
    let runPatterns: ReturnType<typeof analyzePastRuns> = [];
    if (!opts.skipRuns) {
      info('Analyzing past runs...');
      try {
        const indexReader = new IndexReader(join(anvilDirs.runs, 'index.jsonl'));
        const runs = await indexReader.listRuns({ project: projectName });
        runPatterns = analyzePastRuns(runs);
        success(`Found ${runPatterns.length} pattern(s) from ${runs.length} past runs`);
      } catch {
        info('No past run data available');
      }
    }

    // 6. Generate rules
    info('Generating convention rules...');
    const language = project.repos[0]?.language ?? 'typescript';
    const rules = generateRules({
      ciConfigs: allCiConfigs,
      testPatterns: allTestPatterns,
      runPatterns,
      language,
    });

    // 7. Write generated rules
    const rulesDir = join(anvilDirs.conventionRules, projectName);
    if (!existsSync(rulesDir)) {
      mkdirSync(rulesDir, { recursive: true });
    }
    const rulesPath = join(rulesDir, 'generated-rules.json');
    writeFileSync(rulesPath, JSON.stringify({ rules }, null, 2), 'utf-8');
    success(`Generated ${rules.length} convention rules -> ${rulesPath}`);

    // 8. Summary
    console.log('');
    console.log(pc.bold('Learn Summary'));
    console.log(pc.dim('─'.repeat(40)));
    console.log(`  CI configs found:    ${allCiConfigs.length}`);
    console.log(`  Test patterns found: ${allTestPatterns.length}`);
    console.log(`  Run patterns found:  ${runPatterns.length}`);
    console.log(`  Rules generated:     ${rules.length}`);
  });
