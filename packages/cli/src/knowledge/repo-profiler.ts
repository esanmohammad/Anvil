/**
 * Autonomous Repo Profiler (WS-1)
 *
 * Given a list of repos with zero manual config, reads signal-dense
 * "fingerprint" files and sends them to an LLM for structured profiling.
 * Each repo gets a RepoProfile describing its role, domain, tech stack,
 * exposed/consumed endpoints, and entry points.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { runLLM } from './claude-runner.js';
import type { RepoProfile } from './types.js';
import { getKnowledgeBasePath } from './config.js';

// ---------------------------------------------------------------------------
// Types (internal)
// ---------------------------------------------------------------------------

interface FingerprintFile {
  relativePath: string;
  content: string;
}

export interface RepoFingerprint {
  repoPath: string;
  repoName: string;
  files: FingerprintFile[];
  totalChars: number;
  fingerprintHash: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_FINGERPRINT_CHARS = 6000;
const MAX_CONCURRENT = 3;
const PROFILE_FILENAME = 'profile.json';

const PROFILER_SYSTEM_PROMPT = `You are a senior software architect analyzing a repository to understand its role in a larger system.

Given the fingerprint files below, produce a structured JSON profile.

Rules:
- Infer the repo's role from its code, not just its name
- For "domain", group by business function (e.g., "email-delivery", "billing", "user-management", "infrastructure")
- For "exposes", list what this repo provides: HTTP endpoints, Kafka topics it produces, gRPC services, etc.
- For "consumes", list what this repo depends on: Kafka topics it subscribes to, HTTP services it calls, databases it reads
- Be specific with identifiers: use actual topic names, endpoint paths, table names from the code
- If you can't determine something, use "unknown" -- don't guess

Respond with ONLY valid JSON matching this schema (no markdown fences):
{
  "name": "string",
  "role": "service | library | cli | worker | gateway | ui | schema | config | monorepo | unknown",
  "domain": "string",
  "description": "string (1-2 sentences)",
  "technologies": ["string"],
  "exposes": [{ "type": "http | grpc | kafka-producer | kafka-consumer | database | redis | s3 | websocket | cron | other", "identifier": "string", "description": "string" }],
  "consumes": [{ "type": "http | grpc | kafka-producer | kafka-consumer | database | redis | s3 | websocket | cron | other", "identifier": "string", "description": "string" }],
  "entryPoints": ["string"]
}`;

// ---------------------------------------------------------------------------
// File reading helpers
// ---------------------------------------------------------------------------

/** Safely read a file, returning null if missing or unreadable */
function safeReadFile(path: string, maxChars?: number): string | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    return maxChars ? content.slice(0, maxChars) : content;
  } catch {
    return null;
  }
}

/** Safely read first N lines of a file */
function safeReadLines(path: string, maxLines: number): string | null {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8');
    return content.split('\n').slice(0, maxLines).join('\n');
  } catch {
    return null;
  }
}

/** Find the first existing file from a list of candidates */
function findFirst(repoPath: string, candidates: string[]): string | null {
  for (const c of candidates) {
    const full = join(repoPath, c);
    if (existsSync(full)) return c;
  }
  return null;
}

/** Find first matching glob-like pattern in a directory */
function findFirstGlob(repoPath: string, dir: string, ext: string): string | null {
  const dirPath = join(repoPath, dir);
  try {
    if (!existsSync(dirPath)) return null;
    const entries = readdirSync(dirPath);
    const match = entries.find((e) => e.endsWith(ext));
    return match ? join(dir, match) : null;
  } catch {
    return null;
  }
}

/** Strip version numbers from package.json dependencies, keeping only names */
function extractPackageJsonEssentials(raw: string): string {
  try {
    const pkg = JSON.parse(raw);
    const essentials: Record<string, unknown> = {};
    for (const key of ['name', 'description', 'scripts', 'dependencies', 'devDependencies', 'peerDependencies']) {
      if (!(key in pkg)) continue;
      if (key === 'scripts') {
        essentials[key] = pkg[key];
      } else if (typeof pkg[key] === 'object' && pkg[key] !== null && key !== 'name' && key !== 'description') {
        // For dependency maps, keep only the keys (package names)
        essentials[key] = Object.keys(pkg[key]);
      } else {
        essentials[key] = pkg[key];
      }
    }
    return JSON.stringify(essentials, null, 2);
  } catch {
    return raw;
  }
}

