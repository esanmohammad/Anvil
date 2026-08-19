import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { CrossRepoEdge, WorkspaceMap } from '@esankhan3/anvil-knowledge-core';
import { detectWorkspace } from './workspace-detector.js';

/**
 * Cross-repo edge detection, split into two phases (extract → correlate):
 *
 * - `extractCrossRepoSignals(repoPath)` scans ONE repo's working tree and
 *   returns a small, JSON-serializable signal bundle. It runs inside the
 *   per-repo pipeline (worker thread) while the tree exists — in the
 *   bounded-scratch writer the clone is DISCARDED right after, so this is
 *   the only moment the tree is available. The bundle is persisted as
 *   `<repo>/signals.json` through the blob port.
 * - `correlateCrossRepoEdges(signals, workspaceMaps)` joins the persisted
 *   bundles across repos — pure data, no filesystem. A partial cycle
 *   correlates fresh signals from re-indexed repos with stored signals from
 *   unchanged ones, so edges stay complete without cloning the whole org.
 *
 * `detectCrossRepoEdges(repos, workspaceMaps)` remains as the tree-based
 * wrapper (extract every repo in place, then correlate) for callers that
 * have all working trees locally.
 */

/** Per-repo, JSON-serializable inputs to the 14 correlation strategies. */
export interface CrossRepoSignals {
  /** Scoped (@org/…) npm deps from package.json (shared-npm-deps). */
  npmDeps?: string[];
  /** Exported TS interface/type names → defining file (shared-types). */
  types?: Record<string, string>;
  /** Env var names from .env.example/.template/.sample (env-var-correlation). */
  envVars?: string[];
  /** Event/topic/channel names → file (event-schemas). */
  events?: Record<string, string>;
  /** Route definitions path → file (api-endpoints). */
  apiRoutes?: Record<string, string>;
  /** HTTP client call paths → file (api-endpoints). */
  apiClients?: Record<string, string>;
  /** gRPC service definitions service → .proto file (grpc-services). */
  grpcDefs?: Record<string, string>;
  /** gRPC client usages service → file (grpc-services). */
  grpcClients?: Record<string, string>;
  /** DB table names → file (database-schemas). */
  dbTables?: Record<string, string>;
  /** Redis key prefixes → file (redis-key-patterns). */
  redisPrefixes?: Record<string, string>;
  /** S3/GCS bucket names → file (s3-buckets). */
  buckets?: Record<string, string>;
  /** OpenAPI spec endpoint paths → spec file (openapi-schemas). */
  apiSpecPaths?: Record<string, string>;
  /** HTTP client call paths → file, openapi variant (openapi-schemas). */
  httpCalls?: Record<string, string>;
  /** docker-compose depends_on/links service refs (docker-compose-links). */
  composeRefs?: Array<{ file: string; service: string; evidence: string }>;
  /** K8s service references from manifests (k8s-service-refs). */
  k8sRefs?: Array<{ file: string; service: string; evidence: string }>;
  /** Interesting exported string constants value → {name, file} (shared-constants). */
  constants?: Record<string, { name: string; filePath: string }>;
}

/** Recursively find files matching a predicate, skipping common non-source dirs */
function walkFiles(
  dir: string,
  match: (filePath: string) => boolean,
  maxFiles: number = 5000,
): string[] {
  const results: string[] = [];
  const skipDirs = new Set(['node_modules', 'dist', '.git', '.next', 'build', 'coverage', '__pycache__', '.venv', 'vendor']);

  function walk(currentDir: string): void {
    if (results.length >= maxFiles) return;
    let entries: string[];
    try {
      entries = readdirSync(currentDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxFiles) return;
      if (skipDirs.has(entry)) continue;
      const fullPath = join(currentDir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walk(fullPath);
        } else if (stat.isFile() && match(fullPath)) {
          results.push(fullPath);
        }
      } catch {
        // Skip inaccessible files
      }
    }
  }

  walk(dir);
  return results;
}

