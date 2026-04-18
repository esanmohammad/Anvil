import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ValidationCheck {
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  output: string;
  duration: number;
}

export interface RepoValidation {
  repoName: string;
  repoPath: string;
  checks: ValidationCheck[];
  allPassed: boolean;
}

interface CheckSpec {
  name: string;
  command: string;
  args: string[];
  critical?: boolean; // if true, stop on failure
}

function getChecksForLanguage(language: 'typescript' | 'go' | 'unknown'): CheckSpec[] {
  if (language === 'typescript') {
    return [
      { name: 'build', command: 'npm', args: ['run', 'build'], critical: true },
      { name: 'type-check', command: 'npx', args: ['tsc', '--noEmit'] },
      { name: 'lint', command: 'npx', args: ['eslint', '.'] },
      { name: 'test', command: 'npm', args: ['test'] },
    ];
  }

  if (language === 'go') {
    return [
      { name: 'build', command: 'go', args: ['build', './...'], critical: true },
      { name: 'vet', command: 'go', args: ['vet', './...'] },
      { name: 'lint', command: 'golangci-lint', args: ['run'] },
      { name: 'test', command: 'go', args: ['test', './...'] },
    ];
  }

  return [];
}

async function runCheck(
  repoPath: string,
  spec: CheckSpec,
): Promise<ValidationCheck> {
  const start = Date.now();
  const command = `${spec.command} ${spec.args.join(' ')}`;

  try {
    const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
      cwd: repoPath,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
      timeout: 5 * 60_000,
    });

    return {
      name: spec.name,
      command,
      status: 'passed',
      output: (stdout + '\n' + stderr).trim(),
      duration: Date.now() - start,
    };
  } catch (error: any) {
    return {
      name: spec.name,
      command,
      status: 'failed',
      output: (error.stdout || '') + '\n' + (error.stderr || '') + '\n' + (error.message || ''),
      duration: Date.now() - start,
    };
  }
}

/**
 * Runs validation checks for a repo based on its language.
 * Stops early if the build (critical) check fails.
 */
export async function runValidationChecks(
  repoPath: string,
  repoName: string,
  language: 'typescript' | 'go' | 'unknown',
): Promise<RepoValidation> {
  const specs = getChecksForLanguage(language);
  const checks: ValidationCheck[] = [];
  let buildFailed = false;

  for (const spec of specs) {
    if (buildFailed) {
      checks.push({
        name: spec.name,
        command: `${spec.command} ${spec.args.join(' ')}`,
        status: 'skipped',
        output: 'Skipped due to build failure',
        duration: 0,
      });
      continue;
    }

    const result = await runCheck(repoPath, spec);
    checks.push(result);

    if (spec.critical && result.status === 'failed') {
      buildFailed = true;
    }
  }

  return {
    repoName,
    repoPath,
    checks,
    allPassed: checks.every((c) => c.status === 'passed'),
  };
}