/** Extract module path + require block from go.mod */
function extractGoModEssentials(raw: string): string {
  const lines = raw.split('\n');
  const result: string[] = [];
  let inRequire = false;
  for (const line of lines) {
    if (line.startsWith('module ')) {
      result.push(line);
    } else if (line.startsWith('require')) {
      inRequire = true;
      result.push(line);
    } else if (inRequire) {
      result.push(line);
      if (line.trim() === ')') inRequire = false;
    }
  }
  return result.join('\n');
}

// ---------------------------------------------------------------------------
// Fingerprint extraction
// ---------------------------------------------------------------------------

/**
 * Extract signal-dense "fingerprint" files from a repo.
 * Reads only the files most useful for understanding what the repo does,
 * capped to ~6000 chars total. Fast — just file reads, no LLM.
 */
export async function extractFingerprint(repoPath: string): Promise<RepoFingerprint> {
  const repoName = basename(repoPath);
  const files: FingerprintFile[] = [];
  let totalChars = 0;

  function addFile(relativePath: string, content: string): boolean {
    if (totalChars + content.length > MAX_FINGERPRINT_CHARS) {
      // Try to fit a truncated version
      const remaining = MAX_FINGERPRINT_CHARS - totalChars;
      if (remaining > 200) {
        files.push({ relativePath, content: content.slice(0, remaining) });
        totalChars += remaining;
      }
      return false; // budget exhausted
    }
    files.push({ relativePath, content });
    totalChars += content.length;
    return true;
  }

  // 1. README.md — first 2000 chars
  const readme = safeReadFile(join(repoPath, 'README.md'), 2000);
  if (readme) addFile('README.md', readme);

  // 2. Dockerfile or docker-compose.yml — first 1500 chars
  const dockerFile = findFirst(repoPath, ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml']);
  if (dockerFile) {
    const content = safeReadFile(join(repoPath, dockerFile), 1500);
    if (content) addFile(dockerFile, content);
  }

  // 3. Main entry point detection — first 100 lines
  const entryPointCandidates = [
    'main.go',
    'src/index.ts',
    'src/main.ts',
    'src/index.js',
    'app.py',
    'main.py',
    'index.ts',
    'index.js',
  ];
  // Also check cmd/*/main.go
  const cmdMainGo = findFirstGlob(repoPath, 'cmd', 'main.go');
  if (cmdMainGo) entryPointCandidates.unshift(cmdMainGo);
  // Check src/main/java/**/Application.java — simplified to first level
  const javaApp = findFirstGlob(repoPath, 'src/main/java', 'Application.java');
  if (javaApp) entryPointCandidates.push(javaApp);

  const entryPoint = findFirst(repoPath, entryPointCandidates);
  if (entryPoint && totalChars < MAX_FINGERPRINT_CHARS) {
    const content = safeReadLines(join(repoPath, entryPoint), 100);
    if (content) addFile(entryPoint, content);
  }

  // 4. Package manifest
  if (totalChars < MAX_FINGERPRINT_CHARS) {
    const manifestFile = findFirst(repoPath, ['package.json', 'go.mod', 'pyproject.toml', 'Cargo.toml', 'pom.xml']);
    if (manifestFile) {
      const raw = safeReadFile(join(repoPath, manifestFile));
      if (raw) {
        let content = raw;
        if (manifestFile === 'package.json') {
          content = extractPackageJsonEssentials(raw);
        } else if (manifestFile === 'go.mod') {
          content = extractGoModEssentials(raw);
        }
        addFile(manifestFile, content);
      }
    }
  }

  // 5. CI config — first workflow file, first 1000 chars
  if (totalChars < MAX_FINGERPRINT_CHARS) {
    const ciFile = findFirstGlob(repoPath, '.github/workflows', '.yml')
      ?? findFirstGlob(repoPath, '.github/workflows', '.yaml');
    if (ciFile) {
      const content = safeReadFile(join(repoPath, ciFile), 1000);
      if (content) addFile(ciFile, content);
    }
  }

  // 6. API schemas
  if (totalChars < MAX_FINGERPRINT_CHARS) {
    const apiSchema = findFirst(repoPath, ['openapi.yaml', 'openapi.json', 'asyncapi.yaml']);
    if (apiSchema) {
      const content = safeReadFile(join(repoPath, apiSchema), 1500);
      if (content) addFile(apiSchema, content);
    }
    // Also check for .proto files
    if (!apiSchema) {
      const protoFile = findFirstGlob(repoPath, 'proto', '.proto')
        ?? findFirstGlob(repoPath, '.', '.proto');
      if (protoFile) {
        const content = safeReadFile(join(repoPath, protoFile), 1500);
        if (content) addFile(protoFile, content);
      }
    }
  }

  // 7. Kubernetes / deploy manifests — first found, first 500 chars
  if (totalChars < MAX_FINGERPRINT_CHARS) {
    const k8sFile = findFirstGlob(repoPath, 'k8s', '.yaml')
      ?? findFirstGlob(repoPath, 'k8s', '.yml')
      ?? findFirstGlob(repoPath, 'deploy', '.yaml')
      ?? findFirstGlob(repoPath, 'deploy', '.yml');
    if (k8sFile) {
      const content = safeReadFile(join(repoPath, k8sFile), 500);
      if (content) addFile(k8sFile, content);
    }
  }

  // Compute fingerprint hash from concatenated content
  const hash = createHash('sha256');
  for (const f of files) {
    hash.update(f.relativePath);
    hash.update(f.content);
  }
  const fingerprintHash = hash.digest('hex');

  return {
    repoPath,
    repoName,
    files,
    totalChars,
    fingerprintHash,
  };
}

// ---------------------------------------------------------------------------
// LLM profiling
// ---------------------------------------------------------------------------

/** Build the user message from fingerprint files */
function buildFingerprintText(fingerprint: RepoFingerprint): string {
  const sections = fingerprint.files.map(
    (f) => `### ${f.relativePath}\n\n${f.content}`,
  );
  return `Repository: ${fingerprint.repoName}\n\n${sections.join('\n\n---\n\n')}`;
}

/** Parse LLM response, handling markdown fences and partial JSON */
function parseLLMJson(raw: string): Record<string, unknown> {
  let text = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    text = fenceMatch[1].trim();
  }

  // Try direct parse first
  try {
    return JSON.parse(text);
  } catch {
    // Attempt to extract JSON object from surrounding text
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart !== -1 && jsonEnd > jsonStart) {
      try {
        return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
      } catch {
        throw new Error(`Failed to parse LLM response as JSON: ${text.slice(0, 200)}...`);
      }
    }
    throw new Error(`No JSON object found in LLM response: ${text.slice(0, 200)}...`);
  }
}