/** Read file contents safely, returning empty string on failure */
function safeReadFile(filePath: string): string {
  try {
    return readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// EXTRACT — one repo's tree → serializable signals
// ---------------------------------------------------------------------------

function extractNpmDeps(repoPath: string): string[] {
  const content = safeReadFile(join(repoPath, 'package.json'));
  if (!content) return [];
  try {
    const pkg = JSON.parse(content);
    const allDeps = new Set<string>([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.peerDependencies ?? {}),
    ]);
    // Filter to scoped/workspace packages (likely internal)
    return [...allDeps].filter((d) => d.startsWith('@'));
  } catch {
    return []; // Malformed package.json
  }
}

function extractTypes(repoPath: string): Record<string, string> {
  const typeExportPattern = /export\s+(?:interface|type)\s+(\w+)/g;
  const tsFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ext === '.ts' || ext === '.d.ts';
  }, 2000);

  const typeMap: Record<string, string> = {};
  for (const filePath of tsFiles) {
    const content = safeReadFile(filePath);
    let match: RegExpExecArray | null;
    typeExportPattern.lastIndex = 0;
    while ((match = typeExportPattern.exec(content)) !== null) {
      const typeName = match[1];
      if (!(typeName in typeMap)) typeMap[typeName] = filePath;
    }
  }
  return typeMap;
}

function extractEnvVars(repoPath: string): string[] {
  const envFileNames = ['.env.example', '.env.template', '.env.sample'];
  const envVarPattern = /^([A-Z][A-Z0-9_]{2,})=/gm;
  const vars = new Set<string>();
  for (const envFile of envFileNames) {
    const content = safeReadFile(join(repoPath, envFile));
    if (!content) continue;
    let match: RegExpExecArray | null;
    envVarPattern.lastIndex = 0;
    while ((match = envVarPattern.exec(content)) !== null) {
      vars.add(match[1]);
    }
  }
  return [...vars];
}

function extractEvents(repoPath: string): Record<string, string> {
  // Match patterns like: TOPIC = 'user.created', channel: 'orders', event: 'payment_completed'
  const eventPatterns = [
    /(?:topic|TOPIC|channel|CHANNEL|event|EVENT)\s*[:=]\s*['"`]([a-zA-Z0-9._-]+)['"`]/g,
    /(?:subscribe|publish|emit|on)\s*\(\s*['"`]([a-zA-Z0-9._-]+)['"`]/g,
  ];
  const sourceFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ['.ts', '.js', '.py', '.go', '.java'].includes(ext);
  }, 3000);

  const eventMap: Record<string, string> = {};
  for (const filePath of sourceFiles) {
    const content = safeReadFile(filePath);
    for (const pattern of eventPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const eventName = match[1];
        // Filter out overly generic names
        if (eventName.length > 3 && eventName.includes('.') && !(eventName in eventMap)) {
          eventMap[eventName] = filePath;
        }
      }
    }
  }
  return eventMap;
}

function extractApiEndpoints(repoPath: string): { routes: Record<string, string>; clients: Record<string, string> } {
  // Route definition patterns
  const routeDefPatterns = [
    /(?:app|router)\.(get|post|put|patch|delete)\s*\(\s*['"`](\/[a-zA-Z0-9/:._-]+)['"`]/g,
    /@(Get|Post|Put|Patch|Delete)\s*\(\s*['"`](\/[a-zA-Z0-9/:._-]+)['"`]/g,
  ];
  // HTTP client call patterns
  const httpCallPatterns = [
    /(?:axios|fetch|http|client)\.(get|post|put|patch|delete)\s*\(\s*[`'"](?:https?:\/\/[^/]*?)?(\/[a-zA-Z0-9/:._-]+)['"`]/g,
    /fetch\s*\(\s*[`'"](?:https?:\/\/[^/]*?)?(\/[a-zA-Z0-9/:._-]+)['"`]/g,
  ];

  const sourceFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ['.ts', '.js'].includes(ext);
  }, 3000);

  const routes: Record<string, string> = {};
  const clients: Record<string, string> = {};

  for (const filePath of sourceFiles) {
    const content = safeReadFile(filePath);

    for (const pattern of routeDefPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        // Normalize path: strip params to base pattern
        const routePath = match[2].replace(/:[a-zA-Z]+/g, ':param');
        if (!(routePath in routes)) routes[routePath] = filePath;
      }
    }

    for (const pattern of httpCallPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const clientPath = match[2].replace(/:[a-zA-Z]+/g, ':param');
        if (!(clientPath in clients)) clients[clientPath] = filePath;
      }
    }
  }
  return { routes, clients };
}

function extractGrpc(repoPath: string): { defs: Record<string, string>; clients: Record<string, string> } {
  const serviceDefPattern = /service\s+(\w+)\s*\{[^}]*rpc\s+(\w+)/gs;
  const tsClientPattern = /import\s*\{[^}]*(\w+)Client[^}]*\}\s*from\s*['"][^'"]*_grpc_pb['"]/g;
  const goClientPattern = /pb\.New(\w+)Client\s*\(/g;

  // Scan .proto files for service definitions
  const protoFiles = walkFiles(repoPath, (f) => extname(f) === '.proto', 500);
  const defs: Record<string, string> = {};
  for (const filePath of protoFiles) {
    const content = safeReadFile(filePath);
    serviceDefPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = serviceDefPattern.exec(content)) !== null) {
      defs[match[1]] = filePath;
    }
  }

  // Scan source files for client usage
  const sourceFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ['.ts', '.js', '.go'].includes(ext);
  }, 3000);
  const clients: Record<string, string> = {};
  for (const filePath of sourceFiles) {
    const content = safeReadFile(filePath);

    tsClientPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = tsClientPattern.exec(content)) !== null) {
      clients[match[1]] = filePath;
    }

    goClientPattern.lastIndex = 0;
    while ((match = goClientPattern.exec(content)) !== null) {
      clients[match[1]] = filePath;
    }
  }
  return { defs, clients };
}

