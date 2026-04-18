#!/usr/bin/env node
/**
 * Code Search MCP — multi-repo code intelligence via MCP.
 *
 * DEFAULT MODE (remote proxy):
 *   code-search-mcp                                  # uses CODE_SEARCH_SERVER env
 *   code-search-mcp --remote https://server:3100     # explicit server URL
 *
 * LOCAL MODE (self-hosted, has repos + index locally):
 *   code-search-mcp --local /path/to/repos           # index local repos
 *   code-search-mcp --local github:org-name           # clone from GitHub
 *   code-search-mcp --serve                           # HTTP server mode
 *
 * Environment:
 *   CODE_SEARCH_SERVER            — remote server URL (default mode)
 *   CODE_SEARCH_API_KEY           — API key for remote server
 *   GITHUB_TOKEN                  — for private repos (local mode)
 *   OLLAMA_HOST                   — Ollama endpoint (local mode)
 */

import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);

// ── Parse arguments ──────────────────────────────────────────────────

let mode: 'remote' | 'local' | 'serve' = 'remote'; // DEFAULT: remote proxy
let remoteUrl: string | null = null;
let apiKey: string | undefined;
let source: string | null = null;
let projectName: string | null = null;
let githubToken: string | undefined;
let force = false;
let port: string | undefined;
let transport: string | undefined;
let authMode: string | undefined;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--remote' && args[i + 1]) {
    mode = 'remote';
    remoteUrl = args[++i];
  } else if (args[i] === '--local') {
    mode = 'local';
    // Next arg might be a source path (if it doesn't start with --)
    if (args[i + 1] && !args[i + 1].startsWith('--')) {
      source = args[++i];
    }
  } else if (args[i] === '--serve') {
    mode = 'serve';
  } else if (args[i] === '--api-key' && args[i + 1]) {
    apiKey = args[++i];
  } else if (args[i] === '--project' && args[i + 1]) {
    projectName = args[++i];
  } else if (args[i] === '--token' && args[i + 1]) {
    githubToken = args[++i];
  } else if (args[i] === '--force') {
    force = true;
  } else if (args[i] === '--port' && args[i + 1]) {
    port = args[++i];
  } else if (args[i] === '--transport' && args[i + 1]) {
    transport = args[++i];
  } else if (args[i] === '--auth' && args[i + 1]) {
    authMode = args[++i];
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.error(`
Code Search MCP — multi-repo code intelligence via MCP

REMOTE MODE (default — connects to a deployed server):
  code-search-mcp                                    Uses CODE_SEARCH_SERVER env
  code-search-mcp --remote https://server:3100       Explicit server URL
  code-search-mcp --remote https://server:3100 --api-key sk-xxx

  Environment:
    CODE_SEARCH_SERVER              Remote server URL
    CODE_SEARCH_API_KEY             API key for authentication

  Claude Desktop config:
    {
      "mcpServers": {
        "code-search": {
          "command": "code-search-mcp",
          "env": {
            "CODE_SEARCH_SERVER": "https://your-server:3100",
            "CODE_SEARCH_API_KEY": "your-api-key"
          }
        }
      }
    }

LOCAL MODE (self-hosted — indexes repos locally):
  code-search-mcp --local /path/to/repos             Index local directory
  code-search-mcp --local github:org-name             Clone from GitHub org
  code-search-mcp --local --project my-project        Serve existing index

  Options:
    --project <name>        Project name (default: derived from source)
    --token <token>         GitHub token (or GITHUB_TOKEN env)
    --force                 Force full re-index

SERVER MODE (deploy as HTTP service):
  code-search-mcp --serve                             Start HTTP server
  code-search-mcp --serve --port 3100 --auth api-key

  Options:
    --port <port>           HTTP port (default: 3100)
    --auth <mode>           none | api-key | jwt
    --transport <mode>      streamable-http | sse

  Environment:
    CODE_SEARCH_TRANSPORT           streamable-http | sse
    CODE_SEARCH_PORT                HTTP port (default: 3100)
    CODE_SEARCH_AUTH_MODE           none | api-key | jwt
    CODE_SEARCH_AUTH_API_KEYS       Comma-separated API keys
    CODE_SEARCH_EMBEDDING_PROVIDER  auto | codestral | openai | voyage | ollama | custom
    CODE_SEARCH_EMBEDDING_API_KEY   Unified embedding API key
    CODE_SEARCH_DATA_DIR            Data directory override
`);
    process.exit(0);
  } else if (!args[i].startsWith('-')) {
    // Bare arg — could be a source path or a remote URL
    const arg = args[i];
    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      mode = 'remote';
      remoteUrl = arg;
    } else {
      // Treat as local source for backward compat
      mode = 'local';
      source = arg;
    }
  }
}