/**
 * Send a repo fingerprint to an LLM and get a structured RepoProfile back.
 */
export async function profileRepo(
  fingerprint: RepoFingerprint,
  opts?: { model?: string; provider?: 'claude' | 'gemini' },
): Promise<RepoProfile> {
  const model = opts?.model ?? 'claude-sonnet-4-6';

  const fingerprintText = buildFingerprintText(fingerprint);

  const result = await runLLM(
    fingerprintText,
    PROFILER_SYSTEM_PROMPT,
    { model, provider: opts?.provider, timeoutMs: 600_000 },
  );

  const parsed = parseLLMJson(result.result);

  // Build the full RepoProfile with metadata
  const profile: RepoProfile = {
    name: (parsed.name as string) ?? fingerprint.repoName,
    role: (parsed.role as RepoProfile['role']) ?? 'unknown',
    domain: (parsed.domain as string) ?? 'unknown',
    description: (parsed.description as string) ?? '',
    technologies: (parsed.technologies as string[]) ?? [],
    exposes: (parsed.exposes as RepoProfile['exposes']) ?? [],
    consumes: (parsed.consumes as RepoProfile['consumes']) ?? [],
    entryPoints: (parsed.entryPoints as string[]) ?? [],
    profiledAt: new Date().toISOString(),
    profiledBy: model,
    fingerprintHash: fingerprint.fingerprintHash,
  };

  return profile;
}

// ---------------------------------------------------------------------------
// Batch profiling
// ---------------------------------------------------------------------------

/**
 * Profile all repos in a project. Features:
 * - Caching: skips repos whose fingerprint hash hasn't changed
 * - Parallel: up to 3 concurrent profiling calls
 * - Progress: reports via onProgress callback
 * - Error handling: continues if one repo fails
 * - Storage: saves each profile to {kbPath}/{repoName}/profile.json
 */