function extractDbTables(repoPath: string): Record<string, string> {
  const sqlCreatePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  const sqlQueryPattern = /(?:FROM|INTO|JOIN|UPDATE)\s+["`]?(\w+)["`]?/gi;
  const typeormPattern = /@Entity\s*\(\s*['"`](\w+)['"`]\s*\)/g;
  const gormPattern = /TableName\s*\(\s*\)\s*string\s*\{\s*return\s*["'](\w+)["']/g;
  const sequelizePattern = /sequelize\.define\s*\(\s*['"`](\w+)['"`]/g;

  const tableMap: Record<string, string> = {};

  // SQL migration files
  const sqlFiles = walkFiles(repoPath, (f) => {
    const lower = f.toLowerCase();
    return lower.endsWith('.sql') || lower.includes('migration');
  }, 1000);

  // Source files for ORM patterns and raw queries
  const sourceFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ['.ts', '.js', '.go', '.py', '.java'].includes(ext);
  }, 3000);

  const allFiles = [...sqlFiles, ...sourceFiles];
  const patterns = [sqlCreatePattern, sqlQueryPattern, typeormPattern, gormPattern, sequelizePattern];
  const skipTables = new Set(['information_schema', 'pg_catalog', 'dual', 'sqlite_master', 'schema_migrations']);

  for (const filePath of allFiles) {
    const content = safeReadFile(filePath);
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const tableName = match[1].toLowerCase();
        if (tableName.length > 2 && !skipTables.has(tableName) && !(tableName in tableMap)) {
          tableMap[tableName] = filePath;
        }
      }
    }
  }
  return tableMap;
}

function extractRedisPrefixes(repoPath: string): Record<string, string> {
  const redisPatterns = [
    /(?:redis|cache|rdb)\.(get|set|del|hget|hset|sadd|srem)\s*\(\s*(?:ctx,\s*)?['"`]([a-zA-Z0-9_:-]+)/g,
    /(?:redis|cache|rdb)\.(?:Get|Set|Del|HGet|HSet)\s*\(\s*ctx\s*,\s*["']([a-zA-Z0-9_:-]+)/g,
  ];
  const sourceFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ['.ts', '.js', '.go', '.py', '.java'].includes(ext);
  }, 3000);

  const prefixMap: Record<string, string> = {};
  for (const filePath of sourceFiles) {
    const content = safeReadFile(filePath);
    for (const pattern of redisPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        // Extract the key — could be in group 2 (first pattern) or group 1 (second pattern)
        const key = match[2] ?? match[1];
        // Extract prefix: everything before first interpolation marker or take full key up to second colon
        const colonParts = key.split(':');
        const prefix = colonParts.length >= 2
          ? `${colonParts[0]}:${colonParts[1]}`
          : key;
        if (prefix.length > 3 && !(prefix in prefixMap)) {
          prefixMap[prefix] = filePath;
        }
      }
    }
  }
  return prefixMap;
}

function extractBuckets(repoPath: string): Record<string, string> {
  const s3Patterns = [
    /s3\.(?:putObject|getObject|deleteObject|upload|headObject)\s*\(\s*\{[^}]*Bucket\s*:\s*['"`]([a-zA-Z0-9._-]+)['"`]/gs,
    /new\s+(?:S3|AWS\.S3)\s*\([^)]*\)[^;]*\.(?:putObject|getObject)\s*\(\s*\{[^}]*Bucket\s*:\s*['"`]([a-zA-Z0-9._-]+)['"`]/gs,
    /storage\.bucket\s*\(\s*['"`]([a-zA-Z0-9._-]+)['"`]\s*\)/g,
  ];
  const envBucketPattern = /(?:S3_BUCKET|GCS_BUCKET|BUCKET_NAME|AWS_BUCKET)\s*=\s*['"`]?([a-zA-Z0-9._-]+)['"`]?/g;

  const bucketMap: Record<string, string> = {};
  const sourceFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ['.ts', '.js', '.go', '.py', '.java', '.env', '.yaml', '.yml'].includes(ext)
      || f.endsWith('.env.example') || f.endsWith('.env.template');
  }, 3000);

  for (const filePath of sourceFiles) {
    const content = safeReadFile(filePath);
    for (const pattern of s3Patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const bucket = match[1];
        if (bucket && !(bucket in bucketMap)) bucketMap[bucket] = filePath;
      }
    }
    envBucketPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = envBucketPattern.exec(content)) !== null) {
      const bucket = match[1];
      if (bucket && bucket.length > 3 && !(bucket in bucketMap)) bucketMap[bucket] = filePath;
    }
  }
  return bucketMap;
}

function extractOpenApi(repoPath: string): { specPaths: Record<string, string>; httpCalls: Record<string, string> } {
  const openApiFileNames = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json'];
  const pathPattern = /^\s*(?:\/[a-zA-Z0-9/:._{}*-]+)\s*:/gm;
  const jsonPathPattern = /"(\/[a-zA-Z0-9/:._{}*-]+)"\s*:/g;

  // HTTP client patterns (complement to Strategy 5)
  const httpCallPatterns = [
    /(?:axios|fetch|http|client|httpGet|httpPost|httpPut|httpDelete)\s*\(\s*[^,]*?,?\s*['"`](\/[a-zA-Z0-9/:._-]+)['"`]/g,
    /fetch\s*\(\s*[`'"](?:https?:\/\/[^/]*?)?(\/[a-zA-Z0-9/:._-]+)['"`]/g,
  ];

  const specPaths: Record<string, string> = {};
  const specFiles = walkFiles(repoPath, (f) => {
    const basename = f.split('/').pop() ?? '';
    return openApiFileNames.includes(basename);
  }, 200);

  for (const filePath of specFiles) {
    const content = safeReadFile(filePath);
    if (filePath.endsWith('.json')) {
      jsonPathPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = jsonPathPattern.exec(content)) !== null) {
        const path = match[1].replace(/\{[^}]+\}/g, ':param');
        if (!(path in specPaths)) specPaths[path] = filePath;
      }
    } else {
      pathPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pathPattern.exec(content)) !== null) {
        const rawPath = match[0].trim().replace(/:$/, '').trim();
        if (rawPath.startsWith('/')) {
          const normalized = rawPath.replace(/\{[^}]+\}/g, ':param');
          if (!(normalized in specPaths)) specPaths[normalized] = filePath;
        }
      }
    }
  }

  // Scan for HTTP client calls
  const sourceFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ['.ts', '.js'].includes(ext);
  }, 3000);
  const httpCalls: Record<string, string> = {};
  for (const filePath of sourceFiles) {
    const content = safeReadFile(filePath);
    for (const pattern of httpCallPatterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const callPath = (match[2] ?? match[1]).replace(/:[a-zA-Z]+/g, ':param');
        if (!(callPath in httpCalls)) httpCalls[callPath] = filePath;
      }
    }
  }
  return { specPaths, httpCalls };
}