// ── Execute ──────────────────────────────────────────────────────────

(async () => {
  try {
    // ── REMOTE MODE (default) ──────────────────────────────────────
    if (mode === 'remote') {
      const serverUrl = remoteUrl
        ?? process.env.CODE_SEARCH_SERVER
        ?? process.env.CODE_SEARCH_REMOTE_URL;

      const key = apiKey
        ?? process.env.CODE_SEARCH_API_KEY
        ?? process.env.CODE_SEARCH_AUTH_API_KEY;

      if (!serverUrl) {
        console.error(`[code-search-mcp] No remote server configured.

Set CODE_SEARCH_SERVER environment variable:
  export CODE_SEARCH_SERVER=https://your-server:3100

Or pass it directly:
  code-search-mcp --remote https://your-server:3100

For local use (self-hosted with repos on this machine):
  code-search-mcp --local /path/to/repos

For help:
  code-search-mcp --help
`);
        process.exit(1);
      }

      const { startRemoteProxy } = await import('./transports/remote-proxy.js');
      await startRemoteProxy({ serverUrl, apiKey: key });
      return;
    }

    // ── SERVE MODE (HTTP server) ───────────────────────────────────
    if (mode === 'serve') {
      if (port) process.env.CODE_SEARCH_PORT = port;
      if (authMode) process.env.CODE_SEARCH_AUTH_MODE = authMode;
      process.env.CODE_SEARCH_TRANSPORT = transport === 'sse' ? 'sse' : 'streamable-http';

      const { startServer } = await import('./server.js');
      await startServer(projectName ?? 'default', source ? resolve(source) : null);
      return;
    }

    // ── LOCAL MODE (stdio with local repos) ────────────────────────
    let directoryPath: string | null = null;

    if (source?.startsWith('github:')) {
      const { cloneOrUpdateOrg } = await import('./sources/github-org.js');
      const spec = source.replace('github:', '');
      const slashIdx = spec.indexOf('/');
      const org = slashIdx > 0 ? spec.slice(0, slashIdx) : spec;
      const pattern = slashIdx > 0 ? spec.slice(slashIdx + 1) : undefined;

      if (!projectName) projectName = org;

      console.error(`[code-search-mcp] Cloning repos from github:${org}${pattern ? `/${pattern}` : ''}...`);
      const repos = await cloneOrUpdateOrg(org, {
        pattern,
        token: githubToken,
        onProgress: (m) => console.error(m),
      });
      console.error(`[code-search-mcp] ${repos.length} repos ready`);

      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      directoryPath = join(homedir(), '.code-search', org);

    } else if (source) {
      directoryPath = resolve(source);
      if (!existsSync(directoryPath)) {
        console.error(`[code-search-mcp] Directory not found: ${directoryPath}`);
        process.exit(1);
      }
      if (!projectName) {
        projectName = directoryPath.split('/').filter(Boolean).pop() || 'project';
      }

    } else if (!projectName) {
      directoryPath = process.cwd();
      projectName = directoryPath.split('/').filter(Boolean).pop() || 'project';
    }

    const { startServer } = await import('./server.js');
    await startServer(projectName!, directoryPath);
  } catch (err) {
    console.error(`[code-search-mcp] Fatal:`, err);
    process.exit(1);
  }
})();
