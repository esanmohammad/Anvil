/**
 * Dashboard server — Hivemind/Swarm pattern.
 *
 * The dashboard IS the orchestrator. It uses:
 *   - ProjectLoader for project configuration (discovery, workspace setup)
 *   - FeatureStore for artifact persistence
 *   - PipelineRunner for multi-stage orchestration with per-repo parallelism
 *   - AgentManager for spawning Claude agents
 *
 * Architecture:
 *   HTTP server serves static files from dist/
 *   WebSocket server on same port via upgrade handler
 *   File watcher (fs.watch + polling) on state.json and runs/index.jsonl
 *   Full state broadcast on every change
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import {
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  mkdirSync,
  watch as fsWatch,
  appendFileSync,
  statSync,
} from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { spawn, execSync, ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// @ts-ignore — ws is a runtime dependency
import { WebSocketServer, WebSocket } from 'ws';

import { AgentManager } from './agent-manager.js';
import type { AgentState } from './agent-manager.js';
import type { AgentActivity } from './agent-process.js';
import { PipelineRunner } from './pipeline-runner.js';
import type { PipelineRunState } from './pipeline-runner.js';
import { ProjectLoader } from './project-loader.js';
import type { ProjectRepo } from './project-loader.js';
import { FeatureStore } from './feature-store.js';
import type { FeatureRecord } from './feature-store.js';
import { MemoryStore } from './memory-store.js';
import type { MemoryTarget } from './memory-store.js';
import { KnowledgeBaseManager } from './knowledge-base-manager.js';
import type { KBProjectStatus, KBRefreshProgress } from './knowledge-base-manager.js';
import { discoverProviders, invalidateProviderCache } from './provider-registry.js';

// ── Paths ───────────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ANVIL_HOME = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
const SYSTEMS_DIR = join(ANVIL_HOME, 'projects');
const RUNS_DIR = join(ANVIL_HOME, 'runs');
const RUNS_INDEX = join(RUNS_DIR, 'index.jsonl');
const STATE_FILE = join(ANVIL_HOME, 'state.json');

// ── Load saved API keys from ~/.anvil/.env ──────────────────────────────
// Security: only load known API key variable names (prevent env injection of PATH, NODE_OPTIONS, etc.)
const ALLOWED_ENV_KEYS = new Set([
  'OPENAI_API_KEY', 'GOOGLE_API_KEY', 'GEMINI_API_KEY',
  'OPENROUTER_API_KEY', 'COHERE_API_KEY', 'VOYAGE_API_KEY',
  'MISTRAL_API_KEY', 'GITHUB_TOKEN', 'OLLAMA_HOST',
  'ANTHROPIC_API_KEY',
]);
try {
  const envPath = join(ANVIL_HOME, '.env');
  if (existsSync(envPath)) {
    const envContent = readFileSync(envPath, 'utf-8');
    let loaded = 0;
    for (const line of envContent.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx < 1) continue;
      const key = trimmed.slice(0, eqIdx);
      const val = trimmed.slice(eqIdx + 1);
      if (ALLOWED_ENV_KEYS.has(key) && !process.env[key]) {
        process.env[key] = val;
        loaded++;
      }
    }
    if (loaded > 0) console.log(`[dashboard] Loaded ${loaded} API key(s) from ${envPath}`);
  }
} catch { /* ok — no .env file */ }

// ── MIME map ────────────────────────────────────────────────────────────
const MIME: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

// ── Types ───────────────────────────────────────────────────────────────
export interface ProjectSummary {
  name: string;
  title: string;
  owner: string;
  lifecycle: string;
  repoCount: number;
  repos?: Array<{ name: string; language: string; github: string }>;
}

export interface RunSummary {
  id: string;
  project: string;
  feature: string;
  featureSlug?: string;
  status: string;
  model?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  totalCost?: number;
  stages: number;
  completedStages: number;
  repos: string[];
  prUrls?: string[];
  runType?: string;      // 'build' | 'fix' | 'spike'
  output?: string;       // stored output for detail view
  stageDetails?: Array<{
    name: string;
    label: string;
    status: string;
    cost: number;
    startedAt: string | null;
    completedAt: string | null;
    error: string | null;
  }>;
}

export interface DashboardStageState {
  name: string;
  label?: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting';
  startedAt?: string;
  completedAt?: string;
  error?: string;
  cost?: number;
  perRepo?: boolean;
  repos?: Array<{
    repoName: string;
    agentId: string | null;
    status: string;
    cost: number;
    error: string | null;
  }>;
}

export interface DashboardPipeline {
  runId: string;
  project: string;
  feature: string;
  featureSlug?: string;
  status: 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting';
  currentStage: number;
  stages: DashboardStageState[];
  startedAt: string;
  cost: { inputTokens: number; outputTokens: number; estimatedCost: number };
  model?: string;
  repoNames?: string[];
  waitingForInput?: boolean;
}

export interface DashboardState {
  activePipeline: DashboardPipeline | null;
  lastUpdated: string;
}

export interface ServerMessage {
  type: string;
  payload: unknown;
}

export interface ClientMessage {
  action: string;
  project?: string;
  feature?: string;
  runId?: string;
  text?: string;
  agentId?: string;
  stage?: number;
  reason?: string;
  fromStage?: string;
  slug?: string;
  query?: string;
  maxChunks?: number;
  referenceAnswer?: string;
  benchModel?: string;
  provider?: string;
  model?: string;
  path?: string;
  force?: boolean;
  maxPerRun?: number;           // budget: max per run
  maxPerDay?: number;           // budget: max per day
  alertAt?: number;             // budget: alert threshold
  key?: string;                 // API key value for set-auth-key
  options?: {
    skipClarify?: boolean;
    skipShip?: boolean;
    model?: string;
    models?: Record<string, string>;
    approvalRequired?: boolean;
    baseBranch?: string;
    repo?: string;
    level?: string;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Read workspace path from factory.yaml / project.yaml for a project. */
function getWorkspaceFromConfig(project: string): string | null {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const candidates = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];
  for (const configPath of candidates) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const wsMatch = raw.match(/^workspace:\s+(.+)$/m);
      if (wsMatch) {
        return wsMatch[1].replace(/^["']|["']$/g, '').trim().replace(/^~/, homedir());
      }
    } catch { /* ignore */ }
  }
  return null;
}

// ── Model discovery (delegates to provider-registry) ─────────────────────

interface AvailableModelsResult {
  providers: Array<{
    name: string;
    displayName: string;
    type: string;
    available: boolean;
    models: string[];
    tier: string;
    envVar?: string;
    binary?: string;
    setupHint?: string;
    capabilities: string[];
  }>;
  defaultModel: string;
  defaultProvider: string;
}

async function discoverAvailableModels(): Promise<AvailableModelsResult> {
  const discovery = await discoverProviders();
  return {
    providers: discovery.providers.map(p => ({
      name: p.name,
      displayName: p.displayName,
      type: p.type,
      available: p.available,
      models: p.models.map(m => m.id),
      tier: p.capabilities.includes('agentic') ? 'agentic' : p.capabilities.includes('chat') ? 'chat' : 'embedding',
      envVar: p.envVar,
      binary: p.binary,
      setupHint: p.setupHint,
      capabilities: p.capabilities,
    })),
    defaultModel: discovery.defaultModel,
    defaultProvider: discovery.defaultProvider,
  };
}

// ── Data loaders ────────────────────────────────────────────────────────
function loadRunsSync(): RunSummary[] {
  if (!existsSync(RUNS_INDEX)) return [];
  try {
    const content = readFileSync(RUNS_INDEX, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    return lines.map((line) => {
      const r = JSON.parse(line);
      const stages = Array.isArray(r.stages) ? r.stages : [];
      return {
        id: r.id,
        project: r.project,
        feature: r.feature,
        featureSlug: r.featureSlug,
        status: r.status,
        model: r.model,
        startedAt: new Date(r.createdAt).getTime(),
        completedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : undefined,
        durationMs: r.durationMs,
        totalCost: r.totalCost,
        stages: stages.length,
        completedStages: stages.filter((s: any) => s.status === 'completed').length,
        repos: r.repoNames ?? stages.flatMap((s: any) =>
          (s.repos ?? []).map((rp: any) => typeof rp === 'string' ? rp : rp.repoName),
        ),
        prUrls: r.prUrls ?? [],
        runType: r.type ?? 'build',  // 'build' | 'fix' | 'spike'
        output: r.output,            // stored output for detail view
        stageDetails: stages.map((s: any) => ({
          name: s.name,
          label: s.label ?? s.name,
          status: s.status,
          cost: s.cost ?? 0,
          startedAt: s.startedAt ?? null,
          completedAt: s.completedAt ?? null,
          error: s.error ?? null,
        })),
      };
    }).reverse(); // newest first
  } catch {
    return [];
  }
}

function readStateFile(): DashboardState {
  try {
    const raw = readFileSync(STATE_FILE, 'utf-8');
    return JSON.parse(raw) as DashboardState;
  } catch {
    return { activePipeline: null, lastUpdated: new Date().toISOString() };
  }
}

// ── Static file server ──────────────────────────────────────────────────
function serveStatic(staticDir: string, kbManagerRef?: { current: KnowledgeBaseManager | null }) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Serve knowledge base graph.html: /api/kb/:project/:repo/graph.html
    const kbMatch = url.pathname.match(/^\/api\/kb\/([^/]+)\/([^/]+)\/graph\.html$/);
    if (kbMatch && kbManagerRef?.current) {
      const htmlPath = kbManagerRef.current.getGraphHtmlPath(kbMatch[1], kbMatch[2]);
      if (htmlPath) {
        try {
          const data = await readFile(htmlPath);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(data);
          return;
        } catch { /* fall through */ }
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Knowledge graph not found');
      return;
    }

    // Security: resolve and validate path to prevent directory traversal
    const requestedPath = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    let filePath = resolve(staticDir, requestedPath);
    const resolvedStatic = resolve(staticDir);
    if (!filePath.startsWith(resolvedStatic + '/') && filePath !== resolvedStatic) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    try {
      const s = await stat(filePath);
      if (s.isDirectory()) filePath = join(filePath, 'index.html');
    } catch {
      filePath = join(staticDir, 'index.html');
    }

    try {
      const data = await readFile(filePath);
      const ext = extname(filePath);
      res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    }
  };
}

// ── Dashboard server ────────────────────────────────────────────────────
export interface DashboardServerOptions {
  port?: number;
  staticDir: string;
  open?: boolean;
}

export async function startDashboardServer(opts: DashboardServerOptions): Promise<void> {
  const port = opts.port ?? 5173;
  const kbManagerRef: { current: KnowledgeBaseManager | null } = { current: null };
  const handler = serveStatic(opts.staticDir, kbManagerRef);
  const server = createServer(handler);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  // ── Shared services ─────────────────────────────────────────────────
  const projectLoader = new ProjectLoader();
  const featureStore = new FeatureStore();
  const agentManager = new AgentManager();
  const memoryStore = new MemoryStore();
  const kbManager = new KnowledgeBaseManager(projectLoader);
  kbManagerRef.current = kbManager;

  // ── Clean up stale "running" state from previous crashes ────────────
  {
    const staleState = readStateFile();
    if (staleState.activePipeline) {
      staleState.activePipeline = null;
      staleState.lastUpdated = new Date().toISOString();
      try {
        const tmp = STATE_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(staleState, null, 2), 'utf-8');
        renameSync(tmp, STATE_FILE);
        console.log('[dashboard] Cleared stale pipeline state');
      } catch { /* ignore */ }
    }
  }