function extractComposeRefs(repoPath: string): Array<{ file: string; service: string; evidence: string }> {
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
  // Simplified YAML parsing via regex (no YAML parser dependency)
  const dependsOnPattern = /depends_on\s*:\s*\n((?:\s+-\s+\w[\w.-]*\n?)+)/gm;
  const dependsOnItemPattern = /^\s+-\s+(\w[\w.-]*)/gm;
  const linksPattern = /links\s*:\s*\n((?:\s+-\s+\w[\w.-]*(?::\w[\w.-]*)?\n?)+)/gm;
  const linksItemPattern = /^\s+-\s+(\w[\w.-]*)/gm;

  const refs: Array<{ file: string; service: string; evidence: string }> = [];
  const foundFiles = walkFiles(repoPath, (f) => {
    const basename = f.split('/').pop() ?? '';
    return composeFiles.includes(basename);
  }, 50);

  for (const filePath of foundFiles) {
    const content = safeReadFile(filePath);

    dependsOnPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = dependsOnPattern.exec(content)) !== null) {
      const block = match[1];
      dependsOnItemPattern.lastIndex = 0;
      let dep: RegExpExecArray | null;
      while ((dep = dependsOnItemPattern.exec(block)) !== null) {
        refs.push({ file: filePath, service: dep[1], evidence: `Docker Compose depends_on: ${dep[1]}` });
      }
    }

    linksPattern.lastIndex = 0;
    while ((match = linksPattern.exec(content)) !== null) {
      const block = match[1];
      linksItemPattern.lastIndex = 0;
      let link: RegExpExecArray | null;
      while ((link = linksItemPattern.exec(block)) !== null) {
        refs.push({ file: filePath, service: link[1], evidence: `Docker Compose link: ${link[1]}` });
      }
    }
  }
  return refs;
}

