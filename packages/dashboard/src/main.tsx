import React, { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import './styles/index.css';
import { CommandPalette } from './components/command/CommandPalette.js';
import { PipelineContainer } from './components/pipeline/PipelineContainer.js';
import type { PipelineData } from './components/pipeline/PipelineContainer.js';
import { ProjectOverview } from './components/overview/ProjectOverview.js';
import { PRBoardContainer } from './components/pr-board/PRBoardContainer.js';
import { RunHistoryList } from './components/history/RunHistoryList.js';
import { HomePage } from './components/home/HomePage.js';
import { KnowledgeGraphPage } from './components/knowledge-graph/KnowledgeGraphPage.js';

import { ReviewPage } from './components/review/ReviewPage.js';
import { TestGenPage } from './components/test-gen/TestGenPage.js';
import { PlanPage } from './components/plan/PlanPage.js';
import { SettingsPage } from './components/settings/SettingsPage.js';
import type { ActivityEntry } from './components/output/ActivityLine.js';
import { OutputPanel } from './components/output/OutputPanel.js';
import type { ChangeEntry } from './components/output/OutputPanel.js';
import { StatsPage } from './components/stats/StatsPage.js';
import { DashboardLayout } from './components/layout/DashboardLayout.js';
import type { NavItem } from './components/layout/Sidebar.js';
import { ProjectProvider } from './context/ProjectContext.js';
import { routes, primaryRoutes, secondaryRoutes, useHashRouter } from './router.js';
import type { ProjectInfo } from './context/ProjectContext.js';
import type { RunSummary } from './components/history/RunRow.js';
import type { OutputChunk } from '../server/types.js';
import { ArrowLeft, Square, RotateCcw, Play } from 'lucide-react';

// ---------------------------------------------------------------------------
// Raw content cleaner — strips JSON, tool inputs, commands from Claude's text
// ---------------------------------------------------------------------------

/** Returns true if a line looks like JSON or a shell command rather than narrative text */
function isNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  // JSON object/array openers
  if (/^\s*[\[{]/.test(t) && /[\]}]\s*,?\s*$/.test(t)) return true;
  // Standalone JSON keys ("key": ...)
  if (/^\s*"[^"]+"\s*:/.test(t)) return true;
  // Shell commands (find, ls, grep, head, echo, etc.)
  if (/^\s*(?:find|ls|grep|head|tail|cat|echo|cd|mkdir|rm|cp|mv|git|npm|npx|node|curl)\s/.test(t)) return true;
  // File paths on their own line
  if (/^\/[^\s]+$/.test(t)) return true;
  return false;
}

/**
 * Clean a text activity's content for the Raw output tab.
 * Removes JSON blocks, tool call inputs, command strings, and metadata headers.
 */
function cleanRawContent(text: string): string {
  if (!text) return '';
  const trimmed = text.trim();

  // Skip entirely if content is a JSON object/array
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    return '';
  }

  // Remove fenced code blocks that contain JSON, shell commands, or tool inputs
  let cleaned = trimmed.replace(/```(?:json|javascript|typescript|js|ts|bash|shell|sh)?\n[\s\S]*?```/g, '');

  // Remove inline JSON objects (multi-line { ... } blocks)
  cleaned = cleaned.replace(/^\s*\{[\s\S]*?\}\s*$/gm, '');

  // Filter out noise lines
  const lines = cleaned.split('\n');
  const filtered = lines.filter((line) => !isNoiseLine(line));
  cleaned = filtered.join('\n').trim();

  // Collapse excessive blank lines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');

  return cleaned;
}

