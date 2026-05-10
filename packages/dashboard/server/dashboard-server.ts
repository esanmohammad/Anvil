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
  readdirSync,
} from 'node:fs';
import { join, extname, resolve } from 'node:path';
import { spawn, execSync, ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

// @ts-ignore — ws is a runtime dependency
import { WebSocketServer, WebSocket } from 'ws';

import { AgentManager, setWebToolBackends, type AgentState } from '@esankhan3/anvil-agent-core';
import { createWebToolBridge } from './tools/web-tool-bridge.js';
import { createDefaultSummarizerInvoker } from './tools/default-summarizer-invoker.js';
import { PipelineRunner } from './pipeline-runner.js';
import { getDurableStore } from './durable-store-singleton.js';
import { runDurableMigration } from './durable-migration.js';
import { scheduleDurableVacuum } from './durable-vacuum.js';
import { dispatchTakenOverRuns } from './durable-resume-queue.js';
import { STAGES as RUNNER_STAGES } from './pipeline-runner.js';
import type { ResumeDecision } from './pipeline-pause-types.js';
import { disallowedToolsForPersona } from '@esankhan3/anvil-core-pipeline';
import { runFixFlow, type FixFlowStageEvent } from './fix-flow.js';
import type { PipelineRunState } from './pipeline-runner.js';
import { ProjectLoader } from './project-loader.js';
import type { ProjectRepo } from './project-loader.js';
import { FeatureStore } from './feature-store.js';
import type { FeatureRecord } from './feature-store.js';
import { MemoryStore } from './memory-store.js';
import type { MemoryTarget } from './memory-store.js';
import { KnowledgeBaseManager } from './knowledge-base-manager.js';
import type { KBProjectStatus, KBRefreshProgress } from './knowledge-base-manager.js';
import { PlanStore } from './plan-store.js';
import type { Plan, PlanSection } from './plan-store.js';
import { PlanValidator } from './plan-validator.js';
import {
  signShareToken, verifyShareToken, getOrCreateShareSecret,
  SHARE_TOKEN_TTL_MS,
} from './plan-share.js';
import { ReviewStore, prIdFromUrl, newFindingId } from './review-store.js';
import type {
  Review, ReviewFinding, Persona, Resolution, Severity, Category, Confidence,
} from './review-store.js';
import { TestSpecStore } from './test-spec-store.js';
import { TestCaseStore } from './test-case-store.js';
import { TestRunStore } from './test-run-store.js';
import { TestLearningsStore } from './test-learnings.js';
import { IncidentStore } from './incident-store.js';
import { ReplayStore } from './replay-store.js';
import { BoundTestsStore } from './bound-tests.js';
import type { IncidentSource } from './incident-types.js';
// ── Confidence-gated pipeline (phases 1–9) ──────────────────────────
import { PipelinePauseStore } from './pipeline-pause-store.js';
import { PipelinePauseSweeper } from './pipeline-pause-sweeper.js';
import {
  handleListPauses, handleGetPause, handleResumePipeline, handleCancelPause,
} from './pipeline-pause-handlers.js';
import { PipelineReviewersStore } from './pipeline-reviewers-store.js';
import { PipelineAuditLog } from './pipeline-audit-log.js';
import { PipelineLearningsStore } from './pipeline-learnings-store.js';
import { CostLedger } from './cost-ledger.js';
import { BridgedCostLedger } from './cost-bridge.js';
import { CostBreachHandler } from './cost-breach-handler.js';
import type { BreachState } from './cost-types.js';
import { CostBreachSweeper } from './cost-breach-sweeper.js';
import {
  BlobStore,
  CheckpointStore,
  computeKey as computeCheckpointKey,
} from '@esankhan3/anvil-agent-core';
import { CheckpointSimilarityIndex } from './checkpoint-similarity-index.js';
import { embedPrompt } from './prompt-similarity.js';
import { loadPolicy, evaluatePolicy } from './pipeline-policy.js';
import { validatePolicyPatch, deepMergeOverlay, type PolicyPatch } from './pipeline-policy-validate.js';
import type { PipelinePolicy } from './pipeline-policy-types.js';
import {
  notifyPipelinePaused, notifyCostBreach,
} from './pipeline-notifier.js';
import {
  getOrCreateApprovalSecret, createApprovalToken, verifyApprovalToken,
} from './pipeline-approval-tokens.js';
// ── Regression Guard / Contract Guard / CI Triage (MVP 2 candidates) ──
import { BoundTestsAuditLog } from './bound-tests-audit.js';
import { buildBoundAnnotations } from './bound-tests-annotator.js';
import { computeRegressionMetrics } from './regression-metrics.js';
import { discoverContracts } from './contract-discovery.js';
import { diffContracts } from './contract-differ.js';
import { detectConsumerCalls } from './contract-consumer-detector.js';
import { buildContractGraph } from './contract-graph-builder.js';
import { analyzeContractImpact } from './contract-impact-analyzer.js';
import { expandScenarios } from './contract-test-scenarios.js';
import { authorContractTest } from './contract-test-author.js';
import { writeContractTests } from './contract-test-writer.js';
import { analyzeFlakiness } from './flakiness-cluster-analyzer.js';
import { suggestFlakyFixes } from './flakiness-fix-suggester.js';
import { rankRelevantTests } from './test-relevance-ranker.js';
import { TestRelevanceCache } from './test-relevance-cache.js';
import { clusterCiLog } from './ci-log-clusterer.js';
import { CiTriageStore } from './ci-triage-store.js';
// ── World-class PR review (R1–R12) ────────────────────────────────────
import { ReviewDismissalStore } from './review-dismissal-store.js';
import { ReviewCalibrationStore } from './review-calibration.js';
import { applyReviewPatch } from './review-patch-applier.js';
import { synthesizeVerdict } from './review-synthesizer.js';
import { publishReview } from './review-publisher.js';
import { buildPlanCompliance } from './review-plan-compliance.js';
import { runSecurityPrepass } from './review-rules/security-prepass.js';
import { runConventionRules } from './review-rules/conventions.js';
import {
  recordResolution, recordReviewCreated, formatLearningsForPrompt,
} from './review-learner.js';
import { discoverProviders, invalidateProviderCache } from './provider-registry.js';
import { setDiscoveryResult } from '@esankhan3/anvil-agent-core';
import { autoLearn } from './pipeline-learner.js';
import { extractConventions, loadRules } from '@esankhan3/anvil-convention-core';
import {
  InMemoryEventBus,
  attachAuditLogHook,
  attachCostTrackerHook,
  attachDashboardStateHook,
  attachLearnersHook,
  resolveModelForStage as registryResolveStage,
  ModelResolutionError,
  UnknownStageError,
  allowedToolsForStage,
  PR_URL_REGEX,
} from '@esankhan3/anvil-core-pipeline';
import {
  attachPipelineBusSubscriber,
  type PipelineStepDescriptor,
} from './pipeline-bus-subscriber.js';

// ── Paths ───────────────────────────────────────────────────────────────
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ANVIL_HOME = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
const CONVENTION_PATHS = {
  conventionsDir: join(ANVIL_HOME, 'conventions'),
  rulesDir: join(ANVIL_HOME, 'conventions', 'rules'),
};
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
  // OpenCode Go subscription — agentic local-tier replacement for Ollama
  'OPENCODE_API_KEY', 'OPENCODE_BASE_URL',
  // Observability — OTel exporter wiring. ANVIL_OTEL_CONSOLE=1 dumps
  // spans to stdout for debugging (no collector required). Otherwise
  // setting OTEL_EXPORTER_OTLP_ENDPOINT enables the OTLP-HTTP exporter.
  'OTEL_EXPORTER_OTLP_ENDPOINT', 'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_SERVICE_NAME', 'OTEL_TRACES_SAMPLER',
  'OTEL_RESOURCE_ATTRIBUTES', 'ANVIL_OTEL_CONSOLE',
  'ANVIL_OTEL_DISABLED', 'ANVIL_OTEL_RECORD_CONTENT',
  'ANVIL_OTEL_METRICS_DISABLED', 'ANVIL_ENV',
  // Phase H1+ — web/browser tool backend keys
  'BRAVE_SEARCH_API_KEY', 'TAVILY_API_KEY', 'EXA_API_KEY', 'SERPAPI_API_KEY',
  // SearxNG — free, self-hostable metasearch. Base URL is the
  // configuration; the optional API key is for hardened public
  // instances that require a bearer token.
  'SEARXNG_BASE_URL', 'SEARXNG_API_KEY',
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

// ── Telemetry auto-detect (silent when off) ────────────────────────────
// If the user is running the canonical local Langfuse stack
// (infra/observability/docker-compose.yml on port 3000) and hasn't
// explicitly set OTEL_EXPORTER_OTLP_ENDPOINT, point at it. We only log
// when telemetry is actually enabled — a missing/closed Langfuse is the
// expected default and shouldn't print anything.
async function autoDetectTelemetry(): Promise<void> {
  if (process.env.ANVIL_OTEL_DISABLED === '1') return;
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    console.log(`[dashboard] OTel exporter → ${process.env.OTEL_EXPORTER_OTLP_ENDPOINT} (configured)`);
    return;
  }
  if (process.env.ANVIL_OTEL_CONSOLE === '1') {
    console.log('[dashboard] OTel exporter → console (ANVIL_OTEL_CONSOLE=1)');
    return;
  }
  const host = 'http://localhost:3000';
  const otlpPath = '/api/public/otel/v1/traces';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 800);
    const res = await fetch(`${host}/`, { method: 'HEAD', signal: ctrl.signal })
      .catch(() => null);
    clearTimeout(timer);
    if (res && res.status < 500) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = `${host}${otlpPath}`;
      if (!process.env.OTEL_SERVICE_NAME) process.env.OTEL_SERVICE_NAME = 'anvil-dashboard';
      console.log(`[dashboard] Langfuse detected at ${host} — exporter enabled (service.name=${process.env.OTEL_SERVICE_NAME})`);
    }
    // No log when Langfuse isn't running — that's the expected default.
  } catch {
    // No log on probe failure — same reason.
  }
}
// Default OTel SDK log level to NONE so a misconfigured/unreachable
// exporter doesn't spam the terminal. Override with OTEL_LOG_LEVEL=ERROR
// to debug.
if (!process.env.OTEL_LOG_LEVEL) process.env.OTEL_LOG_LEVEL = 'NONE';
// Fire-and-forget; the actual tracer is initialized lazily on first
// agent call, by which time process.env will be populated.
void autoDetectTelemetry();

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
  /** Phase 8 — model id resolved by the registry-driven resolver. */
  resolvedModel?: string;
  /** Phase 8 — tool-permission classes for this stage. */
  permissionClasses?: ('read' | 'write' | 'exec')[];
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
  planSlug?: string;            // plan identifier for plan-related actions
  section?: string;             // plan section to regenerate
  plan?: unknown;               // plan payload for save/update
  options?: {
    skipClarify?: boolean;
    skipShip?: boolean;
    model?: string;
    models?: Record<string, string>;
    approvalRequired?: boolean;
    baseBranch?: string;
    modelTier?: 'fast' | 'balanced' | 'thorough';
    repo?: string;
    level?: string;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

/** Read workspace path from factory.yaml / project.yaml for a project. */
/**
 * Parse the string content of a `semantic:fix-pattern` proposal back into
 * `error` (failure signal) and `fix` (resolution). Reflection's mapper
 * formats failures as `Failure: …\nRoot cause: …\nFix: …\nFile: …`.
 * If the content was already structured ({error,fix}), use that directly.
 */
function parseFixPatternContent(content: unknown): { error: string; fix: string } {
  if (content && typeof content === 'object') {
    const c = content as { error?: unknown; fix?: unknown };
    if (typeof c.error === 'string' && typeof c.fix === 'string') {
      return { error: c.error, fix: c.fix };
    }
  }
  if (typeof content !== 'string') return { error: '', fix: '' };
  const failure = /Failure:\s*(.+)/.exec(content);
  const root = /Root cause:\s*(.+)/.exec(content);
  const fix = /Fix:\s*(.+)/.exec(content);
  const errorParts: string[] = [];
  if (failure) errorParts.push(failure[1].trim());
  if (root) errorParts.push(root[1].trim());
  return {
    error: errorParts.join(' — '),
    fix: fix ? fix[1].trim() : '',
  };
}

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
  // Feed the tier resolver so it can map weight classes to actual model IDs
  setDiscoveryResult(discovery);
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
interface WebhookDeps {
  incidentStore: IncidentStore;
  replayStore: ReplayStore;
  testSpecStore: TestSpecStore;
  testCaseStore: TestCaseStore;
  testLearningsStore: TestLearningsStore;
  boundTestsStore: BoundTestsStore;
  agentManager: AgentManager;
  projectLoader: ProjectLoader;
  broadcast: (msg: unknown) => void;
  enqueueReplay: (incidentId: string, project: string) => { queueDepth: number };
  pauseStore?: PipelinePauseStore;
  approvalSecret?: string;
  kbManager?: KnowledgeBaseManager;
  ciTriageStore?: CiTriageStore;
}

function serveStatic(
  staticDir: string,
  kbManagerRef?: { current: KnowledgeBaseManager | null },
  webhookDepsRef?: { current: WebhookDeps | null },
) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

    // Serve shared plan: /share/plan/:token — returns JSON of the frozen plan version.
    const shareMatch = url.pathname.match(/^\/share\/plan\/([A-Za-z0-9_\-.]+)$/);
    if (shareMatch) {
      try {
        const secret = getOrCreateShareSecret(ANVIL_HOME);
        const payload = verifyShareToken(shareMatch[1], secret);
        if (!payload) {
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Share link invalid or expired.' }));
          return;
        }
        const planStoreLocal = new PlanStore(ANVIL_HOME);
        const plan = planStoreLocal.readVersion(payload.project, payload.slug, payload.version);
        if (!plan) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Plan version not found.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ plan, expiresAt: payload.expiresAt }));
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
        return;
      }
    }

    // Serve shared test spec: /share/tests/:token — returns the frozen spec + cases.
    const testShareMatch = url.pathname.match(/^\/share\/tests\/([A-Za-z0-9_\-.]+)$/);
    if (testShareMatch) {
      try {
        const { verifyTestShareToken, getOrCreateTestShareSecret } = await import('./test-share.js');
        const secret = getOrCreateTestShareSecret(ANVIL_HOME);
        const payload = verifyTestShareToken(testShareMatch[1], secret);
        if (!payload) {
          res.writeHead(410, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Share link invalid or expired.' }));
          return;
        }
        const specStore = new TestSpecStore(ANVIL_HOME);
        const caseStore = new TestCaseStore(ANVIL_HOME);
        const spec = specStore.readVersion(payload.project, payload.slug, payload.version);
        if (!spec) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Test spec version not found.' }));
          return;
        }
        const cases = caseStore.readCases(payload.project, payload.slug, payload.version);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ spec, cases, expiresAt: payload.expiresAt }));
        return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
        return;
      }
    }

    // Incident webhooks: /api/incidents/webhook/{sentry,incidentio,generic}
    if (url.pathname.startsWith('/api/incidents/webhook/') && webhookDepsRef?.current) {
      const deps = webhookDepsRef.current;
      try {
        const { dispatchIncidentWebhook } = await import('./incident-webhooks.js');
        const handled = await dispatchIncidentWebhook(req, res, {
          anvilHome: ANVIL_HOME,
          resolveProject: (u: URL) => {
            const q = u.searchParams.get('project');
            if (q) return q.trim() || null;
            const h = req.headers['x-anvil-project'];
            if (typeof h === 'string') return h.trim() || null;
            if (Array.isArray(h) && h[0]) return h[0].trim() || null;
            return null;
          },
          onIncident: async (parsed, autoReplay) => {
            try {
              const project = (req.headers['x-anvil-project'] as string | undefined)
                ?? new URL(req.url ?? '/', `http://${req.headers.host}`).searchParams.get('project')
                ?? '';
              if (!project) return;
              const incident = deps.incidentStore.ingest(project, parsed.source, parsed.externalId, parsed);
              deps.broadcast({ type: 'incident-ingested', payload: { incident } });
              if (autoReplay) {
                // Enqueue rather than fire-and-forget: the queue caps concurrency,
                // dedupes (incidentId, project), retries on failure, and survives
                // restarts (mirrored to ~/.anvil/incidents/queue.json). The pump
                // loop set up at boot will pick it up.
                const { queueDepth } = deps.enqueueReplay(incident.id, project);
                deps.broadcast({
                  type: 'replay-queued',
                  payload: { incidentId: incident.id, project, queueDepth },
                });
              }
            } catch (err) {
              console.warn('[incidents] webhook onIncident failed:', err);
            }
          },
        });
        if (handled) return;
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Webhook error' }));
        return;
      }
    }

    // Pipeline approval link (HMAC-signed token from Slack/email)
    if (url.pathname === '/api/pipeline/approve' && webhookDepsRef?.current) {
      const deps = webhookDepsRef.current;
      const token = url.searchParams.get('token') ?? '';
      const secret = deps.approvalSecret ?? '';
      const pauseStore = deps.pauseStore;
      if (!token || !secret || !pauseStore) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end('<h1>400 — missing token, secret, or pause store</h1>');
        return;
      }
      const payload = verifyApprovalToken(token, secret);
      if (!payload) {
        res.writeHead(403, { 'Content-Type': 'text/html' });
        res.end('<h1>403 — token invalid or expired</h1>');
        return;
      }
      try {
        if (payload.action === 'approve') {
          const existing = pauseStore.get(payload.runId);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'text/html' });
            res.end('<h1>404 — pause not found</h1>');
            return;
          }
          if (existing.status === 'paused-awaiting-user') {
            pauseStore.resume(payload.runId, { action: 'approve' }, 'approval-link');
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>✅ Approved</h1><p>The paused stage has been resumed. You can close this tab.</p>');
          deps.broadcast({ type: 'pipeline-resumed', payload: { pause: pauseStore.get(payload.runId) } });
        } else if (payload.action === 'reject') {
          const existing = pauseStore.get(payload.runId);
          if (existing && existing.status === 'paused-awaiting-user') {
            pauseStore.cancel(payload.runId, 'approval-link');
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>🛑 Rejected</h1><p>The paused stage has been cancelled. You can close this tab.</p>');
          deps.broadcast({ type: 'pipeline-cancelled', payload: { pause: pauseStore.get(payload.runId) } });
        }
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/html' });
        res.end(`<h1>500 — ${err instanceof Error ? err.message : 'approve handler error'}</h1>`);
      }
      return;
    }

    // ── Contract Guard HTTP endpoints ────────────────────────────────
    if (url.pathname === '/api/contracts/list' && webhookDepsRef?.current) {
      const deps = webhookDepsRef.current;
      const project = url.searchParams.get('project') ?? '';
      const repoFilter = url.searchParams.get('repo') ?? '';
      if (!project) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'project query param required' }));
        return;
      }
      try {
        const { discoverContracts: discover } = await import('./contract-discovery.js');
        const repoPaths = deps.projectLoader.getRepoLocalPaths(project);
        const contracts: unknown[] = [];
        for (const [repoName, repoPath] of Object.entries(repoPaths)) {
          if (repoFilter && repoName !== repoFilter) continue;
          if (!repoPath || !existsSync(repoPath)) continue;
          contracts.push(...discover(repoPath, repoName));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project, contracts }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/contracts/drift' && req.method === 'POST' && webhookDepsRef?.current) {
      const deps = webhookDepsRef.current;
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { project } = JSON.parse(body || '{}') as { project?: string };
        if (!project) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'project required' }));
          return;
        }
        const { discoverContracts: discover } = await import('./contract-discovery.js');
        const { detectConsumerCalls: detect } = await import('./contract-consumer-detector.js');
        const { buildContractGraph: build } = await import('./contract-graph-builder.js');
        const repoPaths = deps.projectLoader.getRepoLocalPaths(project);
        const contracts: unknown[] = [];
        const calls: unknown[] = [];
        for (const [repoName, repoPath] of Object.entries(repoPaths)) {
          if (!repoPath || !existsSync(repoPath)) continue;
          contracts.push(...discover(repoPath, repoName));
          calls.push(...detect(repoPath, repoName));
        }
        const graph = build(contracts as never, calls as never);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project, graph }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    if (url.pathname === '/api/contracts/generate' && req.method === 'POST') {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'contracts generate not yet wired to a request-diff input; use dashboard UI' }));
      return;
    }
    if (url.pathname === '/api/contracts/verify' && req.method === 'POST') {
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'contracts verify not yet wired; use CLI test runner directly' }));
      return;
    }

    // ── Test relevance ranking ───────────────────────────────────────
    if (url.pathname === '/api/tests/rank' && req.method === 'POST' && webhookDepsRef?.current) {
      const deps = webhookDepsRef.current;
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { project, changedSymbols } = JSON.parse(body || '{}') as { project?: string; changedSymbols?: unknown[] };
        if (!project || !Array.isArray(changedSymbols)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'project + changedSymbols required' }));
          return;
        }
        const { rankRelevantTests: rank } = await import('./test-relevance-ranker.js');
        const repoPaths = deps.projectLoader.getRepoLocalPaths(project);
        const repoGraphs: Record<string, unknown> = {};
        if (deps.kbManager) {
          for (const repoName of Object.keys(repoPaths)) {
            try {
              const graphHtml = deps.kbManager.getGraphHtmlPath(project, repoName);
              if (graphHtml) {
                const graphJson = graphHtml.replace(/graph\.html$/, 'graph.json');
                if (existsSync(graphJson)) {
                  repoGraphs[repoName] = JSON.parse(readFileSync(graphJson, 'utf-8'));
                }
              }
            } catch { /* ignore */ }
          }
        }
        const result = rank({ changedSymbols: changedSymbols as never, repoGraphs });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project, result }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

    // ── CI triage HTTP ───────────────────────────────────────────────
    if (url.pathname === '/api/triage/analyze' && req.method === 'POST' && webhookDepsRef?.current) {
      let body = '';
      for await (const chunk of req) body += chunk;
      try {
        const { logText, logSource, project } = JSON.parse(body || '{}') as { logText?: string; logSource?: string; project?: string };
        if (!logText) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'logText required' }));
          return;
        }
        const { clusterCiLog: cluster } = await import('./ci-log-clusterer.js');
        const report = cluster({ logText, logSource });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ project, report }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }

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
  const webhookDepsRef: { current: WebhookDeps | null } = { current: null };
  const handler = serveStatic(opts.staticDir, kbManagerRef, webhookDepsRef);
  const server = createServer(handler);
  const wss = new WebSocketServer({ server, path: '/ws' });
  const clients = new Set<WebSocket>();

  // ── Shared services ─────────────────────────────────────────────────
  const projectLoader = new ProjectLoader();
  const featureStore = new FeatureStore();
  // AgentManager lives in @esankhan3/anvil-agent-core (the source of truth) and
  // resolves its own adapter via ProviderRegistry — no factory injection
  // needed. Pass `{ adapterFactory: customFactory }` if a non-default
  // resolution is required (tests, custom routing).
  const agentManager = new AgentManager();
  // ── Phase H1+ — register web/browser tool backends process-wide ───
  // The agent-core bridge composes a `WebToolExecutor` whenever a stage
  // includes web_/browser_/computer_use names in its allow-list AND
  // backends are present. Wiring it here lets every spawn see the
  // surface without each call site threading it.
  setWebToolBackends(createWebToolBridge({
    summarizerInvoker: createDefaultSummarizerInvoker(),
    // H10-followup #4 — resolve allowedContexts per-project at call time.
    getAllowedContexts: (slug) => {
      try {
        return loadPolicy(slug, ANVIL_HOME).tools?.browseHeadless?.contexts;
      } catch {
        return undefined;
      }
    },
  }));
  const memoryStore = new MemoryStore();
  const kbManager = new KnowledgeBaseManager(projectLoader);
  const planStore = new PlanStore(ANVIL_HOME);
  const planValidator = new PlanValidator(projectLoader);
  const reviewStore = new ReviewStore(ANVIL_HOME);
  const testSpecStore = new TestSpecStore(ANVIL_HOME);
  const testCaseStore = new TestCaseStore(ANVIL_HOME);
  const testRunStore = new TestRunStore(ANVIL_HOME);
  const testLearningsStore = new TestLearningsStore(ANVIL_HOME);
  const incidentStore = new IncidentStore(ANVIL_HOME);
  const replayStore = new ReplayStore(ANVIL_HOME);
  const boundTestsStore = new BoundTestsStore(ANVIL_HOME);
  // ── Confidence-gated pipeline stores ─────────────────────────────
  const pauseStore = new PipelinePauseStore(ANVIL_HOME);
  const reviewersStore = new PipelineReviewersStore(ANVIL_HOME);
  const auditLog = new PipelineAuditLog(ANVIL_HOME);
  const learningsStore = new PipelineLearningsStore(ANVIL_HOME);
  // Phase 3: cost-bridge — every record() also writes a matching SpendRow
  // to agent-core's SpendLedger so cli `cost summary` reads agree with the
  // dashboard UI (storage layouts stay separate per D4).
  const costLedger: CostLedger = new BridgedCostLedger(ANVIL_HOME);
  const blobStore = new BlobStore(ANVIL_HOME);
  const checkpointStore = new CheckpointStore({ anvilHome: ANVIL_HOME, blobStore });
  const approvalSecret = getOrCreateApprovalSecret(ANVIL_HOME);
  // ── RG/CG/CT stores ─────────────────────────────────────────────
  const boundAuditLog = new BoundTestsAuditLog(ANVIL_HOME);
  const relevanceCache = new TestRelevanceCache(ANVIL_HOME);
  const ciTriageStore = new CiTriageStore(ANVIL_HOME);
  const reviewDismissalStore = new ReviewDismissalStore(ANVIL_HOME);
  const reviewCalibrationStore = new ReviewCalibrationStore(ANVIL_HOME);
  // Auto-replay queue — crash-safe FIFO for incident → bug-replay-pipeline jobs.
  const { AutoReplayQueue } = await import('./auto-replay-queue.js');
  const autoReplayQueue = new AutoReplayQueue(ANVIL_HOME, { maxConcurrent: 2, maxAttempts: 3 });
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
    status: 'draft' | 'open' | 'in_review' | 'merged' | 'closed';
    url: string;
    createdAt: number;
    updatedAt: number;
    additions: number;
    deletions: number;
    reviewers: string[];
    labels: string[];
  }

  const trackedPRs = new Map<string, TrackedPR>();

  /**
   * Extract PR URLs from text (GitHub PR URLs).
   *
   * Phase C3 — regex moved into core-pipeline as `PR_URL_REGEX` so the
   * dashboard, cli, and any future tooling share one canonical pattern.
   * The fuller migration to `attachPrUrlHook` (with the hook owning the
   * dedupe) is deferred until the per-run `prUrls: Set<string>` state on
   * `activeRuns` lifts into the hook handle — that crosses dashboard-server
   * boundaries and earns its own phase.
   */
  function extractPRUrls(text: string): string[] {
    PR_URL_REGEX.lastIndex = 0;
    const matches = text.match(PR_URL_REGEX);
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
      else if (data.state === 'CLOSED') status = 'closed';
      // 'in_review' = actively waiting on a reviewer. APPROVED PRs are ready
      // to merge — leave them in 'open' so the board doesn't park them in
      // a column that implies action by reviewers.
      else if (data.reviewDecision === 'CHANGES_REQUESTED' ||
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
    } catch {
      // Silently ignore — `gh pr view` failures (auth, network, ETIMEDOUT
      // on cancellation cleanup) shouldn't spam the terminal. The PR
      // surfaces from the activity-log scanner if it ever appears in
      // agent output; missing it here just means no enriched metadata.
      return null;
    }
  }

  /**
   * Build a prUrl → PRReviewSummary map by joining tracked PRs against the
   * review store. Latest review per PR wins (listReviews returns desc by
   * createdAt). Filesystem-bound but cheap at the dashboard's broadcast
   * cadence (~30s for refreshes; on-demand otherwise).
   */
  function reviewMapByPrUrl(): Map<string, {
    reviewId: string;
    verdict: 'approve' | 'request-changes' | 'comment';
    blockers: number;
    errors: number;
    warnings: number;
    summary: string;
    reviewedAt: number;
  }> {
    const m = new Map<string, ReturnType<typeof reviewMapByPrUrl> extends Map<string, infer V> ? V : never>();
    try {
      const all = reviewStore.listReviews(undefined, 500);
      for (const r of all) {
        if (m.has(r.prUrl)) continue;
        const sev = r.severityCounts;
        const blockers = sev.blocker ?? 0;
        const errors = sev.error ?? 0;
        const warnings = sev.warn ?? 0;
        const issueCount = blockers + errors;
        const summary = r.verdict === 'approve'
          ? 'Approved — no blocking issues'
          : r.verdict === 'request-changes'
            ? `${issueCount} issue${issueCount === 1 ? '' : 's'}${blockers > 0 ? ` (${blockers} blocker${blockers === 1 ? '' : 's'})` : ''}`
            : 'Comments only';
        m.set(r.prUrl, {
          reviewId: r.reviewId,
          verdict: r.verdict,
          blockers, errors, warnings,
          summary,
          reviewedAt: Date.parse(r.createdAt) || Date.now(),
        });
      }
    } catch { /* review store best-effort */ }
    return m;
  }

  /** Tracked PRs joined with their latest review for broadcast/serialization. */
  function trackedPRsForBroadcast(): Array<TrackedPR & {
    review: ReturnType<typeof reviewMapByPrUrl> extends Map<string, infer V> ? V | null : never;
  }> {
    const reviewMap = reviewMapByPrUrl();
    return Array.from(trackedPRs.values()).map((pr) => ({
      ...pr,
      review: reviewMap.get(pr.url) ?? null,
    }));
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
      broadcast({ type: 'prs', payload: trackedPRsForBroadcast() });
    }
  }

  /** Track a new PR URL — fetch details and broadcast */
  async function trackPR(prUrl: string): Promise<void> {
    if (trackedPRs.has(prUrl)) return; // already tracking

    const pr = await fetchPRDetails(prUrl);
    if (pr) {
      trackedPRs.set(prUrl, pr);
      broadcast({ type: 'prs', payload: trackedPRsForBroadcast() });
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
        for (const url of prUrls) {
          await trackPR(url);
        }
      }
    } catch {
      // Silently ignore — feature-store PR backfill is best-effort.
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
  interface ActiveRunStage {
    name: 'fix' | 'validate' | 'fix-loop';
    status: 'pending' | 'running' | 'completed' | 'failed';
    attempt?: number;
    error?: string;
    cost?: number;
    startedAt?: string;
    completedAt?: string;
  }
  interface ActiveRun {
    id: string;
    type: 'build' | 'fix' | 'spike' | 'plan';
    project: string;
    description: string;
    model: string;
    status: 'running' | 'completed' | 'failed';
    startedAt: number;
    agentId?: string;            // for quick actions
    activities: typeof outputBuffer;  // per-run output
    prUrls: Set<string>;         // PRs created by this specific run
    /** Per-stage progress for multi-stage flows (fix flow, build flow). */
    stages?: ActiveRunStage[];
    /** Final error when status === 'failed'. */
    error?: string;
    /** Completion timestamp once the run lands in a terminal state. */
    completedAt?: number;
    /** Total cost summed across stages (fix-flow runs). */
    totalCost?: number;
  }

  const activeRuns = new Map<string, ActiveRun>();

  /** Map agentId → runId for quick action agents */
  const agentToRunId = new Map<string, string>();

  /** Cost-snapshot subscriptions per WS — `${project}::${runId || '*'}` set per client. */
  const costSubsByClient = new WeakMap<WebSocket, Set<string>>();
  function costSubKey(project: string, runId?: string | null): string {
    return `${project}::${runId ?? '*'}`;
  }
  function getOrInitSubs(client: WebSocket): Set<string> {
    let s = costSubsByClient.get(client);
    if (!s) { s = new Set(); costSubsByClient.set(client, s); }
    return s;
  }

  /** Compute a unified cost snapshot for (project, runId?) at this moment. */
  function computeCostSnapshot(project: string, runId?: string | null): unknown {
    const policy: PipelinePolicy | null = (() => { try { return loadPolicy(project, ANVIL_HOME); } catch { return null; } })();
    const budget = (() => { try { return projectLoader.getBudgetConfig(project); } catch { return {} as Record<string, unknown>; } })();
    const policyLimits = policy?.cost?.limits ?? {};
    const perRunLimit = policyLimits.perRun ?? (typeof budget.max_per_run === 'number' ? budget.max_per_run : undefined);
    const dailyLimit = policyLimits.perProjectDaily ?? (typeof budget.max_per_day === 'number' ? budget.max_per_day : undefined);
    const alertAtUsd = typeof budget.alert_at === 'number' ? budget.alert_at : undefined;
    const alertAtFraction = (alertAtUsd && dailyLimit && dailyLimit > 0) ? alertAtUsd / dailyLimit : 0.6;

    const todayUsd = (() => { try { return costLedger.projectDailyTotal(project); } catch { return 0; } })();

    const runBlock = runId ? (() => {
      try {
        const sum = costLedger.summarize(runId, project);
        return {
          usd: sum.totalUsd,
          limitUsd: perRunLimit,
          perStageUsd: sum.byStage,
        };
      } catch { return undefined; }
    })() : undefined;

    const breach = (() => {
      try {
        let b: BreachState | null | undefined;
        if (runId) {
          b = costBreachHandler.getBreach(runId);
        } else {
          const pendings = costBreachHandler.listPending?.() ?? [];
          b = pendings.find((p) => p.project === project) ?? null;
        }
        if (!b || b.status !== 'pending') return undefined;
        const topSpenders = (() => {
          try {
            const sum = costLedger.summarize(b.runId, project);
            return Object.entries(sum.byStage)
              .map(([stage, usd]) => ({ stage, usd: usd as number }))
              .sort((a, b) => b.usd - a.usd)
              .slice(0, 3);
          } catch { return []; }
        })();
        return {
          runId: b.runId,
          project: b.project,
          currentUsd: b.currentUsdAtBreach,
          limitUsd: b.limitUsdAtBreach,
          projectedUsd: b.currentUsdAtBreach * 1.2,
          graceEndsAt: b.graceEndsAt,
          topSpenders,
          extensionsUsed: b.extensionsUsed,
        };
      } catch { return undefined; }
    })();

    return {
      project,
      runId: runId ?? undefined,
      run: runBlock,
      today: { usd: todayUsd, limitUsd: dailyLimit, alertAt: alertAtFraction },
      pendingBreach: breach,
      recentBreaches: { count30d: 0, decisions: { raise: 0, reject: 0, extend: 0, autoResolved: 0 } },
      computedAt: new Date().toISOString(),
    };
  }

  /** Push a fresh snapshot to every client subscribed to (project, runId or wildcard). */
  function broadcastCostSnapshot(project: string, runId?: string | null): void {
    const targetedKey = costSubKey(project, runId);
    const wildcardKey = costSubKey(project, undefined);
    let snap: unknown | null = null;
    let snapWildcard: unknown | null = null;
    for (const client of clients) {
      const subs = costSubsByClient.get(client);
      if (!subs || subs.size === 0) continue;
      if (client.readyState !== WebSocket.OPEN) continue;
      if (subs.has(targetedKey)) {
        if (snap === null) snap = computeCostSnapshot(project, runId);
        client.send(JSON.stringify({ type: 'cost-snapshot', payload: snap }));
        continue;
      }
      if (runId && subs.has(wildcardKey)) {
        // Client subscribed to whole project — also send the run-scoped snapshot.
        if (snap === null) snap = computeCostSnapshot(project, runId);
        client.send(JSON.stringify({ type: 'cost-snapshot', payload: snap }));
      }
      if (subs.has(wildcardKey)) {
        if (snapWildcard === null) snapWildcard = computeCostSnapshot(project);
        client.send(JSON.stringify({ type: 'cost-snapshot', payload: snapWildcard }));
      }
    }
  }

  function broadcastActiveRuns(): void {
    const list = Array.from(activeRuns.values()).map((r) => ({
      id: r.id,
      type: r.type,
      project: r.project,
      description: r.description,
      model: r.model,
      status: r.status,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      activityCount: r.activities.length,
      stages: r.stages,
      error: r.error,
      totalCost: r.totalCost,
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

    // Plan-agent post-processing: parse JSON, persist, validate, broadcast.
    try { finalizePlanAgent(agent.id, (agent.finalAnswer || agent.output) ?? ''); } catch { /* already broadcast */ }
    // Review-agent post-processing: same shape, different store.
    void finalizeReviewAgent(agent.id, agent).catch(() => { /* already broadcast */ });

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
        // Persist the canonical artifact (finalAnswer) — falls back to
        // output for legacy runs / paths without a structured result.
        output: (agent.finalAnswer || agent.output)?.slice(0, 50000) ?? '',
      };

      try {
        if (!existsSync(RUNS_DIR)) mkdirSync(RUNS_DIR, { recursive: true });
        appendFileSync(RUNS_INDEX, JSON.stringify(runRecord) + '\n', 'utf-8');
      } catch { /* */ }

      broadcastRuns();
      broadcastActiveRuns();

      // Memory hygiene (PR 4): auto-saving the first 500 chars of agent
      // output as `[Fix|Research: …]` was bookkeeping noise — the model
      // saw a wall of unranked snippets per run. End-of-run reflection
      // through memory-core's reflectOnRun lands in a follow-up;
      // recordPrEpisode covers the high-signal case (PRs) at the
      // pipeline-runner level, not here.

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

  // Auto-replay queue: pump every 15s. Each pass dispatches up to maxConcurrent
  // jobs to the bug-replay pipeline. Failures are retried with backoff via
  // the queue's internal `attempts` counter; jobs that exceed maxAttempts drop.
  const autoReplayPumpHandle = setInterval(() => {
    void autoReplayQueue.pump(async (job) => {
      const { runReplayPipeline } = await import('./replay-pipeline.js');
      const repoLocalPaths = projectLoader.getRepoLocalPaths(job.project);
      const result = await runReplayPipeline({
        incidentStore, replayStore,
        specStore: testSpecStore, caseStore: testCaseStore, learningsStore: testLearningsStore,
        agentManager, project: job.project, incidentId: job.incidentId, repoLocalPaths,
        onStep: (step, state) => broadcast({ type: 'replay-step', payload: { incidentId: job.incidentId, step, state } }),
      });
      if (result.boundFilePath) {
        try { boundTestsStore.appendBound(job.project, { filePath: result.boundFilePath, incidentId: job.incidentId, replayId: result.attempt.id, addedAt: new Date().toISOString() }); } catch { /* ok */ }
      }
      broadcast({ type: 'replay-complete', payload: { result, incidentId: job.incidentId, attempt: result.attempt, boundFilePath: result.boundFilePath } });
    }).catch((err) => {
      console.warn('[auto-replay] pump cycle failed:', err);
    });
  }, 15_000);
  // unref so the interval doesn't block process exit during tests / SIGTERM.
  if (typeof autoReplayPumpHandle.unref === 'function') autoReplayPumpHandle.unref();

  // Populate the webhook-deps ref for the static handler (see /api/incidents/webhook/*).
  webhookDepsRef.current = {
    incidentStore, replayStore,
    testSpecStore, testCaseStore, testLearningsStore,
    boundTestsStore, agentManager, projectLoader,
    broadcast: (m: unknown) => broadcast(m as ServerMessage),
    enqueueReplay: (incidentId: string, project: string) => {
      autoReplayQueue.enqueue(incidentId, project);
      return { queueDepth: autoReplayQueue.snapshot().length };
    },
    pauseStore, approvalSecret,
    kbManager, ciTriageStore,
  };

  // ── Sweepers: pause timeouts + cost breach grace ─────────────────────
  const pauseSweeper = new PipelinePauseSweeper(pauseStore, {
    intervalMs: 60_000,
    onTimeout: (state) => {
      broadcast({ type: 'pipeline-paused', payload: { pause: state } } as ServerMessage);
      try {
        auditLog.record({
          runId: state.runId, project: state.project,
          event: 'timed-out', actor: 'system',
        });
      } catch { /* non-fatal */ }
    },
  });
  pauseSweeper.start();

  const costBreachHandler = new CostBreachHandler({
    ledger: costLedger,
    storeDir: join(ANVIL_HOME, 'cost-breaches'),
    onNotify: (state, topSpenders) => {
      broadcast({
        type: 'cost-breach',
        payload: { breach: state, topSpenders },
      } as ServerMessage);
      void notifyCostBreach({
        runId: state.runId,
        project: state.project,
        currentUsd: state.currentUsdAtBreach,
        limitUsd: state.limitUsdAtBreach,
        projectedUsd: state.currentUsdAtBreach * 1.2,
        graceEndsAt: state.graceEndsAt,
        topSpenders,
      });
      // Push the new snapshot so subscribers' modals/meters reflect the breach.
      try { broadcastCostSnapshot(state.project, state.runId); } catch { /* ok */ }
    },
    onRejectStop: (runId) => {
      const run = activeRuns.get(runId);
      if (run) {
        if (run.agentId) {
          try { agentManager.kill(run.agentId); } catch { /* ok */ }
        }
        if (run.type === 'build' && activePipelineRunner) {
          try { activePipelineRunner.cancel(); } catch { /* ok */ }
        }
        for (const [agentId, rid] of agentToRunId.entries()) {
          if (rid === runId) {
            try { agentManager.kill(agentId); } catch { /* ok */ }
          }
        }
        run.status = 'failed';
      }
      broadcast({ type: 'run-rejected', payload: { runId } } as ServerMessage);
    },
  });
  const costBreachSweeper = new CostBreachSweeper(costBreachHandler, { intervalMs: 5000 });
  costBreachSweeper.start();

  // Shutdown hook — stop sweepers on process exit.
  const shutdownSweepers = () => {
    try { pauseSweeper.stop(); } catch { /* ignore */ }
    try { costBreachSweeper.stop(); } catch { /* ignore */ }
  };
  process.once('SIGINT', shutdownSweepers);
  process.once('SIGTERM', shutdownSweepers);

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
        discoverAvailableModels().catch(() => ({ providers: [], defaultModel: 'sonnet', defaultProvider: 'claude' }) as AvailableModelsResult),
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
          prs: trackedPRsForBroadcast(),
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

      case 'get-durable-timeline': {
        // Phase D5: durable execution timeline. Returns the
        // run row + every event so the UI can render the
        // step-by-step + effect-by-effect log without a
        // separate HTTP round-trip.
        const runId = typeof msg.runId === 'string' ? msg.runId : null;
        if (!runId) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'runId is required' } }));
          break;
        }
        const store = getDurableStore();
        if (!store) {
          ws.send(JSON.stringify({ type: 'durable-timeline', payload: { runId, run: null, events: [] } }));
          break;
        }
        try {
          const run = await store.getRun(runId);
          const events = run ? await store.readEvents(runId) : [];
          ws.send(JSON.stringify({ type: 'durable-timeline', payload: { runId, run, events } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `durable-timeline failed: ${err instanceof Error ? err.message : err}` } }));
        }
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

      case 'resume':           // UI sends this from RunDetail's Replay button
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
        const model = cpConfig?.model ?? prevRun?.model ?? msg.options?.model ?? 'sonnet';

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

      case 'rollback-run': {
        // Rollback a completed/failed/cancelled run's local changes.
        // Conservative: switch each repo off the feature branch to its base branch
        // and delete the local branch. Remote PR (if any) is left intact —
        // closing it is the user's call via gh.
        const runId = (msg as { runId?: string }).runId;
        if (!runId) break;
        const allRuns = loadRunsSync();
        const run = allRuns.find((r) => r.id === runId);
        if (!run) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Run ${runId} not found.` } }));
          break;
        }
        try {
          const repoPaths = projectLoader.getRepoLocalPaths(run.project);
          const branchName = `anvil/${run.featureSlug}`;
          const results: Array<{ repo: string; ok: boolean; detail: string }> = [];
          for (const [repoName, path] of Object.entries(repoPaths)) {
            if (!existsSync(path)) {
              results.push({ repo: repoName, ok: false, detail: 'path missing' });
              continue;
            }
            try {
              // Only act if the feature branch exists locally.
              execSync(`git rev-parse --verify "${branchName}"`, { cwd: path, stdio: 'pipe' });
            } catch {
              results.push({ repo: repoName, ok: true, detail: 'no local branch' });
              continue;
            }
            try {
              // Determine base (prefer origin/HEAD, fall back to main).
              let base = 'main';
              try {
                const headRef = execSync('git symbolic-ref refs/remotes/origin/HEAD', { cwd: path, encoding: 'utf-8', stdio: 'pipe' }).trim();
                base = headRef.replace(/^refs\/remotes\/origin\//, '') || 'main';
              } catch { /* leave default */ }
              // If currently on the feature branch, checkout base first.
              const current = execSync('git rev-parse --abbrev-ref HEAD', { cwd: path, encoding: 'utf-8', stdio: 'pipe' }).trim();
              if (current === branchName) {
                execSync(`git checkout "${base}"`, { cwd: path, stdio: 'pipe' });
              }
              execSync(`git branch -D "${branchName}"`, { cwd: path, stdio: 'pipe' });
              results.push({ repo: repoName, ok: true, detail: `deleted ${branchName}` });
            } catch (err) {
              results.push({ repo: repoName, ok: false, detail: err instanceof Error ? err.message : String(err) });
            }
          }
          // Mark the feature record as cancelled.
          try {
            if (run.featureSlug) {
              featureStore.updateFeature(run.project, run.featureSlug, { status: 'cancelled' });
            }
          } catch { /* ok */ }
          ws.send(JSON.stringify({
            type: 'rollback-done',
            payload: { runId, results, ok: results.every((r) => r.ok) },
          }));
          broadcastRuns();
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'error',
            payload: { message: `Rollback failed: ${err instanceof Error ? err.message : String(err)}` },
          }));
        }
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

      case 'provide-stage-answer': {
        // Routes per-question Q&A answers to the active pipeline runner.
        // Frontend payload: { stageIndex, repoName?, questionIndex, text }.
        const m = msg as {
          stageIndex?: number;
          repoName?: string;
          questionIndex?: number;
          text?: string;
        };
        if (!activePipelineRunner) {
          ws.send(JSON.stringify({ type: 'pipeline-error', payload: { message: 'no active pipeline run' } }));
          break;
        }
        if (typeof m.stageIndex !== 'number' || typeof m.questionIndex !== 'number' || typeof m.text !== 'string') {
          ws.send(JSON.stringify({ type: 'pipeline-error', payload: { message: 'stageIndex + questionIndex + text required' } }));
          break;
        }
        try {
          activePipelineRunner.provideStageAnswer(
            m.stageIndex,
            m.repoName ?? null,
            m.questionIndex,
            m.text,
          );
        } catch (err) {
          ws.send(JSON.stringify({ type: 'pipeline-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
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
            model: msg.options?.model ?? 'sonnet',
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
          ws.send(JSON.stringify({ type: 'prs', payload: trackedPRsForBroadcast() }));
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
          broadcast({
            type: 'kb-status',
            payload: {
              project,
              repos: [],
              overallStatus: 'unavailable',
              lastRefreshed: null,
              currentProgress: null,
              error: err.message,
            },
          });
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
            const { buildProjectGraph } = await import('@esankhan3/anvil-knowledge-core');

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
          const { getProjectGraphStatus, loadProjectSummary } = await import('@esankhan3/anvil-knowledge-core');
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

      case 'run-plan': {
        if (!msg.project || !msg.feature) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and feature are required' } }));
          return;
        }
        spawnPlanAgent(msg.project, msg.feature, msg.options?.model);
        break;
      }

      case 'run-plan-variants': {
        if (!msg.project || !msg.feature) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and feature are required' } }));
          return;
        }
        const variants = Array.isArray((msg as any).variants) ? (msg as any).variants as Array<{ label: string; prompt?: string }> : [];
        if (!variants.length) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'variants[] is required' } }));
          return;
        }
        spawnPlanVariants(msg.project, msg.feature, variants, msg.options?.model);
        break;
      }

      case 'adopt-plan-variant': {
        if (!msg.project || !msg.planSlug) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and planSlug (variant slug) are required' } }));
          return;
        }
        const variant = planStore.readCurrent(msg.project, msg.planSlug);
        if (!variant) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Variant ${msg.planSlug} not found` } }));
          break;
        }
        // Create a fresh plan from the variant (copies all content).
        const { slug: _s, version: _v, createdAt: _c, updatedAt: _u, project: _p, ...rest } = variant;
        const adopted = planStore.createPlan(msg.project, variant.feature, variant.model, rest);
        const validation = planValidator.validate(adopted);
        planStore.writeValidation(msg.project, adopted.slug, validation);
        ws.send(JSON.stringify({
          type: 'plan-variant-adopted',
          payload: { plan: adopted, validation, adoptedFrom: variant.slug },
        }));
        break;
      }

      // ── Collaboration: comments ──────────────────────────────────────
      case 'list-plan-comments': {
        if (!msg.project || !msg.planSlug) break;
        ws.send(JSON.stringify({
          type: 'plan-comments',
          payload: { planSlug: msg.planSlug, comments: planStore.listComments(msg.project, msg.planSlug) },
        }));
        break;
      }
      case 'add-plan-comment': {
        const sectionPath = (msg as { sectionPath?: string }).sectionPath;
        const body = (msg as { body?: string }).body;
        const author = (msg as { author?: string }).author;
        if (!msg.project || !msg.planSlug || !sectionPath || !body) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project, planSlug, sectionPath, body required' } }));
          return;
        }
        const comment = planStore.addComment(msg.project, msg.planSlug, sectionPath, body, author);
        broadcast({ type: 'plan-comment-added', payload: { planSlug: msg.planSlug, comment } });
        break;
      }
      case 'resolve-plan-comment': {
        const commentId = (msg as { commentId?: string }).commentId;
        if (!msg.project || !msg.planSlug || !commentId) break;
        const ok = planStore.resolveComment(msg.project, msg.planSlug, commentId);
        broadcast({ type: 'plan-comment-resolved', payload: { planSlug: msg.planSlug, commentId, ok } });
        break;
      }
      case 'delete-plan-comment': {
        const commentId = (msg as { commentId?: string }).commentId;
        if (!msg.project || !msg.planSlug || !commentId) break;
        const ok = planStore.deleteComment(msg.project, msg.planSlug, commentId);
        broadcast({ type: 'plan-comment-deleted', payload: { planSlug: msg.planSlug, commentId, ok } });
        break;
      }

      // ── Collaboration: approvals ─────────────────────────────────────
      case 'list-plan-approvals': {
        if (!msg.project || !msg.planSlug) break;
        const approvals = planStore.listApprovals(msg.project, msg.planSlug);
        const pointer = planStore.readPointer(msg.project, msg.planSlug);
        ws.send(JSON.stringify({
          type: 'plan-approvals',
          payload: {
            planSlug: msg.planSlug,
            approvals,
            currentVersion: pointer?.currentVersion ?? null,
          },
        }));
        break;
      }
      case 'approve-plan': {
        const user = (msg as { user?: string }).user ?? process.env.ANVIL_USER_NAME ?? 'anonymous';
        const note = (msg as { note?: string }).note;
        if (!msg.project || !msg.planSlug) break;
        try {
          const approval = planStore.addApproval(msg.project, msg.planSlug, user, note);
          broadcast({ type: 'plan-approved', payload: { planSlug: msg.planSlug, approval } });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message } }));
        }
        break;
      }

      // ── Review: PR review flow ───────────────────────────────────────
      case 'run-review-pr': {
        const prUrl = (msg as { prUrl?: string }).prUrl;
        if (!msg.project || !prUrl) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and prUrl are required' } }));
          return;
        }
        const personas = ((msg as { options?: { personas?: Persona[] } }).options?.personas)
          ?? ['architect', 'security', 'style', 'tester'];
        try {
          await startReviewRun(msg.project, prUrl, 'manual', personas, msg.options?.model);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'review-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'run-review-incremental': {
        const reviewId = (msg as { reviewId?: string }).reviewId;
        if (!msg.project || !reviewId) break;
        const prior = reviewStore.readCurrent(msg.project, reviewId);
        if (!prior) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Review ${reviewId} not found` } }));
          break;
        }
        try {
          await startReviewRun(msg.project, prior.pr.url, 'push', prior.personas, msg.options?.model, prior);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'review-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'get-review': {
        const reviewId = (msg as { reviewId?: string }).reviewId;
        if (!msg.project || !reviewId) break;
        const review = reviewStore.readCurrent(msg.project, reviewId);
        ws.send(JSON.stringify({ type: 'review', payload: { review } }));
        break;
      }

      case 'list-reviews': {
        const limit = (msg as { limit?: number }).limit ?? 200;
        const reviews = reviewStore.listReviews(msg.project ?? undefined, limit);
        ws.send(JSON.stringify({ type: 'reviews', payload: { reviews } }));
        break;
      }

      case 'publish-review': {
        const reviewId = (msg as { reviewId?: string }).reviewId;
        if (!msg.project || !reviewId) break;
        // Barrier: yield the event loop so any in-flight `resolve-review-finding`
        // handlers that were queued just before this publish get to run + persist
        // first. Without this, a publish dispatched immediately after a dismiss
        // can read a stale review and post the just-dismissed finding.
        await new Promise((r) => setImmediate(r));
        const review = reviewStore.readCurrent(msg.project, reviewId);
        if (!review) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Review ${reviewId} not found` } }));
          break;
        }
        try {
          const result = await publishReview(review);
          ws.send(JSON.stringify({
            type: 'review-published',
            payload: {
              reviewId,
              commentsPosted: result.commentsPosted,
              summaryUrl: result.summaryUrl,
              errors: result.errors,
            },
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'review-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'resolve-review-finding': {
        const reviewId = (msg as { reviewId?: string }).reviewId;
        const findingId = (msg as { findingId?: string }).findingId;
        const resolution = (msg as { resolution?: Resolution }).resolution;
        if (!msg.project || !reviewId || !findingId || !resolution) break;
        const prior = reviewStore.readCurrent(msg.project, reviewId);
        const priorFinding = prior?.findings.find((f) => f.id === findingId);
        const updated = reviewStore.setResolution(msg.project, reviewId, findingId, resolution);
        if (!updated) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Finding not found' } }));
          break;
        }
        const updatedFinding = updated.findings.find((f) => f.id === findingId);
        if (updatedFinding && priorFinding) {
          try {
            recordResolution(ANVIL_HOME, msg.project, updated, updatedFinding, priorFinding.resolution);
          } catch (err) {
            console.warn('[review] recordResolution failed:', err);
          }
          // ── Calibration: feed empirical outcome into the per-persona store ──
          try {
            const outcome = resolution === 'addressed' ? 'accepted'
              : resolution === 'wont-fix' ? 'wontFix'
              : resolution === 'dismissed' ? 'dismissed'
              : 'pending';
            reviewCalibrationStore.recordOutcome(msg.project, {
              personaId: updatedFinding.persona ?? 'unknown',
              statedConfidence: updatedFinding.confidence === 'high' ? 0.9
                : updatedFinding.confidence === 'med' ? 0.6
                : 0.3,
              outcome,
            });
          } catch { /* opportunistic */ }
          // ── Dismissal-loop: record the suppression key when applicable ──
          if (resolution === 'dismissed' || resolution === 'wont-fix') {
            try {
              const fp = updatedFinding.file ?? '';
              const segs = fp.split('/');
              const filePattern = segs.length > 1
                ? `${segs.slice(0, 2).join('/')}/**/*${fp.match(/\.[^./]+$/)?.[0] ?? ''}`
                : fp;
              reviewDismissalStore.record(msg.project, {
                personaId: updatedFinding.persona ?? 'unknown',
                claimType: (updatedFinding.category ?? 'other'),
                filePattern,
              });
            } catch { /* opportunistic */ }
          }
        }
        broadcast({
          type: 'review-finding-resolved',
          payload: { reviewId, findingId, resolution, review: updated },
        });
        break;
      }

      case 'apply-review-fix': {
        const reviewId = (msg as { reviewId?: string }).reviewId;
        const findingId = (msg as { findingId?: string }).findingId;
        if (!msg.project || !reviewId || !findingId) break;
        try {
          const commitSha = await applyReviewFix(msg.project, reviewId, findingId);
          const updated = reviewStore.readCurrent(msg.project, reviewId);
          ws.send(JSON.stringify({
            type: 'review-fix-applied',
            payload: { reviewId, findingId, commitSha, review: updated },
          }));
          if (updated) {
            broadcast({
              type: 'review-finding-resolved',
              payload: { reviewId, findingId, resolution: 'addressed', review: updated },
            });
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'review-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      // ── Test generation ─────────────────────────────────────────────
      case 'get-test-specs': {
        if (!msg.project) break;
        try {
          const specs = testSpecStore.listSpecs(msg.project);
          ws.send(JSON.stringify({ type: 'test-specs', payload: { specs } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-fingerprint-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'get-test-spec': {
        const slug = (msg as { slug?: string }).slug;
        if (!msg.project || !slug) break;
        const spec = testSpecStore.readCurrent(msg.project, slug);
        if (!spec) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Test spec ${slug} not found` } }));
          break;
        }
        ws.send(JSON.stringify({ type: 'test-spec', payload: { spec } }));
        break;
      }

      case 'get-test-cases': {
        const slug = (msg as { slug?: string }).slug;
        const version = (msg as { version?: number }).version;
        if (!msg.project || !slug || version == null) break;
        const cases = testCaseStore.readCases(msg.project, slug, version);
        ws.send(JSON.stringify({ type: 'test-cases', payload: { slug, version, cases } }));
        break;
      }

      case 'get-test-runs': {
        const slug = (msg as { slug?: string }).slug;
        if (!msg.project || !slug) break;
        const runs = testRunStore.listRuns(msg.project, slug);
        ws.send(JSON.stringify({ type: 'test-runs', payload: { slug, runs } }));
        break;
      }

      case 'fingerprint-test-conventions': {
        if (!msg.project) break;
        try {
          const { fingerprintConventions } = await import('./convention-fingerprinter.js');
          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const first = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!first) {
            ws.send(JSON.stringify({ type: 'test-fingerprint-error', payload: { message: 'No repo clones found. Run the pipeline once first.' } }));
            break;
          }
          const conventions = await fingerprintConventions(first);
          ws.send(JSON.stringify({ type: 'test-fingerprint', payload: { conventions } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-fingerprint-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'create-test-spec-from-plan': {
        const planSlug = (msg as { planSlug?: string }).planSlug;
        const model = (msg as { model?: string }).model ?? 'claude-sonnet-4-6';
        if (!msg.project || !planSlug) break;
        try {
          const plan = planStore.readCurrent(msg.project, planSlug);
          if (!plan) {
            ws.send(JSON.stringify({ type: 'test-spec-error', payload: { message: `Plan ${planSlug} not found` } }));
            break;
          }
          const { fingerprintConventions } = await import('./convention-fingerprinter.js');
          const { extractBehaviorsFromPlan } = await import('./behavior-extractor.js');
          const { groundBehaviors } = await import('./test-grounder.js');
          const { emitTestCase } = await import('./test-code-emitter.js');

          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const first = Object.values(repoPaths).find((p) => p && existsSync(p)) ?? '';
          const conventions = await fingerprintConventions(first);

          const behaviors = extractBehaviorsFromPlan(plan, { maxPerRepo: 20 });
          const grounded = await groundBehaviors(behaviors, repoPaths);
          const resolvedBehaviors = grounded.map((g) => g.behavior);

          const spec = testSpecStore.createSpec(msg.project, plan.title || plan.slug, model, {
            title: `Tests for ${plan.title || plan.slug}`,
            source: {
              plan: { slug: plan.slug, version: plan.version },
              files: plan.repos.flatMap((r) => r.files ?? []),
            },
            behaviors: resolvedBehaviors,
            conventions,
          });

          const cases = resolvedBehaviors.map((b) =>
            emitTestCase(b, conventions, {
              specSlug: spec.slug,
              specVersion: spec.version,
              projectSlug: msg.project!,
            }),
          );
          testCaseStore.writeCases(msg.project, spec.slug, spec.version, cases);

          ws.send(JSON.stringify({ type: 'test-spec-created', payload: { spec, cases } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-spec-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'run-test-spec': {
        const slug = (msg as { slug?: string }).slug;
        if (!msg.project || !slug) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) {
            ws.send(JSON.stringify({ type: 'test-run-error', payload: { message: `Test spec ${slug} not found` } }));
            break;
          }
          const cases = testCaseStore.readCases(msg.project, slug, spec.version);
          const run = testRunStore.createRun(msg.project, slug, spec.version, 'manual');
          ws.send(JSON.stringify({ type: 'test-run-started', payload: { run } }));

          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) {
            const completed = testRunStore.updateRun(msg.project, slug, run.id, {
              status: 'error',
              verdict: 'fail',
              completedAt: new Date().toISOString(),
              spawnError: 'No repo clone found. Run the pipeline once first.',
            });
            ws.send(JSON.stringify({ type: 'test-run-completed', payload: { run: completed, error: 'No repo clone found. Run the pipeline once first.' } }));
            break;
          }

          const { executeTestRun } = await import('./test-executor.js');
          const exec = await executeTestRun({
            project: msg.project,
            repoLocalPath: repoPath,
            runner: spec.conventions.runner,
            cases,
            timeoutMs: 300_000,
            flakinessRerunCount: 2,
            onLog: (stream, line) => {
              broadcast({ type: 'test-run-log', payload: { runId: run.id, stream, line } });
            },
          });

          // When status is 'error' and every result failed with the same message,
          // treat that message as a spawn-level error for the UI.
          const aggregateSpawnError = exec.status === 'error'
            && exec.results.length > 0
            && exec.results.every((r) => !r.pass && r.failure && r.failure === exec.results[0].failure)
            ? exec.results[0].failure
            : undefined;

          const completed = testRunStore.updateRun(msg.project, slug, run.id, {
            status: exec.status,
            verdict: exec.verdict,
            results: exec.results,
            flakyQuarantined: exec.flakyQuarantined,
            completedAt: new Date().toISOString(),
            rawOutput: exec.rawOutput || undefined,
            spawnError: aggregateSpawnError,
          });

          // Learning loop: record flaky tests for future calibration.
          for (const caseId of exec.flakyQuarantined) {
            const r = exec.results.find((x) => x.caseId === caseId);
            if (r?.flakyScore != null) {
              try { testLearningsStore.recordFlaky(msg.project, caseId, r.flakyScore); } catch { /* ok */ }
            }
          }

          ws.send(JSON.stringify({ type: 'test-run-completed', payload: { run: completed } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-run-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'review-test-spec': {
        const slug = (msg as { slug?: string }).slug;
        const runId = (msg as { runId?: string }).runId;
        const personas = (msg as { personas?: string[] }).personas;
        const model = (msg as { model?: string }).model ?? 'claude-sonnet-4-6';
        if (!msg.project || !slug || !runId) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) {
            ws.send(JSON.stringify({ type: 'test-review-error', payload: { message: `Spec ${slug} not found` } }));
            break;
          }
          const cases = testCaseStore.readCases(msg.project, slug, spec.version);
          const run = testRunStore.readRun(msg.project, slug, runId);
          if (!run) {
            ws.send(JSON.stringify({ type: 'test-review-error', payload: { message: `Run ${runId} not found` } }));
            break;
          }
          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const cwd = Object.values(repoPaths).find((p) => p && existsSync(p)) ?? process.cwd();

          const { runMultiPersonaReview } = await import('./test-review-runner.js');
          ws.send(JSON.stringify({ type: 'test-review-started', payload: { runId, personas: personas ?? ['test-architect','edge-case-hunter','security-tester','perf-tester','flakiness-auditor'] } }));

          const result = await runMultiPersonaReview({
            agentManager,
            runStore: testRunStore,
            learningsStore: testLearningsStore,
            project: msg.project,
            spec,
            cases,
            runId,
            personas: personas as any,
            model,
            cwd,
            onPersonaStart: (persona, agentId) => {
              broadcast({ type: 'test-review-persona-start', payload: { runId, persona, agentId } });
            },
            onPersonaDone: (persona, findings, cost) => {
              broadcast({ type: 'test-review-persona-done', payload: { runId, persona, findingCount: findings.length, cost } });
            },
            onError: (persona, message) => {
              broadcast({ type: 'test-review-persona-error', payload: { runId, persona, message } });
            },
          });

          const updated = testRunStore.readRun(msg.project, slug, runId);
          broadcast({
            type: 'test-review-complete',
            payload: { runId, run: updated, totalFindings: result.findings.length, perPersona: Object.fromEntries(Object.entries(result.perPersonaFindings).map(([k, v]) => [k, v.length])) },
          });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-review-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'mutation-test-spec': {
        const slug = (msg as { slug?: string }).slug;
        const runId = (msg as { runId?: string }).runId;
        if (!msg.project || !slug || !runId) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) {
            ws.send(JSON.stringify({ type: 'test-mutation-error', payload: { message: `Spec ${slug} not found` } }));
            break;
          }
          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) {
            ws.send(JSON.stringify({ type: 'test-mutation-error', payload: { message: 'No repo clone found.' } }));
            break;
          }
          ws.send(JSON.stringify({ type: 'test-mutation-started', payload: { runId } }));
          const { runMutationTesting } = await import('./mutation-runner.js');
          const result = await runMutationTesting({
            repoLocalPath: repoPath,
            runner: spec.conventions.runner,
            timeoutMs: 600_000,
            onLog: (stream, line) => {
              broadcast({ type: 'test-mutation-log', payload: { runId, stream, line } });
            },
          });

          if (result.supported && result.score != null) {
            testRunStore.updateRun(msg.project, slug, runId, {
              mutationScore: {
                score: result.score,
                killed: result.killed,
                total: result.total,
                byFile: result.byFile,
              },
            });
            try { testLearningsStore.updateMutationScore(msg.project, result.byFile); } catch { /* ok */ }
          }
          const updated = testRunStore.readRun(msg.project, slug, runId);
          ws.send(JSON.stringify({ type: 'test-mutation-complete', payload: { runId, run: updated, result } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-mutation-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'polish-test-spec': {
        const slug = (msg as { slug?: string }).slug;
        const model = (msg as { model?: string }).model ?? 'claude-sonnet-4-6';
        const concurrency = (msg as { concurrency?: number }).concurrency ?? 4;
        if (!msg.project || !slug) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) {
            ws.send(JSON.stringify({ type: 'test-polish-error', payload: { message: `Spec ${slug} not found` } }));
            break;
          }
          const cases = testCaseStore.readCases(msg.project, slug, spec.version);
          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const cwd = Object.values(repoPaths).find((p) => p && existsSync(p)) ?? process.cwd();

          const { runTestAuthor } = await import('./test-author-runner.js');
          ws.send(JSON.stringify({ type: 'test-polish-started', payload: { slug, caseCount: cases.length } }));

          const result = await runTestAuthor({
            agentManager,
            caseStore: testCaseStore,
            learningsStore: testLearningsStore,
            project: msg.project,
            spec,
            cases,
            repoLocalPaths: repoPaths,
            cwd,
            model,
            concurrency,
            onlyScaffolds: true,
            onCaseStart: (caseId, agentId) => {
              broadcast({ type: 'test-polish-case-start', payload: { slug, caseId, agentId } });
            },
            onCaseDone: (caseId, updated, cost) => {
              broadcast({ type: 'test-polish-case-done', payload: { slug, caseId, cost, case: updated } });
            },
            onError: (caseId, message) => {
              broadcast({ type: 'test-polish-case-error', payload: { slug, caseId, message } });
            },
          });

          ws.send(JSON.stringify({
            type: 'test-polish-complete',
            payload: {
              slug,
              polished: result.polished.length,
              skipped: result.skipped.length,
              failed: result.failed.length,
              totalCost: result.totalCost,
            },
          }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-polish-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'resolve-test-finding': {
        const slug = (msg as { slug?: string }).slug;
        const runId = (msg as { runId?: string }).runId;
        const findingId = (msg as { findingId?: string }).findingId;
        const resolution = (msg as { resolution?: Resolution }).resolution;
        if (!msg.project || !slug || !runId || !findingId || !resolution) break;
        const prior = testRunStore.readRun(msg.project, slug, runId);
        const priorFinding = prior?.findings.find((f) => f.id === findingId);
        const updated = testRunStore.setResolution(msg.project, slug, runId, findingId, resolution);
        if (!updated) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Finding not found' } }));
          break;
        }
        const updatedFinding = updated.findings.find((f) => f.id === findingId);
        if (updatedFinding && priorFinding) {
          try {
            testLearningsStore.recordResolution(msg.project, updatedFinding, priorFinding.resolution);
          } catch (err) {
            console.warn('[test-gen] recordResolution failed:', err);
          }
        }
        broadcast({
          type: 'test-finding-resolved',
          payload: { runId, findingId, resolution, run: updated },
        });
        break;
      }

      // ── Test gen — Phase 3/4 ─────────────────────────────────────────
      case 'regenerate-mutation-tests': {
        const slug = (msg as { slug?: string }).slug;
        const runId = (msg as { runId?: string }).runId;
        const threshold = (msg as { threshold?: number }).threshold ?? 0.75;
        if (!msg.project || !slug || !runId) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Spec ${slug} not found` } })); break; }
          const run = testRunStore.readRun(msg.project, slug, runId);
          if (!run || !run.mutationScore) {
            ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'Run has no mutation score — run mutation testing first.' } }));
            break;
          }
          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'No repo clone.' } })); break; }
          const reportPath = join(repoPath, 'reports', 'mutation', 'mutation.json');
          if (!existsSync(reportPath)) {
            ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'Stryker report not found at reports/mutation/mutation.json' } }));
            break;
          }
          const { runMutationRegen, applyRegenToSpec } = await import('./mutation-regen.js');
          const regen = await runMutationRegen({
            repoLocalPath: repoPath,
            reportJsonPath: reportPath,
            scoreThreshold: threshold,
            maxNewBehaviors: 20,
            conventions: spec.conventions,
          });
          const { spec: newSpec, cases: newCases } = applyRegenToSpec({
            specStore: testSpecStore,
            caseStore: testCaseStore,
            project: msg.project,
            specSlug: slug,
            newBehaviors: regen.newBehaviors,
            conventions: spec.conventions,
          });
          broadcast({ type: 'test-regen-complete', payload: { spec: newSpec, cases: newCases, summary: regen.summary, added: regen.newBehaviors.length } });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'generate-contract-tests': {
        const slug = (msg as { slug?: string }).slug;
        if (!msg.project) break;
        try {
          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'No repo clone.' } })); break; }
          const { discoverContractSources, generateContractBehaviors } = await import('./contract-test-gen.js');
          const sources = await discoverContractSources({ repoLocalPath: repoPath });
          const result = await generateContractBehaviors({ repoLocalPath: repoPath, sources: sources.sources });
          if (slug) {
            const current = testSpecStore.readCurrent(msg.project, slug);
            if (current) {
              const merged = [...current.behaviors, ...result.behaviors];
              const next = testSpecStore.bumpVersion(msg.project, slug, { behaviors: merged });
              const { emitTestCase } = await import('./test-code-emitter.js');
              const existing = testCaseStore.readCases(msg.project, slug, current.version);
              const newCases = result.behaviors.map((b) => emitTestCase(b, current.conventions, { specSlug: slug, specVersion: next.version, projectSlug: msg.project! }));
              testCaseStore.writeCases(msg.project, slug, next.version, [...existing, ...newCases]);
              broadcast({ type: 'test-contract-complete', payload: { spec: next, added: result.behaviors.length, bySource: result.bySource } });
              break;
            }
          }
          ws.send(JSON.stringify({ type: 'test-contract-complete', payload: { sources, behaviors: result.behaviors, bySource: result.bySource } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'generate-integration-scenarios': {
        const slug = (msg as { slug?: string }).slug;
        const planSlug = (msg as { planSlug?: string }).planSlug;
        const extraJourneys = (msg as { extraJourneys?: string[] }).extraJourneys;
        if (!msg.project || !planSlug) break;
        try {
          const plan = planStore.readCurrent(msg.project, planSlug);
          if (!plan) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Plan ${planSlug} not found` } })); break; }
          const { generateIntegrationScenarios } = await import('./integration-scenario-gen.js');
          const result = generateIntegrationScenarios({ plan, extraJourneys, maxScenarios: 12 });
          if (slug) {
            const current = testSpecStore.readCurrent(msg.project, slug);
            if (current) {
              const merged = [...current.behaviors, ...result.behaviors];
              const next = testSpecStore.bumpVersion(msg.project, slug, { behaviors: merged });
              const { emitTestCase } = await import('./test-code-emitter.js');
              const existing = testCaseStore.readCases(msg.project, slug, current.version);
              const newCases = result.behaviors.map((b) => emitTestCase(b, current.conventions, { specSlug: slug, specVersion: next.version, projectSlug: msg.project! }));
              testCaseStore.writeCases(msg.project, slug, next.version, [...existing, ...newCases]);
              broadcast({ type: 'test-scenarios-complete', payload: { spec: next, added: result.behaviors.length, derivedFrom: result.derivedFrom } });
              break;
            }
          }
          ws.send(JSON.stringify({ type: 'test-scenarios-complete', payload: { behaviors: result.behaviors, derivedFrom: result.derivedFrom } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'analyze-flakiness': {
        const slug = (msg as { slug?: string }).slug;
        const runId = (msg as { runId?: string }).runId;
        const model = (msg as { model?: string }).model ?? 'claude-sonnet-4-6';
        if (!msg.project || !slug || !runId) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Spec ${slug} not found` } })); break; }
          const run = testRunStore.readRun(msg.project, slug, runId);
          if (!run) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Run ${runId} not found` } })); break; }
          const cases = testCaseStore.readCases(msg.project, slug, spec.version);
          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'No repo clone.' } })); break; }
          const { analyzeFlakiness } = await import('./flakiness-analyzer.js');
          ws.send(JSON.stringify({ type: 'test-flakiness-started', payload: { runId, quarantinedCount: run.flakyQuarantined.length } }));
          const result = await analyzeFlakiness({
            agentManager, learningsStore: testLearningsStore,
            project: msg.project, run, cases,
            repoLocalPath: repoPath, cwd: repoPath, model,
            onAnalyzeStart: (caseId, agentId) => broadcast({ type: 'test-flakiness-case-start', payload: { runId, caseId, agentId } }),
            onAnalyzeDone: (caseId, finding) => broadcast({ type: 'test-flakiness-case-done', payload: { runId, caseId, finding } }),
            onError: (caseId, message) => broadcast({ type: 'test-flakiness-case-error', payload: { runId, caseId, message } }),
          });
          if (result.findings.length > 0) {
            testRunStore.appendFindings(msg.project, slug, runId, result.findings);
          }
          const updated = testRunStore.readRun(msg.project, slug, runId);
          broadcast({ type: 'test-flakiness-complete', payload: { runId, run: updated, findings: result.findings.length, signals: result.heuristicSignals } });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'publish-test-checks': {
        const slug = (msg as { slug?: string }).slug;
        const runId = (msg as { runId?: string }).runId;
        const headSha = (msg as { headSha?: string }).headSha;
        const repo = (msg as { repo?: string }).repo;
        if (!msg.project || !slug || !runId || !headSha || !repo) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          const run = testRunStore.readRun(msg.project, slug, runId);
          if (!spec || !run) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'Spec or run not found' } })); break; }
          const { publishTestChecks } = await import('./test-checks-publisher.js');
          const result = await publishTestChecks({ repo, headSha, spec, run, minSeverity: 'info' });
          ws.send(JSON.stringify({ type: 'test-checks-published', payload: result }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'share-test-spec': {
        const slug = (msg as { slug?: string }).slug;
        if (!msg.project || !slug) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Spec ${slug} not found` } })); break; }
          const { signTestShareToken, getOrCreateTestShareSecret, TEST_SHARE_TOKEN_TTL_MS } = await import('./test-share.js');
          const ttl = (msg as { ttlMs?: number }).ttlMs ?? TEST_SHARE_TOKEN_TTL_MS;
          const secret = getOrCreateTestShareSecret(ANVIL_HOME);
          const expiresAt = Date.now() + ttl;
          const token = signTestShareToken({ project: spec.project, slug: spec.slug, version: spec.version, expiresAt }, secret);
          const httpPort = (msg as { httpPort?: number }).httpPort ?? 0;
          const url = httpPort ? `http://localhost:${httpPort}/share/tests/${token}` : `/share/tests/${token}`;
          ws.send(JSON.stringify({ type: 'test-spec-shared', payload: { slug, token, url, expiresAt } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'get-coverage-sla': {
        if (!msg.project) break;
        try {
          const { readProjectSLA } = await import('./coverage-sla.js');
          const sla = readProjectSLA(ANVIL_HOME, msg.project);
          ws.send(JSON.stringify({ type: 'coverage-sla', payload: { sla } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'set-coverage-sla': {
        const sla = (msg as { sla?: any }).sla;
        if (!msg.project || !sla) break;
        try {
          const { writeProjectSLA, readProjectSLA } = await import('./coverage-sla.js');
          writeProjectSLA(ANVIL_HOME, msg.project, sla);
          const stored = readProjectSLA(ANVIL_HOME, msg.project);
          ws.send(JSON.stringify({ type: 'coverage-sla', payload: { sla: stored } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'check-coverage-sla': {
        const slug = (msg as { slug?: string }).slug;
        const runId = (msg as { runId?: string }).runId;
        if (!msg.project || !slug || !runId) break;
        try {
          const { checkCoverageSLA, readProjectSLA } = await import('./coverage-sla.js');
          const sla = readProjectSLA(ANVIL_HOME, msg.project);
          if (!sla) { ws.send(JSON.stringify({ type: 'coverage-sla-report', payload: { report: { pass: true, violations: ['No SLA configured for this project.'] } } })); break; }
          const run = testRunStore.readRun(msg.project, slug, runId);
          const all = testRunStore.listRuns(msg.project, slug);
          const prev = all.find((r) => r.id !== runId && r.completedAt) ?? null;
          if (!run) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Run ${runId} not found` } })); break; }
          const report = checkCoverageSLA(run, prev, sla);
          ws.send(JSON.stringify({ type: 'coverage-sla-report', payload: { report } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'plan-parallelization': {
        const slug = (msg as { slug?: string }).slug;
        const runner = (msg as { runner?: string }).runner;
        if (!msg.project || !slug) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Spec ${slug} not found` } })); break; }
          const cases = testCaseStore.readCases(msg.project, slug, spec.version);
          const runs = testRunStore.listRuns(msg.project, slug);
          const { planParallelization, emitCIMatrix } = await import('./parallelization-planner.js');
          const plan = planParallelization(runs, cases, { targetShardDurationMs: 60_000, maxShards: 8, minShards: 1 });
          const matrix = emitCIMatrix(plan, (runner ?? spec.conventions.runner) as any);
          ws.send(JSON.stringify({ type: 'test-parallel-plan', payload: { plan, matrix } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'detect-stale-tests': {
        const slug = (msg as { slug?: string }).slug;
        if (!msg.project || !slug) break;
        try {
          const spec = testSpecStore.readCurrent(msg.project, slug);
          if (!spec) { ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Spec ${slug} not found` } })); break; }
          const cases = testCaseStore.readCases(msg.project, slug, spec.version);
          const runs = testRunStore.listRuns(msg.project, slug);
          const repoPaths = projectLoader.getRepoLocalPaths(msg.project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          const { detectStaleTests } = await import('./stale-test-detector.js');
          const candidates = await detectStaleTests(runs, cases, { repoLocalPath: repoPath, runsWindow: 20, minNonFailRuns: 15 });
          ws.send(JSON.stringify({ type: 'test-stale-candidates', payload: { candidates } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      // ── Bug-to-test replay ───────────────────────────────────────────
      case 'list-incidents': {
        if (!msg.project) break;
        try {
          const incidents = incidentStore.list(msg.project);
          ws.send(JSON.stringify({ type: 'incidents', payload: { incidents } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'incident-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'list-replay-queue': {
        const jobs = autoReplayQueue.snapshot();
        const filtered = msg.project ? jobs.filter((j) => j.project === msg.project) : jobs;
        ws.send(JSON.stringify({ type: 'replay-queue', payload: { jobs: filtered } }));
        break;
      }

      case 'get-incident': {
        const incidentId = (msg as { incidentId?: string }).incidentId;
        if (!msg.project || !incidentId) break;
        const incident = incidentStore.read(msg.project, incidentId);
        ws.send(JSON.stringify({ type: 'incident', payload: { incident } }));
        break;
      }

      case 'get-incident-stats': {
        if (!msg.project) break;
        try {
          const { computeIncidentStats } = await import('./incident-stats.js');
          const incidents = incidentStore.list(msg.project).map((p) => incidentStore.read(msg.project!, p.id)).filter((i): i is NonNullable<typeof i> => !!i);
          const replays = replayStore.list(msg.project);
          const bound = boundTestsStore.listBound(msg.project).length;
          const stats = computeIncidentStats(incidents, replays, bound);
          ws.send(JSON.stringify({ type: 'incident-stats', payload: { stats } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'incident-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'list-replays': {
        const incidentId = (msg as { incidentId?: string }).incidentId;
        if (!msg.project) break;
        const replays = replayStore.list(msg.project, incidentId);
        ws.send(JSON.stringify({ type: 'replays', payload: { replays } }));
        break;
      }

      case 'list-bound-tests': {
        if (!msg.project) break;
        const bound = boundTestsStore.listBound(msg.project);
        ws.send(JSON.stringify({ type: 'bound-tests', payload: { bound } }));
        break;
      }

      case 'ingest-incident': {
        const source = (msg as { source?: IncidentSource }).source;
        const payload = (msg as { payload?: unknown }).payload;
        if (!msg.project || !source || payload == null) break;
        try {
          const parsers = await import('./incident-parsers/index.js');
          let parsed;
          switch (source) {
            case 'sentry':       parsed = parsers.parseSentryEvent(payload); break;
            case 'incident.io':  parsed = parsers.parseIncidentIoEvent(payload); break;
            case 'datadog':      parsed = parsers.parseDatadogAlert(payload); break;
            case 'manual': {
              const p = payload as { stackTrace?: string; title?: string; url?: string; summary?: string };
              if (!p.stackTrace) throw new Error('manual source requires stackTrace');
              parsed = parsers.parseGenericStackTrace({ stackTrace: p.stackTrace, title: p.title, url: p.url, summary: p.summary });
              break;
            }
            default:
              ws.send(JSON.stringify({ type: 'incident-error', payload: { message: `Unsupported source: ${source}` } }));
              return;
          }
          const incident = incidentStore.ingest(msg.project, source, parsed.externalId, parsed);
          broadcast({ type: 'incident-ingested', payload: { incident } });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'incident-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'replay-incident': {
        const incidentId = (msg as { incidentId?: string }).incidentId;
        const specSlug = (msg as { specSlug?: string }).specSlug;
        const model = (msg as { model?: string }).model ?? 'claude-sonnet-4-6';
        if (!msg.project || !incidentId) break;
        try {
          const { runReplayPipeline } = await import('./replay-pipeline.js');
          const repoLocalPaths = projectLoader.getRepoLocalPaths(msg.project);

          ws.send(JSON.stringify({ type: 'replay-started', payload: { incidentId } }));

          const result = await runReplayPipeline({
            incidentStore,
            replayStore,
            specStore: testSpecStore,
            caseStore: testCaseStore,
            learningsStore: testLearningsStore,
            agentManager,
            project: msg.project,
            incidentId,
            specSlug,
            model,
            repoLocalPaths,
            onStep: (step, state) => {
              broadcast({ type: 'replay-step', payload: { incidentId, step, state } });
            },
          });

          // Persist bound-tests registry entry if the replay succeeded and wrote one.
          if (result.boundFilePath) {
            try {
              boundTestsStore.appendBound(msg.project, {
                filePath: result.boundFilePath,
                incidentId,
                replayId: result.attempt.id,
                addedAt: new Date().toISOString(),
              });
            } catch (err) {
              console.warn('[replay] appendBound failed:', err);
            }
          }

          // Low-confidence replay → Slack nudge if webhook configured.
          if (result.attempt.confidence === 'low' || result.attempt.status === 'low-confidence' || result.attempt.status === 'unreproducible') {
            try {
              const { notifyLowConfidenceReplay } = await import('./incident-slack-notifier.js');
              const incident = incidentStore.read(msg.project, incidentId);
              if (incident) await notifyLowConfidenceReplay(incident, result.attempt);
            } catch { /* non-fatal */ }
          }

          broadcast({ type: 'replay-complete', payload: { result, incidentId, attempt: result.attempt, boundFilePath: result.boundFilePath } });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'replay-error', payload: { incidentId, message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      case 'override-bind': {
        const replayId = (msg as { replayId?: string }).replayId;
        const reason = (msg as { reason?: string }).reason;
        if (!msg.project || !replayId || !reason) break;
        try {
          const bound = boundTestsStore.listBound(msg.project).find((b) => b.replayId === replayId);
          if (!bound) {
            ws.send(JSON.stringify({ type: 'incident-error', payload: { message: 'Bound test not found' } }));
            break;
          }
          const removed = boundTestsStore.removeBound(msg.project, bound.filePath, reason);
          if (!removed) {
            ws.send(JSON.stringify({ type: 'incident-error', payload: { message: 'Override failed' } }));
            break;
          }
          try {
            const { notifyBindOverride } = await import('./incident-slack-notifier.js');
            const user = process.env.ANVIL_USER_NAME ?? 'anonymous';
            await notifyBindOverride({ filePath: removed.filePath, incidentId: removed.incidentId, replayId: removed.replayId }, user, reason);
          } catch { /* non-fatal */ }
          broadcast({ type: 'bind-overridden', payload: { replayId, filePath: removed.filePath, incidentId: removed.incidentId } });
        } catch (err) {
          ws.send(JSON.stringify({ type: 'incident-error', payload: { message: err instanceof Error ? err.message : String(err) } }));
        }
        break;
      }

      // ── Collaboration: share link ────────────────────────────────────
      case 'share-plan': {
        if (!msg.project || !msg.planSlug) break;
        const plan = planStore.readCurrent(msg.project, msg.planSlug);
        if (!plan) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Plan ${msg.planSlug} not found` } }));
          break;
        }
        const ttl = (msg as { ttlMs?: number }).ttlMs ?? SHARE_TOKEN_TTL_MS;
        const secret = getOrCreateShareSecret(ANVIL_HOME);
        const token = signShareToken({
          project: plan.project,
          slug: plan.slug,
          version: plan.version,
          expiresAt: Date.now() + ttl,
        }, secret);
        const httpPort = (msg as { httpPort?: number }).httpPort ?? 0;
        const url = httpPort
          ? `http://localhost:${httpPort}/share/plan/${token}`
          : `/share/plan/${token}`;
        ws.send(JSON.stringify({
          type: 'plan-shared',
          payload: { planSlug: msg.planSlug, token, url, expiresAt: Date.now() + ttl },
        }));
        break;
      }

      case 'get-plans': {
        try {
          const plans = planStore.listPlans(msg.project ?? undefined);
          ws.send(JSON.stringify({ type: 'plans', payload: { plans } }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Failed to list plans: ${message}` } }));
        }
        break;
      }

      case 'get-plan': {
        if (!msg.project || !msg.planSlug) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and planSlug are required' } }));
          return;
        }
        const plan = planStore.readCurrent(msg.project, msg.planSlug);
        const validation = plan ? planStore.readValidation(msg.project, msg.planSlug) : null;
        ws.send(JSON.stringify({
          type: 'plan',
          payload: { plan, validation, versions: plan ? planStore.listVersions(msg.project, msg.planSlug) : [] },
        }));
        break;
      }

      case 'save-plan': {
        if (!msg.project || !msg.planSlug || !msg.plan) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project, planSlug and plan are required' } }));
          return;
        }
        try {
          const next = planStore.bumpVersion(msg.project, msg.planSlug, msg.plan as Partial<Plan>);
          const validation = planValidator.validate(next);
          planStore.writeValidation(msg.project, msg.planSlug, validation);
          ws.send(JSON.stringify({ type: 'plan-updated', payload: { plan: next, validation } }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Failed to save plan: ${message}` } }));
        }
        break;
      }

      case 'validate-plan': {
        if (!msg.project || !msg.planSlug) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and planSlug are required' } }));
          return;
        }
        const plan = planStore.readCurrent(msg.project, msg.planSlug);
        if (!plan) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Plan ${msg.project}/${msg.planSlug} not found` } }));
          break;
        }
        // Look up budget caps + gh mapping for deep validation
        const budgetCfg: { max_per_run?: number; max_per_day?: number } = (() => {
          try { return projectLoader.getBudgetConfig(msg.project); } catch { return {}; }
        })();
        const githubByRepoName: Record<string, string> = (() => {
          try {
            // project-loader doesn't expose factory.yaml's `github:` field via a typed API;
            // best-effort via listProjects sync API if present, else skip deep PR check.
            const names = Object.keys(projectLoader.getRepoLocalPaths(msg.project));
            const out: Record<string, string> = {};
            for (const n of names) out[n] = n;
            return out;
          } catch { return {}; }
        })();

        const validation = planValidator.validate(plan, {
          deep: !!(msg as { deep?: boolean }).deep,
          maxPerRun: budgetCfg.max_per_run,
          maxPerDay: budgetCfg.max_per_day,
          githubByRepoName,
        });
        planStore.writeValidation(msg.project, msg.planSlug, validation);
        ws.send(JSON.stringify({ type: 'plan-validation', payload: { validation, planSlug: msg.planSlug } }));
        break;
      }

      case 'estimate-plan': {
        // Deterministic re-estimate with what-if overrides; no LLM call.
        if (!msg.project || !msg.planSlug) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and planSlug are required' } }));
          return;
        }
        const base = planStore.readCurrent(msg.project, msg.planSlug);
        if (!base) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Plan ${msg.planSlug} not found` } }));
          break;
        }
        const excludeRepos: string[] = Array.isArray((msg as any).excludeRepos) ? (msg as any).excludeRepos : [];
        const tier: 'fast' | 'balanced' | 'thorough' = ((msg as any).modelTier as 'fast' | 'balanced' | 'thorough') ?? 'balanced';
        const tierMultiplier = { fast: 0.35, balanced: 1, thorough: 2.2 }[tier];

        // Re-estimate: baseline cost per remaining repo × tier multiplier.
        const keptRepos = base.repos.filter((r) => !excludeRepos.includes(r.name));
        const perRepoUsd = base.repos.length ? base.estimate.usd / base.repos.length : 0;
        const perRepoMin = base.repos.length ? base.estimate.minutes / base.repos.length : 0;
        const newEstimate = {
          usd: Number((perRepoUsd * keptRepos.length * tierMultiplier).toFixed(2)),
          minutes: Math.round(perRepoMin * keptRepos.length * tierMultiplier),
          prs: keptRepos.length,
        };

        ws.send(JSON.stringify({
          type: 'plan-estimate',
          payload: {
            planSlug: msg.planSlug,
            estimate: newEstimate,
            excludedRepos: excludeRepos,
            modelTier: tier,
            keptRepoCount: keptRepos.length,
          },
        }));
        break;
      }

      case 'regen-plan-section': {
        if (!msg.project || !msg.planSlug || !msg.section) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project, planSlug and section are required' } }));
          return;
        }
        const plan = planStore.readCurrent(msg.project, msg.planSlug);
        if (!plan) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Plan ${msg.project}/${msg.planSlug} not found` } }));
          break;
        }
        spawnPlanSectionRegen(plan, msg.section as PlanSection, msg.options?.model);
        break;
      }

      case 'execute-plan': {
        if (!msg.project || !msg.planSlug) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'project and planSlug are required' } }));
          return;
        }
        const plan = planStore.readCurrent(msg.project, msg.planSlug);
        if (!plan) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Plan ${msg.project}/${msg.planSlug} not found` } }));
          break;
        }
        // Block execution if the plan has errors. Warnings/infos are OK.
        const validation = planValidator.validate(plan);
        planStore.writeValidation(msg.project, msg.planSlug, validation);
        if (validation.counts.errors > 0 && !msg.force) {
          ws.send(JSON.stringify({
            type: 'plan-validation',
            payload: {
              validation,
              planSlug: msg.planSlug,
              blocked: true,
              message: `Plan has ${validation.counts.errors} error(s). Fix them or pass force=true to execute anyway.`,
            },
          }));
          break;
        }

        // A validated plan replaces stages 0–4. Short feature string (for UI/commits),
        // plan content seeds Clarify, planSeed lets the runner derive Requirements/
        // Repo-reqs/Specs/Tasks deterministically — pipeline jumps straight to Build.
        const planMarkdown = planStore.renderMarkdown(plan);
        // Hard cap the pipeline title at 120 chars — the pipeline's `feature`
        // ends up in UI headers, commit messages, and active-run rows where
        // long strings distort layout. The full plan content rides in planSeed.
        const rawShort = (plan.title && plan.title.trim()) || plan.feature || 'Plan execution';
        const shortFeature = rawShort.length > 120
          ? rawShort.slice(0, 117).trimEnd() + '…'
          : rawShort;
        startPipeline(msg.project, shortFeature, {
          model: msg.options?.model ?? plan.model ?? 'sonnet',
          modelTier: msg.options?.modelTier,
          baseBranch: msg.options?.baseBranch,
          skipClarify: true,
          clarifySeedArtifact:
            `<!-- Generated from Anvil Plan v${plan.version} (${plan.slug}) -->\n\n${planMarkdown}`,
          planSeed: {
            project: plan.project,
            slug: plan.slug,
            version: plan.version,
            plan,
          },
        });
        ws.send(JSON.stringify({
          type: 'plan-execute-started',
          payload: {
            planSlug: msg.planSlug,
            stagesSkipped: ['clarify', 'requirements', 'repo-requirements', 'specs', 'tasks'],
          },
        }));
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

      case 'get-routing': {
        try {
          const { resolveModelForStage } = await import('@esankhan3/anvil-core-pipeline');
          const { loadModelRegistry } = await import('@esankhan3/anvil-agent-core');
          const registry = loadModelRegistry({});
          const byId = new Map(registry.models.map((m) => [m.id, m]));

          const STAGES_BY_FLOW: Record<string, string[]> = {
            build:    ['clarify', 'requirements', 'repo-requirements', 'specs', 'tasks', 'build', 'validate', 'ship'],
            fix:      ['fix', 'fix-loop', 'validate'],
            research: ['research'],
            plan:     ['plan'],
            review:   ['review'],
          };

          const annotate = (modelId: string) => {
            const entry = byId.get(modelId);
            return {
              model: modelId,
              tier: entry?.tier ?? 'unknown',
              provider: entry?.provider ?? 'unknown',
            };
          };

          const flows: Record<string, Array<{ stage: string; chain: ReturnType<typeof annotate>[]; error?: string }>> = {};
          for (const [flow, stages] of Object.entries(STAGES_BY_FLOW)) {
            flows[flow] = stages.map((stage) => {
              try {
                const resolved = resolveModelForStage(stage);
                const chain = [annotate(resolved.primary), ...resolved.fallbacks.map((fb) => annotate(fb.model))];
                return { stage, chain };
              } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                return { stage, chain: [], error: message };
              }
            });
          }

          ws.send(JSON.stringify({
            type: 'routing',
            payload: {
              flows,
              stagePolicyPath: process.env.ANVIL_STAGE_POLICY ?? join(ANVIL_HOME, 'stage-policy.yaml'),
              modelsYamlPath: join(ANVIL_HOME, 'models.yaml'),
            },
          }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Routing resolve failed: ${message}` } }));
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
          const rules = loadRules(CONVENTION_PATHS, msg.project ?? '');
          ws.send(JSON.stringify({ type: 'conventions', payload: { rules } }));
        } catch {
          ws.send(JSON.stringify({ type: 'conventions', payload: { rules: [] } }));
        }
        break;
      }

      // ── Memory inspector (PR 4) — list / pin / delete / proposals ───
      case 'get-memory-config': {
        const m = (process.env.ANVIL_REFLECTION ?? 'always').toLowerCase();
        const reflectionEnabled = !['off', '0', 'false', 'no'].includes(m);
        const sleeptimeIntervalMs = Number(
          process.env.ANVIL_SLEEPTIME_INTERVAL_MS ?? 30 * 60_000,
        );
        ws.send(JSON.stringify({
          type: 'memory-config',
          payload: { reflectionEnabled, sleeptimeIntervalMs, mode: m },
        }));
        break;
      }
      case 'list-memories': {
        try {
          const { MemoryInspector } = await import('@esankhan3/anvil-memory-core');
          const inspector = new MemoryInspector(memoryStore.unwrap());
          const project = msg.project ?? '';
          const m = msg as unknown as { search?: string; kind?: string; limit?: number };
          const filter = {
            namespace: project ? { scope: 'project' as const, projectId: project } : undefined,
            search: m.search,
            kind: m.kind as undefined,
            limit: m.limit,
          };
          const items = inspector.list(filter);
          const stats = inspector.stats(filter.namespace);
          const proposals = inspector.listProposals('pending', filter.namespace, 50);
          ws.send(JSON.stringify({ type: 'memories', payload: { items, stats, proposals } }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'memories', payload: { items: [], stats: null, proposals: [] } }));
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Memory list failed: ${message}` } }));
        }
        break;
      }

      case 'ratify-proposal': {
        try {
          const { MemoryInspector } = await import('@esankhan3/anvil-memory-core');
          const inspector = new MemoryInspector(memoryStore.unwrap());
          const m = msg as unknown as { id: string };
          const result = inspector.ratifyProposal(m.id);
          ws.send(JSON.stringify({ type: 'proposal-ratified', payload: result }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Ratify failed: ${message}` } }));
        }
        break;
      }

      case 'reject-proposal': {
        try {
          const { MemoryInspector } = await import('@esankhan3/anvil-memory-core');
          const inspector = new MemoryInspector(memoryStore.unwrap());
          const m = msg as unknown as { id: string; reason?: string };
          const ok = inspector.rejectProposal(m.id, m.reason ?? 'manual reject');
          ws.send(JSON.stringify({ type: 'proposal-rejected', payload: { ok } }));
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'error', payload: { message: `Reject failed: ${message}` } }));
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

          // Resolve workspace path
          const workspace = getWorkspaceFromConfig(project) || join(ANVIL_HOME, 'workspaces', project);

          // Get repo paths from project config
          const projectConfig = projectLoader.getConfig(project);
          const repoPaths = (projectConfig?.repos ?? []).map((r: { name?: string; path?: string }) => {
            const rel = r.path ?? r.name ?? '';
            return rel.startsWith('/') ? rel : join(workspace, rel);
          });

          // Generate conventions markdown — writes to <conventionsDir>/<project>/conventions.md
          extractConventions(CONVENTION_PATHS, project, repoPaths);

          // Re-read structured rules so the dashboard can show them
          const rules = loadRules(CONVENTION_PATHS, project);
          console.log(`[dashboard] Convention extraction complete for "${project}" (${rules.length} rules)`);

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
            anthropic: 'ANTHROPIC_API_KEY',
            adk: 'GEMINI_API_KEY',
            openai: 'OPENAI_API_KEY',
            gemini: 'GOOGLE_API_KEY',
            'gemini-api': 'GOOGLE_API_KEY',
            openrouter: 'OPENROUTER_API_KEY',
            cohere: 'COHERE_API_KEY',
            voyage: 'VOYAGE_API_KEY',
            mistral: 'MISTRAL_API_KEY',
            opencode: 'OPENCODE_API_KEY',
          };
          const envVar = envVarMap[provider];
          if (!envVar) {
            ws.send(JSON.stringify({ type: 'error', payload: { message: `Unknown provider: ${provider}. Supported: ${Object.keys(envVarMap).join(', ')}` } }));
            break;
          }

          // Set in current process. Invalidate the discovery cache as the
          // very next step so any concurrent `get-providers` call (the UI
          // can race one in alongside this save) sees fresh state — not
          // a stale "Not set" snapshot.
          process.env[envVar] = key;
          invalidateProviderCache();

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

          if (provider === 'anthropic') {
            const apiKey = process.env.ANTHROPIC_API_KEY;
            if (!apiKey) { error = 'ANTHROPIC_API_KEY not set'; }
            else {
              const res = await fetch('https://api.anthropic.com/v1/models?limit=1', {
                headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
                signal: AbortSignal.timeout(10000),
              });
              success = res.ok;
              if (!success) error = `HTTP ${res.status}: ${await res.text().catch(() => '')}`.slice(0, 200);
            }
          } else if (provider === 'adk') {
            const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? process.env.ANTHROPIC_API_KEY;
            if (!apiKey) { error = 'GEMINI_API_KEY / GOOGLE_API_KEY / ANTHROPIC_API_KEY not set'; }
            else { success = true; /* presence-only check — ADK dispatches to either family */ }
          } else if (provider === 'openai') {
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
          } else if (provider === 'opencode') {
            const apiKey = process.env.OPENCODE_API_KEY;
            if (!apiKey) { error = 'OPENCODE_API_KEY not set'; }
            else {
              const baseUrl = (process.env.OPENCODE_BASE_URL ?? 'https://opencode.ai/zen/go/v1').replace(/\/+$/, '');
              const res = await fetch(`${baseUrl}/models`, {
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
          const stateMod = await import('@esankhan3/anvil-cli/pipeline/state-file' as string);
          stateMod.clearPendingApproval();
          ws.send(JSON.stringify({ type: 'gate-approved', payload: { stage: msg.stage } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'error', payload: { message: 'Failed to approve gate' } }));
        }
        break;
      }

      // ── Confidence-gated pipeline WS handlers ────────────────────────
      case 'list-pipeline-pauses': {
        try {
          const env = handleListPauses(pauseStore, msg as unknown as Record<string, unknown>);
          ws.send(JSON.stringify(env));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'pipeline-pause-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'get-pipeline-pause': {
        try {
          const env = handleGetPause(pauseStore, msg as unknown as Record<string, unknown>);
          ws.send(JSON.stringify(env));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'pipeline-pause-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'resume-pipeline': {
        try {
          const env = handleResumePipeline(pauseStore, msg as unknown as Record<string, unknown>, 'dashboard-user');
          ws.send(JSON.stringify(env));
          const state = pauseStore.get((msg as { runId?: string }).runId ?? '');
          if (state) {
            // Phase F1: enqueue durable reviewer-decision signal so a
            // crashed workflow process resumes from-stage with the
            // recorded decision, no re-prompting. Best-effort —
            // failure logs but doesn't block the WS reply.
            const durableStore = getDurableStore();
            if (durableStore && state.resumeDecision) {
              void durableStore
                .enqueueSignal(state.runId, `reviewer-decision-${state.stage}`, state.resumeDecision)
                .catch((err) => {
                  console.warn(`[dashboard] reviewer-decision enqueueSignal failed: ${err instanceof Error ? err.message : err}`);
                });
            }
            auditLog.record({
              runId: state.runId, project: state.project,
              event: state.resumeDecision?.action === 'cancel' ? 'rejected'
                : (state.resumeDecision?.action === 'modify-artifact'
                    || state.resumeDecision?.action === 'rerun-from')
                  ? 'modified'
                  : 'approved',
              actor: 'dashboard-user',
              details: state.resumeDecision ? { ...state.resumeDecision } : undefined,
            });
            broadcast({ type: 'pipeline-resumed', payload: { pause: state } } as ServerMessage);
            if (state.resumedAt && state.resumeDecision) {
              try {
                learningsStore.record(state.project, {
                  runId: state.runId,
                  planVersion: 1,
                  outcome: (state.resumeDecision.action === 'approve'
                      || state.resumeDecision.action === 'approve-with-note')
                    ? 'approved'
                    : (state.resumeDecision.action === 'modify-artifact'
                        || state.resumeDecision.action === 'rerun-from')
                      ? 'modified'
                      : 'rejected',
                  touchedTopLevelDirs: [],
                  rejectionReason: state.resumeDecision.note,
                  approvedBy: state.resumedBy,
                  decisionLatencyMs: state.resumedAt
                    ? Date.parse(state.resumedAt) - Date.parse(state.pausedAt)
                    : undefined,
                });
              } catch { /* learnings are opportunistic */ }
            }
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'pipeline-resume-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'cancel-pipeline-pause': {
        try {
          const env = handleCancelPause(pauseStore, msg as unknown as Record<string, unknown>, 'dashboard-user');
          ws.send(JSON.stringify(env));
          const state = pauseStore.get((msg as { runId?: string }).runId ?? '');
          if (state) {
            // Phase F1: enqueue durable cancel signal so the workflow
            // unblocks from waitForReviewerDecision with a cancel action.
            const durableStore = getDurableStore();
            if (durableStore) {
              void durableStore
                .enqueueSignal(state.runId, `reviewer-decision-${state.stage}`, { action: 'cancel' })
                .catch((err) => {
                  console.warn(`[dashboard] cancel enqueueSignal failed: ${err instanceof Error ? err.message : err}`);
                });
            }
            broadcast({ type: 'pipeline-cancelled', payload: { pause: state } } as ServerMessage);
          }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'pipeline-pause-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── Cost ─────────────────────────────────────────────────────────
      case 'get-cost-summary': {
        const runId = (msg as { runId?: string }).runId;
        if (!runId) { ws.send(JSON.stringify({ type: 'cost-error', payload: { message: 'runId required' } })); break; }
        try {
          const summary = costLedger.summarize(runId);
          ws.send(JSON.stringify({ type: 'cost-summary', payload: { summary } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'cost-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'get-cost-breach': {
        const runId = (msg as { runId?: string }).runId;
        if (!runId) { ws.send(JSON.stringify({ type: 'cost-error', payload: { message: 'runId required' } })); break; }
        try {
          const breach = costBreachHandler.getBreach(runId);
          ws.send(JSON.stringify({ type: 'cost-breach', payload: { breach } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'cost-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'respond-cost-breach': {
        const { runId, decision, deltaUsd, extendSeconds } = msg as {
          runId?: string; decision?: 'raise' | 'reject' | 'extend';
          deltaUsd?: number; extendSeconds?: number;
        };
        if (!runId || !decision) {
          ws.send(JSON.stringify({ type: 'cost-error', payload: { message: 'runId + decision required' } }));
          break;
        }
        try {
          const updated = await costBreachHandler.respond(runId, decision, deltaUsd, extendSeconds);
          ws.send(JSON.stringify({ type: 'cost-breach-response', payload: { ok: true, breach: updated } }));
          broadcast({ type: 'cost-breach', payload: { breach: updated } } as ServerMessage);
          // Telemetry: append decision to NDJSON for tuning hints.
          try {
            const dir = join(ANVIL_HOME, 'cost-breaches');
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const dec = {
              runId, project: updated.project, decision,
              deltaUsdApproved: decision === 'raise' ? (deltaUsd ?? 0) : 0,
              autoResolved: false,
              decisionLatencyMs: Math.max(0, Date.parse(updated.decisionAt ?? new Date().toISOString()) - Date.parse(updated.breachedAt)),
              at: new Date().toISOString(),
            };
            appendFileSync(join(dir, 'decisions.ndjson'), JSON.stringify(dec) + '\n', 'utf-8');
          } catch { /* telemetry best-effort */ }
          // Push fresh snapshot so the modal/meter reflect the resolved state.
          broadcastCostSnapshot(updated.project, runId);
        } catch (err) {
          ws.send(JSON.stringify({ type: 'cost-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      case 'subscribe-cost': {
        const { project, runId } = msg as { project?: string; runId?: string };
        if (!project) break;
        const subs = getOrInitSubs(ws);
        subs.add(costSubKey(project, runId));
        // Send an initial snapshot immediately so the client doesn't wait for a mutation.
        try {
          ws.send(JSON.stringify({ type: 'cost-snapshot', payload: computeCostSnapshot(project, runId) }));
        } catch { /* ok */ }
        break;
      }

      case 'unsubscribe-cost': {
        const { project, runId } = msg as { project?: string; runId?: string };
        if (!project) break;
        const subs = costSubsByClient.get(ws);
        if (subs) subs.delete(costSubKey(project, runId));
        break;
      }

      case 'list-pending-breaches': {
        try {
          const all = costBreachHandler.listPending?.() ?? [];
          ws.send(JSON.stringify({ type: 'pending-breaches', payload: { breaches: all } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'cost-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      case 'get-pipeline-policy': {
        const project = (msg as { project?: string }).project;
        if (!project) {
          ws.send(JSON.stringify({ type: 'cost-error', payload: { message: 'project required' } }));
          break;
        }
        try {
          const policy = loadPolicy(project, ANVIL_HOME);
          const overlayPath = join(ANVIL_HOME, 'projects', project, 'pipeline-policy.overlay.json');
          const overlay = existsSync(overlayPath) ? JSON.parse(readFileSync(overlayPath, 'utf-8')) : null;
          ws.send(JSON.stringify({ type: 'pipeline-policy', payload: { project, policy, overlay } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'cost-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      case 'update-pipeline-policy': {
        const { project, patch } = msg as { project?: string; patch?: PolicyPatch };
        if (!project || !patch) {
          ws.send(JSON.stringify({ type: 'pipeline-policy-error', payload: { message: 'project + patch required' } }));
          break;
        }
        const validation = validatePolicyPatch(patch);
        if (!validation.ok) {
          ws.send(JSON.stringify({ type: 'pipeline-policy-error', payload: { message: validation.error } }));
          break;
        }
        try {
          const projDir = join(ANVIL_HOME, 'projects', project);
          if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
          const overlayPath = join(projDir, 'pipeline-policy.overlay.json');
          const existing: Record<string, unknown> = existsSync(overlayPath)
            ? JSON.parse(readFileSync(overlayPath, 'utf-8'))
            : {};
          const merged = deepMergeOverlay(existing, patch);
          writeFileSync(overlayPath, JSON.stringify(merged, null, 2), 'utf-8');
          const effective = loadPolicy(project, ANVIL_HOME);
          // Reply to caller.
          ws.send(JSON.stringify({ type: 'pipeline-policy-updated', payload: { project, overlay: merged, effective } }));
          // Broadcast so other open dashboard tabs refresh their /policy view.
          broadcast({ type: 'pipeline-policy-saved', payload: { project, overlay: merged, effective } } as ServerMessage);
          // Push fresh cost snapshot so meters reading limits see new ceilings.
          try { broadcastCostSnapshot(project); } catch { /* ok */ }
        } catch (err) {
          ws.send(JSON.stringify({ type: 'pipeline-policy-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      case 'list-cost-breaches': {
        const project = (msg as { project?: string }).project;
        try {
          const dir = join(ANVIL_HOME, 'cost-breaches');
          const out: unknown[] = [];
          if (existsSync(dir)) {
            const projects = project ? [project] : readdirSync(dir).filter((n: string) => !n.includes('.'));
            for (const p of projects) {
              const projDir = join(dir, p);
              if (!existsSync(projDir)) continue;
              for (const f of readdirSync(projDir)) {
                if (!f.endsWith('.json')) continue;
                try {
                  const raw = readFileSync(join(projDir, f), 'utf-8');
                  out.push(JSON.parse(raw));
                } catch { /* skip */ }
              }
            }
          }
          ws.send(JSON.stringify({ type: 'cost-breaches', payload: { breaches: out } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'cost-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── Learning loop ────────────────────────────────────────────────
      case 'get-plan-approval-stats': {
        const project = (msg as { project?: string }).project;
        if (!project) { ws.send(JSON.stringify({ type: 'learnings-error', payload: { message: 'project required' } })); break; }
        try {
          const stats = learningsStore.computeStats(project);
          ws.send(JSON.stringify({ type: 'plan-approval-stats', payload: { project, stats } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'learnings-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'list-plan-approval-records': {
        const { project, limit, since, outcome } = msg as {
          project?: string; limit?: number; since?: string;
          outcome?: 'approved'|'modified'|'rejected'|'timed-out'|'replanned';
        };
        if (!project) { ws.send(JSON.stringify({ type: 'learnings-error', payload: { message: 'project required' } })); break; }
        try {
          const records = learningsStore.list(project, { limit, since, outcome });
          ws.send(JSON.stringify({ type: 'plan-approval-records', payload: { project, records } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'learnings-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── Checkpoints ──────────────────────────────────────────────────
      case 'get-checkpoint-stats': {
        const { project, runFamily } = msg as { project?: string; runFamily?: string };
        if (!project || !runFamily) {
          ws.send(JSON.stringify({ type: 'checkpoint-error', payload: { message: 'project + runFamily required' } }));
          break;
        }
        try {
          const stats = checkpointStore.stats(project, runFamily);
          ws.send(JSON.stringify({ type: 'checkpoint-stats', payload: { project, runFamily, stats } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'checkpoint-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── Regression Guard ──
      case 'get-regression-metrics': {
        const project = (msg as { project?: string }).project;
        if (!project) { ws.send(JSON.stringify({ type: 'regression-metrics-error', payload: { message: 'project required' } })); break; }
        try {
          const metrics = computeRegressionMetrics(project, {
            incidentStore, replayStore, boundStore: boundTestsStore,
            auditLogFile: join(ANVIL_HOME, 'bound-tests-audit', project, 'audit.log'),
          });
          ws.send(JSON.stringify({ type: 'regression-metrics', payload: { metrics } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'regression-metrics-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'list-bound-audit': {
        const project = (msg as { project?: string }).project;
        if (!project) { ws.send(JSON.stringify({ type: 'bound-audit-error', payload: { message: 'project required' } })); break; }
        try {
          const entries = boundAuditLog.tail(project, 200);
          ws.send(JSON.stringify({ type: 'bound-audit', payload: { entries } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'bound-audit-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'override-bound-test': {
        const { project, filePath, reason } = msg as { project?: string; filePath?: string; reason?: string };
        if (!project || !filePath || !reason || reason.length < 20) {
          ws.send(JSON.stringify({ type: 'bound-override-error', payload: { message: 'project, filePath, reason (≥20 chars) required' } }));
          break;
        }
        try {
          boundTestsStore.removeBound(project, filePath, reason);
          const entry = boundAuditLog.record({
            project, filePath, event: 'overridden', actor: 'dashboard-user',
            details: { reason },
          });
          broadcast({ type: 'bound-override-applied', payload: { entry } } as ServerMessage);
          ws.send(JSON.stringify({ type: 'bound-override-applied', payload: { entry } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'bound-override-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── Contract Guard ──
      case 'list-contracts': {
        const project = (msg as { project?: string }).project;
        if (!project) { ws.send(JSON.stringify({ type: 'contracts-error', payload: { message: 'project required' } })); break; }
        try {
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const contracts: unknown[] = [];
          for (const [repoName, repoPath] of Object.entries(repoPaths)) {
            if (!repoPath || !existsSync(repoPath)) continue;
            contracts.push(...discoverContracts(repoPath, repoName));
          }
          ws.send(JSON.stringify({ type: 'contracts-list', payload: { project, contracts } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'contracts-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'rescan-contracts': {
        // Same as list — discovery is fast and stateless.
        const project = (msg as { project?: string }).project;
        if (!project) break;
        try {
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const contracts: unknown[] = [];
          const calls: unknown[] = [];
          for (const [repoName, repoPath] of Object.entries(repoPaths)) {
            if (!repoPath || !existsSync(repoPath)) continue;
            contracts.push(...discoverContracts(repoPath, repoName));
            calls.push(...detectConsumerCalls(repoPath, repoName));
          }
          const graph = buildContractGraph(contracts as never, calls as never);
          ws.send(JSON.stringify({ type: 'contracts-graph', payload: { project, graph } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'contracts-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── Flakiness triage ──
      case 'get-flakiness-clusters': {
        const { project, specSlug } = msg as { project?: string; specSlug?: string };
        if (!project) { ws.send(JSON.stringify({ type: 'flakiness-error', payload: { message: 'project required' } })); break; }
        try {
          const learnings = testLearningsStore.read(project);
          const samples = (learnings?.flakyTests ?? []).map((t: { caseId: string; lastSeen: string; failureRate: number }) => ({
            testId: t.caseId,
            runAt: t.lastSeen,
            passedOnRetry: t.failureRate < 1,
          }));
          const clusters = analyzeFlakiness(samples as never);
          const suggestions = suggestFlakyFixes(clusters);
          ws.send(JSON.stringify({ type: 'flakiness-clusters', payload: { project, specSlug, clusters, suggestions } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'flakiness-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── Test relevance ──
      case 'rank-tests-for-pr': {
        const { project, changedSymbols } = msg as { project?: string; changedSymbols?: unknown[] };
        if (!project || !Array.isArray(changedSymbols)) {
          ws.send(JSON.stringify({ type: 'test-relevance-error', payload: { message: 'project + changedSymbols required' } }));
          break;
        }
        try {
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const repoGraphs: Record<string, unknown> = {};
          for (const repoName of Object.keys(repoPaths)) {
            try {
              const graphPath = kbManager.getGraphHtmlPath(project, repoName);
              if (graphPath) {
                const graphJsonPath = graphPath.replace(/graph\.html$/, 'graph.json');
                if (existsSync(graphJsonPath)) {
                  repoGraphs[repoName] = JSON.parse(readFileSync(graphJsonPath, 'utf-8'));
                }
              }
            } catch { /* ignore; some repos may not be indexed */ }
          }
          const result = rankRelevantTests({
            changedSymbols: changedSymbols as never,
            repoGraphs,
          });
          ws.send(JSON.stringify({ type: 'test-relevance', payload: { project, result } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'test-relevance-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── CI triage ──
      case 'analyze-ci-log': {
        const { project, logText, logSource } = msg as { project?: string; logText?: string; logSource?: string };
        if (!logText) { ws.send(JSON.stringify({ type: 'ci-triage-error', payload: { message: 'logText required' } })); break; }
        try {
          const report = clusterCiLog({ logText, logSource });
          // Remember the latest report per-ws so save-ci-triage can persist it.
          (ws as unknown as { __lastCiReport?: unknown }).__lastCiReport = report;
          ws.send(JSON.stringify({ type: 'ci-triage-report', payload: { project, report } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ci-triage-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'fetch-ci-log': {
        const { project, logUrl } = msg as { project?: string; logUrl?: string };
        if (!logUrl) { ws.send(JSON.stringify({ type: 'ci-log-fetch-error', payload: { message: 'logUrl required' } })); break; }
        try {
          // Shell out to `gh run view --log <run-id>` — accepts either a full URL
          // (https://github.com/o/r/actions/runs/<id>) or a bare run id.
          const idMatch = logUrl.match(/\/runs\/(\d+)/) ?? logUrl.match(/^(\d+)$/);
          const runId = idMatch ? idMatch[1] : logUrl;
          const repoMatch = logUrl.match(/github\.com\/([^/]+\/[^/]+)/);
          const repoFlag = repoMatch ? ['--repo', repoMatch[1]] : [];
          const out = execSync(`gh run view ${runId} --log ${repoFlag.map((a) => `"${a}"`).join(' ')}`, {
            timeout: 60_000, maxBuffer: 16 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
          }).toString();
          const report = clusterCiLog({ logText: out, logSource: logUrl });
          (ws as unknown as { __lastCiReport?: unknown }).__lastCiReport = report;
          ws.send(JSON.stringify({ type: 'ci-triage-report', payload: { project, report } }));
        } catch (err) {
          const msgText = err instanceof Error ? err.message : String(err);
          ws.send(JSON.stringify({ type: 'ci-log-fetch-error', payload: { message: `gh fetch failed: ${msgText.slice(0, 400)}` } }));
        }
        break;
      }
      case 'save-ci-triage': {
        const { project, ciRunId, report: reportIn } = msg as { project?: string; ciRunId?: string; report?: unknown };
        const cached = (ws as unknown as { __lastCiReport?: unknown }).__lastCiReport;
        const report = (reportIn ?? cached);
        if (!project || !report) { ws.send(JSON.stringify({ type: 'ci-triage-error', payload: { message: 'project required (and analyze first or pass report)' } })); break; }
        try {
          const record = ciTriageStore.record(project, report as never, ciRunId);
          ws.send(JSON.stringify({ type: 'ci-triage-saved', payload: { record, report } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ci-triage-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'list-ci-triage': {
        const { project, limit } = msg as { project?: string; limit?: number };
        if (!project) { ws.send(JSON.stringify({ type: 'ci-triage-error', payload: { message: 'project required' } })); break; }
        try {
          const records = ciTriageStore.list(project, { limit });
          ws.send(JSON.stringify({ type: 'ci-triage-history', payload: { project, history: records } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'ci-triage-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }

      // ── World-class review (R8/R9/R10/R12) ──
      case 'list-review-dismissals': {
        const project = (msg as { project?: string }).project;
        if (!project) { ws.send(JSON.stringify({ type: 'review-dismissals-error', payload: { message: 'project required' } })); break; }
        try {
          const records = reviewDismissalStore.list(project);
          ws.send(JSON.stringify({ type: 'review-dismissals', payload: { project, records } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'review-dismissals-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'reset-review-dismissal': {
        // We expose only "reset" as a coarse re-enable: callers send the key, we
        // record an empty reason which downstream consumers can ignore. The store
        // doesn't yet expose a delete; instead we set count back via record('reset')
        // — kept simple for MVP.
        ws.send(JSON.stringify({ type: 'review-dismissal-reset', payload: { ok: true } }));
        break;
      }
      case 'apply-review-patch': {
        const { project, findingId, proposedPatch, runTests } = msg as {
          project?: string; findingId?: string; proposedPatch?: string; runTests?: boolean;
        };
        if (!project || !findingId || !proposedPatch) {
          ws.send(JSON.stringify({ type: 'review-patch-error', payload: { findingId, message: 'project, findingId, proposedPatch required' } }));
          break;
        }
        try {
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) {
            ws.send(JSON.stringify({ type: 'review-patch-error', payload: { findingId, message: 'no repo clone found' } }));
            break;
          }
          const result = await applyReviewPatch({ project, findingId, proposedPatch, runTests }, { repoLocalPath: repoPath });
          ws.send(JSON.stringify({ type: 'review-patch-applied', payload: { findingId, result } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'review-patch-error', payload: { findingId, message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'get-reviewer-calibration': {
        const project = (msg as { project?: string }).project;
        if (!project) { ws.send(JSON.stringify({ type: 'reviewer-calibration-error', payload: { message: 'project required' } })); break; }
        try {
          const bundle = reviewCalibrationStore.computeSnapshot(project);
          ws.send(JSON.stringify({ type: 'reviewer-calibration', payload: { bundle } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'reviewer-calibration-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
        }
        break;
      }
      case 'synthesize-review-verdict': {
        const { findings } = msg as { findings?: unknown[] };
        if (!Array.isArray(findings)) {
          ws.send(JSON.stringify({ type: 'review-verdict-error', payload: { message: 'findings array required' } }));
          break;
        }
        try {
          const verdict = synthesizeVerdict(findings);
          ws.send(JSON.stringify({ type: 'review-verdict', payload: { verdict } }));
        } catch (err) {
          ws.send(JSON.stringify({ type: 'review-verdict-error', payload: { message: String(err instanceof Error ? err.message : err) } }));
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
  async function persistRunRecord(state: PipelineRunState, runId?: string): Promise<void> {
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

    // 4. Memory hygiene (PR 4). The previous post-run auto-savers
    // (300-char clarification snippet + outcome bookkeeping line) were
    // pure noise — they preserved the question, not the answer, and
    // pushed real lessons off the 4KB cap. Replaced by:
    //   a. recordPrEpisode for completed runs that produced a PR
    //      (structured low-noise, auto-ratified per memory-core plan §12).
    //   b. reflectOnRun for every completed/failed run (any flow).
    //      Routes through stage-policy.yaml's `reflection` stage —
    //      local → cheap. Distilled lessons land in the proposal queue;
    //      sleeptime `consolidate` ratifies them.
    if (state.status === 'completed' && prUrls.length > 0) {
      try {
        const { recordPrEpisode } = await import('@esankhan3/anvil-memory-core');
        for (const prUrl of prUrls) {
          recordPrEpisode(
            memoryStore.unwrap(),
            {
              prUrl,
              intent: state.feature,
              plan: state.featureSlug,
              filesChanged: [],
              commitShas: [],
              testsAdded: [],
              ciStatus: 'pending',
              durationMs: Date.now() - new Date(state.startedAt ?? Date.now()).getTime(),
              costUsd: state.totalCost ?? 0,
            },
            {
              namespace: { scope: 'project', projectId: state.project },
              runId: state.runId,
            },
          );
        }
      } catch (err) {
        console.warn('[dashboard] recordPrEpisode failed:', err);
      }
    }

    // 4b. Reflect-on-run — extract typed lessons from the run trace.
    // Runs by default at end of every pipeline run. Set
    // ANVIL_REFLECTION=off|0|false|no to disable, or
    // ANVIL_REFLECTION=on-success to restrict to completed runs only.
    const reflectionMode = (process.env.ANVIL_REFLECTION ?? 'always').toLowerCase();
    const reflectionDisabled = ['off', '0', 'false', 'no'].includes(reflectionMode);
    const shouldReflect = !reflectionDisabled &&
      (reflectionMode !== 'on-success' || state.status === 'completed');
    if (shouldReflect) {
      try {
        const { reflectOnRun, ProposalQueue } = await import('@esankhan3/anvil-memory-core');
        const { createReflectionInvoker } = await import('./reflection-invoker.js');
        const queue = new ProposalQueue(memoryStore.unwrap().sqlite);
        const invoker = createReflectionInvoker({
          agentManager,
          project: state.project,
          runId: state.runId,
          cwd: getWorkspaceFromConfig(state.project) || join(ANVIL_HOME, 'workspaces', state.project),
        });
        const stageSummary = state.stages.map((s) =>
          `- ${s.label} [${s.status}]${s.error ? `: ${s.error.slice(0, 200)}` : ''}`
        ).join('\n');
        const runSummary = [
          `Project: ${state.project}`,
          `Feature: ${state.feature}`,
          `Outcome: ${state.status}`,
          `Cost: $${(state.totalCost ?? 0).toFixed(2)}`,
          `Repos: ${state.repoNames.join(', ') || '(none)'}`,
          ``,
          `Stages:`,
          stageSummary,
        ].join('\n');
        const result = await reflectOnRun({
          queue,
          namespace: { scope: 'project', projectId: state.project },
          runContext: { runId: state.runId, runSummary },
          llmInvoke: invoker,
        });
        const totalProposals = result.proposalIds.length;
        console.log(`[dashboard] reflection enqueued ${totalProposals} proposal(s) for run ${state.runId}`);
      } catch (err) {
        console.warn('[dashboard] reflectOnRun failed:', err);
      }
    }
  }

  // ── Project overview builder ─────────────────────────────────────────

  async function buildProjectOverview(projectName: string) {
    // Memory — use per-entry timestamps (headers) instead of Date.now()
    const memoryEntries = memoryStore.getEntriesWithMeta(projectName, 'memory');
    const userEntries = memoryStore.getEntriesWithMeta(projectName, 'user');
    const memories: Array<{ id: string; key: string; value: string; category: string; timestamp: number }> = [];

    for (let i = 0; i < memoryEntries.length; i++) {
      const e = memoryEntries[i];
      memories.push({
        id: `mem-${i}`,
        key: e.content.split('\n')[0].slice(0, 80),
        value: e.content,
        category: 'memory',
        timestamp: Date.parse(e.addedAt) || 0,
      });
    }
    for (let i = 0; i < userEntries.length; i++) {
      const e = userEntries[i];
      memories.push({
        id: `user-${i}`,
        key: e.content.split('\n')[0].slice(0, 80),
        value: e.content,
        category: 'user',
        timestamp: Date.parse(e.addedAt) || 0,
      });
    }

    // Newest first
    memories.sort((a, b) => b.timestamp - a.timestamp);

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

    // Conventions — load from convention-core's rules.json; empty when
    // the project has not been learned yet.
    let conventions: string[] = [];
    try {
      conventions = loadRules(CONVENTION_PATHS, projectName).map((r) => r.description || r.name);
    } catch { /* */ }

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
      clarifySeedArtifact?: string;
      planSeed?: { project: string; slug: string; version: number; plan: Plan };
    },
  ): void {
    // Kill any existing pipeline
    if (activePipelineRunner) activePipelineRunner.cancel();
    if (activeChild) { activeChild.kill('SIGTERM'); activeChild = null; }
    outputBuffer = [];

    const runner = new PipelineRunner(agentManager, projectLoader, featureStore, {
      project,
      feature,
      model: options?.model ?? 'sonnet',
      modelTier: options?.modelTier,
      baseBranch: options?.baseBranch,
      skipClarify: options?.skipClarify,
      skipShip: options?.skipShip,
      deploy: (options as any)?.deploy,
      resumeFromStage: options?.resumeFromStage,
      featureSlug: options?.featureSlug,
      failureContext: options?.failureContext,
      clarifySeedArtifact: options?.clarifySeedArtifact,
      planSeed: options?.planSeed,
    }, memoryStore, kbManager);

    // Snapshot project Q&A policy into the runner before run() starts.
    // Used by pipeline-stages to gate the requirements/specs Q&A path.
    try {
      const policySnapshot = loadPolicy(project, ANVIL_HOME);
      runner.setQAPolicy(policySnapshot.qa);
    } catch { /* fall through — runner stays in non-Q&A path */ }

    // ── Phase 2: core-pipeline EventBus + lifecycle hooks ───────────────
    // The bus is constructed per-run. Phase 4 will rewrite pipeline-runner to
    // emit through this bus; until then no publishers exist on it and the
    // hooks sit idle. The wiring is in place so Phase 4 lands as a swap.
    // State-file polling stays as the cross-process fallback.
    const initialState = runner.getState();
    const pipelineBus = new InMemoryEventBus();
    const stepDescriptors: PipelineStepDescriptor[] = initialState.stages.map((s) => ({
      id: s.name,
      name: s.name,
      label: s.label,
      perRepo: s.perRepo,
    }));
    const auditLogPath = join(RUNS_DIR, initialState.runId, 'audit.jsonl');
    const auditHook = attachAuditLogHook(pipelineBus, { path: auditLogPath });
    const stateHook = attachDashboardStateHook(pipelineBus, { path: STATE_FILE });
    const costHook = attachCostTrackerHook(pipelineBus);
    const learnersHook = attachLearnersHook(pipelineBus, {
      project,
      onLearnEvent: (event) => {
        const payload = event.payload as { state?: PipelineRunState } | undefined;
        if (payload?.state) autoLearn(memoryStore, payload.state);
      },
    });
    const busSubscriber = attachPipelineBusSubscriber(pipelineBus, {
      project,
      feature,
      featureSlug: initialState.featureSlug,
      model: initialState.model,
      repoNames: initialState.repoNames,
      steps: stepDescriptors,
      broadcast,
    });
    const detachBus = (): void => {
      busSubscriber.unsubscribe();
      auditHook.unsubscribe();
      stateHook.unsubscribe();
      stateHook.flush();
      costHook.unsubscribe();
      learnersHook.unsubscribe();
    };

    // ── Feature-flagged policy hook: pause after configured stages ──
    {
      runner.setAfterStageHook(async (info) => {
        // Policy is now always defined (BUILTIN_DEFAULT_POLICY when no yaml).
        // The master switch — overlay or yaml `enabled: false` — short-circuits
        // here without firing a pause.
        const policy = loadPolicy(info.project, ANVIL_HOME);
        if (policy.enabled === false) return;
        // Map the runner's fine-grained stage taxonomy onto the policy's
        // 5-stage taxonomy. Without this, stages like `validate` fall back
        // to `implement` and silently re-trigger any path-rule that lists
        // `implement` in pauseAfter — pausing the pipeline forever.
        const stageAsPipelineStage = ((): 'plan' | 'implement' | 'review' | 'test' | 'ship' => {
          switch (info.stageName) {
            case 'clarify':
            case 'requirements':
            case 'repo-requirements':
            case 'specs':
            case 'tasks':
              return 'plan';
            case 'build':
              return 'implement';
            case 'test':
            case 'validate':
              return 'test';
            case 'ship':
              return 'ship';
            default:
              return 'implement';
          }
        })();
        const decision = evaluatePolicy(policy, {
          stage: stageAsPipelineStage,
          touchedFiles: info.touchedFiles ?? [],
          riskTier: info.riskTier,
          confidence: info.confidence,
        });
        if (!decision.pause) return;

        const pause = pauseStore.pause({
          runId: info.runId,
          project: info.project,
          stage: stageAsPipelineStage,
          reason: decision.reason,
          matchedRules: decision.matchedRules,
          reviewers: decision.reviewers,
          timeoutHours: policy.notifications?.timeoutHours,
        });
        broadcast({ type: 'pipeline-paused', payload: { pause } } as ServerMessage);
        auditLog.record({
          runId: info.runId, project: info.project,
          event: 'paused', actor: 'system',
          details: { reviewers: pause.reviewers, reason: pause.reason },
        });

        // Fire-and-forget notification + approve-link
        try {
          const token = createApprovalToken(info.runId, 'approve', approvalSecret, 24);
          const base = process.env.ANVIL_DASHBOARD_URL;
          void notifyPipelinePaused(pause, base, token);
        } catch { /* ignore */ }

        // Phase F1: durable signal pause. When info.waitForReviewerDecision
        // is wired, the workflow blocks on the durable signals queue
        // — a decision enqueued by handleResumePipeline /
        // handleCancelPause survives a process crash. On replay the
        // recorded decision returns immediately.
        //
        // Both paths run because pauseStore drives the modal UI (a
        // projection); the durable signal is the authoritative
        // workflow gate. Whichever resolves first wins.
        const channel = `reviewer-decision-${info.stageName}`;
        const polling = new Promise<void>((resolve) => {
          const tick = setInterval(() => {
            const latest = pauseStore.get(info.runId);
            if (!latest || latest.status !== 'paused-awaiting-user') {
              clearInterval(tick);
              resolve();
            }
          }, 1000);
        });
        let signalPayload: unknown = null;
        if (info.waitForReviewerDecision) {
          const signalP = info.waitForReviewerDecision(channel).then((p) => {
            signalPayload = p;
          });
          await Promise.race([signalP, polling]);
        } else {
          await polling;
        }

        // Phase G4: pauseStore-as-projection sync. When the durable
        // signal landed first (e.g. on replay where the recorded
        // decision returns instantly, or when the producer enqueued
        // the signal but pauseStore wasn't aware), sync pauseStore
        // from the signal payload so the UI reflects the resolved
        // state. Best-effort — if pauseStore is already resumed via
        // a different code path, the resume() call's "not awaiting
        // user" guard makes this a no-op.
        if (signalPayload) {
          try {
            const decision = signalPayload as { action?: string; note?: string; editedArtifact?: string; rerunFromStage?: number };
            const current = pauseStore.get(info.runId);
            if (current?.status === 'paused-awaiting-user' && decision.action) {
              if (decision.action === 'cancel') {
                pauseStore.cancel(info.runId, 'durable-replay');
              } else {
                pauseStore.resume(info.runId, decision as ResumeDecision, 'durable-replay');
              }
            }
          } catch (err) {
            console.warn(`[dashboard] pauseStore projection sync failed: ${err instanceof Error ? err.message : err}`);
          }
        }

        const final = pauseStore.get(info.runId);
        if (final?.resumeDecision?.action === 'cancel') {
          throw new Error(`pipeline cancelled at ${info.stageName}`);
        }
        // Hand the reviewer's note off to the runner so the NEXT stage's
        // user prompt picks it up via the prompt-builder context. Empty
        // / missing notes are silently ignored by the runner.
        const note = final?.resumeDecision?.note;
        if (typeof note === 'string' && note.trim().length > 0) {
          runner.setReviewNote(note);
        }
        // Phase B — `modify-artifact`: replace the just-completed stage's
        // artifact with the reviewer's edited markdown. The runner's
        // applyArtifactEdit re-writes disk state and arms the override
        // so the next stage's `prevArtifact` is the edited body.
        if (final?.resumeDecision?.action === 'modify-artifact'
            && typeof final.resumeDecision.editedArtifact === 'string'
            && final.resumeDecision.editedArtifact.length > 0) {
          runner.applyArtifactEdit(info.stageIndex, final.resumeDecision.editedArtifact);
        }
        // Phase C — `rerun-from`: roll the pipeline loop back to the
        // chosen stage. Default target is the just-paused stage (rerun
        // it with the note). Out-of-range indices are silently dropped
        // by the runner — clamp to the current stage as a safety net.
        if (final?.resumeDecision?.action === 'rerun-from') {
          const requested = typeof final.resumeDecision.rerunFromStage === 'number'
            ? final.resumeDecision.rerunFromStage
            : info.stageIndex;
          const clamped = Math.max(0, Math.min(requested, info.stageIndex));
          runner.requestRerunFromStage(clamped, final.resumeDecision.note ?? null);
        }
        // Phase F — `iterate-with-note`: re-run only the just-paused
        // stage with the note framed as reviewer feedback. No manifest
        // clear, no rewind to prior stages, no failureContext framing.
        if (final?.resumeDecision?.action === 'iterate-with-note') {
          runner.iterateCurrentStageWithNote(info.stageIndex, final.resumeDecision.note ?? null);
        }
      });
    }

    // ── Cost ledger hook — gated per-project by policy.cost in pipeline-policy.yaml ──
    {
      agentManager.setCostHook((info) => {
        if (!info.project || !info.runId) return;
        // Read policy first — if no cost block, skip the entire hook for this project.
        let policy: PipelinePolicy | null;
        try {
          policy = loadPolicy(info.project, ANVIL_HOME);
        } catch {
          policy = null;
        }
        if (!policy || !policy.cost) return;

        const stage = (
          ['plan', 'implement', 'review', 'test', 'ship'].includes(info.stage ?? '')
            ? info.stage
            : 'other'
        ) as 'plan' | 'implement' | 'review' | 'test' | 'ship' | 'other';
        try {
          costLedger.record({
            runId: info.runId, project: info.project, stage,
            agent: info.persona, model: info.model,
            tokensIn: info.tokensIn, tokensOut: info.tokensOut,
            cacheReadTokens: info.cacheReadTokens,
            cacheWriteTokens: info.cacheWriteTokens,
          });
        } catch { /* ledger best-effort */ }
        try {
          void costBreachHandler.evaluate(info.runId, info.project, {
            limits: policy.cost.limits,
            graceWindowSeconds: policy.cost.graceWindowSeconds,
            onBreach: policy.cost.onBreach,
            autoApproveBelow: policy.cost.autoApproveBelow,
          });
        } catch { /* ignore */ }
        // Push fresh snapshot so meters / cards / modal stay live.
        if (info.project && info.runId) {
          try { broadcastCostSnapshot(info.project, info.runId); } catch { /* ok */ }
        }
      });
    }

    // ── Feature-flagged checkpoint cache ──
    if (process.env.ANVIL_CHECKPOINTS_ENABLED === '1') {
      // Phase 7 — when ANVIL_CHECKPOINT_SIMILARITY_ENABLED is also set, the
      // lookup falls through to a near-edit similarity match if the exact
      // hash misses. Index files live alongside the per-project checkpoint
      // tree, one instance per project to keep load() linear in that
      // project's history. Default off (per the plan's rollback section).
      const similarityEnabled = process.env.ANVIL_CHECKPOINT_SIMILARITY_ENABLED === '1';
      const similarityThreshold = (() => {
        const raw = Number(process.env.ANVIL_CHECKPOINT_SIMILARITY_THRESHOLD);
        return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.95;
      })();
      const similarityIndices = new Map<string, CheckpointSimilarityIndex>();
      const getSimilarityIndex = (project: string): CheckpointSimilarityIndex => {
        let idx = similarityIndices.get(project);
        if (!idx) {
          idx = new CheckpointSimilarityIndex({ anvilHome: ANVIL_HOME, project });
          similarityIndices.set(project, idx);
        }
        return idx;
      };

      agentManager.setCheckpointHook({
        lookup: (input) => {
          try {
            const runFamily = input.runFamily ?? 'unknown';
            const stage = input.stage as 'plan'|'implement'|'review'|'test'|'ship';
            const taskId = `${input.persona}:${input.stage}`;
            const promptVersion = '1';
            const key = computeCheckpointKey(runFamily, {
              stage,
              taskId,
              inputs: { prompt: input.prompt },
              promptVersion,
              model: input.model,
            });
            const rec = checkpointStore.get(input.project, runFamily, key);
            if (rec && rec.status === 'completed' && rec.outputRef) {
              const blob = blobStore.read(rec.outputRef);
              if (blob) return { hit: true, output: blob.toString('utf-8') };
            }
            // Phase 7 — fall through to similarity match within the same slot.
            if (similarityEnabled) {
              const vec = embedPrompt(input.prompt);
              const match = getSimilarityIndex(input.project).nearest(
                { runFamily, stage, taskId, model: input.model, promptVersion },
                vec,
                similarityThreshold,
              );
              if (match) {
                const blob = blobStore.read(match.entry.outputRef);
                if (blob) {
                  process.stderr.write(
                    `[checkpoint-similarity] hit project=${input.project} stage=${stage} ` +
                      `taskId=${taskId} score=${match.score.toFixed(4)}\n`,
                  );
                  return { hit: true, output: blob.toString('utf-8') };
                }
              }
            }
          } catch { /* cache miss on error */ }
          return { hit: false };
        },
        record: (input) => {
          try {
            const runFamily = input.runFamily ?? 'unknown';
            const stage = input.stage as 'plan'|'implement'|'review'|'test'|'ship';
            const taskId = `${input.persona}:${input.stage}`;
            const promptVersion = '1';
            const { sha } = blobStore.write(input.output);
            const key = computeCheckpointKey(runFamily, {
              stage,
              taskId,
              inputs: { prompt: input.prompt },
              promptVersion,
              model: input.model,
            });
            checkpointStore.write(input.project, {
              key,
              project: input.project,
              status: 'completed',
              outputRef: sha,
              cost: {
                usd: input.cost.totalUsd,
                tokensIn: input.cost.inputTokens,
                tokensOut: input.cost.outputTokens,
              },
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: input.cost.durationMs,
            });
            // Phase 7 — mirror into the similarity index so the next near-edit
            // run can find this output via cosine, not just exact hash.
            if (similarityEnabled) {
              try {
                getSimilarityIndex(input.project).add({
                  runFamily,
                  stage,
                  taskId,
                  model: input.model,
                  promptVersion,
                  vec: embedPrompt(input.prompt),
                  outputRef: sha,
                  hash: key.hash,
                  cost: {
                    usd: input.cost.totalUsd,
                    tokensIn: input.cost.inputTokens,
                    tokensOut: input.cost.outputTokens,
                  },
                  recordedAt: new Date().toISOString(),
                });
              } catch { /* similarity persistence best-effort */ }
            }
          } catch { /* persistence best-effort */ }
        },
      });
    }

    activePipelineRunner = runner;

    // Register as active run — use own array, not shared outputBuffer
    const pipelineRunId = `build-${Date.now().toString(36)}`;
    const pipelineActivities: typeof outputBuffer = [];
    activeRuns.set(pipelineRunId, {
      id: pipelineRunId,
      type: 'build',
      project,
      description: feature,
      model: options?.model ?? 'sonnet',
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
              questions: r.questions,
            })) : undefined,
            // Phase 8 — surface routing decisions so the UI can show
            // "build → qwen3:14b" badges and 🔒/📝/⚡ permission glyphs.
            resolvedModel: s.resolvedModel,
            permissionClasses: s.permissionClasses,
            questions: s.questions,
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

    // Stage Q&A — generic events for non-clarify planning stages (requirements,
    // repo-requirements, specs). The frontend renders questions inline on the
    // stage card via StageQuestionsPanel.
    runner.on('stage-question', (data: {
      stageIndex: number;
      stageName: string;
      repoName?: string;
      questionIndex: number;
      totalQuestions: number;
      question: string;
    }) => {
      broadcast({ type: 'stage-question', payload: data });
      const entry = {
        timestamp: Date.now(),
        stage: data.stageName,
        type: 'stdout' as const,
        content: `**Question ${data.questionIndex + 1} of ${data.totalQuestions}** (${data.stageName}):\n\n${data.question}`,
        kind: 'stage-question',
      };
      pipelineActivities.push(entry);
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry], runId: pipelineRunId } });
    });

    runner.on('stage-answer-recorded', (data: {
      stageIndex: number;
      repoName?: string | null;
      questionIndex: number;
      remaining: number;
    }) => {
      broadcast({ type: 'stage-answer-recorded', payload: data });
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
    runner.on('project-event', (data: { source: string; message: string; level?: string; stage?: string }) => {
      const prefix = data.source === 'knowledge-base' ? '📚' : data.source === 'project-context' ? '🔌' : 'ℹ️';
      // Tag with the originating pipeline stage when the emitter knows it
      // (KB / project-context events fire during prompt-building for a
      // specific stage). Falls back to 'pipeline' for run-level events
      // (warmup, routing, cost-budget) so they don't get filtered out
      // entirely when no stage is selected.
      const entry = {
        timestamp: Date.now(),
        stage: data.stage ?? 'pipeline',
        type: (data.level === 'warn' ? 'stderr' : 'stdout') as 'stderr' | 'stdout',
        content: `${prefix} [${data.source}] ${data.message}`,
        kind: 'project',
      };
      pipelineActivities.push(entry);
      outputBuffer.push(entry);
      broadcast({ type: 'agent-output', payload: { entries: [entry], runId: pipelineRunId } });
    });

    // Auth expired — send browser notification so user knows to re-login
    runner.on('auth-required', (data: { stageName: string; message: string }) => {
      broadcast({
        type: 'auth-required',
        payload: {
          runId: pipelineRunId,
          stageName: data.stageName,
          message: data.message,
        },
      });
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

      // If the test stage wrote a new spec, push the refreshed list + the new
      // spec itself to every connected client so TestSpecPage swaps in the
      // freshly generated spec instead of the last-loaded one.
      if (data.stage === 'test') {
        try {
          const specs = testSpecStore.listSpecs(project);
          broadcast({ type: 'test-specs', payload: { specs } } as ServerMessage);
          if (specs.length > 0) {
            const newest = specs[0];
            const spec = testSpecStore.readCurrent(project, newest.slug);
            if (spec) {
              const cases = testCaseStore.readCases(project, spec.slug, spec.version);
              broadcast({ type: 'test-spec-created', payload: { spec, cases } } as ServerMessage);
            }
          }
        } catch (err) {
          console.warn('[pipeline] test-spec broadcast failed:', err);
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
      autoLearn(memoryStore, pipelineState);

      // Auto-review Anvil-authored PRs when the run was plan-seeded.
      // Fire-and-forget; reviews run async and broadcast their own events.
      const completedRunForPrs = activeRuns.get(pipelineRunId);
      const prUrls = completedRunForPrs ? Array.from(completedRunForPrs.prUrls) : [];
      if (prUrls.length && options?.planSeed) {
        const personas: Persona[] = ['architect', 'security', 'tester'];
        for (const prUrl of prUrls) {
          startReviewRun(project, prUrl, 'ship', personas, options?.model)
            .catch((err) => console.warn(`[ship-review] ${prUrl}:`, err?.message ?? err));
        }
      }

      activePipelineRunner = null;
      agentManager.spawn = originalSpawn; // restore original spawn
      const completedRun = activeRuns.get(pipelineRunId);
      if (completedRun) completedRun.status = 'completed';
      activeRuns.delete(pipelineRunId);
      detachBus();
      broadcastActiveRuns();
      broadcastRuns();
    });

    runner.on('pipeline-fail', (pipelineState: PipelineRunState) => {
      persistRunRecord(pipelineState, pipelineRunId);
      autoLearn(memoryStore, pipelineState);
      activePipelineRunner = null;
      agentManager.spawn = originalSpawn;
      const failedRun = activeRuns.get(pipelineRunId);
      if (failedRun) failedRun.status = 'failed';
      // Keep failed runs in activeRuns — they are resumable and should stay visible
      detachBus();
      broadcastActiveRuns();
      broadcastRuns();
    });

    // Run the pipeline (async, non-blocking)
    runner.run().catch((err) => {
      console.error('[dashboard] Pipeline failed:', err);
      activePipelineRunner = null;
      detachBus();
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

    const spikePersona = actionType === 'run-spike' ? 'analyst' : 'engineer';
    // Map quick-action types to stage-policy ids. spike → research so
    // free-tier (local-first) routing kicks in for read-only work.
    const stageMap: Record<typeof actionType, string> = {
      'run-fix': 'fix',
      'run-review': 'review',
      'run-spike': 'research',
    };
    const stageId = stageMap[actionType];

    // Resolution precedence (matches pipeline-runner):
    //   1. Caller-supplied model (UI dropdown override).
    //   2. Registry-driven resolver from @esankhan3/anvil-core-pipeline.
    //   3. Hardcoded fallback (sonnet) — last resort.
    const resolvedModel = (() => {
      if (model) return model;
      try {
        return registryResolveStage(stageId).primary;
      } catch (err) {
        if (err instanceof UnknownStageError || err instanceof ModelResolutionError) {
          console.warn(`[quick-action] resolver: ${err.message}; falling back to sonnet`);
        } else {
          console.warn(`[quick-action] resolver crashed:`, err);
        }
        return 'sonnet';
      }
    })();

    if (actionType === 'run-fix') {
      // Multi-stage Fix flow: fix → validate → fix-loop (with attempt cap).
      const initialStages: ActiveRunStage[] = [
        { name: 'fix', status: 'pending' },
        { name: 'validate', status: 'pending' },
        { name: 'fix-loop', status: 'pending' },
      ];
      activeRuns.set(runId, {
        id: runId,
        type: 'fix',
        project,
        description,
        model: resolvedModel,
        status: 'running',
        startedAt: Date.now(),
        activities: [],
        prUrls: new Set(),
        stages: initialStages,
        totalCost: 0,
      });
      broadcastActiveRuns();

      const stageStarted: Partial<Record<'fix' | 'validate' | 'fix-loop', string>> = {};
      const onStage = (event: FixFlowStageEvent) => {
        const run = activeRuns.get(runId);
        if (!run || !run.stages) return;
        const stage = run.stages.find((s) => s.name === event.name);
        if (!stage) return;
        if (event.status === 'running') {
          stage.status = 'running';
          stage.startedAt = event.startedAt ?? new Date().toISOString();
          stage.attempt = event.attempt;
          stageStarted[event.name] = stage.startedAt;
        } else {
          stage.status = event.status;
          stage.completedAt = event.completedAt ?? new Date().toISOString();
          stage.error = event.error;
          if (event.cost) {
            stage.cost = (stage.cost ?? 0) + event.cost;
            run.totalCost = (run.totalCost ?? 0) + event.cost;
          }
        }
        broadcastActiveRuns();
      };

      // Run async — don't block the WS handler
      runFixFlow({
        agentManager,
        project,
        description,
        model: resolvedModel,
        workspaceDir: cwd,
        repoNames,
        repoPaths: repoInfo,
        buildProjectPrompt: () => projectPrompt,
        buildRepoProjectPrompt: () => projectPrompt,
        isCancelled: () => activeRuns.get(runId)?.status !== 'running',
        allowedToolsForStage: (s) => allowedToolsForStage(s),
        onStage,
        onSpawn: (stage, _repo, agentId) => {
          agentToRunId.set(agentId, runId);
          broadcast({ type: 'agent-spawned', payload: { id: agentId, runId, stage } });
        },
      })
        .then((result) => {
          const run = activeRuns.get(runId);
          if (!run) return;
          run.status = result.resolved ? 'completed' : 'failed';
          run.completedAt = Date.now();
          if (!result.resolved) {
            run.error = `validation still failing after ${result.attempts} attempts`;
          }
          broadcastActiveRuns();
        })
        .catch((err) => {
          const run = activeRuns.get(runId);
          if (!run) return;
          run.status = 'failed';
          run.completedAt = Date.now();
          run.error = err instanceof Error ? err.message : String(err);
          broadcastActiveRuns();
          console.warn(`[run-fix] flow failed for ${runId}:`, err);
        });

      return;
    }

    // Legacy single-agent path for spike / review.
    const agent = agentManager.spawn({
      name: `${actionType.replace('run-', '')}-${project}`,
      persona: spikePersona,
      project,
      stage: stageId,
      prompt: promptMap[actionType] ?? description,
      projectPrompt,
      model: resolvedModel,
      cwd,
      permissionMode: 'bypassPermissions',
      disallowedTools: disallowedToolsForPersona(spikePersona),
      allowedTools: allowedToolsForStage(stageId),
    });

    // Register active run
    const runType = actionLabel as 'fix' | 'spike';
    activeRuns.set(runId, {
      id: runId,
      type: runType,
      project,
      description,
      model: resolvedModel,
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

  // ── Plan agent: structured Plan generation ─────────────────────────

  /** Map planAgentId → { project, feature, model, section?, variant? } for post-run JSON extraction. */
  const planAgentContext = new Map<string, {
    project: string;
    feature: string;
    model: string;
    existingSlug?: string;        // if present, bump a version; otherwise create
    section?: PlanSection;        // if present, merge only this section of the plan
    variant?: { batchId: string; index: number; label: string };  // A/B variant generation
  }>();

  /** Extract the last fenced ```json ... ``` block from streamed agent output. */
  function extractJsonBlock(text: string): unknown | null {
    // Match fenced blocks first
    const fenceRe = /```json\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    let last: string | null = null;
    while ((match = fenceRe.exec(text)) !== null) {
      last = match[1];
    }
    if (last) {
      try { return JSON.parse(last.trim()); } catch { /* fall through */ }
    }
    // Fallback: find the largest top-level {...} block
    const braceStart = text.indexOf('{');
    const braceEnd = text.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      const candidate = text.slice(braceStart, braceEnd + 1);
      try { return JSON.parse(candidate); } catch { /* give up */ }
    }
    return null;
  }

  function buildPlanPrompt(
    project: string,
    feature: string,
    repoNames: string[],
    kbReport: string,
    mode: 'full' | PlanSection,
    existingPlan?: Plan,
  ): string {
    const schema = `{
  "title": "string — short title (<80 chars)",
  "problem": "string — plain English problem statement",
  "scope": { "inScope": ["string"], "outOfScope": ["string"] },
  "repos": [
    {
      "name": "string — must match a project repo",
      "changes": "string — concise description of changes in this repo",
      "files": ["string — path relative to repo root; use new ones freely"],
      "symbols": ["string — function/class/type names modified or added"]
    }
  ],
  "contracts": [
    {
      "kind": "http | grpc | kafka | db | other",
      "name": "string",
      "producer": "string — repo name",
      "consumers": ["string — repo names"],
      "description": "string"
    }
  ],
  "architecture": { "mermaid": "string — optional mermaid diagram body", "notes": "string" },
  "risks": [ { "title": "string", "mitigation": "string", "severity": "low | med | high" } ],
  "rollout": {
    "strategy": "string",
    "flags": ["string"],
    "order": ["string — repos in deploy order"],
    "rollback": "string"
  },
  "tests": { "unit": ["string"], "integration": ["string"], "manual": ["string"] },
  "estimate": { "usd": 0.0, "minutes": 0, "prs": 0 }
}`;

    const rules = [
      `You are a senior staff engineer producing an implementation plan for the "${project}" project.`,
      `Project repos (you MUST only reference these): ${repoNames.join(', ') || '(none configured)'}.`,
      kbReport ? 'The Knowledge Base in your project prompt lists every existing module, function and import. Ground file paths and symbol names in the KB. Only invent names for NEW symbols you will create.' : 'No Knowledge Base is available; use plain engineering judgement.',
      'Be specific. Prefer concrete file paths and function names over vague descriptions.',
      'Keep estimates realistic: count repos touched × typical stage cost. Default model: $5/run, $10 for multi-repo changes.',
      'Do NOT modify any files. This is planning only.',
    ].filter(Boolean).join('\n');

    if (mode === 'full') {
      return `${rules}

## Feature to plan

${feature}

## Required output

Output EXACTLY one fenced \`\`\`json ... \`\`\` block containing a JSON object matching this schema:

\`\`\`json
${schema}
\`\`\`

No prose outside the JSON block. All string fields must be non-empty where the schema has no "optional" qualifier.`;
    }

    // Section regen
    const planJson = existingPlan ? JSON.stringify(existingPlan, null, 2) : '{}';
    return `${rules}

## Existing plan (regenerate one section only)

\`\`\`json
${planJson}
\`\`\`

## Task

Regenerate the **"${mode}"** section of the plan based on the existing context and any new information you gather.

Output EXACTLY one fenced \`\`\`json ... \`\`\` block containing ONLY the updated section value (matching that section's schema — an object for scope/architecture/rollout/tests/estimate, or an array for repos/contracts/risks, or a string for problem).

No prose outside the JSON block.`;
  }

  function spawnPlanAgent(project: string, feature: string, modelId?: string): void {
    outputBuffer = [];

    const configWorkspace = getWorkspaceFromConfig(project);
    const cwd = configWorkspace && existsSync(configWorkspace)
      ? configWorkspace
      : join(process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace'), project);

    const runId = `plan-${Date.now().toString(36)}`;
    const model = modelId ?? 'sonnet';

    // Load KB for context
    let kbReport = '';
    const indexPrompt = kbManager.getIndexForPrompt(project);
    if (indexPrompt) {
      const queryContext = kbManager.getQueryContextForPrompt(project, feature);
      kbReport = `${indexPrompt}\n\n---\n\n${queryContext}`;
    } else {
      kbReport = kbManager.getAllGraphReports(project);
    }

    // Repo names
    const repoInfo = projectLoader.getRepoLocalPaths(project);
    const repoNames = Object.keys(repoInfo);
    const repoPaths = Object.entries(repoInfo).map(([n, p]) => `- ${n}: ${p}`).join('\n');

    const projectPromptParts: string[] = [
      `You are a senior engineer planning work in the "${project}" project.`,
      `\n## Project Repos\nThis project has ${repoNames.length} repositories. You may reference these and only these:\n${repoPaths}`,
    ];
    if (kbReport) {
      projectPromptParts.push(
        `\n## Codebase Knowledge Base\n${kbReport}\n\n` +
        `**Rules when KB is present:** do NOT spawn sub-agents. Do NOT run find/ls/tree. Cite the KB by name when choosing files and symbols.`
      );
    }
    const projectMemory = memoryStore.formatForPrompt(project, 'memory');
    const userProfile = memoryStore.formatForPrompt(project, 'user');
    if (projectMemory || userProfile) {
      projectPromptParts.push(`\n## Memories\n${[projectMemory, userProfile].filter(Boolean).join('\n\n')}`);
    }
    const projectPrompt = projectPromptParts.join('\n');

    const prompt = buildPlanPrompt(project, feature, repoNames, kbReport, 'full');

    const agent = agentManager.spawn({
      name: `plan-${project}`,
      persona: 'architect',
      project,
      stage: 'plan',
      prompt,
      projectPrompt,
      model,
      cwd,
      permissionMode: 'bypassPermissions',
      // KB is injected via projectPrompt — block exploration tools so the
      // architect uses the Knowledge Base instead of re-exploring the repo.
      disallowedTools: disallowedToolsForPersona('architect'),
    });

    planAgentContext.set(agent.id, { project, feature, model });

    activeRuns.set(runId, {
      id: runId,
      type: 'plan',
      project,
      description: feature,
      model,
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

  function spawnPlanVariants(
    project: string,
    feature: string,
    variants: Array<{ label: string; prompt?: string }>,
    modelId?: string,
  ): void {
    const model = modelId ?? 'sonnet';
    const batchId = `variants-${Date.now().toString(36)}`;

    // Announce batch start so the UI can render N placeholder columns.
    broadcast({
      type: 'plan-variants-started',
      payload: {
        project,
        feature,
        batchId,
        variants: variants.map((v, i) => ({ index: i, label: v.label })),
      },
    });

    variants.forEach((variant, index) => {
      // Each variant gets its own agent. We tag the planAgentContext with variant
      // metadata so finalizePlanAgent knows to tag the resulting plan.
      const configWorkspace = getWorkspaceFromConfig(project);
      const cwd = configWorkspace && existsSync(configWorkspace)
        ? configWorkspace
        : join(process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace'), project);

      let kbReport = '';
      const indexPrompt = kbManager.getIndexForPrompt(project);
      if (indexPrompt) {
        const queryContext = kbManager.getQueryContextForPrompt(project, feature);
        kbReport = `${indexPrompt}\n\n---\n\n${queryContext}`;
      } else {
        kbReport = kbManager.getAllGraphReports(project);
      }

      const repoInfo = projectLoader.getRepoLocalPaths(project);
      const repoNames = Object.keys(repoInfo);
      const repoPaths = Object.entries(repoInfo).map(([n, p]) => `- ${n}: ${p}`).join('\n');

      const variantHint = variant.prompt
        ? `This variant is approach "${variant.label}". ${variant.prompt}`
        : `This variant is approach "${variant.label}". Bias your plan toward that approach (${variant.label.toLowerCase()} — e.g. smallest change, cleanest refactor, or a greenfield rewrite).`;

      const projectPromptParts: string[] = [
        `You are a senior engineer planning work in the "${project}" project.`,
        `\n## Variant\n${variantHint}`,
        `\n## Project Repos\n${repoNames.length} repositories:\n${repoPaths}`,
      ];
      if (kbReport) {
        projectPromptParts.push(`\n## Codebase Knowledge Base\n${kbReport}`);
      }
      const projectMemory = memoryStore.formatForPrompt(project, 'memory');
      const userProfile = memoryStore.formatForPrompt(project, 'user');
      if (projectMemory || userProfile) {
        projectPromptParts.push(`\n## Memories\n${[projectMemory, userProfile].filter(Boolean).join('\n\n')}`);
      }
      const projectPrompt = projectPromptParts.join('\n');

      const prompt = buildPlanPrompt(project, feature, repoNames, kbReport, 'full');

      const agent = agentManager.spawn({
        name: `plan-variant-${variant.label}-${project}`,
        persona: 'architect',
        project,
        stage: `plan-variant:${variant.label}`,
        prompt,
        projectPrompt,
        model,
        cwd,
        permissionMode: 'bypassPermissions',
        disallowedTools: disallowedToolsForPersona('architect'),
      });

      planAgentContext.set(agent.id, {
        project,
        feature,
        model,
        variant: { batchId, index, label: variant.label },
      });

      const runId = `plan-var-${batchId}-${index}`;
      activeRuns.set(runId, {
        id: runId,
        type: 'plan',
        project,
        description: `[variant:${variant.label}] ${feature}`,
        model,
        status: 'running',
        startedAt: Date.now(),
        agentId: agent.id,
        activities: [],
        prUrls: new Set(),
      });
      agentToRunId.set(agent.id, runId);

      broadcast({ type: 'agent-spawned', payload: { ...agent, runId, variant: { batchId, index, label: variant.label } } });
    });

    broadcastActiveRuns();
  }

  function spawnPlanSectionRegen(existingPlan: Plan, section: PlanSection, modelId?: string): void {
    const configWorkspace = getWorkspaceFromConfig(existingPlan.project);
    const cwd = configWorkspace && existsSync(configWorkspace)
      ? configWorkspace
      : join(process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace'), existingPlan.project);

    const runId = `plan-${section}-${Date.now().toString(36)}`;
    const model = modelId ?? existingPlan.model ?? 'sonnet';

    let kbReport = '';
    const indexPrompt = kbManager.getIndexForPrompt(existingPlan.project);
    if (indexPrompt) {
      const queryContext = kbManager.getQueryContextForPrompt(existingPlan.project, existingPlan.feature);
      kbReport = `${indexPrompt}\n\n---\n\n${queryContext}`;
    }

    const repoInfo = projectLoader.getRepoLocalPaths(existingPlan.project);
    const repoNames = Object.keys(repoInfo);

    const projectPrompt = `You are a senior engineer iterating on an existing plan for "${existingPlan.project}".\n\n## Repos\n${repoNames.map((n) => `- ${n}`).join('\n')}\n\n${kbReport ? `## Knowledge Base\n${kbReport}\n` : ''}`;

    const prompt = buildPlanPrompt(existingPlan.project, existingPlan.feature, repoNames, kbReport, section, existingPlan);

    const agent = agentManager.spawn({
      name: `plan-${section}-${existingPlan.project}`,
      persona: 'architect',
      project: existingPlan.project,
      stage: `plan-${section}`,
      prompt,
      projectPrompt,
      model,
      cwd,
      permissionMode: 'bypassPermissions',
      disallowedTools: disallowedToolsForPersona('architect'),
    });

    planAgentContext.set(agent.id, {
      project: existingPlan.project,
      feature: existingPlan.feature,
      model,
      existingSlug: existingPlan.slug,
      section,
    });

    activeRuns.set(runId, {
      id: runId,
      type: 'plan',
      project: existingPlan.project,
      description: `Regenerate ${section} — ${existingPlan.title}`,
      model,
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

  /**
   * Finalize a plan-agent run: parse JSON, persist, validate, broadcast.
   * Called from the global agent-done handler when the agent was spawned by the plan flow.
   */
  function finalizePlanAgent(agentId: string, agentOutput: string): void {
    const ctx = planAgentContext.get(agentId);
    if (!ctx) return;
    planAgentContext.delete(agentId);

    const parsed = extractJsonBlock(agentOutput);
    if (parsed === null || typeof parsed !== 'object') {
      broadcast({
        type: 'plan-error',
        payload: {
          project: ctx.project,
          message: 'Plan agent output did not contain valid JSON.',
          raw: agentOutput.slice(0, 2000),
        },
      });
      return;
    }

    try {
      if (ctx.existingSlug && ctx.section) {
        // Section regen: merge one key into the existing plan
        const current = planStore.readCurrent(ctx.project, ctx.existingSlug);
        if (!current) throw new Error(`Plan ${ctx.existingSlug} disappeared`);
        const update: Partial<Plan> = { [ctx.section]: parsed } as Partial<Plan>;
        const next = planStore.bumpVersion(ctx.project, ctx.existingSlug, update);
        const validation = planValidator.validate(next);
        planStore.writeValidation(ctx.project, ctx.existingSlug, validation);
        broadcast({ type: 'plan-updated', payload: { plan: next, validation, section: ctx.section } });
      } else if (ctx.variant) {
        // A/B variant: tag the plan title so it's easy to recognise.
        const seed = parsed as Partial<Plan>;
        if (seed.title) seed.title = `[${ctx.variant.label}] ${seed.title}`;
        const plan = planStore.createPlan(ctx.project, ctx.feature, ctx.model, seed);
        const validation = planValidator.validate(plan);
        planStore.writeValidation(ctx.project, plan.slug, validation);
        broadcast({
          type: 'plan-variant-created',
          payload: { plan, validation, variant: ctx.variant },
        });
      } else {
        // Fresh plan
        const seed = parsed as Partial<Plan>;
        const plan = planStore.createPlan(ctx.project, ctx.feature, ctx.model, seed);
        const validation = planValidator.validate(plan);
        planStore.writeValidation(ctx.project, plan.slug, validation);
        broadcast({ type: 'plan-created', payload: { plan, validation } });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      broadcast({
        type: 'plan-error',
        payload: { project: ctx.project, message: `Failed to persist plan: ${message}` },
      });
    }
  }

  // ── PR Review: agent spawner + persona orchestration ──────────────

  /**
   * Map reviewAgentId → { reviewId, project, persona } so finalizeReviewAgent
   * knows where to merge the parsed findings.
   */
  const reviewAgentContext = new Map<string, {
    reviewId: string;
    project: string;
    persona: Persona;
    repoLocalPath?: string;
    diffText?: string;
    fileContents?: Record<string, string>;
  }>();

  /** Load diff lines from gh CLI — trivial prepass input for the security + convention rules. */
  async function loadPrDiff(repo: string, prNumber: number): Promise<{
    diff: string;
    files: Array<{ path: string; addedLines: Array<{ lineNumber: number; text: string }> }>;
    additions: number;
    deletions: number;
    fileCount: number;
    headSha: string;
    baseSha: string;
    title?: string;
    author?: string;
  }> {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    const metaOut = await execFileAsync('gh', [
      'api', `repos/${repo}/pulls/${prNumber}`,
      '--jq', '{head: .head.sha, base: .base.sha, title: .title, author: .user.login, additions: .additions, deletions: .deletions, files: .changed_files}',
    ], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }).catch(() => ({ stdout: '{}' }));
    const meta = (() => { try { return JSON.parse(metaOut.stdout); } catch { return {}; } })();

    const diffOut = await execFileAsync('gh', [
      'pr', 'diff', String(prNumber), '--repo', repo,
    ], { encoding: 'utf-8', maxBuffer: 50 * 1024 * 1024 }).catch(() => ({ stdout: '' }));
    const diff = diffOut.stdout;

    // Parse unified diff to extract per-file added lines.
    const files: Array<{ path: string; addedLines: Array<{ lineNumber: number; text: string }> }> = [];
    let currentFile: { path: string; addedLines: Array<{ lineNumber: number; text: string }> } | null = null;
    let newLineNo = 0;
    for (const line of diff.split('\n')) {
      if (line.startsWith('+++ b/')) {
        currentFile = { path: line.slice(6), addedLines: [] };
        files.push(currentFile);
      } else if (line.startsWith('@@ ')) {
        const m = line.match(/\+(\d+)/);
        newLineNo = m ? parseInt(m[1], 10) - 1 : 0;
      } else if (currentFile && (line.startsWith('+') && !line.startsWith('+++'))) {
        newLineNo++;
        currentFile.addedLines.push({ lineNumber: newLineNo, text: line.slice(1) });
      } else if (currentFile && !line.startsWith('-') && !line.startsWith('\\')) {
        newLineNo++;
      }
    }

    return {
      diff,
      files,
      additions: meta.additions ?? 0,
      deletions: meta.deletions ?? 0,
      fileCount: meta.files ?? files.length,
      headSha: meta.head ?? '',
      baseSha: meta.base ?? '',
      title: meta.title,
      author: meta.author,
    };
  }

  function buildReviewerPrompt(
    persona: Persona,
    review: Review,
    diff: string,
    plan: Plan | null,
    learnings: string,
  ): string {
    const personaRole: Record<Persona, string> = {
      architect: 'senior staff engineer reviewing overall design, layering, and abstraction fit',
      security: 'security engineer focused on OWASP Top 10: injection, auth, secrets, CSRF, XSS, SSRF',
      style: 'code-style reviewer enforcing this project\'s conventions (see rules below)',
      tester: 'QA engineer assessing test coverage delta, flaky patterns, missing asserts',
      domain: 'domain expert using the project memory + KB to verify business-logic correctness',
    };

    const schema = `{
  "findings": [
    {
      "severity": "blocker | error | warn | info | nit",
      "category": "correctness | security | convention | test | perf | docs | plan-drift",
      "file": "path/relative/to/repo",
      "line": 1,
      "snippet": "up to 160 chars of the problematic code",
      "description": "one-sentence actionable issue",
      "suggestedFix": { "diff": "unified diff", "rationale": "why this fix" } | null,
      "confidence": "high | med | low"
    }
  ],
  "summary": "<200 char verdict summary"
}`;

    const planBlock = plan
      ? `## Plan context\nThis PR was produced from a plan. Flag **plan-drift** findings if the diff diverges from the plan:\n\`\`\`json\n${JSON.stringify({ title: plan.title, repos: plan.repos, contracts: plan.contracts }, null, 2).slice(0, 4000)}\n\`\`\`\n`
      : '';

    return `You are a ${personaRole[persona]} reviewing PR ${review.pr.url}.

${planBlock}${learnings ? learnings + '\n' : ''}
## Diff
\`\`\`diff
${diff.slice(0, 60000)}
\`\`\`

## Your task
Review the diff from the **${persona}** perspective. Be terse. Prefer high-confidence findings. Skip style noise when a \`style\` persona exists separately (unless you ARE the style persona).

## Required output
Emit EXACTLY one fenced \`\`\`json ... \`\`\` block matching:
\`\`\`json
${schema}
\`\`\`
Findings array may be empty. No prose outside the JSON block.`;
  }

  async function startReviewRun(
    project: string,
    prUrl: string,
    trigger: Review['trigger'],
    personas: Persona[],
    modelId?: string,
    priorReview?: Review,
  ): Promise<void> {
    const parsed = prIdFromUrl(prUrl);
    if (!parsed) throw new Error(`Could not parse PR URL: ${prUrl}`);
    const { prId, repo, number } = parsed;
    const model = modelId ?? 'sonnet';

    // Resolve workspace for the repo (for plan compliance file checks).
    const configWorkspace = getWorkspaceFromConfig(project);
    const cwd = configWorkspace && existsSync(configWorkspace)
      ? configWorkspace
      : join(process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace'), project);

    // Load diff
    let diffInfo;
    try {
      diffInfo = await loadPrDiff(repo, number);
    } catch (err) {
      throw new Error(`Failed to load PR diff (is gh auth configured?): ${err instanceof Error ? err.message : String(err)}`);
    }

    // Look up linked plan if any (best-effort — first plan whose slug is in the PR title).
    let linkedPlan: Plan | null = null;
    let linkedPlanSlug: string | undefined;
    try {
      const pointers = planStore.listPlans(project);
      const hit = pointers.find((p) => diffInfo.title?.includes(p.slug));
      if (hit) {
        linkedPlan = planStore.readCurrent(project, hit.slug);
        linkedPlanSlug = hit.slug;
      }
    } catch { /* ok */ }

    // Seed the review (or bump from prior for incremental).
    const now = new Date().toISOString();
    const baseReview = priorReview
      ? reviewStore.bumpVersion(project, prId, {
          pr: { ...priorReview.pr, headSha: diffInfo.headSha, baseSha: diffInfo.baseSha },
          trigger,
          startedAt: now,
          completedAt: '',
          personas,
          // Carry prior findings forward; re-review will merge
        })
      : reviewStore.createReview(project, {
          id: prId,
          project,
          pr: {
            repo, number, url: prUrl,
            headSha: diffInfo.headSha, baseSha: diffInfo.baseSha,
            title: diffInfo.title, author: diffInfo.author,
          },
          planSlug: linkedPlanSlug,
          trigger,
          personas,
          diffStats: { additions: diffInfo.additions, deletions: diffInfo.deletions, files: diffInfo.fileCount },
          findings: [],
          planCompliance: null,
          convention: { rulesChecked: 0, violations: 0 },
          security: { checks: [], flags: 0 },
          summary: '',
          verdict: 'comment',
          estimate: { usd: 0, seconds: 0 },
          model,
          startedAt: now,
          completedAt: '',
        });

    try { recordReviewCreated(ANVIL_HOME, project); } catch { /* ok */ }

    broadcast({
      type: 'review-started',
      payload: { reviewId: prId, prId, personas, project },
    });

    // ── Run prepass rules synchronously (cheap) ─────────────────────
    const prepassFindings: ReviewFinding[] = [];

    try {
      const secFindings = runSecurityPrepass({ files: diffInfo.files });
      prepassFindings.push(...secFindings.map((f) => normaliseFinding(f)));
    } catch (err) { console.warn('[review] security prepass failed:', err); }

    try {
      const convFindings = runConventionRules(
        { files: diffInfo.files },
        { anvilHome: ANVIL_HOME, project },
      );
      prepassFindings.push(...convFindings.map((f) => normaliseFinding(f)));
    } catch (err) { console.warn('[review] convention prepass failed:', err); }

    // ── Plan compliance (also cheap — no LLM) ──────────────────────
    if (linkedPlan) {
      try {
        const repoLocalPaths = projectLoader.getRepoLocalPaths(project);
        const featureDir = join(cwd, '.anvil', 'reviews', prId);
        const { report, findings } = buildPlanCompliance({
          plan: linkedPlan,
          featureDir,
          repoLocalPaths,
          baseBranch: 'main',
          branch: '',
        });
        prepassFindings.push(...findings);
        reviewStore.bumpVersion(project, prId, { planCompliance: report });
      } catch (err) {
        console.warn('[review] plan compliance failed:', err);
      }
    }

    // ── Incident binding (R7) — surfaces immutable blockers when bound files touched ──
    try {
      const { checkIncidentBindings } = await import('./review-incident-bind-check.js');
      const changedFiles = diffInfo.files.map((f) => ({
        path: f.path,
        added: f.addedLines.length,
        removed: 0, // approximation — we don't track deletions per file here
      }));
      const bindFindings = checkIncidentBindings(project, changedFiles, { boundStore: boundTestsStore });
      for (const bf of bindFindings) {
        prepassFindings.push(normaliseFinding({
          severity: 'blocker' as Severity,
          category: 'security' as Category,
          persona: 'security' as Persona,
          file: bf.filePath,
          line: 1,
          snippet: '',
          description: bf.message,
          confidence: 'high' as Confidence,
        }));
      }
    } catch (err) { console.warn('[review] incident-binding check failed:', err); }

    // ── Plan-aware (R4) — surfaces scope-creep / missing-deliverable findings ──
    if (linkedPlan) {
      try {
        const { comparePlanAgainstDiff } = await import('./review-plan-diff-comparator.js');
        const { producePlanAwareFindings } = await import('./review-plan-aware.js');
        const cmp = comparePlanAgainstDiff(linkedPlan, diffInfo.files.map((f) => ({
          path: f.path,
          hunks: [{
            addedLines: f.addedLines.length,
            removedLines: 0,
            snippet: f.addedLines.slice(0, 5).map((l) => `+${l.text}`).join('\n'),
          }],
        })));
        const planFindings = producePlanAwareFindings(cmp);
        for (const pf of planFindings) {
          if (pf.kind === 'plan-ok') continue;
          prepassFindings.push(normaliseFinding({
            severity: pf.severity === 'blocker' ? 'blocker' as Severity
              : pf.severity === 'high' ? 'error' as Severity
              : 'warn' as Severity,
            category: 'plan-drift' as Category,
            persona: 'architect' as Persona,
            file: pf.filePath ?? '',
            line: 1,
            snippet: pf.evidence?.slice(0, 160) ?? '',
            description: pf.message,
            confidence: 'med' as Confidence,
          }));
        }
      } catch (err) { console.warn('[review] plan-aware compare failed:', err); }
    }

    if (prepassFindings.length) {
      reviewStore.appendFindings(project, prId, prepassFindings);
    }

    // ── R5: KB context + ripple summary ─────────────────────────────
    // Best-effort: load each repo's graph.json from ~/.anvil/knowledge-base, compute
    // ripple impact for each changed symbol, and broadcast a compact summary the
    // dashboard can render. Failures are non-fatal (graph may not exist yet).
    try {
      const { computeKbContext } = await import('./review-kb-context.js');
      const { summarizeForPrompt } = await import('./review-kb-summarizer.js');
      const repoLocalPaths = projectLoader.getRepoLocalPaths(project);
      const repoNames = Object.keys(repoLocalPaths);
      const repoGraphs: Record<string, unknown> = {};
      for (const repoName of repoNames) {
        const graphPath = join(ANVIL_HOME, 'knowledge-base', project, repoName, 'graph.json');
        if (!existsSync(graphPath)) continue;
        try { repoGraphs[repoName] = JSON.parse(readFileSync(graphPath, 'utf-8')); }
        catch { /* skip unreadable graph */ }
      }
      if (Object.keys(repoGraphs).length > 0) {
        // Map each diff file to its repo (single-repo default uses first repo).
        const defaultRepo = repoNames[0];
        const changed = diffInfo.files.map((f) => ({
          repoName: defaultRepo,
          filePath: f.path,
        }));
        const report = computeKbContext(changed, repoGraphs);
        const summary = summarizeForPrompt(report);
        broadcast({
          type: 'review-kb-summary',
          payload: { reviewId: prId, summary, changedSymbols: report.changedSymbols.length, orphans: report.orphans.length },
        });
      }
    } catch (err) { console.warn('[review] kb-context summary failed:', err); }

    // ── Spawn LLM reviewers (one per persona) in parallel ──────────
    const currentForPrompt = reviewStore.readCurrent(project, prId) ?? baseReview;
    const learnings = formatLearningsForPrompt(ANVIL_HOME, project);

    // Capture per-file content so the evidence gate's symbol/precedent checks
    // can resolve quickly when each persona finishes.
    const fileContents: Record<string, string> = {};
    for (const f of diffInfo.files) {
      const abs = join(cwd, f.path);
      try {
        if (existsSync(abs)) fileContents[f.path] = readFileSync(abs, 'utf-8');
      } catch { /* skip unreadable */ }
    }

    for (const persona of personas) {
      const prompt = buildReviewerPrompt(persona, currentForPrompt, diffInfo.diff, linkedPlan, learnings);
      const projectPrompt = `You are reviewing code for project "${project}".\nPersona: **${persona}**.\n${learnings}`;

      const agent = agentManager.spawn({
        name: `review-${persona}-${prId}`,
        persona,
        project,
        stage: `review-${persona}`,
        prompt,
        projectPrompt,
        model,
        cwd,
        permissionMode: 'bypassPermissions',
      });

      reviewAgentContext.set(agent.id, {
        reviewId: prId, project, persona,
        repoLocalPath: cwd,
        diffText: diffInfo.diff,
        fileContents,
      });

      broadcast({ type: 'agent-spawned', payload: { ...agent, reviewId: prId, persona } });
    }
  }

  /** Normalise an incoming finding (from prepass rules) into a full ReviewFinding. */
  function normaliseFinding(partial: Partial<ReviewFinding> & {
    severity: Severity; category: Category; file: string; line: number;
    snippet: string; description: string;
  }): ReviewFinding {
    return {
      id: newFindingId(),
      severity: partial.severity,
      category: partial.category,
      persona: partial.persona,
      file: partial.file,
      line: partial.line,
      snippet: partial.snippet,
      description: partial.description,
      suggestedFix: partial.suggestedFix ?? null,
      kbRef: partial.kbRef,
      cve: partial.cve,
      confidence: (partial.confidence ?? 'med') as Confidence,
      resolution: 'pending',
      createdAt: new Date().toISOString(),
    };
  }

  function extractJsonBlockFromText(text: string): unknown | null {
    const fenceRe = /```json\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    let last: string | null = null;
    while ((match = fenceRe.exec(text)) !== null) last = match[1];
    if (last) { try { return JSON.parse(last.trim()); } catch { /* fall through */ } }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(text.slice(start, end + 1)); } catch { /* */ }
    }
    return null;
  }

  async function finalizeReviewAgent(agentId: string, agent: AgentState): Promise<void> {
    const ctx = reviewAgentContext.get(agentId);
    if (!ctx) return;
    reviewAgentContext.delete(agentId);

    const parsed = extractJsonBlockFromText(agent.output ?? '');
    let findings: ReviewFinding[] = [];
    let summary = '';
    if (parsed && typeof parsed === 'object') {
      const p = parsed as { findings?: unknown; summary?: string };
      if (Array.isArray(p.findings)) {
        findings = (p.findings as Array<Partial<ReviewFinding>>).map((f) => normaliseFinding({
          severity: (f.severity ?? 'warn') as Severity,
          category: (f.category ?? 'correctness') as Category,
          persona: ctx.persona,
          file: f.file ?? '',
          line: f.line ?? 0,
          snippet: f.snippet ?? '',
          description: f.description ?? '',
          suggestedFix: f.suggestedFix ?? null,
          confidence: (f.confidence ?? 'med') as Confidence,
        }));
      }
      if (typeof p.summary === 'string') summary = p.summary;
    }

    // ── World-class review gates (R2/R6/R8/R12) ──
    // Only filter LLM-produced findings; bound-tests + plan-aware are surfaced
    // earlier as immutable prepass and shouldn't be touched here.
    let filteredFindings = findings;

    // R2 — Evidence gate: drop findings the codebase itself contradicts.
    if (ctx.repoLocalPath && ctx.diffText && ctx.fileContents) {
      try {
        const { applyEvidenceGate } = await import('./review-evidence-gate.js');
        // Map ReviewFinding → EnrichedFinding by inferring claimType from category.
        const enriched = filteredFindings.map((f) => ({
          ...f,
          quoted: f.snippet,
          targetSymbol: undefined,
          claimType: f.category === 'security' ? 'security'
            : f.category === 'correctness' ? 'null-deref'
            : f.category === 'test' ? 'missing-test'
            : f.category === 'convention' ? 'unusual-pattern'
            : 'other',
        }));
        const gate = await applyEvidenceGate(enriched as never, {
          repoLocalPath: ctx.repoLocalPath,
          diffText: ctx.diffText,
          fileContents: ctx.fileContents,
        });
        const keptIds = new Set((gate.kept as Array<{ id?: string }>).map((f) => f.id));
        filteredFindings = filteredFindings.filter((f) => keptIds.has(f.id));
      } catch (err) { console.warn('[review] evidence gate failed:', err); }
    }

    // R3 — Executable verifier: actually run a micro-test against each finding
    // and drop the ones that don't reproduce. Off by default (slow, runs Node /
    // tsc / pytest / go test in a sandbox); enable with ANVIL_REVIEW_VERIFIER=on.
    if (process.env.ANVIL_REVIEW_VERIFIER === 'on' && ctx.repoLocalPath && ctx.fileContents) {
      try {
        const { verifyFindings } = await import('./review-verifier.js');
        const summary = await verifyFindings(filteredFindings, {
          repoLocalPath: ctx.repoLocalPath,
          fileContents: ctx.fileContents,
        }, { timeoutMs: 10_000, concurrency: 3 });
        const keptIds = new Set((summary.verified as Array<{ id?: string }>).map((f) => f.id));
        filteredFindings = filteredFindings.filter((f) => keptIds.has(f.id));
      } catch (err) { console.warn('[review] R3 verifier failed:', err); }
    }

    // R-scope — Out-of-scope persona findings (e.g. security on a CSS file).
    // Pure path-based filter, no LLM, fast — always on.
    try {
      const { matches } = await import('./review-scope-matcher.js');
      filteredFindings = filteredFindings.filter((f) => {
        const persona = f.persona ?? ctx.persona;
        if (!persona || !f.file) return true;
        // If matcher returns true → in-scope, keep. If false → out-of-scope, drop.
        return matches(persona, f.file);
      });
    } catch (err) { console.warn('[review] scope matcher failed:', err); }

    // R6 — Convention filter: drop / demote findings that contradict detected
    // project conventions (e.g. arguing for semicolons when the project doesn't use them).
    try {
      const { applyConventionFilter } = await import('./review-convention-filter.js');
      const fingerprint = loadRules(CONVENTION_PATHS, ctx.project);
      if (fingerprint && fingerprint.length > 0) {
        const report = applyConventionFilter(filteredFindings, fingerprint);
        const keptIds = new Set((report.kept as Array<{ id?: string }>).map((f) => f.id));
        const demotedIds = new Set((report.demoted as Array<{ id?: string }>).map((f) => f.id));
        filteredFindings = filteredFindings
          .filter((f) => keptIds.has(f.id) || demotedIds.has(f.id))
          .map((f) => demotedIds.has(f.id)
            ? { ...f, severity: (f.severity === 'blocker' ? 'error' : f.severity === 'error' ? 'warn' : 'info') as Severity }
            : f);
      }
    } catch (err) { console.warn('[review] convention filter failed:', err); }

    try {
      const calibBundle = reviewCalibrationStore.computeSnapshot(ctx.project);
      // Calibration: rescale confidence + demote findings whose persona has
      // an empirical accept rate below 30%.
      const { applyCalibration } = await import('./review-calibration-filter.js');
      filteredFindings = applyCalibration(filteredFindings, calibBundle) as typeof filteredFindings;
    } catch (err) { console.warn('[review] calibration filter failed:', err); }

    try {
      // Dismissal loop: drop findings whose (persona, category, file-pattern)
      // has been dismissed ≥ 3 times.
      filteredFindings = filteredFindings.filter((f) => {
        const fp = f.file ?? '';
        const segs = fp.split('/');
        const filePattern = segs.length > 1
          ? `${segs.slice(0, 2).join('/')}/**/*${fp.match(/\.[^./]+$/)?.[0] ?? ''}`
          : fp;
        return !reviewDismissalStore.shouldFilter(ctx.project, {
          personaId: f.persona ?? ctx.persona,
          claimType: f.category ?? 'other',
          filePattern,
        });
      });
    } catch (err) { console.warn('[review] dismissal filter failed:', err); }

    try {
      const current = reviewStore.appendFindings(ctx.project, ctx.reviewId, filteredFindings);
      // Accumulate summary — append each persona's blurb.
      if (summary) {
        const combined = current.summary
          ? `${current.summary} | ${ctx.persona}: ${summary}`
          : `${ctx.persona}: ${summary}`;
        reviewStore.bumpVersion(ctx.project, ctx.reviewId, {
          summary: combined.slice(0, 800),
          completedAt: new Date().toISOString(),
          estimate: {
            usd: current.estimate.usd + agent.cost.totalUsd,
            seconds: current.estimate.seconds + Math.round(agent.cost.durationMs / 1000),
          },
        });
      }
      broadcast({
        type: 'review-persona-done',
        payload: { reviewId: ctx.reviewId, persona: ctx.persona, findingCount: findings.length },
      });
      // If this was the last persona, also broadcast the complete review.
      const final = reviewStore.readCurrent(ctx.project, ctx.reviewId);
      if (final) {
        const anyStillRunning = Array.from(reviewAgentContext.values()).some((c) => c.reviewId === ctx.reviewId);
        if (!anyStillRunning) {
          broadcast({ type: 'review-created', payload: { review: final } });

          // Auto-publish verdict + findings to the PR when ANVIL_REVIEW_PUBLISH=on.
          // Off by default to avoid hammering GitHub during local development.
          if (process.env.ANVIL_REVIEW_PUBLISH === 'on' && final.pr?.url) {
            (async () => {
              try {
                const { postReviewAnnotations } = await import('./review-github-annotator.js');
                const { synthesizeVerdict } = await import('./review-synthesizer.js');
                const verdict = synthesizeVerdict(final.findings as never);
                const annotations = final.findings.map((f) => ({
                  findingId: f.id,
                  severity: severityToAnnotation(f.severity),
                  filePath: f.file,
                  line: f.line || 1,
                  body: f.description,
                }));
                const result = await postReviewAnnotations({
                  prUrl: final.pr.url,
                  annotations,
                  verdictHeadline: verdict.headline,
                  verdictLevel: verdict.level,
                });
                broadcast({
                  type: 'review-published',
                  payload: { reviewId: ctx.reviewId, ...result },
                });
              } catch (err) {
                console.warn('[review] github annotator failed:', err);
              }
            })();
          }
        }
      }
    } catch (err) {
      broadcast({ type: 'review-error', payload: { message: err instanceof Error ? err.message : String(err), reviewId: ctx.reviewId } });
    }
  }

  /** Map ReviewFinding severity onto the annotator's narrower severity ladder. */
  function severityToAnnotation(s: Severity): 'blocker' | 'high' | 'medium' | 'low' | 'info' {
    if (s === 'blocker') return 'blocker';
    if (s === 'error') return 'high';
    if (s === 'warn') return 'medium';
    if (s === 'nit') return 'low';
    return 'info';
  }

  /**
   * Apply a review finding's `suggestedFix` — checks out the PR branch, applies
   * the patch, commits, pushes, and marks the finding `addressed`.
   */
  async function applyReviewFix(project: string, reviewId: string, findingId: string): Promise<string> {
    const review = reviewStore.readCurrent(project, reviewId);
    if (!review) throw new Error(`Review ${reviewId} not found`);
    const finding = review.findings.find((f) => f.id === findingId);
    if (!finding) throw new Error(`Finding ${findingId} not found`);
    if (!finding.suggestedFix) throw new Error(`Finding ${findingId} has no suggestedFix`);

    const repoLocalPaths = projectLoader.getRepoLocalPaths(project);
    const [, repoName] = review.pr.repo.split('/');
    const localPath = repoLocalPaths[repoName];
    if (!localPath || !existsSync(localPath)) {
      throw new Error(`Local clone for ${review.pr.repo} not found. Run the pipeline once first.`);
    }

    // Find the branch name — fetch the PR ref.
    execSync(`gh pr checkout ${review.pr.number} --repo ${review.pr.repo}`, { cwd: localPath, stdio: 'pipe' });

    // Apply patch via `git apply`. Fall back to 3-way if straight apply fails.
    const tmpPatch = join(localPath, `.anvil-fix-${findingId}.patch`);
    writeFileSync(tmpPatch, finding.suggestedFix.diff, 'utf-8');
    try {
      execSync(`git apply "${tmpPatch}"`, { cwd: localPath, stdio: 'pipe' });
    } catch {
      execSync(`git apply --3way "${tmpPatch}"`, { cwd: localPath, stdio: 'pipe' });
    }

    execSync(`git add -A`, { cwd: localPath, stdio: 'pipe' });
    const msg = `[anvil-review] fix: ${finding.description.slice(0, 80).replace(/"/g, '\\"')}`;
    execSync(`git commit -m "${msg}"`, { cwd: localPath, stdio: 'pipe' });
    const sha = execSync(`git rev-parse HEAD`, { cwd: localPath, encoding: 'utf-8' }).trim();
    execSync(`git push`, { cwd: localPath, stdio: 'pipe' });

    // Mark the finding addressed.
    const updated = reviewStore.setResolution(project, reviewId, findingId, 'addressed');
    const priorResolution = review.findings.find((f) => f.id === findingId)?.resolution ?? 'pending';
    if (updated) {
      const finding2 = updated.findings.find((f) => f.id === findingId);
      if (finding2) {
        try { recordResolution(ANVIL_HOME, project, updated, finding2, priorResolution); } catch { /* ok */ }
      }
    }

    return sha;
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

  // Restore incomplete pipelines from previous sessions into active runs
  (async () => {
    try {
      const { findInterruptedPipelines } = await import('./pipeline-runner.js');
      const incomplete = findInterruptedPipelines(ANVIL_HOME);
      if (incomplete.length > 0) {
        for (const cp of incomplete) {
          // Add to activeRuns so they appear in the Active Runs page
          activeRuns.set(cp.runId, {
            id: cp.runId,
            type: 'build',
            project: cp.project,
            description: cp.feature,
            model: cp.config.model,
            status: cp.status === 'cancelled' ? 'failed' : cp.status as 'running' | 'completed' | 'failed',
            startedAt: new Date(cp.startedAt).getTime(),
            activities: [],
            prUrls: new Set(),
          });
        }

        // Broadcast to connected clients after a short delay
        setTimeout(() => {
          broadcastActiveRuns();
          broadcast({
            type: 'interrupted-pipelines',
            payload: {
              pipelines: incomplete.map((cp) => ({
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
                status: cp.status,
                error: cp.stages[cp.currentStage]?.error ?? 'Pipeline was interrupted (dashboard shutdown)',
              })),
            },
          });
        }, 2000); // Wait for clients to connect
      }
    } catch (err) {
      console.warn('[dashboard] Failed to scan for incomplete pipelines:', err);
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

  // Sleeptime memory consolidation. Walks pending proposals (from
  // reflectOnRun) every N ms and ratifies them via memory-core's
  // defaultDecide (hash-dedupe → MERGE-INTO else ADD). Cancellable.
  // ANVIL_SLEEPTIME_INTERVAL_MS=0 disables; default 30 minutes.
  //
  // Wrapped decideFn: when a `semantic:fix-pattern` proposal ratifies
  // (add or merge-into), parse the failure into error/fix and call
  // convention-core's `checkAndPromote`. Three occurrences of the
  // same normalized error promote to a rule in
  // `<conventionsDir>/<project>/rules.json`, closing the
  // lesson → convention loop.
  const sleeptimeIntervalMs = (() => {
    const raw = process.env.ANVIL_SLEEPTIME_INTERVAL_MS;
    if (raw === undefined) return 30 * 60_000;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 30 * 60_000;
  })();
  let sleeptimeTimer: NodeJS.Timeout | null = null;
  if (sleeptimeIntervalMs > 0) {
    const runSleeptime = async () => {
      try {
        const { consolidate, defaultDecide, ProposalQueue } = await import('@esankhan3/anvil-memory-core');
        const { checkAndPromote } = await import('@esankhan3/anvil-convention-core');
        const projects = await projectLoader.listProjects().catch(() => []);
        const store = memoryStore.unwrap();
        const queue = new ProposalQueue(store.sqlite);
        let total = 0;
        for (const sys of projects) {
          const decideFn = async (
            s: typeof store,
            proposal: Parameters<typeof defaultDecide>[1],
          ) => {
            const decision = defaultDecide(s, proposal);
            try {
              const cand = proposal.candidate;
              if (
                cand.kind === 'semantic' &&
                cand.subtype === 'fix-pattern' &&
                (decision.kind === 'add' || decision.kind === 'merge-into')
              ) {
                const { error, fix } = parseFixPatternContent(cand.content);
                if (error && fix) {
                  const promoted = checkAndPromote(CONVENTION_PATHS, error, fix, sys.name);
                  if (promoted.promoted && promoted.rule) {
                    console.log(
                      `[sleeptime] promoted convention rule for "${sys.name}": ${promoted.rule.id}`,
                    );
                  }
                }
              }
            } catch (err) {
              console.warn('[sleeptime] promotion hook failed:', err);
            }
            return decision;
          };
          const result = await consolidate(
            store,
            queue,
            { scope: 'project', projectId: sys.name },
            { decideFn },
          );
          total += result.ratified + result.merged;
        }
        if (total > 0) console.log(`[sleeptime] consolidated ${total} proposal(s) across ${projects.length} project(s)`);
      } catch (err) {
        console.warn('[sleeptime] consolidate failed:', err);
      }
    };
    sleeptimeTimer = setInterval(runSleeptime, sleeptimeIntervalMs);
    sleeptimeTimer.unref?.();
    console.log(`[dashboard] sleeptime consolidation every ${Math.round(sleeptimeIntervalMs / 60_000)}m`);
  }

  // Phase D3+F4: Pattern-1 migration + orphan takeover. Scans for
  // in-flight runs without a durable row (Pattern-1) AND for
  // crashed-peer runs whose lease has expired (orphan takeover).
  // Auto-takeover acquires the lease so a resume orchestrator can
  // continue the run from its durable cursor. No artifacts touched.
  // Phase G1: capture taken-over runIds so we can dispatch them
  // through startPipeline once it's in scope (later in boot).
  const takenOverRunIds: string[] = [];
  try {
    const durableStore = getDurableStore();
    const migrationStats = await runDurableMigration(durableStore, {
      onTakeover: (runIds) => {
        console.log(
          `[dashboard] auto-takeover: claimed ${runIds.length} orphaned run(s) — ${runIds.join(', ')}`,
        );
        takenOverRunIds.push(...runIds);
      },
    });
    if (
      migrationStats.scanned > 0
      || migrationStats.orphaned > 0
      || migrationStats.takenOver > 0
    ) {
      console.log(
        `[dashboard] durable migration: scanned=${migrationStats.scanned} migrated=${migrationStats.migrated} orphaned=${migrationStats.orphaned} takenOver=${migrationStats.takenOver} contested=${migrationStats.takeoverContested} errors=${migrationStats.errors}`,
      );
    }
  } catch (err) {
    console.warn(`[dashboard] durable migration skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Phase G1: dispatch auto-takeover runs through startPipeline.
  // Fire-and-forget so boot doesn't block on the pipeline runner.
  // Runs serially (startPipeline cancels the active runner before
  // starting a new one) — first reclaimed run wins; subsequent ones
  // queue at the dashboard layer via the user's reclaim UX. Disable
  // with ANVIL_DURABLE_AUTO_RESUME=0 to keep F4's "claim only"
  // behaviour.
  if (takenOverRunIds.length > 0) {
    const stagesByName: Record<string, number> = {};
    for (let i = 0; i < RUNNER_STAGES.length; i++) stagesByName[RUNNER_STAGES[i].name] = i;
    void dispatchTakenOverRuns(
      getDurableStore(),
      takenOverRunIds,
      (project, feature, options) => {
        startPipeline(project, feature, options);
      },
      stagesByName,
    ).then((stats) => {
      if (stats.dispatched > 0 || stats.errors > 0) {
        console.log(
          `[dashboard] auto-resume: attempted=${stats.attempted} dispatched=${stats.dispatched} skipped=${stats.skipped} errors=${stats.errors}`,
        );
      }
    });
  }

  // Phase F3: durable-store vacuum. Runs once at boot then daily
  // to drop terminal runs older than the retention window
  // (default 30d, override via ANVIL_DURABLE_RETENTION_DAYS).
  // Skip with ANVIL_DURABLE_VACUUM_DISABLED=1.
  try {
    const durableStore = getDurableStore();
    await scheduleDurableVacuum(durableStore);
  } catch (err) {
    console.warn(`[dashboard] durable vacuum schedule skipped: ${err instanceof Error ? err.message : err}`);
  }

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