function extractK8sRefs(repoPath: string): Array<{ file: string; service: string; evidence: string }> {
  const svcRefPattern = /["'](\w[\w.-]*)\.(\w[\w.-]*)\.svc(?:\.cluster\.local)?["']/g;
  const envServiceUrlPattern = /(?:SERVICE_HOST|SERVICE_URL|_HOST|_URL)\s*:\s*["']?(\w[\w.-]*)(?:\.[\w.-]+)?\.svc/g;

  const refs: Array<{ file: string; service: string; evidence: string }> = [];
  const k8sFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    if (ext !== '.yaml' && ext !== '.yml') return false;
    const lower = f.toLowerCase();
    return lower.includes('k8s') || lower.includes('deploy') || lower.includes('manifests')
      || lower.includes('kustomiz') || lower.includes('kubernetes') || lower.includes('helm');
  }, 500);

  for (const filePath of k8sFiles) {
    const content = safeReadFile(filePath);

    svcRefPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = svcRefPattern.exec(content)) !== null) {
      refs.push({ file: filePath, service: match[1], evidence: `K8s service DNS: ${match[1]}.${match[2]}.svc` });
    }

    envServiceUrlPattern.lastIndex = 0;
    while ((match = envServiceUrlPattern.exec(content)) !== null) {
      refs.push({ file: filePath, service: match[1], evidence: `K8s env service ref: ${match[1]}` });
    }
  }
  return refs;
}