// ---------------------------------------------------------------------------
// Types from the server
// ---------------------------------------------------------------------------
interface DashboardStageState {
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

interface DashboardPipeline {
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

interface DashboardState {
  activePipeline: DashboardPipeline | null;
  lastUpdated: string;
}

interface AgentOutputEntry {
  timestamp: number;
  stage: string;
  type: 'stdout' | 'stderr';
  content: string;
  kind?: string;
  tool?: string;
  agentId?: string;
  repo?: string;
}

interface FeatureRecord {
  slug: string;
  project: string;
  description: string;
  status: string;
  totalCost: number;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPipelineData(pipeline: DashboardPipeline | null): PipelineData | null {
  if (!pipeline) return null;
  const completed = pipeline.stages.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length;
  const progress = Math.round((completed / pipeline.stages.length) * 100);

  return {
    runId: pipeline.runId,
    project: pipeline.project,
    feature: pipeline.feature,
    currentStage: pipeline.currentStage,
    overallProgress: progress,
    status: pipeline.status === 'cancelled' ? 'failed'
      : pipeline.status === 'waiting' ? 'paused'
        : pipeline.status,
    stages: pipeline.stages.map((s) => ({
      name: s.label || s.name,
      rawName: s.name,
      status: s.status === 'waiting' ? 'running' : s.status,
      progress: s.status === 'completed' ? 100 : s.status === 'running' || s.status === 'waiting' ? 50 : 0,
      startedAt: s.startedAt ? new Date(s.startedAt).getTime() : undefined,
      completedAt: s.completedAt ? new Date(s.completedAt).getTime() : undefined,
      cost: s.cost,
      perRepo: s.perRepo,
      repos: s.repos?.map((r) => ({
        repoName: r.repoName,
        agentId: r.agentId,
        status: r.status as 'pending' | 'running' | 'completed' | 'failed',
        cost: r.cost,
        error: r.error,
      })),
    })),
    totalCost: pipeline.cost.estimatedCost,
    pendingApproval: null,
    model: pipeline.model,
    repoNames: pipeline.repoNames,
    waitingForInput: pipeline.waitingForInput,
  };
}

let activityIdCounter = 0;
function toActivityEntry(entry: AgentOutputEntry): ActivityEntry {
  const kind = entry.kind ?? (entry.type === 'stderr' ? 'stderr' : 'text');
  let tool: string | undefined = entry.tool;
  let summary = entry.content;
  let content = entry.content;

  // For tool_use: generate clean summary from tool name + JSON input
  if (kind === 'tool_use') {
    if (!tool) {
      // Try to detect tool from content
      if (entry.content.includes('Reading')) tool = 'Read';
      else if (entry.content.includes('Editing')) tool = 'Edit';
      else if (entry.content.includes('Writing')) tool = 'Write';
      else if (entry.content.includes('Running')) tool = 'Bash';
      else if (entry.content.includes('Searching')) tool = 'Grep';
      else if (entry.content.includes('Finding')) tool = 'Glob';
      else if (entry.content.includes('Agent') || entry.content.includes('subagent')) tool = 'Agent';
      else if (entry.content.includes('skill')) tool = 'Skill';
    }

    // Generate human-readable summary from JSON input
    try {
      const input = JSON.parse(entry.content);
      switch (tool) {
        case 'Read':  summary = `Reading ${shortenPath(input.file_path)}`; break;
        case 'Edit':  summary = `Editing ${shortenPath(input.file_path)}`; break;
        case 'Write': summary = `Writing ${shortenPath(input.file_path)}`; break;
        case 'Bash':  summary = `Running: ${(input.command ?? input.description ?? '').slice(0, 120)}`; break;
        case 'Grep':  summary = `Searching for "${(input.pattern ?? '').slice(0, 60)}"${input.path ? ` in ${shortenPath(input.path)}` : ''}`; break;
        case 'Glob':  summary = `Finding files: ${input.pattern ?? ''}`; break;
        case 'Agent': summary = `Sub-agent: ${input.description ?? ''}`; break;
        case 'Skill': summary = `Skill: ${input.skill ?? ''}${input.args ? ' ' + input.args : ''}`; break;
        default:      summary = `${tool ?? 'Tool'}: ${Object.values(input).filter((v) => typeof v === 'string').join(' ').slice(0, 100)}`; break;
      }
    } catch {
      // Content wasn't JSON — keep as-is but truncate
      summary = entry.content.slice(0, 200);
    }
  } else {
    // Clean up emoji prefixes for non-tool entries
    summary = summary.replace(/^[\u{1F4C4}\u270E\u270F\uFE0F\u{1F4DD}\u26A1\u{1F50D}\u{1F4C1}\u{1F916}\u{1F527}\u{1F680}\u{1F4AD}\u2705\u26A0\uFE0F]\s*/u, '');
  }

  return {
    id: ++activityIdCounter,
    timestamp: entry.timestamp,
    kind: kind as ActivityEntry['kind'],
    tool,
    summary: summary.slice(0, 200),
    content,
    stage: entry.stage,
    repo: entry.repo,
  };
}

/** Shorten a file path for display */
function shortenPath(path: string | undefined): string {
  if (!path) return 'file';
  // Remove /Users/xxx/workspace/project/repo/ prefix
  return path.replace(/^\/Users\/[^/]+\/workspace\/[^/]+\//, '');
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const { currentRoute, navigate, runId: urlRunId } = useHashRouter();
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [currentProject, setCurrentProject] = useState<ProjectInfo | null>(null);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [features, setFeatures] = useState<FeatureRecord[]>([]);
  const [dashboardState, setDashboardState] = useState<DashboardState | null>(null);
  const [agentOutput, setAgentOutput] = useState<OutputChunk[]>([]);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [changes, setChanges] = useState<ChangeEntry[]>([]);
  const [prs, setPrs] = useState<import('./components/pr-board/usePRData.js').PRData[]>([]);
  const [historySelectedRunId, setHistorySelectedRunId] = useState<string | null>(null);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [actionPending, setActionPending] = useState<string | null>(null); // 'build' | 'fix' | 'research' | null
  const [activeRunsList, setActiveRunsList] = useState<Array<{
    id: string; type: string; project: string; description: string;
    model: string; status: string; startedAt: number; activityCount: number;
  }>>([]);
  const [viewingRunActivities, setViewingRunActivities] = useState<ActivityEntry[]>([]);
  const [overviewData, setOverviewData] = useState<{
    memories: Array<{ id: string; key: string; value: string; category: string; timestamp: number }>;
    conventions: string[];
    repos: Array<{ name: string; language: string }>;
    features: Array<{ slug: string; description: string; status: string; totalCost: number; updatedAt: string }>;
    kbStatus?: {
      project: string;
      repos: Array<{ repoName: string; status: string; lastRefreshed: string | null; nodeCount: number; communityCount: number; error: string | null }>;
      overallStatus: string;
      lastRefreshed: string | null;
    } | null;
  }>({ memories: [], conventions: [], repos: [], features: [] });
  const [kbRefreshing, setKbRefreshing] = useState(false);
  const [kbProgress, setKbProgress] = useState<{ repo: string; message: string; repoIndex: number; totalRepos: number } | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [projectSwitching, setProjectSwitching] = useState(false);
  const [availableModels, setAvailableModels] = useState<{
    providers: Array<{
      name: string;
      available: boolean;
      models: string[];
      tier: string;
      envVar?: string;
    }>;
    defaultModel: string;
  } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttempts = useRef(0);
  const MAX_RECONNECTS = 10;

  // Derived
  const activePipeline = toPipelineData(dashboardState?.activePipeline ?? null);
  const rawPipeline = dashboardState?.activePipeline ?? null;
  // Raw output: only Claude's meaningful narrative text (no tool JSON, prompts, or commands)
  const rawOutput = useMemo(
    () => activities
      .filter((a) => a.kind === 'text')
      .map((a) => cleanRawContent(a.content || a.summary))
      .filter((t) => t.length > 0)
      .join('\n\n'),
    [activities],
  );
  const isWaitingForInput = rawPipeline?.waitingForInput === true;

  // Connect to WebSocket with exponential backoff reconnection
  useEffect(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const wsUrl = `${protocol}//${host}/ws`;
    let ws: WebSocket;
    let reconnectTimer: ReturnType<typeof setTimeout>;

    function connect() {
      ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        setWsConnected(true);
        reconnectAttempts.current = 0;
        // Re-request current state on reconnect to avoid stale/blank pipeline
        ws.send(JSON.stringify({ action: 'get-state' }));
      };
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string);
          handleServerMessage(msg);
        } catch { /* ignore */ }
      };
      ws.onclose = () => {
        setWsConnected(false);
        if (reconnectAttempts.current < MAX_RECONNECTS) {
          const delay = Math.min(2000 * Math.pow(1.5, reconnectAttempts.current), 30_000);
          console.warn(`[ws] Connection closed, reconnecting in ${Math.round(delay / 1000)}s... (attempt ${reconnectAttempts.current + 1}/${MAX_RECONNECTS})`);
          reconnectAttempts.current += 1;
          reconnectTimer = setTimeout(connect, delay);
        } else {
          console.warn('[ws] Max reconnection attempts reached. Refresh the page to reconnect.');
        }
      };
      ws.onerror = (err) => {
        console.warn('[ws] Connection error:', err);
        ws.close();
      };
    }

