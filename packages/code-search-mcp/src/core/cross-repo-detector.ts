import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import type { CrossRepoEdge, WorkspaceMap } from './types';
import { detectWorkspace } from './workspace-detector.js';

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
// Strategy 1: Shared npm dependencies
// ---------------------------------------------------------------------------
function detectSharedNpmDeps(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];
  const repoDeps = new Map<string, Set<string>>();

  for (const repo of repos) {
    const pkgPath = join(repo.path, 'package.json');
    const content = safeReadFile(pkgPath);
    if (!content) continue;
    try {
      const pkg = JSON.parse(content);
      const allDeps = new Set<string>([
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ]);
      // Filter to scoped/workspace packages (likely internal)
      const orgDeps = new Set<string>(
        [...allDeps].filter(d => d.startsWith('@')),
      );
      repoDeps.set(repo.name, orgDeps);
    } catch {
      // Malformed package.json
    }
  }

  const repoNames = [...repoDeps.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const nameA = repoNames[i];
      const nameB = repoNames[j];
      const depsA = repoDeps.get(nameA)!;
      const depsB = repoDeps.get(nameB)!;
      for (const dep of depsA) {
        if (depsB.has(dep)) {
          edges.push({
            sourceRepo: nameA,
            sourceNode: `package.json::${dep}`,
            targetRepo: nameB,
            targetNode: `package.json::${dep}`,
            edgeType: 'npm-dep',
            evidence: `Shared scoped dependency: ${dep}`,
            confidence: 0.7,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 2: Shared TypeScript types
// ---------------------------------------------------------------------------
function detectSharedTypes(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];
  const typeExportPattern = /export\s+(?:interface|type)\s+(\w+)/g;
  const repoTypes = new Map<string, Map<string, string>>(); // repo -> typeName -> filePath

  for (const repo of repos) {
    const tsFiles = walkFiles(repo.path, (f) => {
      const ext = extname(f);
      return ext === '.ts' || ext === '.d.ts';
    }, 2000);

    const typeMap = new Map<string, string>();
    for (const filePath of tsFiles) {
      const content = safeReadFile(filePath);
      let match: RegExpExecArray | null;
      typeExportPattern.lastIndex = 0;
      while ((match = typeExportPattern.exec(content)) !== null) {
        const typeName = match[1];
        if (!typeMap.has(typeName)) {
          typeMap.set(typeName, filePath);
        }
      }
    }
    repoTypes.set(repo.name, typeMap);
  }

  const repoNames = [...repoTypes.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const nameA = repoNames[i];
      const nameB = repoNames[j];
      const typesA = repoTypes.get(nameA)!;
      const typesB = repoTypes.get(nameB)!;
      for (const [typeName, fileA] of typesA) {
        const fileB = typesB.get(typeName);
        if (fileB) {
          edges.push({
            sourceRepo: nameA,
            sourceNode: `${fileA}::${typeName}`,
            targetRepo: nameB,
            targetNode: `${fileB}::${typeName}`,
            edgeType: 'shared-type',
            evidence: `Shared type: ${typeName}`,
            confidence: 0.9,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 3: Environment variable correlation
// ---------------------------------------------------------------------------
function detectEnvVarCorrelation(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];
  const envFileNames = ['.env.example', '.env.template', '.env.sample'];
  const envVarPattern = /^([A-Z][A-Z0-9_]{2,})=/gm;
  const repoEnvVars = new Map<string, Set<string>>();

  for (const repo of repos) {
    const vars = new Set<string>();
    for (const envFile of envFileNames) {
      const content = safeReadFile(join(repo.path, envFile));
      if (!content) continue;
      let match: RegExpExecArray | null;
      envVarPattern.lastIndex = 0;
      while ((match = envVarPattern.exec(content)) !== null) {
        vars.add(match[1]);
      }
    }
    if (vars.size > 0) {
      repoEnvVars.set(repo.name, vars);
    }
  }

  const repoNames = [...repoEnvVars.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const nameA = repoNames[i];
      const nameB = repoNames[j];
      const varsA = repoEnvVars.get(nameA)!;
      const varsB = repoEnvVars.get(nameB)!;
      for (const v of varsA) {
        if (varsB.has(v)) {
          edges.push({
            sourceRepo: nameA,
            sourceNode: `env::${v}`,
            targetRepo: nameB,
            targetNode: `env::${v}`,
            edgeType: 'env-var',
            evidence: `Shared env var: ${v}`,
            confidence: 0.6,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 4: Event schema detection (topics, channels, events in constants)
// ---------------------------------------------------------------------------
function detectEventSchemas(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];
  // Match patterns like: TOPIC = 'user.created', channel: 'orders', event: 'payment_completed'
  const eventPatterns = [
    /(?:topic|TOPIC|channel|CHANNEL|event|EVENT)\s*[:=]\s*['"`]([a-zA-Z0-9._-]+)['"`]/g,
    /(?:subscribe|publish|emit|on)\s*\(\s*['"`]([a-zA-Z0-9._-]+)['"`]/g,
  ];
  const repoEvents = new Map<string, Map<string, string>>(); // repo -> eventName -> filePath

  for (const repo of repos) {
    const sourceFiles = walkFiles(repo.path, (f) => {
      const ext = extname(f);
      return ['.ts', '.js', '.py', '.go', '.java'].includes(ext);
    }, 3000);

    const eventMap = new Map<string, string>();
    for (const filePath of sourceFiles) {
      const content = safeReadFile(filePath);
      for (const pattern of eventPatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const eventName = match[1];
          // Filter out overly generic names
          if (eventName.length > 3 && eventName.includes('.')) {
            if (!eventMap.has(eventName)) {
              eventMap.set(eventName, filePath);
            }
          }
        }
      }
    }
    repoEvents.set(repo.name, eventMap);
  }

  const repoNames = [...repoEvents.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const nameA = repoNames[i];
      const nameB = repoNames[j];
      const eventsA = repoEvents.get(nameA)!;
      const eventsB = repoEvents.get(nameB)!;
      for (const [eventName, fileA] of eventsA) {
        const fileB = eventsB.get(eventName);
        if (fileB) {
          edges.push({
            sourceRepo: nameA,
            sourceNode: `${fileA}::${eventName}`,
            targetRepo: nameB,
            targetNode: `${fileB}::${eventName}`,
            edgeType: 'event-schema',
            evidence: `Shared event/topic: ${eventName}`,
            confidence: 0.85,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 5: API endpoint matching (route defs vs HTTP client calls)
// ---------------------------------------------------------------------------
function detectApiEndpoints(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

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

  const repoRoutes = new Map<string, Map<string, string>>(); // repo -> path -> file
  const repoClients = new Map<string, Map<string, string>>(); // repo -> path -> file

  for (const repo of repos) {
    const sourceFiles = walkFiles(repo.path, (f) => {
      const ext = extname(f);
      return ['.ts', '.js'].includes(ext);
    }, 3000);

    const routes = new Map<string, string>();
    const clients = new Map<string, string>();

    for (const filePath of sourceFiles) {
      const content = safeReadFile(filePath);

      for (const pattern of routeDefPatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          // Normalize path: strip params to base pattern
          const routePath = match[2].replace(/:[a-zA-Z]+/g, ':param');
          if (!routes.has(routePath)) {
            routes.set(routePath, filePath);
          }
        }
      }

      for (const pattern of httpCallPatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const clientPath = match[2].replace(/:[a-zA-Z]+/g, ':param');
          if (!clients.has(clientPath)) {
            clients.set(clientPath, filePath);
          }
        }
      }
    }

    repoRoutes.set(repo.name, routes);
    repoClients.set(repo.name, clients);
  }

  // Match routes in one repo to client calls in another
  for (const [routeRepo, routes] of repoRoutes) {
    for (const [clientRepo, clients] of repoClients) {
      if (routeRepo === clientRepo) continue;
      for (const [routePath, routeFile] of routes) {
        const clientFile = clients.get(routePath);
        if (clientFile) {
          edges.push({
            sourceRepo: clientRepo,
            sourceNode: `${clientFile}::${routePath}`,
            targetRepo: routeRepo,
            targetNode: `${routeFile}::${routePath}`,
            edgeType: 'http',
            evidence: `API endpoint: ${routePath}`,
            confidence: 0.8,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 6: Workspace package dependencies (monorepo sibling packages)
// ---------------------------------------------------------------------------
function detectWorkspaceDeps(
  repos: Array<{ name: string; path: string }>,
  workspaceMaps?: Map<string, WorkspaceMap>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  for (const repo of repos) {
    const wsMap = workspaceMaps?.get(repo.name) ?? detectWorkspace(repo.path);
    if (wsMap.packages.length < 2) continue; // not a meaningful workspace

    // For each package, check if its manifest deps reference a sibling package
    for (const pkg of wsMap.packages) {
      for (const depName of pkg.dependencies) {
        const target = wsMap.nameToPackage.get(depName);
        if (target && target.name !== pkg.name) {
          edges.push({
            sourceRepo: repo.name,
            sourceNode: `pkg::${pkg.name}`,
            targetRepo: repo.name,
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
}

// ---------------------------------------------------------------------------
// Strategy 7: gRPC/Proto Service Detection
// ---------------------------------------------------------------------------
function detectGrpcServices(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  const serviceDefPattern = /service\s+(\w+)\s*\{[^}]*rpc\s+(\w+)/gs;
  const tsClientPattern = /import\s*\{[^}]*(\w+)Client[^}]*\}\s*from\s*['"][^'"]*_grpc_pb['"]/g;
  const goClientPattern = /pb\.New(\w+)Client\s*\(/g;

  // repo -> Set<serviceName>
  const repoServiceDefs = new Map<string, Map<string, string>>();
  const repoServiceClients = new Map<string, Map<string, string>>();

  for (const repo of repos) {
    // Scan .proto files for service definitions
    const protoFiles = walkFiles(repo.path, (f) => extname(f) === '.proto', 500);
    const serviceDefs = new Map<string, string>();
    for (const filePath of protoFiles) {
      const content = safeReadFile(filePath);
      serviceDefPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = serviceDefPattern.exec(content)) !== null) {
        serviceDefs.set(match[1], filePath);
      }
    }
    repoServiceDefs.set(repo.name, serviceDefs);

    // Scan source files for client usage
    const sourceFiles = walkFiles(repo.path, (f) => {
      const ext = extname(f);
      return ['.ts', '.js', '.go'].includes(ext);
    }, 3000);
    const serviceClients = new Map<string, string>();
    for (const filePath of sourceFiles) {
      const content = safeReadFile(filePath);

      tsClientPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = tsClientPattern.exec(content)) !== null) {
        serviceClients.set(match[1], filePath);
      }

      goClientPattern.lastIndex = 0;
      while ((match = goClientPattern.exec(content)) !== null) {
        serviceClients.set(match[1], filePath);
      }
    }
    repoServiceClients.set(repo.name, serviceClients);
  }

  // Match service defs in one repo with client usage in another
  for (const [defRepo, defs] of repoServiceDefs) {
    for (const [clientRepo, clients] of repoServiceClients) {
      if (defRepo === clientRepo) continue;
      for (const [serviceName, defFile] of defs) {
        const clientFile = clients.get(serviceName);
        if (clientFile) {
          edges.push({
            sourceRepo: clientRepo,
            sourceNode: `${clientFile}::${serviceName}Client`,
            targetRepo: defRepo,
            targetNode: `${defFile}::${serviceName}`,
            edgeType: 'grpc',
            evidence: `gRPC service: ${serviceName}`,
            confidence: 0.9,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 8: Database Schema Correlation
// ---------------------------------------------------------------------------
function detectDatabaseSchemas(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  const sqlCreatePattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/gi;
  const sqlQueryPattern = /(?:FROM|INTO|JOIN|UPDATE)\s+["`]?(\w+)["`]?/gi;
  const typeormPattern = /@Entity\s*\(\s*['"`](\w+)['"`]\s*\)/g;
  const gormPattern = /TableName\s*\(\s*\)\s*string\s*\{\s*return\s*["'](\w+)["']/g;
  const sequelizePattern = /sequelize\.define\s*\(\s*['"`](\w+)['"`]/g;

  const repoTables = new Map<string, Map<string, string>>(); // repo -> tableName -> filePath

  for (const repo of repos) {
    const tableMap = new Map<string, string>();

    // SQL migration files
    const sqlFiles = walkFiles(repo.path, (f) => {
      const lower = f.toLowerCase();
      return lower.endsWith('.sql') || lower.includes('migration');
    }, 1000);

    // Source files for ORM patterns and raw queries
    const sourceFiles = walkFiles(repo.path, (f) => {
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
          if (tableName.length > 2 && !skipTables.has(tableName)) {
            if (!tableMap.has(tableName)) {
              tableMap.set(tableName, filePath);
            }
          }
        }
      }
    }
    repoTables.set(repo.name, tableMap);
  }

  const repoNames = [...repoTables.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const nameA = repoNames[i];
      const nameB = repoNames[j];
      const tablesA = repoTables.get(nameA)!;
      const tablesB = repoTables.get(nameB)!;
      for (const [tableName, fileA] of tablesA) {
        const fileB = tablesB.get(tableName);
        if (fileB) {
          edges.push({
            sourceRepo: nameA,
            sourceNode: `${fileA}::${tableName}`,
            targetRepo: nameB,
            targetNode: `${fileB}::${tableName}`,
            edgeType: 'database',
            evidence: `Shared table: ${tableName}`,
            confidence: 0.85,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 9: Redis Key Pattern Detection
// ---------------------------------------------------------------------------
function detectRedisKeyPatterns(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  const redisPatterns = [
    /(?:redis|cache|rdb)\.(get|set|del|hget|hset|sadd|srem)\s*\(\s*(?:ctx,\s*)?['"`]([a-zA-Z0-9_:-]+)/g,
    /(?:redis|cache|rdb)\.(?:Get|Set|Del|HGet|HSet)\s*\(\s*ctx\s*,\s*["']([a-zA-Z0-9_:-]+)/g,
  ];

  const repoKeyPrefixes = new Map<string, Map<string, string>>(); // repo -> prefix -> filePath

  for (const repo of repos) {
    const sourceFiles = walkFiles(repo.path, (f) => {
      const ext = extname(f);
      return ['.ts', '.js', '.go', '.py', '.java'].includes(ext);
    }, 3000);

    const prefixMap = new Map<string, string>();
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
          if (prefix.length > 3 && !prefixMap.has(prefix)) {
            prefixMap.set(prefix, filePath);
          }
        }
      }
    }
    repoKeyPrefixes.set(repo.name, prefixMap);
  }

  const repoNames = [...repoKeyPrefixes.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const nameA = repoNames[i];
      const nameB = repoNames[j];
      const prefixesA = repoKeyPrefixes.get(nameA)!;
      const prefixesB = repoKeyPrefixes.get(nameB)!;
      for (const [prefix, fileA] of prefixesA) {
        const fileB = prefixesB.get(prefix);
        if (fileB) {
          edges.push({
            sourceRepo: nameA,
            sourceNode: `${fileA}::redis:${prefix}`,
            targetRepo: nameB,
            targetNode: `${fileB}::redis:${prefix}`,
            edgeType: 'redis',
            evidence: `Shared Redis key prefix: ${prefix}`,
            confidence: 0.75,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 10: S3/GCS Bucket Detection
// ---------------------------------------------------------------------------
function detectS3Buckets(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  const s3Patterns = [
    /s3\.(?:putObject|getObject|deleteObject|upload|headObject)\s*\(\s*\{[^}]*Bucket\s*:\s*['"`]([a-zA-Z0-9._-]+)['"`]/gs,
    /new\s+(?:S3|AWS\.S3)\s*\([^)]*\)[^;]*\.(?:putObject|getObject)\s*\(\s*\{[^}]*Bucket\s*:\s*['"`]([a-zA-Z0-9._-]+)['"`]/gs,
    /storage\.bucket\s*\(\s*['"`]([a-zA-Z0-9._-]+)['"`]\s*\)/g,
  ];

  const envBucketPattern = /(?:S3_BUCKET|GCS_BUCKET|BUCKET_NAME|AWS_BUCKET)\s*=\s*['"`]?([a-zA-Z0-9._-]+)['"`]?/g;

  const repoBuckets = new Map<string, Map<string, string>>(); // repo -> bucketName -> filePath

  for (const repo of repos) {
    const bucketMap = new Map<string, string>();

    const sourceFiles = walkFiles(repo.path, (f) => {
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
          if (bucket && !bucketMap.has(bucket)) {
            bucketMap.set(bucket, filePath);
          }
        }
      }
      envBucketPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = envBucketPattern.exec(content)) !== null) {
        const bucket = match[1];
        if (bucket && bucket.length > 3 && !bucketMap.has(bucket)) {
          bucketMap.set(bucket, filePath);
        }
      }
    }
    repoBuckets.set(repo.name, bucketMap);
  }

  const repoNames = [...repoBuckets.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const nameA = repoNames[i];
      const nameB = repoNames[j];
      const bucketsA = repoBuckets.get(nameA)!;
      const bucketsB = repoBuckets.get(nameB)!;
      for (const [bucket, fileA] of bucketsA) {
        const fileB = bucketsB.get(bucket);
        if (fileB) {
          edges.push({
            sourceRepo: nameA,
            sourceNode: `${fileA}::s3:${bucket}`,
            targetRepo: nameB,
            targetNode: `${fileB}::s3:${bucket}`,
            edgeType: 's3',
            evidence: `Shared bucket: ${bucket}`,
            confidence: 0.8,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 11: OpenAPI Schema References
// ---------------------------------------------------------------------------
function detectOpenApiSchemas(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  const openApiFileNames = ['openapi.yaml', 'openapi.yml', 'openapi.json', 'swagger.yaml', 'swagger.yml', 'swagger.json'];
  const pathPattern = /^\s*(?:\/[a-zA-Z0-9/:._{}*-]+)\s*:/gm;
  const jsonPathPattern = /"(\/[a-zA-Z0-9/:._{}*-]+)"\s*:/g;

  // repo -> endpoint paths -> filePath
  const repoApiPaths = new Map<string, Map<string, string>>();

  // HTTP client patterns (complement to Strategy 5)
  const httpCallPatterns = [
    /(?:axios|fetch|http|client|httpGet|httpPost|httpPut|httpDelete)\s*\(\s*[^,]*?,?\s*['"`](\/[a-zA-Z0-9/:._-]+)['"`]/g,
    /fetch\s*\(\s*[`'"](?:https?:\/\/[^/]*?)?(\/[a-zA-Z0-9/:._-]+)['"`]/g,
  ];
  const repoHttpCalls = new Map<string, Map<string, string>>();

  for (const repo of repos) {
    const apiPaths = new Map<string, string>();

    // Find OpenAPI spec files
    const specFiles = walkFiles(repo.path, (f) => {
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
          if (!apiPaths.has(path)) {
            apiPaths.set(path, filePath);
          }
        }
      } else {
        pathPattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pathPattern.exec(content)) !== null) {
          const rawPath = match[0].trim().replace(/:$/, '').trim();
          if (rawPath.startsWith('/')) {
            const normalized = rawPath.replace(/\{[^}]+\}/g, ':param');
            if (!apiPaths.has(normalized)) {
              apiPaths.set(normalized, filePath);
            }
          }
        }
      }
    }
    repoApiPaths.set(repo.name, apiPaths);

    // Scan for HTTP client calls
    const sourceFiles = walkFiles(repo.path, (f) => {
      const ext = extname(f);
      return ['.ts', '.js'].includes(ext);
    }, 3000);
    const httpCalls = new Map<string, string>();
    for (const filePath of sourceFiles) {
      const content = safeReadFile(filePath);
      for (const pattern of httpCallPatterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const callPath = (match[2] ?? match[1]).replace(/:[a-zA-Z]+/g, ':param');
          if (!httpCalls.has(callPath)) {
            httpCalls.set(callPath, filePath);
          }
        }
      }
    }
    repoHttpCalls.set(repo.name, httpCalls);
  }

  // Match API spec paths in one repo with HTTP calls in another
  for (const [specRepo, apiPaths] of repoApiPaths) {
    for (const [clientRepo, httpCalls] of repoHttpCalls) {
      if (specRepo === clientRepo) continue;
      for (const [apiPath, specFile] of apiPaths) {
        const clientFile = httpCalls.get(apiPath);
        if (clientFile) {
          edges.push({
            sourceRepo: clientRepo,
            sourceNode: `${clientFile}::${apiPath}`,
            targetRepo: specRepo,
            targetNode: `${specFile}::${apiPath}`,
            edgeType: 'api-contract',
            evidence: `OpenAPI endpoint: ${apiPath}`,
            confidence: 0.9,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 12: Docker Compose Service Links
// ---------------------------------------------------------------------------
function detectDockerComposeLinks(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];

  // Extract service names and their dependencies from compose files
  // Simplified YAML parsing via regex (no YAML parser dependency)
  const serviceBlockPattern = /^\s{2}(\w[\w.-]*)\s*:/gm;
  const dependsOnPattern = /depends_on\s*:\s*\n((?:\s+-\s+\w[\w.-]*\n?)+)/gm;
  const dependsOnItemPattern = /^\s+-\s+(\w[\w.-]*)/gm;
  const linksPattern = /links\s*:\s*\n((?:\s+-\s+\w[\w.-]*(?::\w[\w.-]*)?\n?)+)/gm;
  const linksItemPattern = /^\s+-\s+(\w[\w.-]*)/gm;

  // Normalize service name for matching against repo names
  function normalizeServiceName(name: string): string {
    return name.toLowerCase().replace(/[-_.]/g, '-');
  }

  // Build a map of repo names (normalized) to actual repo names
  const repoNameMap = new Map<string, string>();
  for (const repo of repos) {
    repoNameMap.set(normalizeServiceName(repo.name), repo.name);
    // Also add suffixed variants: "mta-routing-engine" matches "routing-engine"
    const parts = repo.name.split(/[-_]/);
    if (parts.length > 1) {
      for (let k = 1; k < parts.length; k++) {
        const suffix = parts.slice(k).join('-');
        if (suffix.length > 3) {
          repoNameMap.set(normalizeServiceName(suffix), repo.name);
        }
      }
    }
  }

  for (const repo of repos) {
    const foundFiles = walkFiles(repo.path, (f) => {
      const basename = f.split('/').pop() ?? '';
      return composeFiles.includes(basename);
    }, 50);

    for (const filePath of foundFiles) {
      const content = safeReadFile(filePath);

      // Extract all service names from the compose file
      serviceBlockPattern.lastIndex = 0;
      const services = new Set<string>();
      let match: RegExpExecArray | null;
      while ((match = serviceBlockPattern.exec(content)) !== null) {
        services.add(match[1]);
      }

      // Extract depends_on links
      dependsOnPattern.lastIndex = 0;
      while ((match = dependsOnPattern.exec(content)) !== null) {
        const block = match[1];
        dependsOnItemPattern.lastIndex = 0;
        let dep: RegExpExecArray | null;
        while ((dep = dependsOnItemPattern.exec(block)) !== null) {
          const depService = dep[1];
          const normalizedDep = normalizeServiceName(depService);
          const targetRepo = repoNameMap.get(normalizedDep);
          if (targetRepo && targetRepo !== repo.name) {
            edges.push({
              sourceRepo: repo.name,
              sourceNode: `${filePath}::compose`,
              targetRepo,
              targetNode: `service::${depService}`,
              edgeType: 'http',
              evidence: `Docker Compose depends_on: ${depService}`,
              confidence: 0.85,
            });
          }
        }
      }

      // Extract links
      linksPattern.lastIndex = 0;
      while ((match = linksPattern.exec(content)) !== null) {
        const block = match[1];
        linksItemPattern.lastIndex = 0;
        let link: RegExpExecArray | null;
        while ((link = linksItemPattern.exec(block)) !== null) {
          const linkService = link[1];
          const normalizedLink = normalizeServiceName(linkService);
          const targetRepo = repoNameMap.get(normalizedLink);
          if (targetRepo && targetRepo !== repo.name) {
            edges.push({
              sourceRepo: repo.name,
              sourceNode: `${filePath}::compose`,
              targetRepo,
              targetNode: `service::${linkService}`,
              edgeType: 'http',
              evidence: `Docker Compose link: ${linkService}`,
              confidence: 0.85,
            });
          }
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 13: Kubernetes Service References
// ---------------------------------------------------------------------------
function detectK8sServiceRefs(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  const k8sServicePattern = /kind:\s*Service\s[\s\S]*?name:\s*["']?(\w[\w.-]*)["']?/gm;
  const k8sDeployPattern = /kind:\s*Deployment\s[\s\S]*?name:\s*["']?(\w[\w.-]*)["']?/gm;
  const svcRefPattern = /["'](\w[\w.-]*)\.(\w[\w.-]*)\.svc(?:\.cluster\.local)?["']/g;
  const envServiceUrlPattern = /(?:SERVICE_HOST|SERVICE_URL|_HOST|_URL)\s*:\s*["']?(\w[\w.-]*)(?:\.[\w.-]+)?\.svc/g;

  // Normalize for repo matching
  function normalizeK8sName(name: string): string {
    return name.toLowerCase().replace(/[-_.]/g, '-');
  }

  const repoNameMap = new Map<string, string>();
  for (const repo of repos) {
    repoNameMap.set(normalizeK8sName(repo.name), repo.name);
    const parts = repo.name.split(/[-_]/);
    if (parts.length > 1) {
      for (let k = 1; k < parts.length; k++) {
        const suffix = parts.slice(k).join('-');
        if (suffix.length > 3) {
          repoNameMap.set(normalizeK8sName(suffix), repo.name);
        }
      }
    }
  }

  for (const repo of repos) {
    const k8sFiles = walkFiles(repo.path, (f) => {
      const ext = extname(f);
      if (ext !== '.yaml' && ext !== '.yml') return false;
      const lower = f.toLowerCase();
      return lower.includes('k8s') || lower.includes('deploy') || lower.includes('manifests')
        || lower.includes('kustomiz') || lower.includes('kubernetes') || lower.includes('helm');
    }, 500);

    for (const filePath of k8sFiles) {
      const content = safeReadFile(filePath);

      // Extract service references via .svc DNS
      svcRefPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = svcRefPattern.exec(content)) !== null) {
        const svcName = match[1];
        const normalized = normalizeK8sName(svcName);
        const targetRepo = repoNameMap.get(normalized);
        if (targetRepo && targetRepo !== repo.name) {
          edges.push({
            sourceRepo: repo.name,
            sourceNode: `${filePath}::k8s-ref`,
            targetRepo,
            targetNode: `k8s-service::${svcName}`,
            edgeType: 'http',
            evidence: `K8s service DNS: ${svcName}.${match[2]}.svc`,
            confidence: 0.8,
          });
        }
      }

      // Extract env var service references
      envServiceUrlPattern.lastIndex = 0;
      while ((match = envServiceUrlPattern.exec(content)) !== null) {
        const svcName = match[1];
        const normalized = normalizeK8sName(svcName);
        const targetRepo = repoNameMap.get(normalized);
        if (targetRepo && targetRepo !== repo.name) {
          edges.push({
            sourceRepo: repo.name,
            sourceNode: `${filePath}::k8s-env`,
            targetRepo,
            targetNode: `k8s-service::${svcName}`,
            edgeType: 'http',
            evidence: `K8s env service ref: ${svcName}`,
            confidence: 0.8,
          });
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Strategy 14: Shared Constants & Magic Strings
// ---------------------------------------------------------------------------
function detectSharedConstants(
  repos: Array<{ name: string; path: string }>,
): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];

  const tsConstPattern = /export\s+const\s+(\w+)\s*=\s*['"`]([^'"`]+)['"`]/g;
  const goConstPattern = /(?:const|var)\s+(\w+)\s*=\s*["']([^"']+)["']/g;

  // A string constant is "interesting" if it looks like an identifier
  function isInterestingConstant(value: string): boolean {
    if (value.length < 8) return false;
    // Must contain dots, slashes, or colons — signals structured identifiers
    return /[./:]+/.test(value);
  }

  // repo -> constValue -> { name, filePath }
  const repoConstants = new Map<string, Map<string, { name: string; filePath: string }>>();

  for (const repo of repos) {
    const sourceFiles = walkFiles(repo.path, (f) => {
      const ext = extname(f);
      return ['.ts', '.js', '.go'].includes(ext);
    }, 3000);

    const constMap = new Map<string, { name: string; filePath: string }>();

    for (const filePath of sourceFiles) {
      const content = safeReadFile(filePath);

      const patterns = [tsConstPattern, goConstPattern];
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
          const constName = match[1];
          const constValue = match[2];
          if (isInterestingConstant(constValue) && !constMap.has(constValue)) {
            constMap.set(constValue, { name: constName, filePath });
          }
        }
      }
    }
    repoConstants.set(repo.name, constMap);
  }

  const repoNames = [...repoConstants.keys()];
  for (let i = 0; i < repoNames.length; i++) {
    for (let j = i + 1; j < repoNames.length; j++) {
      const nameA = repoNames[i];
      const nameB = repoNames[j];
      const constsA = repoConstants.get(nameA)!;
      const constsB = repoConstants.get(nameB)!;
      for (const [value, infoA] of constsA) {
        const infoB = constsB.get(value);
        if (infoB) {
          edges.push({
            sourceRepo: nameA,
            sourceNode: `${infoA.filePath}::${infoA.name}`,
            targetRepo: nameB,
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
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------
export async function detectCrossRepoEdges(
  repos: Array<{ name: string; path: string; language: string }>,
  workspaceMaps?: Map<string, WorkspaceMap>,
): Promise<CrossRepoEdge[]> {
  const allEdges: CrossRepoEdge[] = [];

  const strategies: Array<{ name: string; fn: () => CrossRepoEdge[] }> = [
    { name: 'shared-npm-deps', fn: () => detectSharedNpmDeps(repos) },
    { name: 'shared-types', fn: () => detectSharedTypes(repos) },
    { name: 'env-var-correlation', fn: () => detectEnvVarCorrelation(repos) },
    { name: 'event-schemas', fn: () => detectEventSchemas(repos) },
    { name: 'api-endpoints', fn: () => detectApiEndpoints(repos) },
    { name: 'workspace-deps', fn: () => detectWorkspaceDeps(repos, workspaceMaps) },
    { name: 'grpc-services', fn: () => detectGrpcServices(repos) },
    { name: 'database-schemas', fn: () => detectDatabaseSchemas(repos) },
    { name: 'redis-key-patterns', fn: () => detectRedisKeyPatterns(repos) },
    { name: 's3-buckets', fn: () => detectS3Buckets(repos) },
    { name: 'openapi-schemas', fn: () => detectOpenApiSchemas(repos) },
    { name: 'docker-compose-links', fn: () => detectDockerComposeLinks(repos) },
    { name: 'k8s-service-refs', fn: () => detectK8sServiceRefs(repos) },
    { name: 'shared-constants', fn: () => detectSharedConstants(repos) },
  ];

  for (const strategy of strategies) {
    try {
      const edges = strategy.fn();
      allEdges.push(...edges);
    } catch {
      // Individual strategy failure should not block others
    }
  }

  return allEdges;
}