function extractConstants(repoPath: string): Record<string, { name: string; filePath: string }> {
  const tsConstPattern = /export\s+const\s+(\w+)\s*=\s*['"`]([^'"`]+)['"`]/g;
  const goConstPattern = /(?:const|var)\s+(\w+)\s*=\s*["']([^"']+)["']/g;

  // A string constant is "interesting" if it looks like an identifier
  function isInterestingConstant(value: string): boolean {
    if (value.length < 8) return false;
    // Must contain dots, slashes, or colons — signals structured identifiers
    return /[./:]+/.test(value);
  }

  const constMap: Record<string, { name: string; filePath: string }> = {};
  const sourceFiles = walkFiles(repoPath, (f) => {
    const ext = extname(f);
    return ['.ts', '.js', '.go'].includes(ext);
  }, 3000);

  for (const filePath of sourceFiles) {
    const content = safeReadFile(filePath);
    const patterns = [tsConstPattern, goConstPattern];
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const constName = match[1];
        const constValue = match[2];
        if (isInterestingConstant(constValue) && !(constValue in constMap)) {
          constMap[constValue] = { name: constName, filePath };
        }
      }
    }
  }
  return constMap;
}

/** Scan one repo's working tree into the serializable signal bundle. Pure
 *  CPU + local FS — safe to run in a worker thread while the clone exists. */
export function extractCrossRepoSignals(repoPath: string): CrossRepoSignals {
  const api = extractApiEndpoints(repoPath);
  const grpc = extractGrpc(repoPath);
  const openapi = extractOpenApi(repoPath);
  return {
    npmDeps: extractNpmDeps(repoPath),
    types: extractTypes(repoPath),
    envVars: extractEnvVars(repoPath),
    events: extractEvents(repoPath),
    apiRoutes: api.routes,
    apiClients: api.clients,
    grpcDefs: grpc.defs,
    grpcClients: grpc.clients,
    dbTables: extractDbTables(repoPath),
    redisPrefixes: extractRedisPrefixes(repoPath),
    buckets: extractBuckets(repoPath),
    apiSpecPaths: openapi.specPaths,
    httpCalls: openapi.httpCalls,
    composeRefs: extractComposeRefs(repoPath),
    k8sRefs: extractK8sRefs(repoPath),
    constants: extractConstants(repoPath),
  };
}

// ---------------------------------------------------------------------------
// CORRELATE — persisted signals across repos → edges (no filesystem)
// ---------------------------------------------------------------------------

/** Symmetric pairwise join over a per-repo string→file map. */
function joinPairwise(
  perRepo: Map<string, Record<string, string>>,
  makeEdge: (nameA: string, nameB: string, key: string, fileA: string, fileB: string) => CrossRepoEdge,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];
  const repoNames = [...perRepo.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const a = perRepo.get(repoNames[i])!;
      const b = perRepo.get(repoNames[j])!;
      for (const [key, fileA] of Object.entries(a)) {
        const fileB = b[key];
        if (fileB !== undefined) edges.push(makeEdge(repoNames[i], repoNames[j], key, fileA, fileB));
      }
    }
  }
  return edges;
}

/** Directional join: providers (defs/routes/specs) × consumers (clients). */
function joinProviderConsumer(
  providers: Map<string, Record<string, string>>,
  consumers: Map<string, Record<string, string>>,
  makeEdge: (providerRepo: string, consumerRepo: string, key: string, providerFile: string, consumerFile: string) => CrossRepoEdge,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];
  for (const [providerRepo, provided] of providers) {
    for (const [consumerRepo, consumed] of consumers) {
      if (providerRepo === consumerRepo) continue;
      for (const [key, providerFile] of Object.entries(provided)) {
        const consumerFile = consumed[key];
        if (consumerFile !== undefined) edges.push(makeEdge(providerRepo, consumerRepo, key, providerFile, consumerFile));
      }
    }
  }
  return edges;
}

/** Repo-name lookup used by compose/k8s service-name matching. Also maps
 *  suffixed variants: "mta-routing-engine" matches "routing-engine". */
function buildRepoNameMap(repoNames: string[]): Map<string, string> {
  const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]/g, '-');
  const map = new Map<string, string>();
  for (const name of repoNames) {
    map.set(normalize(name), name);
    const parts = name.split(/[-_]/);
    if (parts.length > 1) {
      for (let k = 1; k < parts.length; k++) {
        const suffix = parts.slice(k).join('-');
        if (suffix.length > 3) map.set(normalize(suffix), name);
      }
    }
  }
  return map;
}

function pick(signals: Map<string, CrossRepoSignals>, field: keyof CrossRepoSignals): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const [name, s] of signals) {
    const v = s[field] as Record<string, string> | undefined;
    if (v && Object.keys(v).length > 0) out.set(name, v);
  }
  return out;
}

/** Join persisted per-repo signals into cross-repo edges. Pure data — a
 *  partial cycle correlates fresh + stored signals without any working tree. */
export function correlateCrossRepoEdges(
  signals: Map<string, CrossRepoSignals>,
  workspaceMaps?: Map<string, WorkspaceMap>,
): CrossRepoEdge[] {
  const allEdges: CrossRepoEdge[] = [];
  const strategies: Array<{ name: string; fn: () => CrossRepoEdge[] }> = [
    {
      name: 'shared-npm-deps',
      fn: () => {
        const perRepo = new Map<string, Record<string, string>>();
        for (const [name, s] of signals) {
          if (s.npmDeps?.length) perRepo.set(name, Object.fromEntries(s.npmDeps.map((d) => [d, 'package.json'])));
        }
        return joinPairwise(perRepo, (a, b, dep) => ({
          sourceRepo: a,
          sourceNode: `package.json::${dep}`,
          targetRepo: b,
          targetNode: `package.json::${dep}`,
          edgeType: 'npm-dep',
          evidence: `Shared scoped dependency: ${dep}`,
          confidence: 0.7,
        }));
      },
    },
    {
      name: 'shared-types',
      fn: () => joinPairwise(pick(signals, 'types'), (a, b, typeName, fileA, fileB) => ({
        sourceRepo: a,
        sourceNode: `${fileA}::${typeName}`,
        targetRepo: b,
        targetNode: `${fileB}::${typeName}`,
        edgeType: 'shared-type',
        evidence: `Shared type: ${typeName}`,
        confidence: 0.9,
      })),
    },
    {
      name: 'env-var-correlation',
      fn: () => {
        const perRepo = new Map<string, Record<string, string>>();
        for (const [name, s] of signals) {
          if (s.envVars?.length) perRepo.set(name, Object.fromEntries(s.envVars.map((v) => [v, 'env'])));
        }
        return joinPairwise(perRepo, (a, b, v) => ({
          sourceRepo: a,
          sourceNode: `env::${v}`,
          targetRepo: b,
          targetNode: `env::${v}`,
          edgeType: 'env-var',
          evidence: `Shared env var: ${v}`,
          confidence: 0.6,
        }));
      },
    },
    {
      name: 'event-schemas',
      fn: () => joinPairwise(pick(signals, 'events'), (a, b, eventName, fileA, fileB) => ({
        sourceRepo: a,
        sourceNode: `${fileA}::${eventName}`,
        targetRepo: b,
        targetNode: `${fileB}::${eventName}`,
        edgeType: 'event-schema',
        evidence: `Shared event/topic: ${eventName}`,
        confidence: 0.85,
      })),
    },
    {
      name: 'api-endpoints',
      fn: () => joinProviderConsumer(pick(signals, 'apiRoutes'), pick(signals, 'apiClients'),
        (routeRepo, clientRepo, routePath, routeFile, clientFile) => ({
          sourceRepo: clientRepo,
          sourceNode: `${clientFile}::${routePath}`,
          targetRepo: routeRepo,
          targetNode: `${routeFile}::${routePath}`,
          edgeType: 'http',
          evidence: `API endpoint: ${routePath}`,
          confidence: 0.8,
        })),
    },
    {
      name: 'workspace-deps',
      fn: () => {
        // Intra-repo edges between sibling workspace packages — needs only the
        // (persisted) workspace map, no tree.
        const edges: CrossRepoEdge[] = [];
        for (const [repoName, wsMap] of workspaceMaps ?? new Map<string, WorkspaceMap>()) {
          if (wsMap.packages.length < 2) continue; // not a meaningful workspace
          for (const pkg of wsMap.packages) {
            for (const depName of pkg.dependencies) {
              const target = wsMap.nameToPackage.get(depName);
              if (target && target.name !== pkg.name) {
                edges.push({
                  sourceRepo: repoName,
                  sourceNode: `pkg::${pkg.name}`,
                  targetRepo: repoName,
                  targetNode: `pkg::${target.name}`,
                  edgeType: 'workspace-dep',
                  evidence: `${pkg.name} depends on ${target.name} (${pkg.manifestFile})`,
                  confidence: 1.0,
                });
              }
            }
          }
        }
        return edges;
      },
    },
    {
      name: 'grpc-services',
      fn: () => joinProviderConsumer(pick(signals, 'grpcDefs'), pick(signals, 'grpcClients'),
        (defRepo, clientRepo, serviceName, defFile, clientFile) => ({
          sourceRepo: clientRepo,
          sourceNode: `${clientFile}::${serviceName}Client`,
          targetRepo: defRepo,
          targetNode: `${defFile}::${serviceName}`,
          edgeType: 'grpc',
          evidence: `gRPC service: ${serviceName}`,
          confidence: 0.9,
        })),
    },
    {
      name: 'database-schemas',
      fn: () => joinPairwise(pick(signals, 'dbTables'), (a, b, tableName, fileA, fileB) => ({
        sourceRepo: a,
        sourceNode: `${fileA}::${tableName}`,
        targetRepo: b,
        targetNode: `${fileB}::${tableName}`,
        edgeType: 'database',
        evidence: `Shared table: ${tableName}`,
        confidence: 0.85,
      })),
    },
    {
      name: 'redis-key-patterns',
      fn: () => joinPairwise(pick(signals, 'redisPrefixes'), (a, b, prefix, fileA, fileB) => ({
        sourceRepo: a,
        sourceNode: `${fileA}::redis:${prefix}`,
        targetRepo: b,
        targetNode: `${fileB}::redis:${prefix}`,
        edgeType: 'redis',
        evidence: `Shared Redis key prefix: ${prefix}`,
        confidence: 0.75,
      })),
    },
    {
      name: 's3-buckets',
      fn: () => joinPairwise(pick(signals, 'buckets'), (a, b, bucket, fileA, fileB) => ({
        sourceRepo: a,
        sourceNode: `${fileA}::s3:${bucket}`,
        targetRepo: b,
        targetNode: `${fileB}::s3:${bucket}`,
        edgeType: 's3',
        evidence: `Shared bucket: ${bucket}`,
        confidence: 0.8,
      })),
    },
    {
      name: 'openapi-schemas',
      fn: () => joinProviderConsumer(pick(signals, 'apiSpecPaths'), pick(signals, 'httpCalls'),
        (specRepo, clientRepo, apiPath, specFile, clientFile) => ({
          sourceRepo: clientRepo,
          sourceNode: `${clientFile}::${apiPath}`,
          targetRepo: specRepo,
          targetNode: `${specFile}::${apiPath}`,
          edgeType: 'api-contract',
          evidence: `OpenAPI endpoint: ${apiPath}`,
          confidence: 0.9,
        })),
    },
    {
      name: 'docker-compose-links',
      fn: () => {
        const edges: CrossRepoEdge[] = [];
        const repoNameMap = buildRepoNameMap([...signals.keys()]);
        const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]/g, '-');
        for (const [repoName, s] of signals) {
          for (const ref of s.composeRefs ?? []) {
            const targetRepo = repoNameMap.get(normalize(ref.service));
            if (targetRepo && targetRepo !== repoName) {
              edges.push({
                sourceRepo: repoName,
                sourceNode: `${ref.file}::compose`,
                targetRepo,
                targetNode: `service::${ref.service}`,
                edgeType: 'http',
                evidence: ref.evidence,
                confidence: 0.85,
              });
            }
          }
        }
        return edges;
      },
    },
    {
      name: 'k8s-service-refs',
      fn: () => {
        const edges: CrossRepoEdge[] = [];
        const repoNameMap = buildRepoNameMap([...signals.keys()]);
        const normalize = (name: string): string => name.toLowerCase().replace(/[-_.]/g, '-');
        for (const [repoName, s] of signals) {
          for (const ref of s.k8sRefs ?? []) {
            const targetRepo = repoNameMap.get(normalize(ref.service));
            if (targetRepo && targetRepo !== repoName) {
              edges.push({
                sourceRepo: repoName,
                sourceNode: `${ref.file}::${ref.evidence.startsWith('K8s env') ? 'k8s-env' : 'k8s-ref'}`,
                targetRepo,
                targetNode: `k8s-service::${ref.service}`,
                edgeType: 'http',
                evidence: ref.evidence,
                confidence: 0.8,
              });
            }
          }
        }
        return edges;
      },
    },
    {
      name: 'shared-constants',
      fn: () => {
        const edges: CrossRepoEdge[] = [];
        const repoNames = [...signals.keys()].filter((n) => signals.get(n)!.constants && Object.keys(signals.get(n)!.constants!).length > 0);
        for (let i = 0; i < repoNames.length; i++) {
          for (let j = i + 1; j < repoNames.length; j++) {
            const constsA = signals.get(repoNames[i])!.constants!;
            const constsB = signals.get(repoNames[j])!.constants!;
            for (const [value, infoA] of Object.entries(constsA)) {
              const infoB = constsB[value];
              if (infoB) {
                edges.push({
                  sourceRepo: repoNames[i],
                  sourceNode: `${infoA.filePath}::${infoA.name}`,
                  targetRepo: repoNames[j],
                  targetNode: `${infoB.filePath}::${infoB.name}`,
                  edgeType: 'shared-constant',
                  evidence: `Shared constant value: "${value}" (${infoA.name} / ${infoB.name})`,
                  confidence: 0.7,
                });
              }
            }
          }
        }
        return edges;
      },
    },
  ];

  for (const strategy of strategies) {
    try {
      allEdges.push(...strategy.fn());
    } catch {
      // Individual strategy failure should not block others
    }
  }
  return allEdges;
}

// ---------------------------------------------------------------------------
// Main entry point — tree-based wrapper (extract every repo, then correlate)
// ---------------------------------------------------------------------------
export async function detectCrossRepoEdges(
  repos: Array<{ name: string; path: string; language: string }>,
  workspaceMaps?: Map<string, WorkspaceMap>,
): Promise<CrossRepoEdge[]> {
  const signals = new Map<string, CrossRepoSignals>();
  for (const repo of repos) {
    try {
      signals.set(repo.name, extractCrossRepoSignals(repo.path));
    } catch {
      // A single unreadable repo should not block the others
    }
  }
  // Workspace maps: fall back to a fresh tree scan per repo (today's behavior
  // for callers that do not thread the maps through).
  const wsMaps = new Map<string, WorkspaceMap>(workspaceMaps ?? []);
  for (const repo of repos) {
    if (!wsMaps.has(repo.name)) {
      try {
        const ws = detectWorkspace(repo.path);
        if (ws.packages.length > 0) wsMaps.set(repo.name, ws);
      } catch { /* non-fatal */ }
    }
  }
  return correlateCrossRepoEdges(signals, wsMaps);
}
