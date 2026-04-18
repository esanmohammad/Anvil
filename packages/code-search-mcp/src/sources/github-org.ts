/**
 * GitHub Organization source — clone/update repos from a GitHub org.
 *
 * Uses `gh` CLI (preferred) or GitHub API as fallback.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

interface OrgRepo {
  name: string;
  cloneUrl: string;
  language: string;
}

/**
 * Clone or update repos from a GitHub organization.
 *
 * @param org - GitHub org name (e.g., "space-company-com")
 * @param opts.pattern - Glob filter (e.g., "mta-*")
 * @param opts.token - GitHub token (or uses GITHUB_TOKEN env)
 * @param opts.workspacePath - Where to clone (default: ~/.code-search/{org}/)
 * @param opts.maxRepos - Limit number of repos
 */
export async function cloneOrUpdateOrg(
  org: string,
  opts?: {
    pattern?: string;
    token?: string;
    workspacePath?: string;
    maxRepos?: number;
    onProgress?: (msg: string) => void;
  },
): Promise<Array<{ name: string; path: string; language: string }>> {
  const log = opts?.onProgress ?? ((m: string) => console.error(`[github] ${m}`));
  const token = opts?.token ?? process.env.GITHUB_TOKEN;
  const workspacePath = opts?.workspacePath ?? join(homedir(), '.code-search', org);
  const maxRepos = opts?.maxRepos ?? 500;

  mkdirSync(workspacePath, { recursive: true });

  // List repos from org
  log(`Fetching repos from github:${org}...`);
  let orgRepos: OrgRepo[];

  try {
    orgRepos = listReposViaGhCli(org, maxRepos);
    log(`Found ${orgRepos.length} repos via gh CLI`);
  } catch {
    if (!token) {
      throw new Error('gh CLI not available and no GITHUB_TOKEN set. Install gh CLI or set GITHUB_TOKEN.');
    }
    orgRepos = await listReposViaApi(org, token, maxRepos);
    log(`Found ${orgRepos.length} repos via GitHub API`);
  }

  // Filter by pattern
  if (opts?.pattern) {
    const pattern = opts.pattern.replace(/\*/g, '.*');
    const re = new RegExp(`^${pattern}$`, 'i');
    orgRepos = orgRepos.filter(r => re.test(r.name));
    log(`Filtered to ${orgRepos.length} repos matching "${opts.pattern}"`);
  }

  // Clone or update
  const results: Array<{ name: string; path: string; language: string }> = [];

  for (let i = 0; i < orgRepos.length; i++) {
    const repo = orgRepos[i];
    const repoPath = join(workspacePath, repo.name);

    if (existsSync(join(repoPath, '.git'))) {
      // Update
      try {
        execSync('git pull --ff-only --quiet', {
          cwd: repoPath, stdio: 'pipe', timeout: 30_000,
        });
        log(`  [${i + 1}/${orgRepos.length}] Updated ${repo.name}`);
      } catch {
        log(`  [${i + 1}/${orgRepos.length}] ${repo.name} — pull failed (skipping)`);
      }
    } else {
      // Clone (shallow)
      try {
        // Security: inject token via http.extraHeader instead of embedding in URL
        // (token in URL is visible in process list via `ps aux`)
        const cloneCmd = token
          ? `git -c "http.extraHeader=Authorization: Bearer ${token}" clone --depth 1 --quiet "${repo.cloneUrl}" "${repoPath}"`
          : `git clone --depth 1 --quiet "${repo.cloneUrl}" "${repoPath}"`;
        execSync(cloneCmd, {
          stdio: 'pipe', timeout: 120_000,
        });
        log(`  [${i + 1}/${orgRepos.length}] Cloned ${repo.name}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`  [${i + 1}/${orgRepos.length}] ${repo.name} — clone failed: ${msg.slice(0, 80)}`);
        continue;
      }
    }

    results.push({
      name: repo.name,
      path: repoPath,
      language: repo.language || 'unknown',
    });
  }

  log(`Ready: ${results.length} repos in ${workspacePath}`);
  return results;
}

function listReposViaGhCli(org: string, limit: number): OrgRepo[] {
  const output = execSync(
    `gh repo list "${org}" --json name,url,primaryLanguage --limit ${limit} --no-archived`,
    { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30_000 },
  );
  const repos = JSON.parse(output);
  return repos.map((r: any) => ({
    name: r.name,
    cloneUrl: r.url.endsWith('.git') ? r.url : `${r.url}.git`,
    language: (r.primaryLanguage?.name ?? '').toLowerCase(),
  }));
}

async function listReposViaApi(org: string, token: string, limit: number): Promise<OrgRepo[]> {
  const allRepos: OrgRepo[] = [];
  let page = 1;

  while (allRepos.length < limit) {
    const url = `https://api.github.com/orgs/${org}/repos?per_page=100&page=${page}&type=sources`;
    const res = await fetch(url, {
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
    });

    if (!res.ok) {
      throw new Error(`GitHub API error: ${res.status} ${res.statusText}`);
    }

    const repos = await res.json() as any[];
    if (repos.length === 0) break;

    for (const r of repos) {
      if (r.archived) continue;
      allRepos.push({
        name: r.name,
        cloneUrl: r.clone_url,
        language: (r.language ?? '').toLowerCase(),
      });
    }

    page++;
  }

  return allRepos.slice(0, limit);
}
