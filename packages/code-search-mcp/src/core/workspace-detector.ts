/**
 * Universal workspace detector — discovers packages in any monorepo structure.
 *
 * Uses a data-driven manifest registry: each ecosystem is a declarative entry
 * with pure-function extractors for name, dependencies, and workspace globs.
 * Adding a new ecosystem = adding one registry entry.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { WorkspacePackage, WorkspaceMap } from './types';

// ---------------------------------------------------------------------------
// Manifest descriptor — one per ecosystem/file type
// ---------------------------------------------------------------------------

interface ManifestDescriptor {
  /** Filename to look for (e.g., 'package.json') */
  filename: string;
  /** Ecosystem label */
  ecosystem: string;
  /** Extract the package name from file content. Return null if not a package. */
  extractName: (content: string, dirName: string) => string | null;
  /** Extract declared dependency names from file content. */
  extractDeps: (content: string) => string[];
  /** Extract workspace glob patterns from a ROOT-level manifest. Return null if not a workspace root. */
  extractWorkspaceGlobs?: (content: string) => string[] | null;
}

// ---------------------------------------------------------------------------
// Safe helpers
// ---------------------------------------------------------------------------

function safeRead(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }
}

function safeJsonParse(content: string): any | null {
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function safeDirEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Manifest registry — data-driven, each entry is self-contained
// ---------------------------------------------------------------------------

const MANIFEST_REGISTRY: ManifestDescriptor[] = [
  // ---- Node.js (npm / yarn / pnpm) ----
  {
    filename: 'package.json',
    ecosystem: 'node',
    extractName(content) {
      const pkg = safeJsonParse(content);
      return pkg?.name ?? null;
    },
    extractDeps(content) {
      const pkg = safeJsonParse(content);
      if (!pkg) return [];
      return [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ];
    },
    extractWorkspaceGlobs(content) {
      const pkg = safeJsonParse(content);
      if (!pkg) return null;
      // npm/yarn: "workspaces": ["packages/*"]
      if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
      // yarn alternative: "workspaces": { "packages": ["packages/*"] }
      if (Array.isArray(pkg.workspaces?.packages)) return pkg.workspaces.packages;
      return null;
    },
  },

  // ---- Rust (Cargo) ----
  {
    filename: 'Cargo.toml',
    ecosystem: 'rust',
    extractName(content) {
      const m = content.match(/\[package\][^[]*?name\s*=\s*"([^"]+)"/s);
      return m?.[1] ?? null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      // Match [dependencies] section entries: name = "version" or name = { ... }
      const depSection = content.match(/\[dependencies\]([\s\S]*?)(?=\n\[|$)/);
      if (depSection) {
        const entries = depSection[1].matchAll(/^(\w[\w-]*)\s*=/gm);
        for (const m of entries) deps.push(m[1]);
      }
      // Also [dev-dependencies]
      const devSection = content.match(/\[dev-dependencies\]([\s\S]*?)(?=\n\[|$)/);
      if (devSection) {
        const entries = devSection[1].matchAll(/^(\w[\w-]*)\s*=/gm);
        for (const m of entries) deps.push(m[1]);
      }
      return deps;
    },
    extractWorkspaceGlobs(content) {
      const ws = content.match(/\[workspace\][^[]*?members\s*=\s*\[([\s\S]*?)\]/);
      if (!ws) return null;
      const globs = [...ws[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
      return globs.length > 0 ? globs : null;
    },
  },

  // ---- Go ----
  {
    filename: 'go.mod',
    ecosystem: 'go',
    extractName(content) {
      const m = content.match(/^module\s+(\S+)/m);
      return m?.[1] ?? null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      // Single-line requires: require path v1.2.3
      const singles = content.matchAll(/^require\s+(\S+)\s+/gm);
      for (const m of singles) deps.push(m[1]);
      // Block requires
      const blocks = content.matchAll(/require\s*\(([\s\S]*?)\)/g);
      for (const block of blocks) {
        const entries = block[1].matchAll(/^\s*(\S+)\s+/gm);
        for (const m of entries) deps.push(m[1]);
      }
      return deps;
    },
    // go.mod doesn't declare workspaces — go.work does (handled separately)
  },

  // ---- Python (pyproject.toml) ----
  {
    filename: 'pyproject.toml',
    ecosystem: 'python',
    extractName(content) {
      const m = content.match(/\[project\][^[]*?name\s*=\s*"([^"]+)"/s);
      return m?.[1] ?? null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      const depSection = content.match(/\[project\][^[]*?dependencies\s*=\s*\[([\s\S]*?)\]/s);
      if (depSection) {
        // "requests>=2.0" → "requests"
        const entries = depSection[1].matchAll(/"([a-zA-Z0-9_-]+)[^"]*"/g);
        for (const m of entries) deps.push(m[1]);
      }
      return deps;
    },
  },

  // ---- Python (setup.py) ----
  {
    filename: 'setup.py',
    ecosystem: 'python',
    extractName(content) {
      const m = content.match(/name\s*=\s*['"]([^'"]+)['"]/);
      return m?.[1] ?? null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      const m = content.match(/install_requires\s*=\s*\[([\s\S]*?)\]/);
      if (m) {
        const entries = m[1].matchAll(/['"]([a-zA-Z0-9_-]+)[^'"]*['"]/g);
        for (const e of entries) deps.push(e[1]);
      }
      return deps;
    },
  },

  // ---- Java (Maven) ----
  {
    filename: 'pom.xml',
    ecosystem: 'java',
    extractName(content) {
      const group = content.match(/<groupId>([^<]+)<\/groupId>/);
      const artifact = content.match(/<artifactId>([^<]+)<\/artifactId>/);
      if (artifact) return group ? `${group[1]}:${artifact[1]}` : artifact[1];
      return null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      const depBlocks = content.matchAll(/<dependency>\s*([\s\S]*?)<\/dependency>/g);
      for (const block of depBlocks) {
        const g = block[1].match(/<groupId>([^<]+)<\/groupId>/);
        const a = block[1].match(/<artifactId>([^<]+)<\/artifactId>/);
        if (a) deps.push(g ? `${g[1]}:${a[1]}` : a[1]);
      }
      return deps;
    },
    extractWorkspaceGlobs(content) {
      const modules = [...content.matchAll(/<module>([^<]+)<\/module>/g)].map(m => m[1]);
      return modules.length > 0 ? modules : null;
    },
  },

  // ---- Java (Gradle) ----
  {
    filename: 'build.gradle',
    ecosystem: 'java',
    extractName(_content, dirName) {
      // Gradle convention: directory name is the project name
      return dirName || null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      // implementation 'group:artifact:version' or implementation "group:artifact:version"
      const entries = content.matchAll(/(?:implementation|api|compileOnly|runtimeOnly)\s+['"]([^'"]+)['"]/g);
      for (const m of entries) deps.push(m[1].replace(/:[^:]+$/, '')); // strip version
      return deps;
    },
  },

  // ---- .NET (C#/F#) ----
  {
    filename: '*.csproj',
    ecosystem: 'dotnet',
    extractName(content, dirName) {
      // .csproj often uses directory name or <AssemblyName>
      const m = content.match(/<AssemblyName>([^<]+)<\/AssemblyName>/);
      return m?.[1] ?? dirName ?? null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      const refs = content.matchAll(/<PackageReference\s+Include="([^"]+)"/g);
      for (const m of refs) deps.push(m[1]);
      const projRefs = content.matchAll(/<ProjectReference\s+Include="([^"]+)"/g);
      for (const m of projRefs) deps.push(m[1]);
      return deps;
    },
  },

  // ---- Elixir (Mix) ----
  {
    filename: 'mix.exs',
    ecosystem: 'elixir',
    extractName(content) {
      const m = content.match(/app:\s*:(\w+)/);
      return m?.[1] ?? null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      const entries = content.matchAll(/\{:(\w+),/g);
      for (const m of entries) deps.push(m[1]);
      return deps;
    },
  },

  // ---- PHP (Composer) ----
  {
    filename: 'composer.json',
    ecosystem: 'php',
    extractName(content) {
      const pkg = safeJsonParse(content);
      return pkg?.name ?? null;
    },
    extractDeps(content) {
      const pkg = safeJsonParse(content);
      if (!pkg) return [];
      return [
        ...Object.keys(pkg.require ?? {}),
        ...Object.keys(pkg['require-dev'] ?? {}),
      ];
    },
  },

  // ---- Swift (Package.swift) ----
  {
    filename: 'Package.swift',
    ecosystem: 'swift',
    extractName(content) {
      const m = content.match(/name:\s*"([^"]+)"/);
      return m?.[1] ?? null;
    },
    extractDeps(content) {
      const deps: string[] = [];
      const entries = content.matchAll(/\.package\s*\([^)]*url:\s*"([^"]+)"/g);
      for (const m of entries) {
        // Extract repo name from URL
        const name = m[1].replace(/\.git$/, '').split('/').pop();
        if (name) deps.push(name);
      }
      return deps;
    },
  },
];

// ---------------------------------------------------------------------------
// Workspace root config files (separate from per-package manifests)
// ---------------------------------------------------------------------------

interface WorkspaceRootDescriptor {
  filename: string;
  extractGlobs: (content: string) => string[] | null;
}

const WORKSPACE_ROOT_CONFIGS: WorkspaceRootDescriptor[] = [
  // pnpm-workspace.yaml
  {
    filename: 'pnpm-workspace.yaml',
    extractGlobs(content) {
      const lines = content.split('\n');
      const globs: string[] = [];
      let inPackages = false;
      for (const line of lines) {
        if (/^packages\s*:/.test(line)) {
          inPackages = true;
          continue;
        }
        if (inPackages) {
          const m = line.match(/^\s+-\s+['"]?([^'"#\s]+)['"]?/);
          if (m) {
            globs.push(m[1]);
          } else if (/^\S/.test(line)) {
            break; // next top-level key
          }
        }
      }
      return globs.length > 0 ? globs : null;
    },
  },
  // go.work
  {
    filename: 'go.work',
    extractGlobs(content) {
      const globs: string[] = [];
      // Single-line: use ./path
      const singles = content.matchAll(/^use\s+(\.\S+)/gm);
      for (const m of singles) globs.push(m[1]);
      // Block: use ( ... )
      const blocks = content.matchAll(/use\s*\(([\s\S]*?)\)/g);
      for (const block of blocks) {
        const entries = block[1].matchAll(/^\s*(\.\S+)/gm);
        for (const m of entries) globs.push(m[1]);
      }
      return globs.length > 0 ? globs : null;
    },
  },
  // lerna.json
  {
    filename: 'lerna.json',
    extractGlobs(content) {
      const parsed = safeJsonParse(content);
      if (Array.isArray(parsed?.packages)) return parsed.packages;
      return null;
    },
  },
  // settings.gradle (Gradle multi-project)
  {
    filename: 'settings.gradle',
    extractGlobs(content) {
      const includes = [...content.matchAll(/include\s+['"]([^'"]+)['"]/g)].map(m => m[1]);
      // Gradle uses ':subproject' notation → convert to path
      return includes.length > 0
        ? includes.map(i => i.replace(/^:/, '').replace(/:/g, '/'))
        : null;
    },
  },
  // settings.gradle.kts
  {
    filename: 'settings.gradle.kts',
    extractGlobs(content) {
      const includes = [...content.matchAll(/include\s*\(\s*"([^"]+)"\s*\)/g)].map(m => m[1]);
      return includes.length > 0
        ? includes.map(i => i.replace(/^:/, '').replace(/:/g, '/'))
        : null;
    },
  },
  // nx.json (Nx workspace — projects are auto-detected from package.json but can be explicit)
  {
    filename: 'nx.json',
    extractGlobs(content) {
      const parsed = safeJsonParse(content);
      if (!parsed) return null;
      // Nx typically uses workspaceLayout or auto-detection
      const layout = parsed.workspaceLayout;
      const globs: string[] = [];
      if (layout?.appsDir) globs.push(`${layout.appsDir}/*`);
      if (layout?.libsDir) globs.push(`${layout.libsDir}/*`);
      return globs.length > 0 ? globs : null;
    },
  },
];

// ---------------------------------------------------------------------------
// Glob expansion — handles simple patterns like 'packages/*', 'crates/**'
// ---------------------------------------------------------------------------

function expandGlobs(rootPath: string, globs: string[]): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();

  for (const glob of globs) {
    // Normalize: strip leading ./ and trailing /
    const cleaned = glob.replace(/^\.\//, '').replace(/\/+$/, '');

    if (cleaned.endsWith('/**')) {
      // Recursive: 'packages/**' → scan packages/ recursively for dirs with manifests
      const base = cleaned.slice(0, -3);
      const searchDir = join(rootPath, base);
      collectDirsRecursive(searchDir, dirs, seen, 3);
    } else if (cleaned.endsWith('/*')) {
      // Single level: 'packages/*' → list immediate children
      const base = cleaned.slice(0, -2);
      const searchDir = join(rootPath, base);
      for (const entry of safeDirEntries(searchDir)) {
        const full = join(searchDir, entry);
        if (isDir(full) && !seen.has(full)) {
          seen.add(full);
          dirs.push(full);
        }
      }
    } else {
      // Exact path: 'services/auth'
      const full = join(rootPath, cleaned);
      if (isDir(full) && !seen.has(full)) {
        seen.add(full);
        dirs.push(full);
      }
    }
  }

  return dirs;
}

function collectDirsRecursive(dir: string, result: string[], seen: Set<string>, maxDepth: number): void {
  if (maxDepth <= 0) return;
  for (const entry of safeDirEntries(dir)) {
    if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;
    const full = join(dir, entry);
    if (isDir(full) && !seen.has(full)) {
      seen.add(full);
      result.push(full);
      collectDirsRecursive(full, result, seen, maxDepth - 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest matching — find which descriptor applies to a directory
// ---------------------------------------------------------------------------

function findManifestInDir(dir: string): { descriptor: ManifestDescriptor; content: string; filename: string } | null {
  const dirName = dir.split('/').pop() ?? '';
  const entries = new Set(safeDirEntries(dir));

  for (const desc of MANIFEST_REGISTRY) {
    // Handle glob filenames like '*.csproj'
    if (desc.filename.startsWith('*')) {
      const ext = desc.filename.slice(1); // '.csproj'
      const match = [...entries].find(e => e.endsWith(ext));
      if (match) {
        const content = safeRead(join(dir, match));
        if (content) return { descriptor: desc, content, filename: match };
      }
    } else if (entries.has(desc.filename)) {
      const content = safeRead(join(dir, desc.filename));
      if (content) {
        const name = desc.extractName(content, dirName);
        if (name) return { descriptor: desc, content, filename: desc.filename };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// tsconfig path alias detection
// ---------------------------------------------------------------------------

export function detectTsconfigAliases(repoPath: string): Map<string, string> {
  const aliases = new Map<string, string>();

  for (const filename of ['tsconfig.json', 'tsconfig.base.json']) {
    const content = safeRead(join(repoPath, filename));
    if (!content) continue;

    const config = safeJsonParse(content);
    if (!config?.compilerOptions?.paths) continue;

    const baseUrl = config.compilerOptions.baseUrl ?? '.';
    const paths: Record<string, string[]> = config.compilerOptions.paths;

    for (const [alias, targets] of Object.entries(paths)) {
      if (!Array.isArray(targets) || targets.length === 0) continue;
      // '@ui-kit/*' → '@ui-kit', 'packages/ui-kit/src/*' → 'packages/ui-kit/src'
      const cleanAlias = alias.replace(/\/\*$/, '');
      const target = targets[0].replace(/\/\*$/, '');
      const resolved = relative(repoPath, resolve(repoPath, baseUrl, target));
      aliases.set(cleanAlias, resolved);
    }
  }

  return aliases;
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export function detectWorkspace(repoPath: string): WorkspaceMap {
  const packages: WorkspacePackage[] = [];
  const nameToPackage = new Map<string, WorkspacePackage>();
  const discoveredDirs = new Set<string>();

  // Step 1: Collect workspace glob patterns from all root config files
  const allGlobs: string[] = [];

  // Check dedicated workspace root configs (pnpm-workspace.yaml, go.work, etc.)
  for (const rootConfig of WORKSPACE_ROOT_CONFIGS) {
    const content = safeRead(join(repoPath, rootConfig.filename));
    if (!content) continue;
    const globs = rootConfig.extractGlobs(content);
    if (globs) allGlobs.push(...globs);
  }

  // Check manifests that can also declare workspaces (package.json, Cargo.toml, pom.xml)
  for (const desc of MANIFEST_REGISTRY) {
    if (!desc.extractWorkspaceGlobs) continue;
    // Skip glob filenames for root check
    if (desc.filename.startsWith('*')) continue;
    const content = safeRead(join(repoPath, desc.filename));
    if (!content) continue;
    const globs = desc.extractWorkspaceGlobs(content);
    if (globs) allGlobs.push(...globs);
  }

  // Step 2: Expand globs to directories
  if (allGlobs.length > 0) {
    const expanded = expandGlobs(repoPath, allGlobs);
    for (const dir of expanded) discoveredDirs.add(dir);
  }

  // Step 3: Fallback — if no workspace config found, scan for manifests up to depth 3
  if (discoveredDirs.size === 0) {
    const fallbackDirs: string[] = [];
    collectDirsRecursive(repoPath, fallbackDirs, new Set(), 3);
    for (const dir of fallbackDirs) {
      if (findManifestInDir(dir)) discoveredDirs.add(dir);
    }
  }

  // Step 4: Parse each discovered directory's manifest
  for (const dir of discoveredDirs) {
    const found = findManifestInDir(dir);
    if (!found) continue;

    const { descriptor, content, filename } = found;
    const dirName = dir.split('/').pop() ?? '';
    const name = descriptor.extractName(content, dirName);
    if (!name) continue;

    const pkg: WorkspacePackage = {
      name,
      path: dir,
      relativePath: relative(repoPath, dir),
      ecosystem: descriptor.ecosystem,
      manifestFile: filename,
      dependencies: descriptor.extractDeps(content),
    };

    packages.push(pkg);
    nameToPackage.set(name, pkg);
  }

  // Step 5: Also register the root package (if it has a manifest with a name)
  const rootManifest = findManifestInDir(repoPath);
  if (rootManifest) {
    const { descriptor, content, filename } = rootManifest;
    const name = descriptor.extractName(content, repoPath.split('/').pop() ?? '');
    if (name && !nameToPackage.has(name)) {
      const pkg: WorkspacePackage = {
        name,
        path: repoPath,
        relativePath: '.',
        ecosystem: descriptor.ecosystem,
        manifestFile: filename,
        dependencies: descriptor.extractDeps(content),
      };
      packages.push(pkg);
      nameToPackage.set(name, pkg);
    }
  }

  // Step 6: Detect tsconfig path aliases
  const pathAliases = detectTsconfigAliases(repoPath);

  return { repoPath, packages, nameToPackage, pathAliases };
}
