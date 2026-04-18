// CI scanner — Wave 9, Section E
// Reads CI config files to extract build/test patterns

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface CiConfig {
  provider: 'github-actions' | 'gitlab-ci' | 'jenkins' | 'circleci' | 'unknown';
  buildSteps: string[];
  testCommands: string[];
  deployTargets: string[];
  triggers: string[];
  filePath: string;
}

const CI_FILE_CANDIDATES = [
  { path: '.github/workflows', provider: 'github-actions' as const },
  { path: '.gitlab-ci.yml', provider: 'gitlab-ci' as const },
  { path: 'Jenkinsfile', provider: 'jenkins' as const },
  { path: '.circleci/config.yml', provider: 'circleci' as const },
];

function extractGitHubActionsInfo(content: string): Partial<CiConfig> {
  const buildSteps: string[] = [];
  const testCommands: string[] = [];
  const deployTargets: string[] = [];
  const triggers: string[] = [];

  // Extract triggers (on: push, pull_request, etc.)
  const onMatch = content.match(/^on:\s*\n((?:\s+.+\n)*)/m);
  if (onMatch) {
    const triggerLines = onMatch[1].match(/^\s+(\w[\w-]*)/gm);
    if (triggerLines) {
      triggers.push(...triggerLines.map((t) => t.trim()));
    }
  }

  // Extract run commands
  const runMatches = content.matchAll(/run:\s*[|]?\s*\n?\s*(.+)/g);
  for (const match of runMatches) {
    const cmd = match[1].trim();
    if (/\b(build|compile|tsc)\b/i.test(cmd)) {
      buildSteps.push(cmd);
    }
    if (/\b(test|jest|mocha|pytest|go\s+test)\b/i.test(cmd)) {
      testCommands.push(cmd);
    }
    if (/\b(deploy|publish|release)\b/i.test(cmd)) {
      deployTargets.push(cmd);
    }
  }

  return { buildSteps, testCommands, deployTargets, triggers };
}

function extractGenericCiInfo(content: string): Partial<CiConfig> {
  const buildSteps: string[] = [];
  const testCommands: string[] = [];
  const deployTargets: string[] = [];

  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/\b(npm\s+run\s+build|make\s+build|go\s+build|mvn\s+compile)\b/.test(trimmed)) {
      buildSteps.push(trimmed);
    }
    if (/\b(npm\s+test|go\s+test|pytest|jest|mocha|mvn\s+test)\b/.test(trimmed)) {
      testCommands.push(trimmed);
    }
    if (/\b(deploy|publish|release|push)\b/i.test(trimmed)) {
      deployTargets.push(trimmed);
    }
  }

  return { buildSteps, testCommands, deployTargets, triggers: [] };
}

/**
 * Scan a repo directory for CI configuration files and extract patterns.
 */
export function scanCiConfigs(repoPath: string): CiConfig[] {
  const configs: CiConfig[] = [];

  for (const candidate of CI_FILE_CANDIDATES) {
    const fullPath = join(repoPath, candidate.path);

    if (!existsSync(fullPath)) continue;

    // For GitHub Actions, scan the workflows directory
    if (candidate.provider === 'github-actions') {
      try {
        const stat = statSync(fullPath);
        if (!stat.isDirectory()) continue;
        const files = readdirSync(fullPath) as string[];
        for (const file of files) {
          if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
          const filePath = join(fullPath, file);
          const content = readFileSync(filePath, 'utf-8');
          const info = extractGitHubActionsInfo(content);
          configs.push({
            provider: 'github-actions',
            buildSteps: info.buildSteps ?? [],
            testCommands: info.testCommands ?? [],
            deployTargets: info.deployTargets ?? [],
            triggers: info.triggers ?? [],
            filePath,
          });
        }
      } catch {
        // Directory read failed
      }
    } else {
      try {
        const content = readFileSync(fullPath, 'utf-8');
        const info = extractGenericCiInfo(content);
        configs.push({
          provider: candidate.provider,
          buildSteps: info.buildSteps ?? [],
          testCommands: info.testCommands ?? [],
          deployTargets: info.deployTargets ?? [],
          triggers: info.triggers ?? [],
          filePath: fullPath,
        });
      } catch {
        // File read failed
      }
    }
  }

  return configs;
}