  // ── PR tracking ─────────────────────────────────────────────────────
  interface TrackedPR {
    id: string;
    title: string;
    repo: string;
    author: string;
    status: 'draft' | 'open' | 'in_review' | 'merged';
    url: string;
    createdAt: number;
    updatedAt: number;
    additions: number;
    deletions: number;
    reviewers: string[];
    labels: string[];
  }

  const trackedPRs = new Map<string, TrackedPR>();

  /** Extract PR URLs from text (GitHub PR URLs) */
  function extractPRUrls(text: string): string[] {
    const matches = text.match(/https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+/g);
    return matches ? [...new Set(matches)] : [];
  }

  /** Fetch PR details using gh CLI */
  async function fetchPRDetails(prUrl: string): Promise<TrackedPR | null> {
    try {
      const result = execSync(
        `gh pr view "${prUrl}" --json number,title,headRepository,author,state,url,createdAt,updatedAt,additions,deletions,reviewRequests,labels,isDraft,reviewDecision`,
        { timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'] },
      ).toString();

      const data = JSON.parse(result);

      let status: TrackedPR['status'] = 'open';
      if (data.isDraft) status = 'draft';
      else if (data.state === 'MERGED') status = 'merged';
      else if (data.state === 'CLOSED') status = 'closed' as TrackedPR['status'];
      else if (data.reviewDecision === 'APPROVED' || data.reviewDecision === 'CHANGES_REQUESTED' ||
               (data.reviewRequests && data.reviewRequests.length > 0)) status = 'in_review';

      const repoName = data.headRepository?.name ??
        prUrl.match(/github\.com\/[^/]+\/([^/]+)/)?.[1] ?? 'unknown';

      return {
        id: prUrl,
        title: data.title ?? `PR #${data.number}`,
        repo: repoName,
        author: data.author?.login ?? 'anvil',
        status,
        url: data.url ?? prUrl,
        createdAt: data.createdAt ? new Date(data.createdAt).getTime() : Date.now(),
        updatedAt: data.updatedAt ? new Date(data.updatedAt).getTime() : Date.now(),
        additions: data.additions ?? 0,
        deletions: data.deletions ?? 0,
        reviewers: (data.reviewRequests ?? []).map((r: any) => r.login ?? r.name ?? '').filter(Boolean),
        labels: (data.labels ?? []).map((l: any) => l.name ?? '').filter(Boolean),
      };
    } catch (err) {
      console.warn(`[dashboard] Failed to fetch PR details for ${prUrl}:`, err instanceof Error ? err.message : err);
      return null;
    }
  }

  /** Refresh all tracked PRs and broadcast updates */
  async function refreshTrackedPRs(): Promise<void> {
    if (trackedPRs.size === 0) return;

    let changed = false;
    for (const [url] of trackedPRs) {
      const updated = await fetchPRDetails(url);
      if (updated) {
        const existing = trackedPRs.get(url);
        if (!existing || existing.status !== updated.status || existing.updatedAt !== updated.updatedAt) {
          trackedPRs.set(url, updated);
          changed = true;
        }
      }
    }

    if (changed) {
      broadcast({ type: 'prs', payload: Array.from(trackedPRs.values()) });
    }
  }

  /** Track a new PR URL — fetch details and broadcast */
  async function trackPR(prUrl: string): Promise<void> {
    if (trackedPRs.has(prUrl)) return; // already tracking

    const pr = await fetchPRDetails(prUrl);
    if (pr) {
      trackedPRs.set(prUrl, pr);
      broadcast({ type: 'prs', payload: Array.from(trackedPRs.values()) });
    }
  }

  // Refresh PR statuses every 30 seconds
  setInterval(() => { refreshTrackedPRs().catch(() => {}); }, 30_000);

  /** Scan feature store artifacts (SHIP.md, feature.json) for PR URLs on startup */
  async function loadPRsFromFeatureStore(): Promise<void> {
    try {
      const allFeatures = featureStore.listFeatures();
      const prUrls = new Set<string>();

      for (const f of allFeatures) {
        // Check prUrls in feature.json
        if (f.prUrls && f.prUrls.length > 0) {
          for (const url of f.prUrls) prUrls.add(url);
        }

        // Check SHIP.md artifact for PR URLs
        const shipMd = featureStore.readArtifact(f.project, f.slug, 'SHIP.md');
        if (shipMd) {
          const urls = extractPRUrls(shipMd);
          for (const url of urls) prUrls.add(url);
        }
      }

      if (prUrls.size > 0) {
        console.log(`[dashboard] Found ${prUrls.size} PR URLs in feature store, tracking...`);
        for (const url of prUrls) {
          await trackPR(url);
        }
      }
    } catch (err) {
      console.warn('[dashboard] Failed to load PRs from feature store:', err);
    }
  }

  // ── Pipeline tracking ───────────────────────────────────────────────
  let activeChild: ChildProcess | null = null;
  let outputBuffer: Array<{
    timestamp: number;
    stage: string;
    type: 'stdout' | 'stderr';
    content: string;
    kind?: string;
    tool?: string;
    agentId?: string;
    repo?: string;
  }> = [];
  let activePipelineRunner: PipelineRunner | null = null;

  // ── Active runs tracker (multi-run support) ────────────────────────
  interface ActiveRun {
    id: string;
    type: 'build' | 'fix' | 'spike';
    project: string;
    description: string;
    model: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: number;
    agentId?: string;            // for quick actions
    activities: typeof outputBuffer;  // per-run output
    prUrls: Set<string>;         // PRs created by this specific run
  }

  const activeRuns = new Map<string, ActiveRun>();

  /** Map agentId → runId for quick action agents */
  const agentToRunId = new Map<string, string>();

  function broadcastActiveRuns(): void {
    const list = Array.from(activeRuns.values()).map((r) => ({
      id: r.id,
      type: r.type,
      project: r.project,
      description: r.description,
      model: r.model,
      status: r.status,
      startedAt: r.startedAt,
      activityCount: r.activities.length,
    }));
    broadcast({ type: 'active-runs', payload: list });
  }

  // ── Agent Manager events ────────────────────────────────────────────
  // Only broadcast structured activities — NOT raw agent-output (which duplicates text)
  agentManager.on('agent-activity', ({ agentId, activity }) => {
    const repo = resolveAgentRepo(agentId);
    const stage = resolveAgentStage(agentId);
    const entry = {
      timestamp: activity.timestamp,
      stage: stage || 'agent',
      type: 'stdout' as const,
      content: activity.content || activity.summary,  // full content, not just summary
      kind: activity.kind,
      tool: activity.tool,
      agentId,
      repo,
    };
    outputBuffer.push(entry);

    // Also store in per-run buffer
    const runId = agentToRunId.get(agentId);
    if (runId) {
      const run = activeRuns.get(runId);
      if (run) run.activities.push(entry);
    }

    broadcast({ type: 'agent-output', payload: { entries: [entry], runId } });

    // Detect PR URLs in agent output and track them per-run
    const content = activity.content || activity.summary;
    const prUrls = extractPRUrls(content);
    if (prUrls.length > 0) {
      const run = runId ? activeRuns.get(runId) : null;
      for (const url of prUrls) {
        trackPR(url).catch(() => {});
        if (run) run.prUrls.add(url);
      }
    }
  });

  // Show user messages (from sendInput) in the output stream
  agentManager.on('agent-output', ({ agentId, chunk }) => {
    // Only broadcast user messages (they start with "> User:")
    if (chunk.includes('> User:')) {
      const stage = resolveAgentStage(agentId);
      const entry = {
        timestamp: Date.now(),
        stage: stage || 'agent',
        type: 'stdout' as const,
        content: chunk.trim(),
        kind: 'user-message',
        agentId,
      };
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry] } });
    }
  });

  agentManager.on('agent-done', ({ agent }) => {
    broadcast({ type: 'agent-done', payload: { agentId: agent.id, agent } });

    // Persist active run to RUNS_INDEX
    const runId = agentToRunId.get(agent.id);
    const activeRun = runId ? activeRuns.get(runId) : null;
    if (activeRun) {
      // Skip for pipeline-managed agents — their lifecycle is handled by
      // pipeline-complete / pipeline-fail events. Individual stage agents
      // finishing (e.g. clarify agent done generating questions) should NOT
      // mark the entire pipeline run as completed.
      if (activeRun.type === 'build' && activePipelineRunner) {
        agentToRunId.delete(agent.id);
        return;
      }

      activeRun.status = agent.status === 'done' ? 'completed' : 'failed';

      const runRecord = {
        id: activeRun.id,
        project: activeRun.project,
        feature: activeRun.description,
        featureSlug: '',
        status: activeRun.status,
        model: activeRun.model,
        type: activeRun.type,
        createdAt: new Date(activeRun.startedAt).toISOString(),
        updatedAt: new Date().toISOString(),
        durationMs: Date.now() - activeRun.startedAt,
        totalCost: agent.cost.totalUsd,
        repoNames: [],
        prUrls: [],
        stages: [{
          name: activeRun.type,
          label: activeRun.type === 'fix' ? 'Bug Fix' : 'Research',
          status: activeRun.status,
          cost: agent.cost.totalUsd,
          startedAt: new Date(activeRun.startedAt).toISOString(),
          completedAt: new Date().toISOString(),
          error: agent.error,
          repos: [],
        }],
        output: agent.output?.slice(0, 50000) ?? '',
      };

      try {
        if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
        appendFileSync(RUNS_INDEX, JSON.stringify(runRecord) + '\n', 'utf-8');
      } catch { /* */ }

      broadcastRuns();
      broadcastActiveRuns();

      // Auto-save learnings to memory store
      if (agent.status === 'done' && agent.output) {
        try {
          const output = agent.output;
          const summary = output.length > 500 ? output.slice(0, 500) + '...' : output;
          const prefix = activeRun.type === 'spike' ? 'Research' : 'Fix';
          memoryStore.add(activeRun.project, 'memory', `[${prefix}: ${activeRun.description}]\n${summary}`);
        } catch { /* */ }
      }

      // Remove from active runs immediately — completed runs go to history
      activeRuns.delete(activeRun.id);
      agentToRunId.delete(agent.id);
      broadcastActiveRuns();
    }
  });

  agentManager.on('agent-error', ({ agentId, error }) => {
    // Broadcast error as an activity so it shows in the output panel
    const stage = resolveAgentStage(agentId);
    const errorEntry = {
      timestamp: Date.now(),
      stage: stage || 'agent',
      type: 'stderr' as const,
      content: `Error: ${error}`,
      kind: 'stderr',
      agentId,
    };
    outputBuffer.push(errorEntry);
    broadcast({ type: 'agent-output', payload: { entries: [errorEntry] } });
    broadcast({ type: 'agent-error', payload: { agentId, error } });
  });

  // Resolve which repo an agent belongs to (from pipeline state)
  function resolveAgentRepo(agentId: string): string | undefined {
    if (!activePipelineRunner) return undefined;
    const state = activePipelineRunner.getState();
    for (const stage of state.stages) {
      for (const repo of stage.repos) {
        if (repo.agentId === agentId) return repo.repoName;
      }
    }
    return undefined;
  }

  function resolveAgentStage(agentId: string): string | undefined {
    if (!activePipelineRunner) return undefined;
    const state = activePipelineRunner.getState();
    for (const stage of state.stages) {
      if (stage.agentId === agentId) return stage.name;
      for (const repo of stage.repos) {
        if (repo.agentId === agentId) return stage.name;
      }
    }
    return undefined;
  }

  // ── Last known state (for dedup) ────────────────────────────────────
  let lastStateJson = '';

  // ── Broadcast helpers ───────────────────────────────────────────────
  function broadcast(msg: ServerMessage): void {
    const raw = JSON.stringify(msg);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  }

  function broadcastState(): void {
    const state = readStateFile();
    const json = JSON.stringify(state);
    if (json === lastStateJson) return;
    lastStateJson = json;
    broadcast({ type: 'state', payload: state });
  }

  // ── Send full init payload to a single client ───────────────────────
  async function sendInit(ws: WebSocket): Promise<void> {
    try {
      // Load projects and discover models in parallel to avoid waterfalls
      const [projects, availableModels] = await Promise.all([
        projectLoader.listProjects(),
        discoverAvailableModels().catch(() => ({ providers: [], defaultModel: 'claude-sonnet-4-6', defaultProvider: 'claude' }) as AvailableModelsResult),
      ]);

      const projectInfos: ProjectSummary[] = projects.map((s) => ({
        name: s.name,
        title: s.title,
        owner: s.owner,
        lifecycle: s.lifecycle,
        repoCount: s.repos.length,
        repos: s.repos.map((r) => ({ name: r.name, language: r.language, github: r.github })),
      }));

      const runs = loadRunsSync();
      const features = featureStore.listFeatures();
      const state = readStateFile();
      lastStateJson = JSON.stringify(state);

      ws.send(JSON.stringify({
        type: 'init',
        payload: {
          projects: projectInfos, runs, state, features,
          prs: Array.from(trackedPRs.values()),
          activeRuns: Array.from(activeRuns.values()).map((r) => ({
            id: r.id, type: r.type, project: r.project, description: r.description,
            model: r.model, status: r.status, startedAt: r.startedAt,
            activityCount: r.activities.length,
          })),
          availableModels,
        },
      }));

      // Send accumulated output
      if (outputBuffer.length > 0) {
        ws.send(JSON.stringify({
          type: 'agent-output',
          payload: { entries: outputBuffer },
        }));
      }
    } catch (err) {
      console.error('[dashboard] Error sending init:', err);
    }
  }

  // ── File watchers ───────────────────────────────────────────────────
  function startStateWatcher(): void {
    try {
      if (existsSync(ANVIL_HOME)) {
        fsWatch(ANVIL_HOME, (eventType, filename) => {
          if (filename === 'state.json') broadcastState();
        });
      }
    } catch {
      console.warn('[dashboard] Could not fs.watch ANVIL_HOME');
    }
    setInterval(() => broadcastState(), 1000);
  }

  function startRunsWatcher(): void {
    let lastRunsSize = 0;
    try {
      if (existsSync(RUNS_INDEX)) lastRunsSize = statSync(RUNS_INDEX).size;
    } catch { /* ignore */ }

    try {
      if (existsSync(RUNS_DIR)) {
        fsWatch(RUNS_DIR, async (_, filename) => {
          if (filename === 'index.jsonl') broadcastRuns();
        });
      }
    } catch { /* ignore */ }

    setInterval(() => {
      try {
        if (!existsSync(RUNS_INDEX)) return;
        const size = statSync(RUNS_INDEX).size;
        if (size !== lastRunsSize) {
          lastRunsSize = size;
          broadcastRuns();
        }
      } catch { /* ignore */ }
    }, 2000);
  }

  function broadcastRuns(): void {
    try {
      const runs = loadRunsSync();
      broadcast({ type: 'runs', payload: runs });
    } catch { /* ignore */ }
  }

  // ── Client connection (origin-checked) ──────────────────────────────
  wss.on('connection', async (ws: any, req: any) => {
    // Security: validate WebSocket origin to prevent cross-site WebSocket hijacking
    const origin = req?.headers?.origin ?? '';
    const allowedOrigins = [
      `http://localhost:${port}`,
      `http://127.0.0.1:${port}`,
      'http://localhost:5173',  // Vite dev server
      'http://127.0.0.1:5173',
    ];
    if (origin && !allowedOrigins.includes(origin)) {
      console.warn(`[dashboard] Rejected WebSocket from unauthorized origin: ${origin}`);
      ws.close(4403, 'Forbidden: unauthorized origin');
      return;
    }

    clients.add(ws);
    await sendInit(ws);

    ws.on('message', async (raw: Buffer) => {
      try {
        const msg: ClientMessage = JSON.parse(raw.toString());
        await handleClientMessage(ws, msg);
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => clients.delete(ws));
  });

  // ── Client message handler ──────────────────────────────────────────
  async function handleClientMessage(ws: WebSocket, msg: ClientMessage): Promise<void> {
    switch (msg.action) {
      case 'get-state': {
        await sendInit(ws);
        break;
      }

      case 'get-projects': {
        // Reuse sendInit which already has correct repo counts
        await sendInit(ws);
        break;
      }

      case 'get-features': {
        const features = featureStore.listFeatures(msg.project);
        ws.send(JSON.stringify({ type: 'features', payload: features }));
        break;
      }

      case 'get-runs': {
        const runs = loadRunsSync();
        ws.send(JSON.stringify({ type: 'runs', payload: runs }));
        break;
      }

      case 'run-pipeline': {
        if (!msg.project || !msg.feature) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and feature are required' } }));
          return;
        }
        startPipeline(msg.project, msg.feature, msg.options);
        break;
      }

      case 'resume-pipeline': {
        // Resume a failed/stopped/cancelled pipeline from where it left off
        const runId = (msg as any).runId as string;
        // Also support resume by featureSlug (from checkpoint discovery)
        const resumeSlug = (msg as any).featureSlug as string | undefined;
        const resumeProject = msg.project;

        if (!runId && !resumeSlug) break;

        // Strategy 1: Try checkpoint file first (most accurate, survives crashes)
        let checkpoint: import('./pipeline-runner.js').PipelineCheckpoint | null = null;
        if (resumeSlug && resumeProject) {
          const { readCheckpoint } = await import('./pipeline-runner.js');
          const featureDir = featureStore.getFeatureDir(resumeProject, resumeSlug);
          checkpoint = readCheckpoint(featureDir);
        }

        // Strategy 2: Fall back to RUNS_INDEX
        let prevRun: RunSummary | undefined;
        if (!checkpoint && runId) {
          const allRuns = loadRunsSync();
          prevRun = allRuns.find((r) => r.id === runId);
          // Also try checkpoint for this run's feature
          if (prevRun?.featureSlug) {
            const { readCheckpoint } = await import('./pipeline-runner.js');
            const featureDir = featureStore.getFeatureDir(prevRun.project, prevRun.featureSlug);
            checkpoint = readCheckpoint(featureDir);
          }
        }

        if (!checkpoint && !prevRun) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Run ${runId || resumeSlug} not found. No checkpoint or run record available.` } }));
          break;
        }

        // Determine resume point from checkpoint or run record
        const stages = checkpoint?.stages ?? prevRun?.stageDetails ?? [];
        const failedIdx = stages.findIndex((s: any) => s.status === 'failed');
        const pendingIdx = stages.findIndex((s: any) => s.status === 'pending');
        const runningIdx = stages.findIndex((s: any) => s.status === 'running');

        let resumeFrom: number;
        let failureContext: string;

        if (failedIdx >= 0) {
          resumeFrom = failedIdx;
          const failedStage = stages[failedIdx];
          failureContext = `Stage "${failedStage.label}" failed${failedStage.error ? ': ' + failedStage.error : ''}. Fix the issues and continue.`;
        } else if (runningIdx >= 0) {
          resumeFrom = runningIdx;
          failureContext = `Pipeline was interrupted during "${stages[runningIdx].label}". Continue from where it left off.`;
        } else if (pendingIdx >= 0) {
          resumeFrom = pendingIdx;
          failureContext = `Pipeline was stopped before "${stages[pendingIdx].label}". Continue from this stage.`;
        } else {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'All stages already completed. Nothing to resume.' } }));
          break;
        }

        // Restore original config from checkpoint when available
        const cpConfig = checkpoint?.config;
        const project = checkpoint?.project ?? prevRun?.project ?? resumeProject ?? '';
        const feature = checkpoint?.feature ?? prevRun?.feature ?? '';
        const slug = checkpoint?.featureSlug ?? prevRun?.featureSlug ?? resumeSlug ?? '';
        const model = cpConfig?.model ?? prevRun?.model ?? msg.options?.model ?? 'claude-sonnet-4-6';

        console.log(`[dashboard] Resuming "${feature}" from stage ${resumeFrom} (${stages[resumeFrom]?.name ?? 'unknown'}) [source: ${checkpoint ? 'checkpoint' : 'runs-index'}]`);

        startPipeline(project, feature, {
          model,
          baseBranch: cpConfig?.baseBranch ?? msg.options?.baseBranch,
          skipClarify: resumeFrom > 0,
          skipShip: cpConfig?.skipShip,
          resumeFromStage: resumeFrom,
          featureSlug: slug,
          failureContext,
        });
        break;
      }

      case 'cancel-pipeline': {
        if (activePipelineRunner) {
          activePipelineRunner.cancel();
          activePipelineRunner = null;
        } else {
          cancelLegacyPipeline();
        }
        break;
      }

      case 'send-input': {
        if (msg.text) {
          // First try pipeline runner's interactive input (clarify waiting)
          if (activePipelineRunner) {
            activePipelineRunner.provideInput(msg.text);
          } else if (msg.agentId) {
            try { agentManager.sendInput(msg.agentId, msg.text); } catch { /* */ }
          } else if (activeChild?.stdin) {
            activeChild.stdin.write(msg.text + '\n');
          }
        }
        break;
      }

      case 'spawn-agent': {
        if (msg.project && msg.feature) {
          const configWs = getWorkspaceFromConfig(msg.project);
          const cwd = (configWs && existsSync(configWs))
            ? configWs
            : join(process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace'), msg.project);
          // Inject KB into project prompt if not already provided
          let agentProjectPrompt = (msg as any).projectPrompt as string | undefined;
          if (!agentProjectPrompt) {
            const indexPrompt = kbManager.getIndexForPrompt(msg.project);
            let kbContent = '';
            if (indexPrompt) {
              const queryCtx = kbManager.getQueryContextForPrompt(msg.project, msg.feature);
              kbContent = `${indexPrompt}\n\n---\n\n${queryCtx}`;
            } else {
              kbContent = kbManager.getAllGraphReports(msg.project);
            }
            if (kbContent) {
              agentProjectPrompt = `You are a senior engineer working on the "${msg.project}" project.\n\n## Codebase Knowledge Graph\nCRITICAL: Read and use this pre-computed architectural analysis BEFORE exploring files. It is your primary source of understanding.\n\n${kbContent}`;
            }
          }
          const agentState = agentManager.spawn({
            name: (msg as any).name ?? 'agent',
            persona: (msg as any).persona ?? 'engineer',
            project: msg.project,
            stage: (msg as any).stage ?? 'general',
            prompt: msg.feature,
            model: msg.options?.model ?? 'claude-sonnet-4-6',
            cwd,
            projectPrompt: agentProjectPrompt,
          });
          ws.send(JSON.stringify({ type: 'agent-spawned', payload: agentState }));
        }
        break;
      }

      case 'kill-agent': {
        if (msg.agentId) agentManager.kill(msg.agentId);
        break;
      }

      case 'stop-run': {
        const runId = (msg as any).runId as string;
        if (!runId) break;

        const run = activeRuns.get(runId);
        if (run) {
          // Kill the agent(s) for this run
          if (run.agentId) {
            agentManager.kill(run.agentId);
          }
          // For build runs, also cancel the pipeline runner
          if (run.type === 'build' && activePipelineRunner) {
            activePipelineRunner.cancel();
          }
          // Kill any agents mapped to this run
          for (const [agentId, rid] of agentToRunId.entries()) {
            if (rid === runId) {
              agentManager.kill(agentId);
            }
          }

          run.status = 'failed';

          // Persist the stopped run so it can be resumed later
          if (run.type !== 'build') {
            // Quick actions — persist to RUNS_INDEX
            try {
              const runRecord = {
                id: run.id,
                project: run.project,
                feature: run.description,
                featureSlug: '',
                status: 'cancelled',
                model: run.model,
                type: run.type,
                createdAt: new Date(run.startedAt).toISOString(),
                updatedAt: new Date().toISOString(),
                durationMs: Date.now() - run.startedAt,
                totalCost: 0,
                repoNames: [],
                prUrls: [],
                stages: [{ name: run.type, label: run.type === 'fix' ? 'Bug Fix' : 'Research', status: 'cancelled', cost: 0, startedAt: new Date(run.startedAt).toISOString(), completedAt: new Date().toISOString(), error: 'Stopped by user', repos: [] }],
              };
              if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
              appendFileSync(RUNS_INDEX, JSON.stringify(runRecord) + '\n', 'utf-8');
            } catch { /* */ }
          }
          // Build runs are persisted by the pipeline-fail handler via cancel()

          activeRuns.delete(runId);
          broadcastActiveRuns();
          broadcastRuns();
          broadcast({ type: 'run-stopped', payload: { runId } });
        }
        break;
      }

      case 'get-active-runs': {
        broadcastActiveRuns();
        break;
      }

      case 'get-run': {
        const runId = (msg as any).runId as string;
        if (!runId) break;

        // 1. Check active runs (in memory — has live activities)
        const activeRun = activeRuns.get(runId);
        if (activeRun) {
          ws.send(JSON.stringify({
            type: 'run-data',
            payload: {
              id: activeRun.id,
              type: activeRun.type,
              project: activeRun.project,
              description: activeRun.description,
              model: activeRun.model,
              status: activeRun.status,
              startedAt: activeRun.startedAt,
              activities: activeRun.activities,
            },
          }));
          break;
        }

        // 2. Fall back to RUNS_INDEX (persisted — has output + stage details)
        const allRuns = loadRunsSync();
        const historicRun = allRuns.find((r) => r.id === runId);
        if (historicRun) {
          ws.send(JSON.stringify({
            type: 'run-data',
            payload: {
              id: historicRun.id,
              type: historicRun.runType ?? 'build',
              project: historicRun.project,
              description: historicRun.feature,
              model: historicRun.model,
              status: historicRun.status,
              startedAt: historicRun.startedAt,
              totalCost: historicRun.totalCost,
              durationMs: historicRun.durationMs,
              stageDetails: historicRun.stageDetails,
              prUrls: historicRun.prUrls,
              output: historicRun.output,
              // No live activities for historic runs — use stored output
              activities: [],
            },
          }));
          break;
        }

        // 3. Check feature store runs directory
        try {
          const features = featureStore.listFeatures();
          for (const f of features) {
            const runPath = join(ANVIL_HOME, 'features', f.project, f.slug, 'runs', `${runId}.json`);
            if (existsSync(runPath)) {
              const runData = JSON.parse(readFileSync(runPath, 'utf-8'));
              ws.send(JSON.stringify({ type: 'run-data', payload: { ...runData, activities: [] } }));
              break;
            }
          }
        } catch { /* */ }

        break;
      }

      case 'get-overview': {
        const sysName = msg.project ?? '';
        const overview = await buildProjectOverview(sysName);
        ws.send(JSON.stringify({ type: 'overview', payload: overview }));
        break;
      }

      case 'memory-add': {
        const project = msg.project ?? '';
        const target = (msg as any).target as MemoryTarget ?? 'memory';
        const content = (msg as any).content as string ?? '';
        const result = memoryStore.add(project, target, content);
        ws.send(JSON.stringify({ type: 'memory-result', payload: result }));
        // Refresh overview
        buildProjectOverview(project).then((o) => ws.send(JSON.stringify({ type: 'overview', payload: o })));
        break;
      }

      case 'memory-replace': {
        const project = msg.project ?? '';
        const target = (msg as any).target as MemoryTarget ?? 'memory';
        const oldText = (msg as any).oldText as string ?? '';
        const content = (msg as any).content as string ?? '';
        const result = memoryStore.replace(project, target, oldText, content);
        ws.send(JSON.stringify({ type: 'memory-result', payload: result }));
        buildProjectOverview(project).then((o) => ws.send(JSON.stringify({ type: 'overview', payload: o })));
        break;
      }

      case 'memory-remove': {
        const project = msg.project ?? '';
        const target = (msg as any).target as MemoryTarget ?? 'memory';
        const oldText = (msg as any).oldText as string ?? '';
        const result = memoryStore.remove(project, target, oldText);
        ws.send(JSON.stringify({ type: 'memory-result', payload: result }));
        buildProjectOverview(project).then((o) => ws.send(JSON.stringify({ type: 'overview', payload: o })));
        break;
      }

      case 'refresh-prs': {
        refreshTrackedPRs().then(() => {
          ws.send(JSON.stringify({ type: 'prs', payload: Array.from(trackedPRs.values()) }));
        }).catch(() => {});
        break;
      }

      case 'get-kb-data': {
        const project = msg.project ?? '';
        const repo = (msg as any).repo as string ?? '';
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project is required' } }));
          return;
        }
        const report = repo === '__system__'
          ? kbManager.getProjectReport(project)
          : repo
            ? kbManager.getGraphReport(project, repo)
            : kbManager.getAllGraphReports(project);
        const hasHtml = (repo && repo !== '__system__') ? !!kbManager.getGraphHtmlPath(project, repo) : false;
        kbManager.getStatus(project).then((status) => {
          ws.send(JSON.stringify({
            type: 'kb-data',
            payload: { project, repo: repo || null, report, hasHtml, status },
          }));
        }).catch(() => {
          ws.send(JSON.stringify({
            type: 'kb-data',
            payload: { project, repo: repo || null, report, hasHtml, status: null },
          }));
        });
        break;
      }

      case 'query-kb': {
        const project = msg.project ?? '';
        const query = (msg as any).query as string ?? '';
        const maxChars = (msg as any).maxChars as number | undefined;
        if (!project || !query) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and query are required for query-kb' } }));
          break;
        }
        try {
          const result = kbManager.queryKnowledgeBase(project, query, maxChars);
          ws.send(JSON.stringify({ type: 'kb-query-result', payload: result }));
        } catch (err: any) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: err.message } }));
        }
        break;
      }

      case 'get-kb-index': {
        const project = msg.project ?? '';
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project is required' } }));
          break;
        }
        const index = kbManager.getProjectIndex(project);
        ws.send(JSON.stringify({ type: 'kb-index', payload: index }));
        break;
      }

      case 'get-kb-status': {
        const project = msg.project ?? '';
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project is required' } }));
          return;
        }
        kbManager.getStatus(project).then((status) => {
          ws.send(JSON.stringify({ type: 'kb-status', payload: status }));
        }).catch((err) => {
          ws.send(JSON.stringify({ type: 'error', payload: { message: err.message } }));
        });
        break;
      }

      case 'refresh-knowledge-base': {
        const project = msg.project ?? '';
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project is required' } }));
          return;
        }
        if (kbManager.isRefreshing()) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Knowledge base refresh already in progress' } }));
          return;
        }
        // Run async, broadcast progress to all clients
        kbManager.refreshProject(project, (progress: KBRefreshProgress) => {
          broadcast({ type: 'kb-progress', payload: progress });
        }).then((status) => {
          broadcast({ type: 'kb-status', payload: status });
        }).catch((err) => {
          broadcast({ type: 'kb-status', payload: { project, repos: [], overallStatus: 'unavailable', lastRefreshed: null, error: err.message } });
        });
        ws.send(JSON.stringify({ type: 'kb-refresh-started', payload: { project } }));
        break;
      }

      case 'build-project-graph': {
        const project = msg.project ?? '';
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project is required' } }));
          return;
        }
        broadcast({ type: 'project-graph-started', payload: { project } });

        // Run async — broadcast progress
        (async () => {
          try {
            const { buildProjectGraph } = await import(
              '@anvil-dev/cli/knowledge/project-graph-builder' as string
            );

            // Find factory.yaml path
            const { homedir: getHome } = await import('node:os');
            const { join: joinPath } = await import('node:path');
            const { existsSync: fsExists } = await import('node:fs');
            const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || joinPath(getHome(), '.anvil');
            const factoryPath = [
              joinPath(anvilHome, 'projects', project, 'factory.yaml'),
              joinPath(anvilHome, 'projects', project, 'project.yaml'),
            ].find((p: string) => fsExists(p));

            if (!factoryPath) {
              throw new Error(`No factory.yaml found for project "${project}"`);
            }

            const graph = await buildProjectGraph(project, factoryPath, {
              provider: msg.provider,
              model: msg.model,
              onProgress: (message: string) => {
                broadcast({ type: 'project-graph-progress', payload: { project, message } });
              },
            });

            broadcast({
              type: 'project-graph-complete',
              payload: {
                project,
                generatedAt: graph.meta.generatedAt,
                model: graph.meta.model,
                provider: graph.meta.provider,
                costUsd: graph.meta.costUsd,
                repoRoles: Object.keys(graph.repoRoles).length,
                relationships: graph.relationships.length,
                keyFlows: graph.keyFlows.length,
              },
            });
          } catch (err: any) {
            broadcast({
              type: 'project-graph-error',
              payload: { project, error: err?.message ?? String(err) },
            });
          }
        })();
        break;
      }

      case 'get-project-graph-status': {
        const project = msg.project ?? '';
        try {
          const { getProjectGraphStatus, loadProjectSummary } = await import(
            '@anvil-dev/cli/knowledge/project-graph-builder' as string
          );
          const status = getProjectGraphStatus(project);
          const summary = status.exists ? loadProjectSummary(project) : null;
          ws.send(JSON.stringify({
            type: 'project-graph-status',
            payload: { ...status, summary },
          }));
        } catch {
          ws.send(JSON.stringify({
            type: 'project-graph-status',
            payload: { exists: false, generatedAt: null, model: null, costUsd: null, summary: null },
          }));
        }
        break;
      }

      case 'get-graph-nodes': {
        // Serve graph.json data for the force-graph visualization
        const project = msg.project ?? '';
        const repo = msg.options?.repo ?? '';
        const level = msg.options?.level ?? 'project'; // 'project' | 'repo'

        try {
          const { join: joinPath } = await import('node:path');
          const { existsSync: fsExists, readFileSync: fsRead, readdirSync: fsReaddir } = await import('node:fs');
          const { homedir: getHome } = await import('node:os');
          const kbDir = joinPath(
            process.env.ANVIL_HOME || process.env.FF_HOME || joinPath(getHome(), '.anvil'),
            'knowledge-base', project,
          );

          if (level === 'repo' && repo) {
            // Return per-repo graph.json
            const graphPath = joinPath(kbDir, repo, 'graph.json');
            if (fsExists(graphPath)) {
              const graphData = JSON.parse(fsRead(graphPath, 'utf-8'));
              ws.send(JSON.stringify({ type: 'graph-nodes', payload: { level: 'repo', repo, data: graphData } }));
            } else {
              ws.send(JSON.stringify({ type: 'graph-nodes', payload: { level: 'repo', repo, data: { nodes: [], links: [] } } }));
            }
          } else {
            // Return project-level data: PROJECT_GRAPH.json if exists, else repo stats
            const projectGraphPath = joinPath(kbDir, 'PROJECT_GRAPH.json');
            let projectGraph: any = null;
            if (fsExists(projectGraphPath)) {
              try { projectGraph = JSON.parse(fsRead(projectGraphPath, 'utf-8')); } catch {}
            }

            // Collect repo stats from metadata (supports both metadata.json and index_meta.json)
            const repoStats: Array<{ repoName: string; nodeCount: number }> = [];
            if (fsExists(kbDir)) {
              for (const entry of fsReaddir(kbDir)) {
                const entryDir = joinPath(kbDir, entry);
                // Try metadata.json first (old KB manager), then index_meta.json (new indexer)
                const metaPath = fsExists(joinPath(entryDir, 'metadata.json'))
                  ? joinPath(entryDir, 'metadata.json')
                  : joinPath(entryDir, 'index_meta.json');
                // Also check for graph.json to count nodes
                const graphPath = joinPath(entryDir, 'graph.json');
                if (fsExists(metaPath) || fsExists(graphPath)) {
                  try {
                    let nodeCount = 0;
                    if (fsExists(metaPath)) {
                      const meta = JSON.parse(fsRead(metaPath, 'utf-8'));
                      nodeCount = meta.nodeCount ?? meta.chunkCount ?? 0;
                    }
                    if (fsExists(graphPath) && nodeCount === 0) {
                      const graph = JSON.parse(fsRead(graphPath, 'utf-8'));
                      nodeCount = graph.nodes?.length ?? 0;
                    }
                    repoStats.push({ repoName: entry, nodeCount });
                  } catch {}
                }
              }
            }

            // Enrich with cross-repo edges from system_graph.json or system_graph_v2.json
            const sysGraphPath = fsExists(joinPath(kbDir, 'system_graph_v2.json'))
              ? joinPath(kbDir, 'system_graph_v2.json')
              : joinPath(kbDir, 'system_graph.json');
            if (fsExists(sysGraphPath)) {
              try {
                const sysGraph = JSON.parse(fsRead(sysGraphPath, 'utf-8'));
                const sysEdges = sysGraph.edges ?? [];
                const repoSet = new Set(repoStats.map((r: any) => r.repoName));

                // Extract unique repo-to-repo relationships from system_graph edges
                const crossRepoEdges: Array<{ from: string; to: string; type: string; description: string; criticality: string; direction: string }> = [];
                const seenEdges = new Set<string>();

                for (const edge of sysEdges) {
                  // Support both flat format (system_graph.json) and Graphology format (system_graph_v2.json)
                  const attrs = edge.attributes ?? edge;
                  const rel = attrs.relation ?? attrs.type ?? '';
                  const transport = attrs.transport ?? '';
                  const srcRepo = (edge.source ?? '').split('::')[0];
                  const tgtRepo = (edge.target ?? '').split('::')[0];

                  if (srcRepo && tgtRepo && srcRepo !== tgtRepo && repoSet.has(srcRepo) && repoSet.has(tgtRepo)) {
                    const key = `${srcRepo}->${tgtRepo}::${rel || transport}`;
                    if (!seenEdges.has(key)) {
                      seenEdges.add(key);
                      crossRepoEdges.push({
                        from: srcRepo,
                        to: tgtRepo,
                        type: transport ? 'async-event' : rel.includes('http') ? 'sync-http' : 'shared-types',
                        description: transport || rel || 'cross-repo',
                        criticality: 'medium',
                        direction: 'unidirectional',
                      });
                    }
                  }
                }

                // Merge into projectGraph if it exists, or create a minimal one
                if (crossRepoEdges.length > 0) {
                  if (!projectGraph) {
                    projectGraph = { relationships: crossRepoEdges };
                  } else {
                    projectGraph.relationships = [
                      ...(projectGraph.relationships ?? []),
                      ...crossRepoEdges,
                    ];
                  }
                }
              } catch {}
            }

            ws.send(JSON.stringify({
              type: 'graph-nodes',
              payload: { level: 'project', projectGraph, repoStats },
            }));
          }
        } catch (err: any) {
          ws.send(JSON.stringify({ type: 'graph-nodes', payload: { level, data: { nodes: [], links: [] }, error: err?.message } }));
        }
        break;
      }


      case 'run-fix':
      case 'run-review':
      case 'run-spike': {
        if (!msg.project || !msg.feature) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and description required' } }));
          return;
        }
        spawnQuickAction(msg.action as 'run-fix' | 'run-review' | 'run-spike', msg.project, msg.feature, msg.options?.model);
        break;
      }

      case 'get-interrupted-pipelines': {
        try {
          const { findInterruptedPipelines } = await import('./pipeline-runner.js');
          const interrupted = findInterruptedPipelines(ANVIL_HOME);
          ws.send(JSON.stringify({
            type: 'interrupted-pipelines',
            payload: {
              pipelines: interrupted.map((cp) => ({
                runId: cp.runId,
                project: cp.project,
                feature: cp.feature,
                featureSlug: cp.featureSlug,
                model: cp.config.model,
                baseBranch: cp.config.baseBranch,
                currentStage: cp.currentStage,
                stageName: cp.stages[cp.currentStage]?.name ?? 'unknown',
                stageLabel: cp.stages[cp.currentStage]?.label ?? 'Unknown',
                totalCost: cp.totalCost,
                startedAt: cp.startedAt,
                error: cp.stages[cp.currentStage]?.error ?? 'Pipeline was interrupted',
              })),
            },
          }));
        } catch {
          ws.send(JSON.stringify({ type: 'interrupted-pipelines', payload: { pipelines: [] } }));
        }
        break;
      }

      case 'get-branches': {
        const project = msg.project ?? '';
        try {
          const configWs = getWorkspaceFromConfig(project);
          const workspace = configWs || join(ANVIL_HOME, 'workspaces', project);

          if (!existsSync(workspace)) {
            ws.send(JSON.stringify({ type: 'branches', payload: { branches: ['main'], default: 'main' } }));
            break;
          }

          // Find the first git repo in the workspace
          let gitDir = workspace;
          try {
            const repoPaths = projectLoader.getRepoLocalPaths(project);
            const firstPath = Object.values(repoPaths)[0];
            if (firstPath && existsSync(join(firstPath, '.git'))) gitDir = firstPath;
          } catch { /* use workspace root */ }

          // Fetch remote branches
          try {
            execSync('git fetch --prune 2>/dev/null', { cwd: gitDir, timeout: 15000, stdio: 'pipe' });
          } catch { /* ok */ }

          const raw = execSync('git branch -r --no-color 2>/dev/null || echo "  origin/main"', {
            cwd: gitDir, timeout: 5000, stdio: 'pipe',
          }).toString();

          const branches = raw.split('\n')
            .map((b) => b.trim())
            .filter((b) => b && !b.includes('->'))  // skip HEAD -> origin/main
            .map((b) => b.replace(/^origin\//, ''))
            .filter((b) => b)
            .sort((a, b) => {
              // Sort: main/master first, then alphabetically
              if (a === 'main' || a === 'master') return -1;
              if (b === 'main' || b === 'master') return 1;
              return a.localeCompare(b);
            });

          // Detect default branch
          const defaultBranch = branches.includes('main') ? 'main'
            : branches.includes('master') ? 'master'
            : branches[0] || 'main';

          ws.send(JSON.stringify({ type: 'branches', payload: { branches, default: defaultBranch } }));
        } catch {
          ws.send(JSON.stringify({ type: 'branches', payload: { branches: ['main'], default: 'main' } }));
        }
        break;
      }

      case 'get-providers': {
        const discovery = await discoverProviders();
        ws.send(JSON.stringify({
          type: 'providers',
          payload: {
            providers: discovery.providers.map(p => ({
              name: p.name,
              displayName: p.displayName,
              type: p.type,
              envVar: p.envVar,
              binary: p.binary,
              available: p.available,
              tier: p.capabilities.includes('agentic') ? 'agentic' : 'chat',
              capabilities: p.capabilities,
              setupHint: p.setupHint,
            })),
          },
        }));
        break;
      }

      case 'get-available-models': {
        try {
          const modelData = await discoverAvailableModels();
          ws.send(JSON.stringify({ type: 'available-models', payload: modelData }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Model discovery failed: ${message}` } }));
        }
        break;
      }

      case 'get-budget-status': {
        try {
          const budgetConfig = projectLoader.getBudgetConfig(msg.project ?? '');
          // Get today's spending from run records
          let todaySpent = 0;
          try {
            const indexPath = join(ANVIL_HOME, 'runs', 'index.jsonl');
            if (existsSync(indexPath)) {
              const content = readFileSync(indexPath, 'utf-8');
              const todayStr = new Date().toISOString().slice(0, 10);
              for (const line of content.split('\n').filter((l) => l.trim())) {
                try {
                  const rec = JSON.parse(line);
                  if (msg.project && rec.project && rec.project !== msg.project) continue;
                  if (!rec.createdAt || !rec.createdAt.startsWith(todayStr)) continue;
                  if (rec.totalCost?.estimatedCost > 0) todaySpent += rec.totalCost.estimatedCost;
                } catch { /* skip */ }
              }
            }
          } catch { /* ok */ }
          const modelConfig = projectLoader.getModelForStage ? {
            default: projectLoader.getModelForStage(msg.project ?? '', 'default'),
            build: projectLoader.getModelForStage(msg.project ?? '', 'build'),
            profiling: projectLoader.getModelForStage(msg.project ?? '', 'profiling'),
          } : {};

          ws.send(JSON.stringify({
            type: 'budget-status',
            payload: {
              maxPerRun: budgetConfig.max_per_run,
              maxPerDay: budgetConfig.max_per_day,
              alertAt: budgetConfig.alert_at,
              todaySpent,
              modelConfig,
            },
          }));
        } catch {
          ws.send(JSON.stringify({ type: 'budget-status', payload: { maxPerRun: 100, maxPerDay: 200, alertAt: 80, todaySpent: 0 } }));
        }
        break;
      }

      case 'set-budget': {
        try {
          const project = msg.project ?? '';
          if (!project) break;
          projectLoader.saveBudgetConfig(project, {
            max_per_run: msg.maxPerRun ?? 100,
            max_per_day: msg.maxPerDay ?? 200,
            alert_at: msg.alertAt ?? 80,
          });
          ws.send(JSON.stringify({ type: 'budget-saved', payload: { success: true } }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message } }));
        }
        break;
      }

      case 'get-conventions': {
        try {
          const conventionsMod = await import('@anvil-dev/cli/pipeline/conventions' as string);
          const rules = conventionsMod.loadConventionRules(msg.project ?? '');
          ws.send(JSON.stringify({ type: 'conventions', payload: { rules } }));
        } catch {
          ws.send(JSON.stringify({ type: 'conventions', payload: { rules: [] } }));
        }
        break;
      }

      case 'generate-conventions': {
        const project = msg.project ?? '';
        if (!project) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project is required' } }));
          break;
        }
        try {
          console.log(`[dashboard] Generating conventions for "${project}"...`);

          // Import the learn module and generate rules from codebase patterns
          const learnMod = await import('@anvil-dev/cli/learn/rule-generator' as string);
          const ciScanner = await import('@anvil-dev/cli/learn/ci-scanner' as string);
          const testScanner = await import('@anvil-dev/cli/learn/test-scanner' as string);

          // Resolve workspace path
          const workspace = getWorkspaceFromConfig(project) || join(ANVIL_HOME, 'workspaces', project);

          // Scan patterns from the workspace
          let ciConfigs: any[] = [];
          let testPatterns: any[] = [];
          try {
            if (existsSync(workspace)) {
              ciConfigs = ciScanner.scanCiConfigs?.(workspace) ?? [];
              testPatterns = testScanner.scanTestPatterns?.(workspace) ?? [];
            }
          } catch { /* scanning is best-effort */ }

          const rules = learnMod.generateRules({
            ciConfigs,
            testPatterns,
          });

          // Save the generated rules to ~/.anvil/conventions/rules/<project>/generated.json
          try {
            const rulesDir = join(ANVIL_HOME, 'conventions', 'rules', project);
            mkdirSync(rulesDir, { recursive: true });
            writeFileSync(join(rulesDir, 'generated.json'), JSON.stringify({ rules }, null, 2), 'utf-8');
            console.log(`[dashboard] Saved ${rules.length} rules to ${rulesDir}/generated.json`);
          } catch { /* saving is best-effort */ }

          console.log(`[dashboard] Generated ${rules.length} convention rules for "${project}"`);
          ws.send(JSON.stringify({ type: 'conventions', payload: { rules } }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[dashboard] Convention generation failed:`, message);
          ws.send(JSON.stringify({ type: 'conventions', payload: { rules: [] } }));
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Convention generation failed: ${message}` } }));
        }
        break;
      }

      case 'get-auth-status': {
        const discovery = await discoverProviders();
        const authProviders = discovery.providers
          .filter(p => p.type === 'api' && p.envVar)
          .map(p => ({
            name: p.name,
            envVar: p.envVar!,
            hasKey: p.available,
          }));
        ws.send(JSON.stringify({ type: 'auth-status', payload: { providers: authProviders } }));
        break;
      }

      case 'set-auth-key': {
        try {
          const provider = msg.provider ?? '';
          const key = msg.key ?? '';
          if (!provider || !key) {
            ws.send(JSON.stringify({ type: 'error', payload: { message: 'provider and key are required' } }));
            break;
          }

          // Map provider name to env var (match both registry names and short names)
          const envVarMap: Record<string, string> = {
            openai: 'OPENAI_API_KEY',
            gemini: 'GOOGLE_API_KEY',
            'gemini-api': 'GOOGLE_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
            cohere: 'COHERE_API_KEY',
            voyage: 'VOYAGE_API_KEY',
            mistral: 'MISTRAL_API_KEY',
          };
          const envVar = envVarMap[provider];
          if (!envVar) {
            ws.send(JSON.stringify({ type: 'error', payload: { message: `Unknown provider: ${provider}. Supported: ${Object.keys(envVarMap).join(', ')}` } }));
            break;
          }

          // Set in current process
          process.env[envVar] = key;

          // Persist to ~/.anvil/.env so it survives restarts
          const envFilePath = join(ANVIL_HOME, '.env');
          let envContent = '';
          try { envContent = readFileSync(envFilePath, 'utf-8'); } catch { /* new file */ }

          // Replace or append
          const lineRegex = new RegExp(`^${envVar}=.*$`, 'm');
          const newLine = `${envVar}=${key}`;
          if (lineRegex.test(envContent)) {
            envContent = envContent.replace(lineRegex, newLine);
          } else {
            envContent = envContent.trimEnd() + (envContent ? '\n' : '') + newLine + '\n';
          }
          mkdirSync(ANVIL_HOME, { recursive: true, mode: 0o700 });
          writeFileSync(envFilePath, envContent, { encoding: 'utf-8', mode: 0o600 });

          // Invalidate provider cache so next get-providers reflects changes
          invalidateProviderCache();

          console.log(`[dashboard] Set ${envVar} for provider "${provider}"`);
          ws.send(JSON.stringify({ type: 'auth-key-saved', payload: { provider, envVar, success: true } }));

          // Re-send providers so UI updates immediately
          const refreshed = await discoverProviders();
          ws.send(JSON.stringify({
            type: 'providers',
            payload: {
              providers: refreshed.providers.map(p => ({
                name: p.name,
                displayName: p.displayName,
                type: p.type,
                envVar: p.envVar,
                binary: p.binary,
                available: p.available,
                capabilities: p.capabilities,
                setupHint: p.setupHint,
              })),
            },
          }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Failed to save key: ${message}` } }));
        }
        break;
      }

      case 'test-auth': {
        const provider = msg.provider ?? '';
        if (!provider) {
          ws.send(JSON.stringify({ type: 'auth-test-result', payload: { provider, success: false, error: 'No provider specified' } }));
          break;
        }

        // Test provider by making a lightweight API call
        try {
          let success = false;
          let error = '';

          if (provider === 'openai') {
            const apiKey = process.env.OPENAI_API_KEY;
            if (!apiKey) { error = 'OPENAI_API_KEY not set'; }
            else {
              const res = await fetch('https://api.openai.com/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(10000),
              });
              success = res.ok;
              if (!success) error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
            }
          } else if (provider === 'gemini-api' || provider === 'gemini') {
            const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY;
            if (!apiKey) { error = 'GOOGLE_API_KEY not set'; }
            else {
              // Security: use Authorization header instead of query string param
              // (query params are logged in server access logs and proxy logs)
              const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models', {
                headers: { 'x-goog-api-key': apiKey },
                signal: AbortSignal.timeout(10000),
              });
              success = res.ok;
              if (!success) error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
            }
          } else if (provider === 'openrouter') {
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) { error = 'OPENROUTER_API_KEY not set'; }
            else {
              const res = await fetch('https://openrouter.ai/api/v1/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` },
                signal: AbortSignal.timeout(10000),
              });
              success = res.ok;
              if (!success) error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
            }
          } else if (provider === 'ollama') {
            const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
            try {
              const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
              success = res.ok;
              if (!success) error = 'Ollama not responding';
            } catch { error = 'Cannot connect to Ollama'; }
          } else {
            error = `Test not implemented for provider: ${provider}`;
          }

          console.log(`[dashboard] Test ${provider}: ${success ? 'OK' : error}`);
          ws.send(JSON.stringify({ type: 'auth-test-result', payload: { provider, success, error } }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'auth-test-result', payload: { provider, success: false, error: message } }));
        }
        break;
      }

      case 'approve-gate': {
        try {
          const stateMod = await import('@anvil-dev/cli/pipeline/state-file' as string);
          stateMod.clearPendingApproval();
          ws.send(JSON.stringify({ type: 'gate-approved', payload: { stage: msg.stage } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to approve gate' } }));
        }
        break;
      }


      default:
        break;
    }
  }

  // ── Run persistence ─────────────────────────────────────────────────

  /**
   * Persist a complete run record to both:
   *  1. RUNS_INDEX (global, for history list)
   *  2. FeatureStore (per-feature, for detailed analysis)
   *
   * Stores: stages, per-stage costs/timing, total cost, model, repos, PRs, duration
   */
  function persistRunRecord(state: PipelineRunState, runId?: string): void {
    const now = new Date().toISOString();
    const startTime = new Date(state.startedAt).getTime();
    const durationMs = Date.now() - startTime;

    // Collect PR URLs that belong to this specific run (not global)
    const activeRun = runId ? activeRuns.get(runId) : null;
    const prUrls = activeRun ? Array.from(activeRun.prUrls) : [];

    // Build comprehensive run record
    const runRecord = {
      id: state.runId,
      project: state.project,
      feature: state.feature,
      featureSlug: state.featureSlug,
      status: state.status,
      model: state.model,
      createdAt: state.startedAt,
      updatedAt: now,
      durationMs,
      totalCost: state.totalCost,
      repoNames: state.repoNames,
      prUrls,
      stages: state.stages.map((s) => ({
        name: s.name,
        label: s.label,
        status: s.status,
        cost: s.cost,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        error: s.error,
        perRepo: s.perRepo,
        repos: s.repos.map((r) => ({
          repoName: r.repoName,
          status: r.status,
          cost: r.cost,
          error: r.error,
        })),
      })),
    };

    // 1. Append to RUNS_INDEX (JSONL)
    try {
      if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
      appendFileSync(RUNS_INDEX, JSON.stringify(runRecord) + '\n', 'utf-8');
      console.log(`[dashboard] Run ${state.runId} persisted to ${RUNS_INDEX}`);
    } catch (err) {
      console.error('[dashboard] Failed to write run to index:', err);
    }

    // 2. Record in feature store (detailed per-feature history)
    try {
      featureStore.recordRun(state.project, state.featureSlug, state.runId, runRecord);
    } catch (err) {
      console.warn('[dashboard] Failed to record run in feature store:', err);
    }

    // 3. Update feature record with final status, cost, PRs
    try {
      featureStore.updateFeature(state.project, state.featureSlug, {
        status: state.status === 'completed' ? 'completed' : 'failed',
        totalCost: state.totalCost,
        prUrls,
        repos: state.repoNames,
      });
    } catch (err) {
      console.warn('[dashboard] Failed to update feature record:', err);
    }

    // 4. Auto-save learnings to memory store
    try {
      const project = state.project;
      const clarification = featureStore.readArtifact(project, state.featureSlug, 'CLARIFICATION.md');
      if (clarification && clarification.length > 50) {
        // Extract a concise learning from the clarification
        const summary = `[${state.feature}] Clarification learnings:\n${clarification.slice(0, 300)}`;
        memoryStore.add(project, 'memory', summary);
      }

      // Record the run outcome
      const outcome = state.status === 'completed'
        ? `[${state.feature}] Completed successfully. Cost: $${state.totalCost.toFixed(2)}, Model: ${state.model}, Repos: ${state.repoNames.join(', ')}`
        : `[${state.feature}] Failed at stage ${state.stages.find((s) => s.status === 'failed')?.label ?? 'unknown'}. Error: ${state.stages.find((s) => s.error)?.error?.slice(0, 100) ?? 'unknown'}`;
      memoryStore.add(project, 'memory', outcome);
    } catch (err) {
      console.warn('[dashboard] Failed to save memory:', err);
    }
  }

  // ── Project overview builder ─────────────────────────────────────────

  async function buildProjectOverview(projectName: string) {
    // Memory
    const memoryEntries = memoryStore.getEntries(projectName, 'memory');
    const userEntries = memoryStore.getEntries(projectName, 'user');
    const memories: Array<{ id: string; key: string; value: string; category: string; timestamp: number }> = [];

    for (let i = 0; i < memoryEntries.length; i++) {
      memories.push({
        id: `mem-${i}`,
        key: memoryEntries[i].split('\n')[0].slice(0, 80),
        value: memoryEntries[i],
        category: 'memory',
        timestamp: Date.now(),
      });
    }
    for (let i = 0; i < userEntries.length; i++) {
      memories.push({
        id: `user-${i}`,
        key: userEntries[i].split('\n')[0].slice(0, 80),
        value: userEntries[i],
        category: 'user',
        timestamp: Date.now(),
      });
    }

    // Repos from project config (cached 30s)
    let repos: Array<{ name: string; language: string }> = [];
    try {
      const allProjects = await projectLoader.listProjects();
      const sys = allProjects.find((s) => s.name === projectName);
      if (sys) {
        repos = sys.repos.map((r) => ({ name: r.name, language: r.language ?? '' }));
      }
    } catch { /* */ }

    // Features for this project
    const systemFeatures = featureStore.listFeatures(projectName).map((f) => ({
      slug: f.slug,
      description: f.description,
      status: f.status,
      totalCost: f.totalCost,
      updatedAt: f.updatedAt,
    }));

    // Conventions — empty for now, populated by ff learn
    const conventions: string[] = [];

    // Knowledge base status
    let kbStatus: KBProjectStatus | null = null;
    try {
      kbStatus = await kbManager.getStatus(projectName);
    } catch { /* ok */ }

    return { projectName, repos, memories, conventions, features: systemFeatures, kbStatus };
  }

  // ── Start pipeline (server-side orchestration) ──────────────────────
  function startPipeline(
    project: string,
    feature: string,
    options?: ClientMessage['options'] & {
      resumeFromStage?: number;
      featureSlug?: string;
      failureContext?: string;
    },
  ): void {
    // Kill any existing pipeline
    if (activePipelineRunner) activePipelineRunner.cancel();
    if (activeChild) { activeChild.kill('SIGTERM'); activeChild = null; }
    outputBuffer = [];

    const runner = new PipelineRunner(agentManager, projectLoader, featureStore, {
      project,
      feature,
      model: options?.model ?? 'claude-sonnet-4-6',
      baseBranch: options?.baseBranch,
      skipClarify: options?.skipClarify,
      skipShip: options?.skipShip,
      deploy: (options as any)?.deploy,
      resumeFromStage: options?.resumeFromStage,
      featureSlug: options?.featureSlug,
      failureContext: options?.failureContext,
    }, memoryStore, kbManager);

    activePipelineRunner = runner;

    // Register as active run — use own array, not shared outputBuffer
    const pipelineRunId = `build-${Date.now().toString(36)}`;
    const pipelineActivities: typeof outputBuffer = [];
    activeRuns.set(pipelineRunId, {
      id: pipelineRunId,
      type: 'build',
      project,
      description: feature,
      model: options?.model ?? 'claude-sonnet-4-6',
      status: 'running',
      startedAt: Date.now(),
      activities: pipelineActivities,
      prUrls: new Set(),
    });

    // Map all pipeline agents to this run ID as they're spawned
    const originalSpawn = agentManager.spawn.bind(agentManager);
    agentManager.spawn = (config: any) => {
      const agent = originalSpawn(config);
      agentToRunId.set(agent.id, pipelineRunId);
      return agent;
    };

    broadcastActiveRuns();

    // Broadcast pipeline state changes
    runner.on('state-change', (pipelineState: PipelineRunState) => {
      const dashState: DashboardState = {
        activePipeline: {
          runId: pipelineState.runId,
          project: pipelineState.project,
          feature: pipelineState.feature,
          featureSlug: pipelineState.featureSlug,
          status: pipelineState.status as DashboardPipeline['status'],
          currentStage: pipelineState.currentStage,
          stages: pipelineState.stages.map((s) => ({
            name: s.name,
            label: s.label,
            status: s.status,
            startedAt: s.startedAt ?? undefined,
            completedAt: s.completedAt ?? undefined,
            error: s.error ?? undefined,
            cost: s.cost,
            perRepo: s.perRepo,
            repos: s.repos.length > 0 ? s.repos.map((r) => ({
              repoName: r.repoName,
              agentId: r.agentId,
              status: r.status,
              cost: r.cost,
              error: r.error,
            })) : undefined,
          })),
          startedAt: pipelineState.startedAt,
          cost: { inputTokens: 0, outputTokens: 0, estimatedCost: pipelineState.totalCost },
          model: pipelineState.model,
          repoNames: pipelineState.repoNames,
          waitingForInput: pipelineState.waitingForInput,
        },
        lastUpdated: new Date().toISOString(),
      };

      // Write to state.json
      try {
        const tmp = STATE_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(dashState, null, 2), 'utf-8');
        renameSync(tmp, STATE_FILE);
      } catch { /* ignore */ }

      // Broadcast directly
      broadcast({ type: 'state', payload: dashState });
    });

    runner.on('waiting-for-input', (stageIndex: number, agentId: string) => {
      broadcast({ type: 'waiting-for-input', payload: { stageIndex, agentId } });
    });

    // Show clarify questions one at a time
    runner.on('clarify-question', (data: { stageIndex: number; questionIndex: number; totalQuestions: number; question: string }) => {
      const stageName = runner.getState().stages[data.stageIndex]?.name ?? 'clarify';
      const entry = {
        timestamp: Date.now(),
        stage: stageName,
        type: 'stdout' as const,
        content: `**Question ${data.questionIndex + 1} of ${data.totalQuestions}:**\n\n${data.question}`,
        kind: 'clarify-question',
      };
      pipelineActivities.push(entry);
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry], runId: pipelineRunId } });
    });

    // Show acknowledgment after user answers
    runner.on('clarify-ack', (data: { stageIndex: number; questionIndex: number; totalQuestions: number; hasMore: boolean }) => {
      const stageName = runner.getState().stages[data.stageIndex]?.name ?? 'clarify';
      const msg = data.hasMore
        ? `Got it! Moving to question ${data.questionIndex + 2} of ${data.totalQuestions}...`
        : `All ${data.totalQuestions} questions answered. Synthesizing understanding...`;
      const entry = {
        timestamp: Date.now(),
        stage: stageName,
        type: 'stdout' as const,
        content: msg,
        kind: 'clarify-ack',
      };
      pipelineActivities.push(entry);
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry], runId: pipelineRunId } });
    });

    // Show user input as a visible entry in the output
    runner.on('user-input', ({ stageIndex, text }: { stageIndex: number; text: string }) => {
      const stageName = runner.getState().stages[stageIndex]?.name ?? 'clarify';
      const entry = {
        timestamp: Date.now(),
        stage: stageName,
        type: 'stdout' as const,
        content: text,
        kind: 'user-message',
      };
      pipelineActivities.push(entry);
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry], runId: pipelineRunId } });
    });

    // Show pipeline warnings (e.g., missing KB)
    runner.on('warning', (data: { message: string }) => {
      const entry = {
        timestamp: Date.now(),
        stage: 'pipeline',
        type: 'stderr' as const,
        content: `⚠️ ${data.message}`,
        kind: 'project',
      };
      pipelineActivities.push(entry);
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry], runId: pipelineRunId } });
    });

    // Show integration events (KB injection, project context) in the output panel
    runner.on('project-event', (data: { source: string; message: string; level?: string }) => {
      const prefix = data.source === 'knowledge-base' ? '📚' : data.source === 'project-context' ? '🔌' : 'ℹ️';
      const entry = {
        timestamp: Date.now(),
        stage: 'pipeline',
        type: (data.level === 'warn' ? 'stderr' : 'stdout') as 'stderr' | 'stdout',
        content: `${prefix} [${data.source}] ${data.message}`,
        kind: 'project',
      };
      pipelineActivities.push(entry);
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry], runId: pipelineRunId } });
    });

    // Show artifacts in changes tab + scan ship artifacts for PR URLs
    runner.on('artifact-written', (data: { stage: string; file: string; summary: string; content: string; repo?: string }) => {
      // If this is the ship stage artifact, scan for PR URLs and associate with this run
      if (data.stage === 'ship' && data.content) {
        const prUrls = extractPRUrls(data.content);
        const run = activeRuns.get(pipelineRunId);
        for (const url of prUrls) {
          trackPR(url).catch(() => {});
          if (run) run.prUrls.add(url);
        }
      }
      const entry = {
        timestamp: Date.now(),
        stage: data.stage,
        type: 'stdout' as const,
        content: `Artifact: ${data.file}`,
        kind: 'artifact',
        repo: data.repo,
      };
      pipelineActivities.push(entry);
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry], runId: pipelineRunId } });
      // Also broadcast as a change entry
      broadcast({ type: 'artifact', payload: {
        file: data.file,
        stage: data.stage,
        summary: data.summary,
        repo: data.repo,
        timestamp: Date.now(),
      }});
    });

    runner.on('pipeline-complete', (pipelineState: PipelineRunState) => {
      persistRunRecord(pipelineState, pipelineRunId);
      activePipelineRunner = null;
      agentManager.spawn = originalSpawn; // restore original spawn
      const completedRun = activeRuns.get(pipelineRunId);
      if (completedRun) completedRun.status = 'completed';
      activeRuns.delete(pipelineRunId);
      broadcastActiveRuns();
      broadcastRuns();
    });

    runner.on('pipeline-fail', (pipelineState: PipelineRunState) => {
      persistRunRecord(pipelineState, pipelineRunId);
      activePipelineRunner = null;
      agentManager.spawn = originalSpawn;
      const failedRun = activeRuns.get(pipelineRunId);
      if (failedRun) failedRun.status = 'failed';
      activeRuns.delete(pipelineRunId);
      broadcastActiveRuns();
      broadcastRuns();
    });

    // Run the pipeline (async, non-blocking)
    runner.run().catch((err) => {
      console.error('[dashboard] Pipeline failed:', err);
      activePipelineRunner = null;
    });
  }

  // ── Quick action spawn (via AgentManager directly) ──────────────────
  function spawnQuickAction(
    actionType: 'run-fix' | 'run-review' | 'run-spike',
    project: string,
    description: string,
    model?: string,
  ): void {
    outputBuffer = [];

    // Resolve workspace: prefer factory.yaml config, then env var, then default
    let cwd: string;
    const configWorkspace = getWorkspaceFromConfig(project);
    if (configWorkspace && existsSync(configWorkspace)) {
      cwd = configWorkspace;
    } else {
      const wsRoot = process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace');
      cwd = join(wsRoot, project);
    }

    const actionLabel = actionType.replace('run-', '');

    // Create runId early so all broadcasts can include it
    const runId = `${actionLabel}-${Date.now().toString(36)}`;

    // Load knowledge graph — prefer index + query-matched context
    let kbReport = '';
    const indexPrompt = kbManager.getIndexForPrompt(project);
    if (indexPrompt) {
      const queryContext = kbManager.getQueryContextForPrompt(project, description);
      kbReport = `${indexPrompt}\n\n---\n\n${queryContext}`;
    } else {
      kbReport = kbManager.getAllGraphReports(project);
    }

    // Emit integration events to the output panel (with runId so they appear in the run view)
    if (kbReport) {
      const kbEntry = {
        timestamp: Date.now(),
        stage: actionLabel,
        type: 'stdout' as const,
        content: `📚 [knowledge-base] Knowledge Base loaded for "${project}" (${kbReport.length} chars, ${indexPrompt ? 'index + query-matched' : 'full blob'}) → injecting into ${actionLabel} agent`,
        kind: 'project',
      };
      outputBuffer.push(kbEntry);
      broadcast({ type: 'agent-output', payload: { entries: [kbEntry], runId } });
    } else {
      const kbEntry = {
        timestamp: Date.now(),
        stage: actionLabel,
        type: 'stderr' as const,
        content: `📚 [knowledge-base] No Knowledge Base available for "${project}" — ${actionLabel} agent will explore codebase manually`,
        kind: 'project',
      };
      outputBuffer.push(kbEntry);
      broadcast({ type: 'agent-output', payload: { entries: [kbEntry], runId } });
    }

    // Log workspace usage
    const wsEntry = {
      timestamp: Date.now(),
      stage: actionLabel,
      type: 'stdout' as const,
      content: `🔌 [project-context] Using workspace at ${cwd} for ${actionLabel} agent`,
      kind: 'project',
    };
    outputBuffer.push(wsEntry);
    broadcast({ type: 'agent-output', payload: { entries: [wsEntry], runId } });

    // Resolve which repos belong to this project
    const repoInfo = projectLoader.getRepoLocalPaths(project);
    const repoNames = Object.keys(repoInfo);
    const repoPaths = Object.entries(repoInfo).map(([name, path]) => `- ${name}: ${path}`).join('\n');

    // Project prompt — gives the agent its behavioral rules and KB context
    const projectPromptParts: string[] = [
      `You are a senior engineer working on the "${project}" project.`,
      `\n## Project Repos\nThis project has ${repoNames.length} repositories. ONLY work within these:\n${repoPaths}\n\nDo NOT explore or read files outside these directories. Ignore all other directories in the workspace.`,
    ];

    if (kbReport) {
      projectPromptParts.push(
        `\n## Codebase Knowledge Base\n` +
        `CRITICAL — KNOWLEDGE BASE AVAILABLE (${kbReport.length} chars):\n` +
        `The following is a pre-computed Knowledge Base for the "${project}" project. It contains:\n` +
        `1. **Project-level synthesis** (if available): Cross-repo dependencies, shared concepts, and architecture overview.\n` +
        `2. **Per-repo analysis**: AST-extracted modules, functions, imports, call graphs, and community clusters.\n\n` +
        `**MANDATORY rules when Knowledge Base is present:**\n` +
        `- Do NOT spawn sub-agents to explore the codebase. You already have the full architectural map.\n` +
        `- Do NOT run find, ls, tree commands to discover file structure. The KB already maps it.\n` +
        `- START your analysis by citing KB findings: "From the Knowledge Base, module X in repo Y handles Z..."\n` +
        `- ONLY read specific source files when you need exact implementation details (function bodies, config values) not in the KB.\n` +
        `- When you do read a file, explain why: "The KB shows module X exists but I need the exact retry logic..."\n\n` +
        `${kbReport}`
      );
    }

    // Load memories
    const projectMemory = memoryStore.formatForPrompt(project, 'memory');
    const userProfile = memoryStore.formatForPrompt(project, 'user');
    if (projectMemory || userProfile) {
      projectPromptParts.push(`\n## Memories\n${[projectMemory, userProfile].filter(Boolean).join('\n\n')}`);
    }

    const projectPrompt = projectPromptParts.join('\n');

    const kbInstructions = kbReport ? `
CRITICAL — KNOWLEDGE BASE AVAILABLE:
Your project prompt contains a comprehensive Knowledge Base (${kbReport.length} chars) with the full architectural map of the "${project}" project — modules, functions, imports, call graphs, cross-repo dependencies, and community clusters.

**You MUST follow these rules:**
1. Do NOT spawn sub-agents to explore the codebase. You already have the architectural map.
2. Do NOT run find, ls, tree, or grep commands to discover files. The KB already tells you what exists and where.
3. START your analysis by citing what the KB reveals about the relevant modules. For example: "From the Knowledge Base, the module X in repo Y handles Z via function W..."
4. ONLY read a specific source file when you need exact implementation details (specific function body, config values, error handling logic) that the KB summary doesn't cover.
5. When you do read a file, explain WHY the KB wasn't sufficient: "The KB shows module X exists but I need to check the exact retry logic in line N..."

` : '';

    const promptMap: Record<string, string> = {
      'run-fix': `Fix the following issue:\n\n${description}\n${kbInstructions}\nFollow these steps in order:\n1. ${kbReport ? 'Review the Knowledge Base in your project prompt to identify affected modules and dependencies\n2. ' : ''}Find the root cause of the issue\n${kbReport ? '3' : '2'}. Implement the fix\n${kbReport ? '4' : '3'}. Run tests to verify the fix works and nothing is broken\n${kbReport ? '5' : '4'}. Create a feature branch: git checkout -b anvil/fix-${Date.now().toString(36)}\n${kbReport ? '6' : '5'}. Stage and commit all changes with a clear message: git add -A && git commit -m "[anvil-fix] ${description.slice(0, 80).replace(/"/g, '\\"')}"\n${kbReport ? '7' : '6'}. Push the branch: git push -u origin HEAD\n${kbReport ? '8' : '7'}. Create a Pull Request: gh pr create --title "[anvil-fix] ${description.slice(0, 60).replace(/"/g, '\\"')}" --body "## Fix\\n${description.replace(/"/g, '\\"').replace(/\n/g, '\\n')}\\n\\n---\\n_Auto-generated by Anvil_"\n\nIMPORTANT: Do NOT merge the PR. Only create it. If tests fail, fix them before creating the PR.`,
      'run-spike': `Research the following:\n\n${description}\n${kbInstructions}\n${kbReport ? `IMPORTANT — Your project prompt contains a Knowledge Base with the full map of this project. Follow this exact workflow:

1. FIRST: Analyze the Knowledge Base to identify which repos, modules, and functions are relevant to "${description}". Write a section called "Analysis from Knowledge Base" citing specific findings.
2. SECOND: Based on KB findings, read ONLY the specific files you need for implementation details. Typically 3-8 files max. Do NOT scan entire directories or run find/grep across the workspace.
3. THIRD: Synthesize your findings with code examples from the files you read.

You have ${repoNames.length} repos: ${repoNames.join(', ')}. Stay within these directories only.\n\n` : ''}This is read-only research — do NOT modify any files.`,
    };

    const agent = agentManager.spawn({
      name: `${actionType.replace('run-', '')}-${project}`,
      persona: actionType === 'run-spike' ? 'analyst' : 'engineer',
      project,
      stage: actionType.replace('run-', ''),
      prompt: promptMap[actionType] ?? description,
      projectPrompt,
      model: model ?? 'claude-sonnet-4-6',
      cwd,
      permissionMode: 'bypassPermissions',
    });

    // Register active run
    const runType = actionLabel as 'fix' | 'spike';
    activeRuns.set(runId, {
      id: runId,
      type: runType,
      project,
      description,
      model: model ?? 'claude-sonnet-4-6',
      status: 'running',
      startedAt: Date.now(),
      agentId: agent.id,
      activities: [],
      prUrls: new Set(),
    });
    agentToRunId.set(agent.id, runId);
    broadcastActiveRuns();

    broadcast({ type: 'agent-spawned', payload: { ...agent, runId } });
  }

  // ── Cancel legacy pipeline ─────────────────────────────────────────
  function cancelLegacyPipeline(): void {
    if (activeChild) {
      activeChild.kill('SIGTERM');
      activeChild = null;
    }
    const state = readStateFile();
    if (state.activePipeline) {
      state.activePipeline.status = 'cancelled';
      for (const stage of state.activePipeline.stages) {
        if (stage.status === 'running' || stage.status === 'pending') {
          stage.status = stage.status === 'running' ? 'failed' : 'skipped';
          stage.completedAt = new Date().toISOString();
        }
      }
      state.lastUpdated = new Date().toISOString();
      try {
        const tmp = STATE_FILE + '.tmp';
        writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
        renameSync(tmp, STATE_FILE);
      } catch { /* ignore */ }
    }
    broadcastState();
  }

  // ── Start watchers and server ───────────────────────────────────────
  startStateWatcher();
  startRunsWatcher();

  // Scan feature store for existing PR URLs on startup (async, non-blocking)
  loadPRsFromFeatureStore();

  // Detect interrupted pipelines from previous sessions
  (async () => {
    try {
      const { findInterruptedPipelines } = await import('./pipeline-runner.js');
      const interrupted = findInterruptedPipelines(ANVIL_HOME);
      if (interrupted.length > 0) {
        console.log(`[dashboard] Found ${interrupted.length} interrupted pipeline(s) from previous session`);
        for (const cp of interrupted) {
          console.log(`  - "${cp.feature}" (${cp.project}) at stage ${cp.currentStage} [${cp.stages[cp.currentStage]?.name ?? '?'}]`);
        }
        // Broadcast to connected clients
        setTimeout(() => {
          broadcast({
            type: 'interrupted-pipelines',
            payload: {
              pipelines: interrupted.map((cp) => ({
                runId: cp.runId,
                project: cp.project,
                feature: cp.feature,
                featureSlug: cp.featureSlug,
                model: cp.config.model,
                baseBranch: cp.config.baseBranch,
                currentStage: cp.currentStage,
                stageName: cp.stages[cp.currentStage]?.name ?? 'unknown',
                stageLabel: cp.stages[cp.currentStage]?.label ?? 'Unknown',
                totalCost: cp.totalCost,
                startedAt: cp.startedAt,
                error: cp.stages[cp.currentStage]?.error ?? 'Pipeline was interrupted (dashboard shutdown)',
              })),
            },
          });
        }, 2000); // Wait for clients to connect
      }
    } catch (err) {
      console.warn('[dashboard] Failed to scan for interrupted pipelines:', err);
    }
  })();

  // ── Graceful shutdown — kill all child processes on exit ──────────
  function gracefulShutdown(signal: string) {
    console.log(`\n[dashboard] ${signal} received — shutting down...`);

    // Kill all agent processes
    const killed = agentManager.killAll();
    if (killed > 0) console.log(`[dashboard] Killed ${killed} running agent(s)`);

    // Kill active pipeline child
    if (activeChild) {
      try { activeChild.kill('SIGTERM'); } catch { /* already dead */ }
      activeChild = null;
      console.log('[dashboard] Killed active pipeline process');
    }

    // Close WebSocket connections
    wss.clients.forEach((ws) => {
      try { ws.close(); } catch { /* ok */ }
    });

    // Close HTTP server
    server.close(() => {
      console.log('[dashboard] Server closed');
      process.exit(0);
    });

    // Force exit after 3s if graceful close hangs
    setTimeout(() => {
      console.log('[dashboard] Force exit after timeout');
      process.exit(1);
    }, 3000).unref();
  }

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  return new Promise(() => {
    server.listen(port, () => {
      const url = `http://localhost:${port}`;
      console.log(`[dashboard] Serving at ${url}`);

      if (opts.open) {
        const openCmd =
          process.platform === 'darwin' ? 'open'
            : process.platform === 'win32' ? 'start'
              : 'xdg-open';
        spawn(openCmd, [url], { shell: true, stdio: 'ignore' });
      }
    });
  });
}