export async function profileProject(
  project: string,
  repos: Array<{ name: string; path: string }>,
  opts?: {
    model?: string;
    provider?: 'claude' | 'gemini';
    force?: boolean;
    onProgress?: (msg: string) => void;
  },
): Promise<RepoProfile[]> {
  const progress = opts?.onProgress ?? (() => {});
  const kbPath = getKnowledgeBasePath(project);
  const profiles: RepoProfile[] = [];
  const errors: Array<{ name: string; error: string }> = [];

  progress(`Profiling ${repos.length} repos...`);

  // Extract all fingerprints first (fast, no LLM)
  const fingerprints = await Promise.all(
    repos.map(async (repo) => {
      try {
        const fp = await extractFingerprint(repo.path);
        return { repo, fingerprint: fp };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push({ name: repo.name, error: msg });
        progress(`  [WARN] Failed to extract fingerprint for ${repo.name}: ${msg}`);
        return null;
      }
    }),
  );

  const validFingerprints = fingerprints.filter(
    (f): f is NonNullable<typeof f> => f !== null,
  );

  // Check cache and filter repos that need profiling
  const needsProfiling: typeof validFingerprints = [];

  for (const item of validFingerprints) {
    if (opts?.force) {
      needsProfiling.push(item);
      continue;
    }

    const cached = loadCachedProfile(kbPath, item.repo.name);
    if (cached && cached.fingerprintHash === item.fingerprint.fingerprintHash) {
      progress(`  [CACHED] ${item.repo.name} (fingerprint unchanged)`);
      profiles.push(cached);
    } else {
      needsProfiling.push(item);
    }
  }

  if (needsProfiling.length === 0) {
    progress('All repos cached, no profiling needed.');
    return profiles;
  }

  progress(`Profiling ${needsProfiling.length} repos (${validFingerprints.length - needsProfiling.length} cached)...`);

  // Profile in batches of MAX_CONCURRENT
  for (let i = 0; i < needsProfiling.length; i += MAX_CONCURRENT) {
    const batch = needsProfiling.slice(i, i + MAX_CONCURRENT);
    const batchResults = await Promise.allSettled(
      batch.map(async (item) => {
        progress(`  [PROFILING] ${item.repo.name} (${item.fingerprint.files.length} files, ${item.fingerprint.totalChars} chars)`);
        const profile = await profileRepo(item.fingerprint, { model: opts?.model, provider: opts?.provider });
        return { repo: item.repo, profile };
      }),
    );

    for (const result of batchResults) {
      if (result.status === 'fulfilled') {
        const { repo, profile } = result.value;
        profiles.push(profile);

        // Persist to disk
        saveProfileToDisk(kbPath, repo.name, profile);
        progress(`  [DONE] ${repo.name} -> ${profile.role} (${profile.domain})`);
      } else {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        // Try to find which repo this was for
        const batchIndex = batchResults.indexOf(result);
        const repoName = batch[batchIndex]?.repo.name ?? 'unknown';
        errors.push({ name: repoName, error: reason });
        progress(`  [WARN] Failed to profile ${repoName}: ${reason}`);
      }
    }
  }

  if (errors.length > 0) {
    progress(`Completed with ${errors.length} error(s): ${errors.map((e) => e.name).join(', ')}`);
  }

  return profiles;
}

// ---------------------------------------------------------------------------
// Cache / persistence
// ---------------------------------------------------------------------------

/** Load a cached profile from the KB directory */
function loadCachedProfile(kbPath: string, repoName: string): RepoProfile | null {
  const profilePath = join(kbPath, repoName, PROFILE_FILENAME);
  try {
    if (!existsSync(profilePath)) return null;
    const raw = readFileSync(profilePath, 'utf-8');
    return JSON.parse(raw) as RepoProfile;
  } catch {
    return null;
  }
}

/** Save a profile to disk under {kbPath}/{repoName}/profile.json */
function saveProfileToDisk(kbPath: string, repoName: string, profile: RepoProfile): void {
  const repoDir = join(kbPath, repoName);
  mkdirSync(repoDir, { recursive: true });
  const profilePath = join(repoDir, PROFILE_FILENAME);
  writeFileSync(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
}

/**
 * Load a cached profile for a single repo.
 * Returns null if no cached profile exists.
 */
export function loadProfile(project: string, repoName: string): RepoProfile | null {
  const kbPath = getKnowledgeBasePath(project);
  const profilePath = join(kbPath, repoName, PROFILE_FILENAME);
  try {
    if (!existsSync(profilePath)) return null;
    const raw = readFileSync(profilePath, 'utf-8');
    return JSON.parse(raw) as RepoProfile;
  } catch {
    return null;
  }
}

/**
 * Load all cached profiles for a project.
 * Scans the project's knowledge base directory for profile.json files.
 */
export function loadAllProfiles(project: string): RepoProfile[] {
  const kbPath = getKnowledgeBasePath(project);
  const profiles: RepoProfile[] = [];

  try {
    if (!existsSync(kbPath)) return profiles;
    const entries = readdirSync(kbPath, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profilePath = join(kbPath, entry.name, PROFILE_FILENAME);
      try {
        if (!existsSync(profilePath)) continue;
        const raw = readFileSync(profilePath, 'utf-8');
        const profile = JSON.parse(raw) as RepoProfile;
        profiles.push(profile);
      } catch {
        // Skip malformed profile files
      }
    }
  } catch {
    // KB directory doesn't exist or isn't readable
  }

  return profiles;
}