    connect();
    return () => { clearTimeout(reconnectTimer); ws?.close(); };
  }, []);

  function handleServerMessage(msg: { type: string; payload: any }) {
    switch (msg.type) {
      case 'init': {
        const { projects: sysList, runs: runList, state, features: featureList, prs: prList, activeRuns: activeRunList } = msg.payload;
        if (Array.isArray(sysList)) {
          setProjects(sysList);
          setCurrentProject((prev) => prev ?? sysList[0] ?? null);
        }
        if (Array.isArray(runList)) setRuns(runList);
        if (Array.isArray(featureList)) setFeatures(featureList);
        if (Array.isArray(prList)) setPrs(prList);
        if (Array.isArray(activeRunList)) setActiveRunsList(activeRunList);
        if (state) setDashboardState(state as DashboardState);
        if (msg.payload.availableModels) {
          setAvailableModels(msg.payload.availableModels);
        }
        setProjectsLoading(false);
        break;
      }

      case 'state': {
        const newState = msg.payload as DashboardState;
        // Keep the last pipeline state visible when it transitions to null (cancel/fail/complete)
        // so the user can see final status and resume. Only clear when a NEW pipeline starts.
        setDashboardState((prev) => {
          if (!newState.activePipeline && prev?.activePipeline) {
            // Pipeline just ended — keep the last state with terminal status
            const terminal = { ...prev };
            if (terminal.activePipeline) {
              const status = terminal.activePipeline.status;
              if (status === 'running' || status === 'waiting') {
                terminal.activePipeline = { ...terminal.activePipeline, status: 'cancelled' };
              }
            }
            return terminal;
          }
          return newState;
        });
        break;
      }

      case 'projects':
        if (Array.isArray(msg.payload)) setProjects(msg.payload);
        break;

      case 'runs':
        if (Array.isArray(msg.payload)) setRuns(msg.payload);
        break;

      case 'features':
        if (Array.isArray(msg.payload)) setFeatures(msg.payload);
        break;

      case 'prs':
        if (Array.isArray(msg.payload)) setPrs(msg.payload);
        break;

      case 'overview':
        if (msg.payload) {
          setOverviewData(msg.payload as typeof overviewData);
          setProjectSwitching(false);
          if (projectSwitchTimer.current) clearTimeout(projectSwitchTimer.current);
        }
        break;

      case 'kb-status':
        if (msg.payload) {
          setOverviewData((prev) => ({ ...prev, kbStatus: msg.payload as typeof overviewData['kbStatus'] }));
          setKbRefreshing(false);
          setKbProgress(null);
        }
        break;

      case 'kb-progress':
        if (msg.payload) {
          setKbProgress(msg.payload as typeof kbProgress);
        }
        break;

      case 'kb-refresh-started':
        setKbRefreshing(true);
        break;

      case 'available-models':
        if (msg.payload) {
          setAvailableModels(msg.payload);
        }
        break;

      case 'active-runs':
        if (Array.isArray(msg.payload)) setActiveRunsList(msg.payload);
        break;

      case 'agent-spawned': {
        // Don't clear actionPending here — wait for first agent-output
        const spawned = msg.payload as any;
        if (spawned?.runId) {
          const hash = window.location.hash.slice(1);
          if (hash === '/fix') setCurrentFixRunId(spawned.runId);
          else if (hash === '/research') setCurrentResearchRunId(spawned.runId);
          else if (hash === '/build') setCurrentBuildRunId(spawned.runId);
        }
        break;
      }

      case 'run-data': {
        const runData = msg.payload as any;
        if (runData?.activities && runData.activities.length > 0) {
          const runActivities = runData.activities.map((e: any) => {
            const a = toActivityEntry(e);
            a.runId = runData.id;
            return a;
          });
          setActivities((prev) => {
            // Merge: keep existing live-streamed activities that aren't in the server response.
            // This preserves clarify-question, user-message, etc. that may not be in run-data.
            const existing = prev.filter((a) => a.runId === runData.id);
            if (existing.length > 0) {
              // We already have live activities — merge server data without wiping
              const existingTimestamps = new Set(existing.map((a) => `${a.timestamp}-${a.summary}`));
              const newFromServer = runActivities.filter(
                (a: ActivityEntry) => !existingTimestamps.has(`${a.timestamp}-${a.summary}`),
              );
              // Prepend server-only activities (older) before existing live ones
              const otherRuns = prev.filter((a) => a.runId !== runData.id);
              return [...otherRuns, ...newFromServer, ...existing];
            }
            // No existing activities — use server data as-is
            const filtered = prev.filter((a) => a.runId !== runData.id);
            return [...filtered, ...runActivities];
          });
          setViewingRunActivities(runActivities);
        }
        break;
      }

      case 'agent-output': {
        const entries: AgentOutputEntry[] = msg.payload?.entries ?? [];
        const msgRunId: string | undefined = msg.payload?.runId;
        if (entries.length > 0) {
          // Clear pending state as soon as output arrives
          setActionPending(null);
          setAgentOutput((prev) => [
            ...prev,
            ...entries.map((e: any) => ({
              runId: '',
              repo: e.repo ?? '',
              stage: e.stage ?? '',
              type: e.type as 'stdout' | 'stderr',
              content: e.content ?? '',
              timestamp: e.timestamp ?? Date.now(),
              kind: e.kind ?? 'text',
            })),
          ]);

          const newActivities = entries.map((e) => {
            const a = toActivityEntry(e);
            if (msgRunId) a.runId = msgRunId;
            return a;
          });
          // Deduplicate: skip text activities with identical content to the last one
          setActivities((prev) => {
            const lastContent = prev.length > 0 ? prev[prev.length - 1].content ?? prev[prev.length - 1].summary : '';
            const deduped = newActivities.filter((a) => {
              if (a.kind !== 'text') return true;
              const thisContent = a.content ?? a.summary;
              return thisContent !== lastContent;
            });
            return [...prev, ...deduped];
          });

          // Extract file changes from tool_use activities
          const newChanges: ChangeEntry[] = [];
          for (const activity of newActivities) {
            if (activity.kind !== 'tool_use') continue;
            const tool = activity.tool;
            if (tool !== 'Edit' && tool !== 'Write') continue;

            // Parse the JSON content to extract file path and diff
            let filePath = '';
            let diff: string | undefined;
            const content = activity.content ?? '';

            try {
              const input = JSON.parse(content);
              filePath = input.file_path ?? '';

              if (tool === 'Edit' && input.old_string && input.new_string) {
                const oldLines = (input.old_string as string).split('\n');
                const newLines = (input.new_string as string).split('\n');
                diff = `--- ${filePath}\n+++ ${filePath}\n` +
                  oldLines.map((l: string) => `- ${l}`).join('\n') + '\n' +
                  newLines.map((l: string) => `+ ${l}`).join('\n');
              } else if (tool === 'Write' && input.content) {
                const lines = (input.content as string).split('\n');
                diff = lines.map((l: string) => `+ ${l}`).join('\n');
              }
            } catch {
              // Content wasn't JSON — try to extract file path from summary
              const match = activity.summary.match(/(?:Editing|Writing)\s+(.+)/);
              if (match) filePath = match[1].trim();
            }

            if (!filePath) continue;

            // Shorten path for display
            const shortPath = filePath.replace(/^\/Users\/[^/]+\/workspace\/[^/]+\//, '');

            newChanges.push({
              file: shortPath,
              tool: tool as 'Edit' | 'Write',
              summary: tool === 'Edit' ? 'Modified' : 'Created',
              timestamp: activity.timestamp,
              diff,
              repo: activity.repo,
            });
          }
          if (newChanges.length > 0) setChanges((prev) => [...prev, ...newChanges]);
        }
        break;
      }

      case 'artifact': {
        // Stage artifact written (REQUIREMENTS.md, SPECS.md, etc.)
        const a = msg.payload;
        if (a?.file) {
          const shortPath = String(a.file).replace(/.*\.anvil\/features\//, '');
          setChanges((prev) => [...prev, {
            file: shortPath,
            tool: 'Write' as const,
            summary: a.summary || 'Artifact',
            timestamp: a.timestamp || Date.now(),
          }]);
        }
        break;
      }

      default:
        break;
    }
  }

  function sendWs(msg: Record<string, unknown>) {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  // Handle project switch: clear stale data and request fresh data
  const projectSwitchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSystemSelect = useCallback((sys: ProjectInfo) => {
    if (sys.name === currentProject?.name) return;
    setProjectSwitching(true);
    setCurrentProject(sys);
    // Clear stale project-specific data immediately
    setOverviewData({ memories: [], conventions: [], repos: [], features: [] });
    // Request fresh data for the new project
    sendWs({ action: 'get-overview', project: sys.name });
    sendWs({ action: 'get-kb-status', project: sys.name });
    sendWs({ action: 'get-active-runs' });
    // Safety timeout: clear loading state after 8s even if server is slow
    if (projectSwitchTimer.current) clearTimeout(projectSwitchTimer.current);
    projectSwitchTimer.current = setTimeout(() => setProjectSwitching(false), 8000);
  }, [currentProject]);

  // Re-fetch run data + pipeline state when navigating to/back to a run view
  useEffect(() => {
    if (urlRunId) {
      sendWs({ action: 'get-run', runId: urlRunId });
      sendWs({ action: 'get-active-runs' });
      // Also request current pipeline state so stages/progress are restored
      sendWs({ action: 'get-state' });
    }
  }, [urlRunId]);

  // Global keyboard shortcut
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setCmdPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const commands = routes.map((r) => ({
    id: r.id,
    label: `Go to ${r.label}`,
    action: () => navigate(r.path),
  }));

  // Pipeline actions
  const handleStop = useCallback(() => sendWs({ action: 'cancel-pipeline' }), []);
  const handleResume = useCallback(() => {
    sendWs({ action: 'resume-pipeline', runId: activePipeline?.runId, project: currentProject?.name });
  }, [activePipeline, currentProject]);
  const handleRetry = useCallback(() => {
    // Re-run with same feature
    if (rawPipeline) {
      handleStartFeature(rawPipeline.feature, {
        project: rawPipeline.project,
        model: rawPipeline.model ?? availableModels?.defaultModel ?? 'claude-sonnet-4-6',
      });
    }
  }, [rawPipeline]);
  const handleRunAgain = handleRetry;

  const handleSendInput = useCallback((agentIdOrText: string, text?: string) => {
    const actualText = text ?? agentIdOrText;
    const agentId = text ? agentIdOrText : undefined;
    sendWs({
      action: 'send-input',
      agentId,
      text: actualText,
      project: currentProject?.name,
      runId: activePipeline?.runId,
    });
  }, [currentProject, activePipeline]);

  // Start feature from homepage or modal
  const handleStartFeature = useCallback(
    (feature: string, options: { project: string; model: string; provider?: string; skipClarify?: boolean; skipShip?: boolean; baseBranch?: string }) => {
      // Select the project
      const sys = projects.find((s) => s.name === options.project);
      if (sys) setCurrentProject(sys);

      setAgentOutput([]);
      setActivities([]);
      setChanges([]);
      activityIdCounter = 0;
      setActionPending('build');

      sendWs({
        action: 'run-pipeline',
        project: options.project,
        feature,
        options: {
          model: options.model,
          skipClarify: options.skipClarify,
          skipShip: options.skipShip,
          baseBranch: options.baseBranch,
        },
      });
      navigate('/');
    },
    [projects, navigate],
  );

  // Track which run is on which route
  const [currentBuildRunId, setCurrentBuildRunId] = useState<string | null>(null);
  const [currentFixRunId, setCurrentFixRunId] = useState<string | null>(null);
  const [currentResearchRunId, setCurrentResearchRunId] = useState<string | null>(null);

  // Whether the current route has active output
  const routeRunId = currentRoute.id === 'build' ? currentBuildRunId
    : currentRoute.id === 'fix' ? currentFixRunId
    : currentRoute.id === 'research' ? currentResearchRunId
    : null;
  const hasActiveOutput = actionPending != null
    || activePipeline
    || activities.length > 0;

  const handleBackToHome = useCallback(() => {
    setAgentOutput([]);
    setActivities([]);
    setChanges([]);
    setCurrentBuildRunId(null);
    setCurrentFixRunId(null);
    setCurrentResearchRunId(null);
    activityIdCounter = 0;
    navigate('/');
  }, [navigate]);

  // Start a quick action and navigate to its route
  const startQuickAction = useCallback((actionType: string, description: string, project: string, model: string, route: string) => {
    setActivities([]);
    setChanges([]);
    activityIdCounter = 0;
    // Don't set actionPending — quick actions should stay on the runs list,
    // not auto-navigate to the pipeline view (which is for full 8-stage builds only)
    sendWs({ action: actionType, project, feature: description, options: { model } });
    navigate(route);
  }, [navigate]);

  // Shared project props for HomePage
  const projectProps = projects.map((s) => ({
    name: s.name,
    title: s.title,
    owner: (s as any).owner ?? '',
    lifecycle: (s as any).lifecycle ?? 'production',
    repoCount: s.repoCount ?? 0,
    repos: (s as any).repos,
  }));

  const renderView = () => {
    switch (currentRoute.id) {
      case 'home':
        if (projectsLoading || projectSwitching) {
          return <PendingView label={projectSwitching ? `Switching to ${currentProject?.title || currentProject?.name || 'project'}...` : 'Loading projects...'} />;
        }
        return (
          <HomePage
            projects={projectProps}
            features={features}
            selectedProject={currentProject?.name ?? null}
            onSelectProject={(name) => {
              const sys = projects.find((s) => s.name === name);
              if (sys) setCurrentProject(sys);
            }}
            onStartFeature={(feature, opts) => {
              handleStartFeature(feature, opts);
              navigate('/runs');
            }}
            onQuickAction={(action) => {
              startQuickAction(action.type, action.description, action.project, action.model, '/runs');
              setTimeout(() => sendWs({ action: 'get-active-runs' }), 500);
            }}
            onResumeFeature={(project, slug) => {
              const feature = features.find((f) => f.slug === slug && f.project === project);
              const run = runs.find((r) =>
                (r.featureSlug === slug && r.project === project) ||
                (r.project === project && feature && r.feature === feature.description),
              );
              setHistorySelectedRunId(run?.id ?? null);
              navigate('/history');
            }}
            availableModels={availableModels}
            ws={wsRef.current}
          />
        );

      case 'project':
        if (projectSwitching) {
          return <PendingView label={`Loading ${currentProject?.title || currentProject?.name || 'project'}...`} />;
        }
        return <ProjectOverview
          projectName={currentProject?.name ?? 'None'}
          repos={overviewData.repos}
          memories={overviewData.memories}
          conventions={overviewData.conventions}
          features={overviewData.features}
          kbStatus={overviewData.kbStatus ?? null}
          kbRefreshing={kbRefreshing}
          kbProgress={kbProgress}
          onRefreshKB={() => {
            if (currentProject?.name && wsRef.current) {
              wsRef.current.send(JSON.stringify({ action: 'refresh-knowledge-base', project: currentProject.name }));
            }
          }}
          ws={wsRef.current}
        />;

      case 'knowledge-graph':
        if (projectSwitching) {
          return <PendingView label={`Loading ${currentProject?.title || currentProject?.name || 'project'} knowledge graph...`} />;
        }
        return <KnowledgeGraphPage
          projectName={currentProject?.name ?? 'None'}
          kbStatus={overviewData.kbStatus ?? null}
          kbRefreshing={kbRefreshing}
          kbProgress={kbProgress}
          onRefreshKB={() => {
            if (currentProject?.name && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({ action: 'refresh-knowledge-base', project: currentProject.name }));
            }
          }}
          ws={wsRef.current}
        />;


      case 'runs': {
        // Auto-navigate to the run if action was just started and there's exactly one
        if (actionPending && activeRunsList.length === 1) {
          const only = activeRunsList[0];
          setActionPending(null);
          sendWs({ action: 'get-run', runId: only.id });
          navigate(`/run/${only.id}`);
          return <PendingView label="Loading run..." />;
        }
        // Still waiting for server to register the run
        if (actionPending && activeRunsList.length === 0) {
          return <PendingView label="Starting agent..." />;
        }
        return (
          <div className="page-enter" style={{ padding: 'var(--space-lg)', maxWidth: 800, margin: '0 auto', overflowY: 'auto', height: '100%' }}>
            <h2 style={{ fontSize: 22, fontWeight: 600, marginBottom: 20 }}>Active Runs</h2>
            {activeRunsList.length === 0 && !activePipeline && (
              <div style={{
                color: 'var(--text-tertiary)', fontSize: 14, padding: '64px 0', textAlign: 'center',
              }}>
                <p style={{ marginBottom: 8 }}>No active runs.</p>
                <p style={{ fontSize: 13 }}>Start a new feature from the home page.</p>
              </div>
            )}
            {/* Show active pipeline even if not in activeRunsList (e.g. waiting for input) */}
            {activeRunsList.length === 0 && activePipeline && (activePipeline.status === 'running' || activePipeline.status === 'paused') && (
              <button
                onClick={() => {
                  sendWs({ action: 'get-run', runId: activePipeline.runId });
                  navigate(`/run/${activePipeline.runId}`);
                }}
                className="card"
                style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                  cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)',
                }}
              >
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                  background: activePipeline.status === 'paused' ? 'var(--color-warning)' : 'var(--color-success)',
                  animation: 'pulse 2s ease-in-out infinite',
                }} />
                <span style={{
                  fontSize: 11, fontWeight: 500, padding: '2px 8px',
                  borderRadius: 'var(--radius-xs)',
                  background: 'rgba(52,211,153,0.12)', color: 'var(--color-success)',
                  flexShrink: 0,
                }}>
                  build
                </span>
                <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {activePipeline.feature || 'Pipeline'}
                </span>
                <span style={{
                  fontSize: 11, color: 'var(--text-tertiary)',
                  fontFamily: 'var(--font-mono)', padding: '1px 6px',
                  borderRadius: 'var(--radius-xs)', background: 'var(--bg-elevated-3)',
                }}>
                  {activePipeline.project}
                </span>
                {activePipeline.status === 'paused' && (
                  <span style={{
                    fontSize: 11, color: 'var(--color-warning)',
                    fontWeight: 500,
                  }}>
                    Waiting for input
                  </span>
                )}
              </button>
            )}
            <div className="stagger" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activeRunsList.map((r) => (
                <button
                  key={r.id}
                  onClick={() => {
                    sendWs({ action: 'get-run', runId: r.id });
                    navigate(`/run/${r.id}`);
                  }}
                  className="card"
                  style={{
                    display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                    cursor: 'pointer', textAlign: 'left', fontFamily: 'var(--font-sans)',
                  }}
                >
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                    background: r.status === 'running' ? 'var(--color-success)' : r.status === 'completed' ? 'var(--color-success)' : 'var(--color-error)',
                    ...(r.status === 'running' ? { animation: 'pulse 2s ease-in-out infinite' } : {}),
                  }} />
                  <span style={{
                    fontSize: 11, fontWeight: 500, padding: '2px 8px',
                    borderRadius: 'var(--radius-xs)',
                    background: r.type === 'build' ? 'rgba(52,211,153,0.12)' : r.type === 'fix' ? 'rgba(251,191,36,0.12)' : 'rgba(96,165,250,0.12)',
                    color: r.type === 'build' ? 'var(--color-success)' : r.type === 'fix' ? 'var(--color-warning)' : 'var(--color-info)',
                    flexShrink: 0,
                  }}>
                    {r.type === 'spike' ? 'research' : r.type}
                  </span>
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>{r.description}</span>
                  <span style={{
                    fontSize: 11, color: 'var(--text-tertiary)',
                    fontFamily: 'var(--font-mono)',
                    padding: '1px 6px', borderRadius: 'var(--radius-xs)',
                    background: 'var(--bg-elevated-3)',
                  }}>{r.project}</span>
                  {r.status === 'running' && (
                    <span
                      onClick={(e) => {
                        e.stopPropagation();
                        sendWs({ action: 'cancel-pipeline' });
                        sendWs({ action: 'stop-run', runId: r.id });
                      }}
                      className="btn btn-danger btn-sm"
                      style={{ flexShrink: 0 }}
                    >
                      Stop
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        );
      }

      case 'run': {
        // Filter activities for this specific run — live stream + loaded data
        const runActivities = urlRunId
          ? [
              ...activities.filter((a) => a.runId === urlRunId),
              ...viewingRunActivities.filter((a) =>
                !activities.some((live) => live.runId === urlRunId && live.timestamp === a.timestamp && live.summary === a.summary)),
            ]
          : activities;

        // Detect quick actions (fix, spike, review) vs full pipeline builds
        const runMeta = urlRunId ? activeRunsList.find((r) => r.id === urlRunId) : null;
        const isQuickAction = runMeta
          ? runMeta.type !== 'build'
          : urlRunId ? /^(?:fix|spike|review)-/.test(urlRunId) : false;

        if (isQuickAction) {
          // Quick action view — just the output panel, no pipeline stage sidebar
          const runRawOutput = runActivities
            .filter((a) => a.kind === 'text')
            .map((a) => cleanRawContent(a.content || a.summary))
            .filter((t) => t.length > 0)
            .join('\n\n');
          return (
            <div style={{ height: '100%', overflow: 'hidden' }}>
              {runActivities.length === 0 ? (
                <PendingView label="Waiting for output..." />
              ) : (
                <OutputPanel
                  activities={runActivities}
                  rawOutput={runRawOutput}
                  changes={changes}
                  onSendInput={handleSendInput}
                />
              )}
            </div>
          );
        }

        return (
          <div style={{ height: '100%', overflow: 'hidden' }}>
            {runActivities.length === 0 ? (
              <PendingView label="Waiting for output..." />
            ) : (
              <PipelineContainer
                pipelineData={activePipeline}
                activities={runActivities}
                rawOutput={rawOutput}
                changes={changes}
                onSendInput={handleSendInput}
                onStop={handleStop}
                onResume={() => {
                  const runId = activePipeline?.runId || urlRunId;
                  if (runId) {
                    sendWs({ action: 'resume-pipeline', runId, project: currentProject?.name });
                    // Clear stale terminal state so UI shows fresh pipeline
                    setDashboardState({ activePipeline: null, lastUpdated: new Date().toISOString() });
                    setActivities([]);
                    setChanges([]);
                  }
                }}
                onRetry={() => {
                  if (activePipeline?.feature && currentProject) {
                    handleStartFeature(activePipeline.feature, {
                      project: currentProject.name,
                      model: activePipeline.model || availableModels?.defaultModel || 'claude-sonnet-4-6',
                    });
                  }
                }}
              />
            )}
          </div>
        );
      }

      case 'insights':
        return (
          <StatsPage
            runs={runs}
            features={features}
            projects={projects.map((s) => ({ name: s.name, repoCount: s.repoCount ?? 0 }))}
            prs={prs.map((p) => ({ status: p.status, repo: p.repo }))}
          />
        );

      case 'pr-board':
        return (
          <PRBoardContainer
            prs={prs}
            loading={false}
            onPRClick={(pr) => { if (pr.url) window.open(pr.url, '_blank'); }}
          />
        );

      case 'review':
        return <ComingSoonOverlay label="Review"><ReviewPage project={currentProject?.name ?? null} ws={wsRef.current} /></ComingSoonOverlay>;

      case 'test-gen':
        return <ComingSoonOverlay label="Test Generation"><TestGenPage project={currentProject?.name ?? null} ws={wsRef.current} /></ComingSoonOverlay>;

      case 'plan':
        return <ComingSoonOverlay label="Plan"><PlanPage project={currentProject?.name ?? null} ws={wsRef.current} /></ComingSoonOverlay>;

      case 'settings':
        return <SettingsPage project={currentProject?.name ?? null} ws={wsRef.current} />;

      case 'history':
        return <RunHistoryList
          runs={runs}
          initialSelectedId={historySelectedRunId}
          getRunStages={(runId: string) => {
            const run = runs.find((r) => r.id === runId);
            return (run?.stageDetails ?? []).map((s) => ({
              name: s.label || s.name,
              status: s.status as 'pending' | 'running' | 'completed' | 'failed' | 'skipped',
              progress: s.status === 'completed' ? 100 : 0,
            }));
          }}
        />;

      default:
        return null;
    }
  };

  // Build nav items for sidebar
  const navItems: NavItem[] = [
    ...primaryRoutes.map((r) => ({
      id: r.id,
      label: r.label,
      path: r.path,
      primary: true,
      badge: r.id === 'runs' ? activeRunsList.length || undefined : undefined,
    })),
    ...secondaryRoutes.map((r) => ({
      id: r.id,
      label: r.label,
      path: r.path,
      secondary: true,
    })),
  ];

  const handleNavigation = useCallback((item: NavItem) => {
    navigate(item.path);
    if (item.id === 'runs') sendWs({ action: 'get-active-runs' });
    if (item.id === 'pr-board') sendWs({ action: 'refresh-prs' });
    if (item.id === 'project') sendWs({ action: 'get-overview', project: currentProject?.name });
    if (item.id === 'knowledge-graph') sendWs({ action: 'get-kb-status', project: currentProject?.name });
  }, [navigate, currentProject]);

  // Contextual header content
  const isRunView = currentRoute.id === 'run';
  const activeRunData = urlRunId ? activeRunsList.find((r) => r.id === urlRunId) : null;
  // Pipeline is "live" if it's in active runs OR if the activePipeline status is running/paused
  const pipelineStatus = activePipeline?.status;
  const isPipelineLive = activeRunData?.status === 'running'
    || pipelineStatus === 'running'
    || pipelineStatus === 'paused';

  const headerLeft = isRunView ? (
    <>
      <button
        onClick={() => navigate('/runs')}
        className="btn btn-ghost btn-sm"
        style={{ gap: 4 }}
      >
        <ArrowLeft size={14} strokeWidth={2} />
        Back
      </button>
      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>
        {activeRunData?.description || runs.find((r) => r.id === urlRunId)?.feature || activePipeline?.feature || urlRunId?.slice(0, 20)}
      </span>
    </>
  ) : null;

  const headerRight = isRunView ? (
    <>
      {activePipeline?.totalCost != null && activePipeline.totalCost > 0 && (
        <span style={{ fontSize: 12, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
          ${activePipeline.totalCost.toFixed(2)}
        </span>
      )}
      {isPipelineLive && (
        <button
          onClick={() => {
            // Send both cancel-pipeline (for pipeline runner) and stop-run (for active runs cleanup)
            sendWs({ action: 'cancel-pipeline' });
            sendWs({ action: 'stop-run', runId: urlRunId });
            navigate('/runs');
          }}
          className="btn btn-danger btn-sm"
          style={{ gap: 4 }}
        >
          <Square size={12} strokeWidth={2} />
          Stop
        </button>
      )}
      {urlRunId && !isPipelineLive && runs.some((r) => r.id === urlRunId) && (
        <button
          onClick={() => {
            sendWs({ action: 'resume-pipeline', runId: urlRunId, project: currentProject?.name });
            setActionPending('build');
            navigate('/runs');
          }}
          className="btn btn-sm"
          style={{
            background: 'rgba(52,211,153,0.1)', color: 'var(--accent)',
            border: '1px solid rgba(52,211,153,0.2)', gap: 4,
          }}
        >
          {runs.find((r) => r.id === urlRunId)?.status === 'failed' ? (
            <><RotateCcw size={12} strokeWidth={2} /> Retry</>
          ) : (
            <><Play size={12} strokeWidth={2} /> Resume</>
          )}
        </button>
      )}
    </>
  ) : null;

  return (
    <ProjectProvider>
      {!wsConnected && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: 28,
          background: 'var(--color-error, #ef4444)', color: '#fff',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 12, fontWeight: 500, zIndex: 9999,
        }}>
          {reconnectAttempts.current < MAX_RECONNECTS
            ? 'Connection lost — reconnecting...'
            : 'Connection lost — refresh the page'}
        </div>
      )}
      <DashboardLayout
        navItems={navItems}
        activeNavId={currentRoute.id}
        onNavigate={handleNavigation}
        projects={projects}
        currentProject={currentProject}
        onProjectSelect={handleSystemSelect}
        headerLeft={headerLeft}
        headerRight={headerRight}
      >
        {renderView()}
      </DashboardLayout>
      <CommandPalette commands={commands} isOpen={cmdPaletteOpen} onClose={() => setCmdPaletteOpen(false)} />
    </ProjectProvider>
  );
}

function PendingView({ label }: { label: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', height: '100%', gap: 16,
    }}>
      <div className="status-dot-spin" style={{ width: 28, height: 28 }} />
      <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
        {label}
      </span>
    </div>
  );
}

/** Overlay that blurs the child page and shows a "Coming Soon" badge */
function ComingSoonOverlay({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ position: 'relative', height: '100%', overflow: 'hidden' }}>
      <div style={{ filter: 'blur(2px) grayscale(0.4)', opacity: 0.45, pointerEvents: 'none', height: '100%' }}>
        {children}
      </div>
      <div style={{
        position: 'absolute', inset: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 12,
      }}>
        <span style={{
          padding: '6px 16px',
          borderRadius: 'var(--radius-full)',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          color: 'var(--text-secondary)',
          fontSize: 14, fontWeight: 600,
          fontFamily: 'var(--font-sans)',
          letterSpacing: '-0.01em',
        }}>
          {label} — Coming Soon
        </span>
        <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>
          This feature is under development.
        </span>
      </div>
    </div>
  );
}

const root = document.getElementById('root');
if (root) {
  ReactDOM.createRoot(root).render(<App />);
}
