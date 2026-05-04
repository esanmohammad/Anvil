import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FlaskConical,
  Layers,
  Shuffle,
  Shield,
  Gauge,
  Zap,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  ExternalLink,
  FileCode,
  Clock,
  Plus,
} from 'lucide-react';
import {
  Pill,
  type Severity,
  type Resolution,
  type Confidence,
} from '../common/findingPrimitives.js';
import { FindingList, type FindingGroup } from '../common/FindingList.js';
import { Toast } from '../common/Toast.js';
import { useResolvableFinding } from '../common/useResolvableFinding.js';
import { IncidentsPanel } from './IncidentsPanel.js';

export interface TestSpecPageProps {
  project: string | null;
  ws: WebSocket | null;
}

// ── Domain types (mirror server test-types.ts) ─────────────────────────

type BehaviorKind = 'unit' | 'integration' | 'property' | 'contract' | 'regression' | 'e2e';
type Priority = 'critical' | 'normal' | 'edge';
type TestCategory = 'coverage' | 'edge-case' | 'security' | 'perf' | 'flakiness' | 'convention';
type TestPersona = 'test-architect' | 'edge-case-hunter' | 'security-tester' | 'perf-tester' | 'flakiness-auditor';
type Runner = 'vitest' | 'jest' | 'pytest' | 'go-test' | 'mocha' | 'unknown';

interface Behavior {
  id: string;
  kind: BehaviorKind;
  intent: string;
  target: { file: string; symbol: string };
  preconditions: string[];
  inputs: { description: string; samples?: unknown[]; generator?: string };
  expected: { description: string; assertion: string };
  priority: Priority;
  ground: { files: string[]; typesSeen: string[]; confidence: number };
  mutationTargets?: string[];
  linkedFindingId?: string;
  linkedIncidentId?: string;
}

interface ConventionFingerprint {
  runner: Runner;
  assertionStyle: 'expect' | 'assert' | 'should' | 'testing.T' | 'unknown';
  fileLayout: 'colocated' | '__tests__' | 'tests-root' | 'unknown';
  namingPattern: string;
  mockStyle?: 'vi.mock' | 'jest.mock' | 'sinon' | 'mocker' | 'none';
  fixtureStyle?: 'factories' | 'files' | 'inline';
  examples: string[];
}

interface TestFinding {
  id: string;
  severity: Severity;
  category: TestCategory;
  persona?: TestPersona;
  behaviorId?: string;
  caseId?: string;
  file?: string;
  line?: number;
  snippet?: string;
  description: string;
  suggestedFix: { diff?: string; newBehaviorId?: string; rationale: string } | null;
  confidence: Confidence;
  resolution: Resolution;
}

interface TestSpec {
  version: number;
  slug: string;
  project: string;
  title: string;
  source: { plan?: { slug: string; version: number }; prUrl?: string; files: string[] };
  behaviors: Behavior[];
  conventions: ConventionFingerprint;
  model: string;
  createdAt: string;
  updatedAt: string;
  findings: TestFinding[];
}

interface TestCase {
  id: string;
  behaviorId: string;
  specSlug: string;
  specVersion: number;
  framework: Runner;
  filePath: string;
  code: string;
  runtime: 'node' | 'jsdom' | 'browser' | 'docker';
  estimatedMs: number;
}

interface TestRunResult {
  caseId: string;
  pass: boolean;
  durationMs: number;
  failure?: string;
  flakyScore?: number;
}

interface TestRun {
  id: string;
  specSlug: string;
  specVersion: number;
  trigger: 'manual' | 'pipeline' | 'post-build' | 'pr';
  startedAt: string;
  completedAt?: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  results: TestRunResult[];
  coverage?: { lines: number; branches: number; statements: number; delta?: { lines: number; branches: number } };
  mutationScore?: { score: number; killed: number; total: number; byFile: Record<string, number> };
  flakyQuarantined: string[];
  findings: TestFinding[];
  verdict: 'pass' | 'fail' | 'warn';
}

// TestRun adapted to ResolvableFinding shape so `useResolvableFinding<TestRun>` works.
// It requires `{ id, findings: ResolvableFinding[] }` structurally, which TestRun already
// satisfies (TestFinding extends ResolvableFinding via severity/resolution/confidence).

interface TestSpecPointer {
  slug: string;
  project: string;
  version: number;
  title: string;
  updatedAt: string;
}

interface PlanPointer {
  slug: string;
  project: string;
  title: string;
  updatedAt: string;
}

// ── Constants ──────────────────────────────────────────────────────────

const models = [
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4' },
  { value: 'claude-opus-4-6', label: 'Opus 4' },
  { value: 'gpt-4o', label: 'GPT-4o' },
];

const behaviorKindOrder: BehaviorKind[] = ['unit', 'integration', 'property', 'contract', 'regression', 'e2e'];

const behaviorKindConfig: Record<BehaviorKind, { label: string; color: string }> = {
  unit:        { label: 'unit',        color: 'var(--color-info, #3b82f6)' },
  integration: { label: 'integration', color: 'var(--accent)' },
  property:    { label: 'property',    color: 'var(--color-info, #3b82f6)' },
  contract:    { label: 'contract',    color: 'var(--color-warning, #f59e0b)' },
  regression:  { label: 'regression',  color: 'var(--color-error, #ef4444)' },
  e2e:         { label: 'e2e',         color: 'var(--color-warning, #f59e0b)' },
};

const priorityConfig: Record<Priority, { label: string; color: string }> = {
  critical: { label: 'critical', color: 'var(--color-error, #ef4444)' },
  normal:   { label: 'normal',   color: 'var(--text-tertiary)' },
  edge:     { label: 'edge',     color: 'var(--color-info, #3b82f6)' },
};

const categoryConfig: Record<TestCategory, { label: string; color: string }> = {
  coverage:     { label: 'coverage',   color: 'var(--color-info, #3b82f6)' },
  'edge-case':  { label: 'edge-case',  color: 'var(--color-warning, #f59e0b)' },
  security:     { label: 'security',   color: 'var(--color-error, #ef4444)' },
  perf:         { label: 'perf',       color: 'var(--color-warning, #f59e0b)' },
  flakiness:    { label: 'flakiness',  color: 'var(--color-warning, #f59e0b)' },
  convention:   { label: 'convention', color: 'var(--text-tertiary)' },
};

const personaConfig: Record<TestPersona, { label: string; icon: React.ComponentType<any> }> = {
  'test-architect':    { label: 'Architect',   icon: Layers },
  'edge-case-hunter':  { label: 'Edge cases',  icon: Shuffle },
  'security-tester':   { label: 'Security',    icon: Shield },
  'perf-tester':       { label: 'Perf',        icon: Gauge },
  'flakiness-auditor': { label: 'Flakiness',   icon: Zap },
};

const runVerdictConfig: Record<'pass' | 'fail' | 'warn', {
  label: string; color: string; background: string; border: string; icon: React.ComponentType<any>;
}> = {
  pass: {
    label: 'Passed',
    color: 'var(--color-success, #22c55e)',
    background: 'rgba(34, 197, 94, 0.08)',
    border: 'var(--color-success, #22c55e)',
    icon: CheckCircle2,
  },
  fail: {
    label: 'Failed',
    color: 'var(--color-error, #ef4444)',
    background: 'rgba(239, 68, 68, 0.08)',
    border: 'var(--color-error, #ef4444)',
    icon: XCircle,
  },
  warn: {
    label: 'Warnings',
    color: 'var(--color-warning, #f59e0b)',
    background: 'rgba(245, 158, 11, 0.08)',
    border: 'var(--color-warning, #f59e0b)',
    icon: AlertTriangle,
  },
};

type Tab = 'overview' | 'behaviors' | 'cases' | 'runs' | 'incidents';

const tabs: Array<{ id: Tab; label: string; icon?: React.ComponentType<any> }> = [
  { id: 'overview',  label: 'Overview' },
  { id: 'behaviors', label: 'Behaviors' },
  { id: 'cases',     label: 'Cases' },
  { id: 'runs',      label: 'Runs' },
  { id: 'incidents', label: 'Incidents', icon: AlertTriangle },
];

// ── Helpers ────────────────────────────────────────────────────────────

function formatTimestamp(iso: string | undefined): string {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function confidenceLabel(n: number): string {
  if (n >= 0.75) return 'high';
  if (n >= 0.45) return 'med';
  return 'low';
}

function groupBy<T, K extends string>(list: T[], keyOf: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of list) {
    const k = keyOf(item);
    (out[k] ??= []).push(item);
  }
  return out;
}

// ── Main page ──────────────────────────────────────────────────────────

export function TestSpecPage({ project, ws }: TestSpecPageProps) {
  // Spec lifecycle
  const [spec, setSpec] = useState<TestSpec | null>(null);
  const [specPointers, setSpecPointers] = useState<TestSpecPointer[]>([]);
  const [cases, setCases] = useState<TestCase[]>([]);
  const [runs, setRuns] = useState<TestRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [fingerprinting, setFingerprinting] = useState(false);
  const [runningSpec, setRunningSpec] = useState(false);

  // UI state
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [banner, setBanner] = useState<{ level: 'info' | 'error' | 'success'; message: string } | null>(null);
  const [parallelPlan, setParallelPlan] = useState<any | null>(null);
  const [staleCandidates, setStaleCandidates] = useState<any[]>([]);
  const [expandedBehaviorId, setExpandedBehaviorId] = useState<string | null>(null);
  const [expandedCaseId, setExpandedCaseId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);

  // Filters for Behaviors tab
  const [filterKind, setFilterKind] = useState<BehaviorKind | 'all'>('all');
  const [filterPriority, setFilterPriority] = useState<Priority | 'all'>('all');

  // Empty-state: plan dropdown
  const [plans, setPlans] = useState<PlanPointer[]>([]);
  const [planDropdownOpen, setPlanDropdownOpen] = useState(false);
  const planDropdownRef = useRef<HTMLDivElement>(null);

  // Resolved findings toggle (per-run expanded card)
  const [showResolved, setShowResolved] = useState(false);

  // The run currently expanded — used as the resource for useResolvableFinding.
  const expandedRun = useMemo(
    () => runs.find((r) => r.id === expandedRunId) ?? null,
    [runs, expandedRunId],
  );

  const setExpandedRunResource = useCallback(
    (updater: React.SetStateAction<TestRun | null>) => {
      setRuns((prevRuns) => {
        if (!expandedRunId) return prevRuns;
        const idx = prevRuns.findIndex((r) => r.id === expandedRunId);
        if (idx < 0) return prevRuns;
        const prev = prevRuns[idx];
        const next = typeof updater === 'function'
          ? (updater as (p: TestRun | null) => TestRun | null)(prev)
          : updater;
        if (!next) return prevRuns;
        const copy = prevRuns.slice();
        copy[idx] = next;
        return copy;
      });
    },
    [expandedRunId],
  );

  const { resolvingId, toast, resolve, undoResolve, dismissToast } = useResolvableFinding<TestRun>({
    ws,
    project,
    resource: expandedRun,
    setResource: setExpandedRunResource as unknown as React.Dispatch<React.SetStateAction<TestRun | null>>,
    resolveAction: 'resolve-test-finding',
    resolvedEvent: 'test-finding-resolved',
    resourceIdField: 'runId',
  });

  // Close plan dropdown on outside click.
  useEffect(() => {
    if (!planDropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (!planDropdownRef.current) return;
      if (!planDropdownRef.current.contains(e.target as Node)) {
        setPlanDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [planDropdownOpen]);

  // Initial fetch when project/ws is ready.
  useEffect(() => {
    if (!ws || !project) return;
    ws.send(JSON.stringify({ action: 'get-test-specs', project }));
  }, [ws, project]);

  // When spec lands, fetch cases and runs.
  useEffect(() => {
    if (!ws || !project || !spec) return;
    ws.send(JSON.stringify({
      action: 'get-test-cases', project, slug: spec.slug, version: spec.version,
    }));
    ws.send(JSON.stringify({ action: 'get-test-runs', project, slug: spec.slug }));
  }, [ws, project, spec?.slug, spec?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  // WebSocket subscription.
  useEffect(() => {
    if (!ws) return;
    const handler = (event: MessageEvent) => {
      let msg: any;
      try { msg = JSON.parse(event.data); } catch { return; }
      const p = msg?.payload ?? {};
      switch (msg.type) {
        case 'test-specs': {
          const list: TestSpecPointer[] = Array.isArray(p.specs) ? p.specs : [];
          setSpecPointers(list);
          // Auto-load the most recent spec for the current project.
          if (list.length > 0 && ws && project) {
            const first = list[0];
            ws.send(JSON.stringify({ action: 'get-test-spec', project, slug: first.slug }));
          } else {
            setSpec(null);
            setCases([]);
            setRuns([]);
          }
          break;
        }
        case 'test-spec': {
          const incoming = p.spec as TestSpec | undefined;
          if (incoming) {
            setSpec(incoming);
            setLoading(false);
            setRegenerating(false);
          }
          break;
        }
        case 'test-spec-created': {
          const incoming = p.spec as TestSpec | undefined;
          if (incoming) {
            setSpec(incoming);
            setLoading(false);
            setRegenerating(false);
            setBanner({ level: 'success', message: 'Test spec generated.' });
            setActiveTab('behaviors');
          }
          break;
        }
        case 'test-cases': {
          if (Array.isArray(p.cases)) setCases(p.cases);
          break;
        }
        case 'test-runs': {
          if (Array.isArray(p.runs)) setRuns(p.runs);
          break;
        }
        case 'test-run-started': {
          setRunningSpec(true);
          setBanner({ level: 'info', message: 'Test run started…' });
          if (p.run) {
            setRuns((prev) => [p.run as TestRun, ...prev.filter((r) => r.id !== (p.run as TestRun).id)]);
          }
          break;
        }
        case 'test-run-completed': {
          setRunningSpec(false);
          const run = p.run as TestRun | undefined;
          if (run) {
            setRuns((prev) => {
              const next = prev.filter((r) => r.id !== run.id);
              return [run, ...next];
            });
            const cfg = runVerdictConfig[run.verdict];
            setBanner({
              level: run.verdict === 'pass' ? 'success' : run.verdict === 'fail' ? 'error' : 'info',
              message: `Run ${cfg.label.toLowerCase()} · ${run.results.length} case(s).`,
            });
          }
          break;
        }
        case 'test-fingerprint': {
          setFingerprinting(false);
          if (p.conventions) {
            setSpec((prev) => prev ? { ...prev, conventions: p.conventions } : prev);
          }
          setBanner({ level: 'success', message: 'Conventions fingerprinted.' });
          break;
        }
        case 'plans': {
          // Reuse PlanPage's server event: list of plan pointers.
          if (Array.isArray(p.plans)) {
            setPlans(p.plans as PlanPointer[]);
          } else if (Array.isArray(p)) {
            setPlans(p as PlanPointer[]);
          }
          break;
        }
        case 'test-error':
        case 'test-polish-error':
        case 'test-review-error':
        case 'test-mutation-error': {
          setLoading(false);
          setRegenerating(false);
          setFingerprinting(false);
          setRunningSpec(false);
          setBanner({ level: 'error', message: p.message ?? 'Test action failed.' });
          break;
        }
        case 'test-polish-complete': {
          setBanner({
            level: 'success',
            message: `Polished ${p.polished ?? 0} case(s) · skipped ${p.skipped ?? 0} · failed ${p.failed ?? 0}.`,
          });
          // Refetch cases so the page shows the new bodies.
          if (spec && ws) {
            ws.send(JSON.stringify({ action: 'get-test-cases', project, slug: spec.slug, version: spec.version }));
          }
          break;
        }
        case 'test-review-complete': {
          const run = p.run as TestRun | undefined;
          if (run) {
            setRuns((prev) => {
              const next = prev.filter((r) => r.id !== run.id);
              return [run, ...next];
            });
          }
          setBanner({
            level: 'success',
            message: `Review complete · ${p.totalFindings ?? 0} finding(s) across personas.`,
          });
          break;
        }
        case 'test-review-persona-done': {
          setBanner({
            level: 'info',
            message: `${p.persona} · ${p.findingCount ?? 0} finding(s)`,
          });
          break;
        }
        case 'test-mutation-complete': {
          const run = p.run as TestRun | undefined;
          if (run) {
            setRuns((prev) => {
              const next = prev.filter((r) => r.id !== run.id);
              return [run, ...next];
            });
          }
          const score = p.result?.score;
          const scoreStr = score != null ? `${(score * 100).toFixed(0)}% mutation score` : p.result?.stryker?.error ?? 'unsupported';
          setBanner({ level: score != null ? 'success' : 'info', message: `Mutation: ${scoreStr}` });
          break;
        }
        case 'test-regen-complete': {
          const nextSpec = p.spec as TestSpec | undefined;
          if (nextSpec) setSpec(nextSpec);
          setBanner({ level: 'success', message: `Regen: added ${p.added ?? 0} behavior(s) for surviving mutants.` });
          break;
        }
        case 'test-contract-complete': {
          const nextSpec = p.spec as TestSpec | undefined;
          if (nextSpec) setSpec(nextSpec);
          setBanner({ level: 'success', message: `Contract tests: ${p.added ?? p.behaviors?.length ?? 0} behavior(s) added.` });
          break;
        }
        case 'test-scenarios-complete': {
          const nextSpec = p.spec as TestSpec | undefined;
          if (nextSpec) setSpec(nextSpec);
          setBanner({ level: 'success', message: `Scenarios: ${p.added ?? p.behaviors?.length ?? 0} integration behavior(s) added.` });
          break;
        }
        case 'test-flakiness-complete': {
          const run = p.run as TestRun | undefined;
          if (run) {
            setRuns((prev) => {
              const next = prev.filter((r) => r.id !== run.id);
              return [run, ...next];
            });
          }
          setBanner({ level: 'success', message: `Flakiness analysis: ${p.findings ?? 0} finding(s).` });
          break;
        }
        case 'test-checks-published': {
          const count = p.annotationsPosted ?? 0;
          const url = p.checkRunUrl ?? '';
          setBanner({ level: 'success', message: `Published ${count} annotation(s) to GitHub${url ? ` — ${url}` : ''}.` });
          break;
        }
        case 'test-spec-shared': {
          const shareUrl = p.url as string | undefined;
          if (shareUrl && typeof window !== 'undefined' && window.navigator?.clipboard) {
            window.navigator.clipboard.writeText(shareUrl).catch(() => { /* ignore */ });
          }
          setBanner({ level: 'success', message: shareUrl ? `Share link copied: ${shareUrl}` : 'Share link created.' });
          break;
        }
        case 'coverage-sla-report': {
          const r = p.report;
          if (!r) break;
          setBanner({
            level: r.pass ? 'success' : 'error',
            message: r.pass ? 'Coverage SLA: pass' : `SLA violation: ${(r.violations ?? []).join(' · ')}`,
          });
          break;
        }
        case 'test-parallel-plan': {
          const shards = p.plan?.shardCount;
          const dur = p.plan?.estimatedShardDurationMs;
          setBanner({ level: 'success', message: `Parallel plan: ${shards} shard(s), ~${Math.round((dur ?? 0) / 1000)}s worst shard.` });
          setParallelPlan(p);
          break;
        }
        case 'test-stale-candidates': {
          const count = (p.candidates ?? []).length;
          setBanner({ level: count > 0 ? 'info' : 'success', message: count > 0 ? `${count} potentially stale test(s) found.` : 'No stale tests detected.' });
          setStaleCandidates(p.candidates ?? []);
          break;
        }
        default: break;
      }
    };
    ws.addEventListener('message', handler);
    return () => ws.removeEventListener('message', handler);
  }, [ws, project, spec]);

  // ── Actions ──────────────────────────────────────────────────────────

  const handleFetchPlans = useCallback(() => {
    if (!ws || !project) return;
    ws.send(JSON.stringify({ action: 'get-plans', project }));
    setPlanDropdownOpen(true);
  }, [ws, project]);

  const handleCreateFromPlan = useCallback((planSlug: string) => {
    if (!ws || !project) return;
    setLoading(true);
    setPlanDropdownOpen(false);
    setBanner({ level: 'info', message: 'Generating test spec from plan…' });
    ws.send(JSON.stringify({
      action: 'create-test-spec-from-plan',
      project, planSlug, model,
    }));
  }, [ws, project, model]);

  const handleRegenerateBehaviors = useCallback(() => {
    if (!ws || !project || !spec) return;
    setRegenerating(true);
    setBanner({ level: 'info', message: 'Regenerating behaviors…' });
    // The server is expected to update the spec in place; we accept either the
    // `test-spec` or `test-spec-created` event as a completion signal.
    ws.send(JSON.stringify({
      action: 'create-test-spec-from-plan',
      project,
      planSlug: spec.source.plan?.slug,
      model,
      regenerate: true,
      specSlug: spec.slug,
    }));
  }, [ws, project, spec, model]);

  const handleFingerprint = useCallback(() => {
    if (!ws || !project) return;
    setFingerprinting(true);
    setBanner({ level: 'info', message: 'Fingerprinting test conventions…' });
    ws.send(JSON.stringify({ action: 'fingerprint-test-conventions', project }));
  }, [ws, project]);

  const handleRunSpec = useCallback(() => {
    if (!ws || !project || !spec) return;
    setRunningSpec(true);
    ws.send(JSON.stringify({ action: 'run-test-spec', project, slug: spec.slug }));
  }, [ws, project, spec]);

  const handlePolishSpec = useCallback(() => {
    if (!ws || !project || !spec) return;
    setBanner({ level: 'info', message: 'Polishing scaffolds with test-author…' });
    ws.send(JSON.stringify({ action: 'polish-test-spec', project, slug: spec.slug, model, concurrency: 4 }));
  }, [ws, project, spec, model]);

  const handleReviewLatestRun = useCallback(() => {
    if (!ws || !project || !spec || runs.length === 0) return;
    const latest = runs[0];
    setBanner({ level: 'info', message: 'Running 5-persona review…' });
    ws.send(JSON.stringify({
      action: 'review-test-spec',
      project,
      slug: spec.slug,
      runId: latest.id,
      personas: ['test-architect', 'edge-case-hunter', 'security-tester', 'perf-tester', 'flakiness-auditor'],
      model,
    }));
  }, [ws, project, spec, runs, model]);

  const handleMutationLatestRun = useCallback(() => {
    if (!ws || !project || !spec || runs.length === 0) return;
    const latest = runs[0];
    setBanner({ level: 'info', message: 'Running mutation testing (Stryker)…' });
    ws.send(JSON.stringify({ action: 'mutation-test-spec', project, slug: spec.slug, runId: latest.id }));
  }, [ws, project, spec, runs]);

  // Phase 3+4 actions ------------------------------------------------------
  const handleMutationRegen = useCallback(() => {
    if (!ws || !project || !spec || runs.length === 0) return;
    const latest = runs[0];
    setBanner({ level: 'info', message: 'Regenerating tests for surviving mutants…' });
    ws.send(JSON.stringify({ action: 'regenerate-mutation-tests', project, slug: spec.slug, runId: latest.id, threshold: 0.75 }));
  }, [ws, project, spec, runs]);

  const handleContractTests = useCallback(() => {
    if (!ws || !project || !spec) return;
    setBanner({ level: 'info', message: 'Scanning for OpenAPI / tRPC / GraphQL sources…' });
    ws.send(JSON.stringify({ action: 'generate-contract-tests', project, slug: spec.slug }));
  }, [ws, project, spec]);

  const handleIntegrationScenarios = useCallback(() => {
    if (!ws || !project || !spec || !spec.source.plan) return;
    setBanner({ level: 'info', message: 'Generating integration scenarios from plan…' });
    ws.send(JSON.stringify({ action: 'generate-integration-scenarios', project, slug: spec.slug, planSlug: spec.source.plan.slug }));
  }, [ws, project, spec]);

  const handleAnalyzeFlakiness = useCallback(() => {
    if (!ws || !project || !spec || runs.length === 0) return;
    const latest = runs[0];
    if (latest.flakyQuarantined.length === 0) { setBanner({ level: 'info', message: 'No flaky tests to analyze.' }); return; }
    setBanner({ level: 'info', message: `Analyzing ${latest.flakyQuarantined.length} flaky case(s)…` });
    ws.send(JSON.stringify({ action: 'analyze-flakiness', project, slug: spec.slug, runId: latest.id, model }));
  }, [ws, project, spec, runs, model]);

  const handlePublishChecks = useCallback(() => {
    if (!ws || !project || !spec || runs.length === 0) return;
    const latest = runs[0];
    const repo = window.prompt('GitHub repo (owner/name):');
    if (!repo) return;
    const headSha = window.prompt('Head SHA to attach the check to:');
    if (!headSha) return;
    setBanner({ level: 'info', message: 'Publishing check run to GitHub…' });
    ws.send(JSON.stringify({ action: 'publish-test-checks', project, slug: spec.slug, runId: latest.id, repo, headSha }));
  }, [ws, project, spec, runs]);

  const handleShareSpec = useCallback(() => {
    if (!ws || !project || !spec) return;
    ws.send(JSON.stringify({ action: 'share-test-spec', project, slug: spec.slug, httpPort: window.location.port ? Number(window.location.port) : undefined }));
  }, [ws, project, spec]);

  const handleParallelPlan = useCallback(() => {
    if (!ws || !project || !spec) return;
    setBanner({ level: 'info', message: 'Computing parallel shard plan…' });
    ws.send(JSON.stringify({ action: 'plan-parallelization', project, slug: spec.slug }));
  }, [ws, project, spec]);

  const handleDetectStale = useCallback(() => {
    if (!ws || !project || !spec) return;
    setBanner({ level: 'info', message: 'Scanning for stale tests…' });
    ws.send(JSON.stringify({ action: 'detect-stale-tests', project, slug: spec.slug }));
  }, [ws, project, spec]);

  const handleCheckSLA = useCallback(() => {
    if (!ws || !project || !spec || runs.length === 0) return;
    ws.send(JSON.stringify({ action: 'check-coverage-sla', project, slug: spec.slug, runId: runs[0].id }));
  }, [ws, project, spec, runs]);

  // ── Derived ──────────────────────────────────────────────────────────

  const behaviors = spec?.behaviors ?? [];
  const filteredBehaviors = useMemo(() => behaviors.filter((b) => {
    if (filterKind !== 'all' && b.kind !== filterKind) return false;
    if (filterPriority !== 'all' && b.priority !== filterPriority) return false;
    return true;
  }), [behaviors, filterKind, filterPriority]);

  const behaviorsByKind = useMemo(() => groupBy(filteredBehaviors, (b) => b.kind), [filteredBehaviors]);
  const casesByFile = useMemo(() => groupBy(cases, (c) => c.filePath), [cases]);

  const behaviorCountsByKind = useMemo(() => {
    const out: Partial<Record<BehaviorKind, number>> = {};
    for (const b of behaviors) out[b.kind] = (out[b.kind] ?? 0) + 1;
    return out;
  }, [behaviors]);

  const behaviorCountsByPriority = useMemo(() => {
    const out: Partial<Record<Priority, number>> = {};
    for (const b of behaviors) out[b.priority] = (out[b.priority] ?? 0) + 1;
    return out;
  }, [behaviors]);

  // ── Render ───────────────────────────────────────────────────────────

  return (
    <div className="page-enter" style={{
      padding: 'var(--space-lg)', maxWidth: 1040, margin: '0 auto',
      height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, flexShrink: 0,
      }}>
        <FlaskConical size={20} style={{ color: 'var(--accent)' }} aria-hidden="true" />
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: 0 }}>Tests</h2>
        {project && <span style={{ fontSize: 13, color: 'var(--text-tertiary)' }}>/ {project}</span>}
        {spec && (
          <span style={{
            marginLeft: 'auto',
            fontSize: 11, color: 'var(--text-tertiary)',
            padding: '2px 8px', borderRadius: 999,
            background: 'var(--bg-elevated-3)',
            display: 'inline-flex', alignItems: 'center', gap: 4,
            fontFamily: 'var(--font-mono)',
          }}>
            {spec.slug} · v{spec.version}
          </span>
        )}
      </div>

      {/* Banner */}
      {banner && (
        <BannerStrip banner={banner} onDismiss={() => setBanner(null)} />
      )}

      {/* Toast */}
      {toast && (
        <Toast
          message={toast.message}
          canUndo={toast.canUndo}
          onUndo={undoResolve}
          onDismiss={dismissToast}
        />
      )}

      {/* Main content */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0, paddingRight: 6 }}>
        {!spec && !loading && (
          <EmptyState
            hasPlans={plans.length > 0}
            plans={plans}
            plansOpen={planDropdownOpen}
            onFetchPlans={handleFetchPlans}
            onSelectPlan={handleCreateFromPlan}
            onClose={() => setPlanDropdownOpen(false)}
            dropdownRef={planDropdownRef}
            model={model}
            onModelChange={setModel}
            fingerprinting={fingerprinting}
            onFingerprint={handleFingerprint}
          />
        )}

        {loading && !spec && (
          <LoadingPanel label="Generating test spec…" />
        )}

        {spec && (
          <>
            {/* Tabs */}
            <div style={{
              display: 'flex', alignItems: 'center', gap: 4,
              marginBottom: 14,
              borderBottom: '1px solid var(--separator)',
            }}>
              {tabs.map((t) => {
                const active = activeTab === t.id;
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      height: 34, padding: '0 14px',
                      background: 'transparent', border: 'none',
                      color: active ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      fontSize: 13, fontWeight: active ? 600 : 500,
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                      borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
                      marginBottom: -1,
                    }}
                  >
                    {Icon && <Icon size={13} strokeWidth={1.75} aria-hidden="true" />}
                    {t.label}
                    {t.id === 'behaviors' && spec.behaviors.length > 0 && (
                      <TabBadge count={spec.behaviors.length} />
                    )}
                    {t.id === 'cases' && cases.length > 0 && (
                      <TabBadge count={cases.length} />
                    )}
                    {t.id === 'runs' && runs.length > 0 && (
                      <TabBadge count={runs.length} />
                    )}
                  </button>
                );
              })}

              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6 }}>
                <select
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  aria-label="Model"
                  style={{
                    appearance: 'none', height: 28, padding: '0 10px',
                    background: 'var(--bg-elevated-2)',
                    border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-sm)',
                    color: 'var(--text-secondary)',
                    fontSize: 11, fontFamily: 'var(--font-sans)',
                    cursor: 'pointer', outline: 'none',
                  }}
                >
                  {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                </select>
                <button
                  onClick={handlePolishSpec}
                  title="Replace deterministic scaffolds with LLM-authored tests"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    height: 28, padding: '0 10px',
                    fontSize: 11, fontWeight: 500,
                    background: 'transparent',
                    color: 'var(--text-secondary)',
                    border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-sm)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  Polish
                </button>
                <button
                  onClick={handleReviewLatestRun}
                  disabled={runs.length === 0}
                  title="Run 5-persona review on the latest run"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    height: 28, padding: '0 10px',
                    fontSize: 11, fontWeight: 500,
                    background: 'transparent',
                    color: runs.length === 0 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                    border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-sm)',
                    cursor: runs.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: runs.length === 0 ? 0.6 : 1,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  Review
                </button>
                <button
                  onClick={handleMutationLatestRun}
                  disabled={runs.length === 0}
                  title="Run mutation testing (Stryker) on the latest run"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    height: 28, padding: '0 10px',
                    fontSize: 11, fontWeight: 500,
                    background: 'transparent',
                    color: runs.length === 0 ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                    border: '1px solid var(--separator)',
                    borderRadius: 'var(--radius-sm)',
                    cursor: runs.length === 0 ? 'not-allowed' : 'pointer',
                    opacity: runs.length === 0 ? 0.6 : 1,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  Mutation
                </button>
                <MoreActionsMenu
                  canRegen={runs.length > 0}
                  canFlakiness={runs.length > 0}
                  canPublish={runs.length > 0}
                  canSLA={runs.length > 0}
                  canIntegration={!!spec?.source.plan}
                  onRegen={handleMutationRegen}
                  onContract={handleContractTests}
                  onIntegration={handleIntegrationScenarios}
                  onFlakiness={handleAnalyzeFlakiness}
                  onPublish={handlePublishChecks}
                  onShare={handleShareSpec}
                  onParallel={handleParallelPlan}
                  onStale={handleDetectStale}
                  onSLA={handleCheckSLA}
                />
                <button
                  onClick={handleRunSpec}
                  disabled={runningSpec}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 5,
                    height: 28, padding: '0 12px',
                    fontSize: 11, fontWeight: 600,
                    background: 'var(--accent)', color: 'var(--text-inverse)',
                    border: 'none', borderRadius: 'var(--radius-sm)',
                    cursor: runningSpec ? 'wait' : 'pointer',
                    opacity: runningSpec ? 0.7 : 1,
                    fontFamily: 'var(--font-sans)',
                  }}
                >
                  {runningSpec ? (
                    <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
                  ) : (
                    <Play size={11} strokeWidth={1.75} aria-hidden="true" />
                  )}
                  {runningSpec ? 'Running…' : 'Run spec'}
                </button>
              </div>
            </div>

            {/* Tab body */}
            {activeTab === 'overview' && (
              <OverviewTab
                spec={spec}
                countsByKind={behaviorCountsByKind}
                countsByPriority={behaviorCountsByPriority}
                fingerprinting={fingerprinting}
                onFingerprint={handleFingerprint}
                onGoToBehaviors={() => setActiveTab('behaviors')}
              />
            )}

            {activeTab === 'behaviors' && (
              <BehaviorsTab
                behaviorsByKind={behaviorsByKind as Partial<Record<BehaviorKind, Behavior[]>>}
                totalBehaviors={filteredBehaviors.length}
                rawBehaviors={behaviors.length}
                filterKind={filterKind}
                setFilterKind={setFilterKind}
                filterPriority={filterPriority}
                setFilterPriority={setFilterPriority}
                expandedId={expandedBehaviorId}
                setExpandedId={setExpandedBehaviorId}
                regenerating={regenerating}
                onRegenerate={handleRegenerateBehaviors}
              />
            )}

            {activeTab === 'cases' && (
              <CasesTab
                casesByFile={casesByFile}
                expandedId={expandedCaseId}
                setExpandedId={setExpandedCaseId}
              />
            )}

            {activeTab === 'runs' && (
              <RunsTab
                runs={runs}
                expandedRunId={expandedRunId}
                setExpandedRunId={(id) => {
                  setExpandedRunId(id);
                  setShowResolved(false);
                }}
                showResolved={showResolved}
                toggleShowResolved={() => setShowResolved((v) => !v)}
                onResolve={resolve}
                resolvingId={resolvingId}
              />
            )}

            {activeTab === 'incidents' && (
              <IncidentsPanel project={project!} ws={ws} specSlug={spec.slug} />
            )}

            <div style={{ height: 40 }} />
          </>
        )}
      </div>

      {/* Spec switcher (if multiple exist) — surfaced at bottom when not empty */}
      {specPointers.length > 1 && spec && (
        <SpecSwitcher
          pointers={specPointers}
          currentSlug={spec.slug}
          onSelect={(slug) => {
            if (!ws || !project) return;
            ws.send(JSON.stringify({ action: 'get-test-spec', project, slug }));
          }}
        />
      )}
    </div>
  );
}

// ── Banner ─────────────────────────────────────────────────────────────

function BannerStrip({ banner, onDismiss }: {
  banner: { level: 'info' | 'error' | 'success'; message: string };
  onDismiss: () => void;
}) {
  return (
    <div
      role={banner.level === 'error' ? 'alert' : 'status'}
      style={{
        marginBottom: 12, padding: '8px 12px',
        borderRadius: 'var(--radius-sm)',
        background: banner.level === 'error' ? 'rgba(239,68,68,0.10)'
          : banner.level === 'success' ? 'rgba(34,197,94,0.10)'
          : 'var(--bg-elevated-2)',
        border: `1px solid ${
          banner.level === 'error' ? 'var(--color-error, #ef4444)'
          : banner.level === 'success' ? 'var(--color-success, #22c55e)'
          : 'var(--separator)'
        }`,
        fontSize: 12,
        color: banner.level === 'error' ? 'var(--color-error, #ef4444)'
          : banner.level === 'success' ? 'var(--color-success, #22c55e)'
          : 'var(--text-secondary)',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
      }}
    >
      <span>{banner.message}</span>
      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{ background: 'transparent', border: 'none', color: 'inherit', cursor: 'pointer', fontSize: 12 }}
      >
        ×
      </button>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────

interface EmptyStateProps {
  hasPlans: boolean;
  plans: PlanPointer[];
  plansOpen: boolean;
  onFetchPlans: () => void;
  onSelectPlan: (planSlug: string) => void;
  onClose: () => void;
  dropdownRef: React.RefObject<HTMLDivElement | null>;
  model: string;
  onModelChange: (m: string) => void;
  fingerprinting: boolean;
  onFingerprint: () => void;
}

function EmptyState({
  plans, plansOpen, onFetchPlans, onSelectPlan, dropdownRef,
  model, onModelChange, fingerprinting, onFingerprint,
}: EmptyStateProps) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '64px 16px 48px',
      color: 'var(--text-tertiary)', gap: 12, textAlign: 'center',
    }}>
      <FlaskConical size={36} style={{ opacity: 0.35 }} aria-hidden="true" />
      <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text-primary)' }}>
        No test spec for this project yet.
      </div>
      <div style={{ fontSize: 12, maxWidth: 480, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        Generate one from an existing Plan, or run <code style={{
          fontFamily: 'var(--font-mono)', padding: '1px 6px', borderRadius: 3,
          background: 'var(--bg-elevated-3)', color: 'var(--text-primary)',
        }}>anvil test fingerprint</code> to scaffold.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
        <select
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          aria-label="Model"
          style={{
            appearance: 'none', height: 32, padding: '0 10px',
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--text-secondary)',
            fontSize: 12, fontFamily: 'var(--font-sans)',
            cursor: 'pointer', outline: 'none',
          }}
        >
          {models.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </select>

        <div ref={dropdownRef} style={{ position: 'relative' }}>
          <button
            onClick={onFetchPlans}
            aria-haspopup="listbox"
            aria-expanded={plansOpen}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: 32, padding: '0 14px',
              fontSize: 12, fontWeight: 600,
              background: 'var(--accent)', color: 'var(--text-inverse)',
              border: 'none', borderRadius: 'var(--radius-sm)',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}
          >
            <Plus size={12} strokeWidth={2} aria-hidden="true" />
            Generate from Plan
            <ChevronDown size={11} strokeWidth={2} aria-hidden="true" />
          </button>
          {plansOpen && (
            <div
              role="listbox"
              aria-label="Select a plan"
              style={{
                position: 'absolute', top: 38, left: 0,
                minWidth: 260, maxHeight: 260, overflowY: 'auto',
                zIndex: 10,
                background: 'var(--bg-elevated-2)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-md)',
                boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
                padding: 4,
                textAlign: 'left',
              }}
            >
              {plans.length === 0 ? (
                <div style={{
                  padding: 10, fontSize: 12, color: 'var(--text-tertiary)', textAlign: 'center',
                }}>
                  No plans found for this project.
                </div>
              ) : (
                plans.map((pl) => (
                  <button
                    key={pl.slug}
                    role="option"
                    aria-selected="false"
                    onClick={() => onSelectPlan(pl.slug)}
                    style={{
                      display: 'block', width: '100%',
                      padding: '8px 10px',
                      background: 'transparent', border: 'none',
                      color: 'var(--text-primary)',
                      fontSize: 12, fontFamily: 'var(--font-sans)',
                      cursor: 'pointer', textAlign: 'left',
                      borderRadius: 'var(--radius-sm)',
                    }}
                    onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-elevated-3)')}
                    onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                  >
                    <div style={{ fontWeight: 600 }}>{pl.title || pl.slug}</div>
                    <div style={{
                      fontSize: 10, color: 'var(--text-tertiary)',
                      fontFamily: 'var(--font-mono)', marginTop: 2,
                    }}>
                      {pl.slug}
                    </div>
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <button
          onClick={onFingerprint}
          disabled={fingerprinting}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            height: 32, padding: '0 14px',
            fontSize: 12, fontWeight: 500,
            background: 'transparent', color: 'var(--text-secondary)',
            border: '1px solid var(--separator)', borderRadius: 'var(--radius-sm)',
            cursor: fingerprinting ? 'wait' : 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          {fingerprinting ? (
            <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} aria-hidden="true" />
          ) : (
            <FileCode size={12} strokeWidth={1.75} aria-hidden="true" />
          )}
          Fingerprint conventions
        </button>
      </div>
    </div>
  );
}

// ── Overview tab ───────────────────────────────────────────────────────

function OverviewTab({
  spec, countsByKind, countsByPriority, fingerprinting, onFingerprint,
  onGoToBehaviors,
}: {
  spec: TestSpec;
  countsByKind: Partial<Record<BehaviorKind, number>>;
  countsByPriority: Partial<Record<Priority, number>>;
  fingerprinting: boolean;
  onFingerprint: () => void;
  onGoToBehaviors: () => void;
}) {
  return (
    <div>
      <Section title={spec.title || spec.slug}>
        <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: -4, marginBottom: 10 }}>
          {spec.behaviors.length} behavior{spec.behaviors.length !== 1 ? 's' : ''} · v{spec.version} · {spec.model}
        </div>

        <KeyValueList items={[
          ['Created',  formatTimestamp(spec.createdAt)],
          ['Updated',  formatTimestamp(spec.updatedAt)],
          ['Model',    spec.model],
        ]} />
      </Section>

      <Section title="Source">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {spec.source.plan ? (
            <a
              href={`#/plan?slug=${encodeURIComponent(spec.source.plan.slug)}`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 12, color: 'var(--accent)', textDecoration: 'none',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <ExternalLink size={11} strokeWidth={1.75} aria-hidden="true" />
              Plan: {spec.source.plan.slug} · v{spec.source.plan.version}
            </a>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>No linked plan.</span>
          )}
          {spec.source.prUrl && (
            <a
              href={spec.source.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 12, color: 'var(--accent)', textDecoration: 'none',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <ExternalLink size={11} strokeWidth={1.75} aria-hidden="true" />
              Source PR
            </a>
          )}
          {spec.source.files.length > 0 && (
            <div style={{ marginTop: 6 }}>
              <div style={{
                fontSize: 11, color: 'var(--text-tertiary)',
                textTransform: 'uppercase', marginBottom: 4,
              }}>
                Files ({spec.source.files.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {spec.source.files.map((f) => (
                  <span key={f} style={{
                    fontSize: 11, fontFamily: 'var(--font-mono)',
                    padding: '2px 7px', borderRadius: 999,
                    background: 'var(--bg-elevated-3)',
                    color: 'var(--text-secondary)',
                  }}>
                    {f}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </Section>

      <Section
        title="Convention fingerprint"
        right={
          <button
            onClick={onFingerprint}
            disabled={fingerprinting}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              height: 24, padding: '0 8px',
              fontSize: 11, fontWeight: 500,
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--separator)', borderRadius: 'var(--radius-sm)',
              cursor: fingerprinting ? 'wait' : 'pointer',
              fontFamily: 'var(--font-sans)',
            }}
          >
            <RefreshCw size={11} strokeWidth={2}
              style={{ animation: fingerprinting ? 'spin 1s linear infinite' : undefined }}
            />
            Re-fingerprint
          </button>
        }
      >
        <KeyValueList items={[
          ['Runner',           spec.conventions.runner],
          ['Assertion style',  spec.conventions.assertionStyle],
          ['File layout',      spec.conventions.fileLayout],
          ['Naming pattern',   spec.conventions.namingPattern || '—'],
          ['Mock style',       spec.conventions.mockStyle ?? '—'],
          ['Fixture style',    spec.conventions.fixtureStyle ?? '—'],
        ]} />
        {spec.conventions.examples.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div style={{
              fontSize: 11, color: 'var(--text-tertiary)',
              textTransform: 'uppercase', marginBottom: 4,
            }}>
              Examples
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {spec.conventions.examples.map((e, i) => (
                <span key={i} style={{
                  fontSize: 11, fontFamily: 'var(--font-mono)',
                  padding: '2px 7px', borderRadius: 999,
                  background: 'var(--bg-elevated-3)',
                  color: 'var(--text-secondary)',
                }}>
                  {e}
                </span>
              ))}
            </div>
          </div>
        )}
      </Section>

      <Section
        title="Behavior coverage"
        right={
          <button
            onClick={onGoToBehaviors}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              height: 24, padding: '0 8px',
              fontSize: 11, fontWeight: 500,
              background: 'transparent', color: 'var(--text-secondary)',
              border: '1px solid var(--separator)', borderRadius: 'var(--radius-sm)',
              cursor: 'pointer', fontFamily: 'var(--font-sans)',
            }}
          >
            View all
            <ChevronRight size={11} strokeWidth={2} aria-hidden="true" />
          </button>
        }
      >
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <div>
            <div style={{
              fontSize: 11, color: 'var(--text-tertiary)',
              textTransform: 'uppercase', marginBottom: 6,
            }}>
              By kind
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {behaviorKindOrder
                .filter((k) => (countsByKind[k] ?? 0) > 0)
                .map((k) => {
                  const cfg = behaviorKindConfig[k];
                  return (
                    <span key={k} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      height: 22, padding: '0 8px', borderRadius: 999,
                      fontSize: 11, fontWeight: 600,
                      color: cfg.color,
                      background: 'var(--bg-elevated-3)',
                      border: `1px solid ${cfg.color}`,
                    }}>
                      <span>{cfg.label}</span>
                      <span style={{ color: 'var(--text-tertiary)' }}>{countsByKind[k]}</span>
                    </span>
                  );
                })}
              {behaviors_totalOrNone(countsByKind) === 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
              )}
            </div>
          </div>

          <div>
            <div style={{
              fontSize: 11, color: 'var(--text-tertiary)',
              textTransform: 'uppercase', marginBottom: 6,
            }}>
              By priority
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {(['critical', 'normal', 'edge'] as Priority[])
                .filter((p) => (countsByPriority[p] ?? 0) > 0)
                .map((p) => {
                  const cfg = priorityConfig[p];
                  return (
                    <span key={p} style={{
                      display: 'inline-flex', alignItems: 'center', gap: 6,
                      height: 22, padding: '0 8px', borderRadius: 999,
                      fontSize: 11, fontWeight: 600,
                      color: 'var(--text-secondary)',
                      background: 'var(--bg-elevated-3)',
                      border: '1px solid var(--separator)',
                    }}>
                      <span style={{
                        width: 7, height: 7, borderRadius: 999,
                        background: cfg.color, display: 'inline-block',
                      }} />
                      <span>{cfg.label}</span>
                      <span style={{ color: 'var(--text-tertiary)' }}>{countsByPriority[p]}</span>
                    </span>
                  );
                })}
              {behaviors_totalOrNone(countsByPriority) === 0 && (
                <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>—</span>
              )}
            </div>
          </div>
        </div>
      </Section>
    </div>
  );
}

function behaviors_totalOrNone(counts: Partial<Record<string, number>>): number {
  let total = 0;
  for (const v of Object.values(counts)) total += v ?? 0;
  return total;
}

// ── Behaviors tab ──────────────────────────────────────────────────────

function BehaviorsTab({
  behaviorsByKind, totalBehaviors, rawBehaviors,
  filterKind, setFilterKind, filterPriority, setFilterPriority,
  expandedId, setExpandedId,
  regenerating, onRegenerate,
}: {
  behaviorsByKind: Partial<Record<BehaviorKind, Behavior[]>>;
  totalBehaviors: number;
  rawBehaviors: number;
  filterKind: BehaviorKind | 'all';
  setFilterKind: (k: BehaviorKind | 'all') => void;
  filterPriority: Priority | 'all';
  setFilterPriority: (p: Priority | 'all') => void;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
  regenerating: boolean;
  onRegenerate: () => void;
}) {
  return (
    <div>
      {/* Filter bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 12, flexWrap: 'wrap',
      }}>
        <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>Filter:</span>
        <FilterSelect
          label="Kind"
          value={filterKind}
          onChange={(v) => setFilterKind(v as BehaviorKind | 'all')}
          options={[
            { value: 'all', label: 'all' },
            ...behaviorKindOrder.map((k) => ({ value: k, label: behaviorKindConfig[k].label })),
          ]}
        />
        <FilterSelect
          label="Priority"
          value={filterPriority}
          onChange={(v) => setFilterPriority(v as Priority | 'all')}
          options={[
            { value: 'all', label: 'all' },
            { value: 'critical', label: 'critical' },
            { value: 'normal', label: 'normal' },
            { value: 'edge', label: 'edge' },
          ]}
        />
        <span style={{
          fontSize: 11, color: 'var(--text-tertiary)', marginLeft: 6,
        }}>
          {totalBehaviors} / {rawBehaviors} shown
        </span>

        <button
          onClick={onRegenerate}
          disabled={regenerating}
          style={{
            marginLeft: 'auto',
            display: 'inline-flex', alignItems: 'center', gap: 5,
            height: 26, padding: '0 10px',
            fontSize: 11, fontWeight: 500,
            background: 'transparent', color: 'var(--text-secondary)',
            border: '1px solid var(--separator)', borderRadius: 'var(--radius-sm)',
            cursor: regenerating ? 'wait' : 'pointer',
            fontFamily: 'var(--font-sans)',
          }}
        >
          <RefreshCw size={11} strokeWidth={2}
            style={{ animation: regenerating ? 'spin 1s linear infinite' : undefined }}
          />
          {regenerating ? 'Regenerating…' : 'Regenerate behaviors'}
        </button>
      </div>

      {totalBehaviors === 0 && (
        <div style={{
          padding: 24, textAlign: 'center',
          fontSize: 13, color: 'var(--text-tertiary)',
          background: 'var(--bg-elevated-2)',
          border: '1px dashed var(--separator)',
          borderRadius: 'var(--radius-md)',
        }}>
          No behaviors match the current filter.
        </div>
      )}

      {behaviorKindOrder
        .filter((k) => (behaviorsByKind[k] ?? []).length > 0)
        .map((kind) => {
          const cfg = behaviorKindConfig[kind];
          const list = behaviorsByKind[kind]!;
          return (
            <section key={kind} style={{ marginBottom: 14 }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '6px 4px', marginBottom: 6,
              }}>
                <span style={{
                  width: 8, height: 8, borderRadius: 999,
                  background: cfg.color, flexShrink: 0,
                }} />
                <span style={{
                  fontSize: 12, fontWeight: 600,
                  color: 'var(--text-primary)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.5,
                }}>
                  {cfg.label}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                  {list.length}
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {list.map((b) => (
                  <BehaviorRow
                    key={b.id}
                    behavior={b}
                    expanded={expandedId === b.id}
                    onToggle={() => setExpandedId(expandedId === b.id ? null : b.id)}
                  />
                ))}
              </div>
            </section>
          );
        })}
    </div>
  );
}

function BehaviorRow({ behavior, expanded, onToggle }: {
  behavior: Behavior;
  expanded: boolean;
  onToggle: () => void;
}) {
  const priCfg = priorityConfig[behavior.priority];
  const confLabel = confidenceLabel(behavior.ground.confidence);
  return (
    <article
      style={{
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', padding: '10px 12px',
          background: 'transparent', border: 'none',
          color: 'var(--text-primary)',
          fontSize: 13,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span
          title={`Priority: ${priCfg.label}`}
          style={{
            width: 8, height: 8, borderRadius: 999,
            background: priCfg.color, flexShrink: 0,
          }}
        />
        <span style={{ flex: 1, minWidth: 0, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {behavior.intent}
        </span>
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-secondary)',
          whiteSpace: 'nowrap',
        }}>
          {behavior.target.file}
          <span style={{ color: 'var(--text-tertiary)' }}>:{behavior.target.symbol}</span>
        </span>
        <span
          title={`Ground confidence: ${(behavior.ground.confidence * 100).toFixed(0)}% (${confLabel})`}
          style={{
            width: 10, height: 10, borderRadius: 999,
            background: confLabel === 'high'
              ? 'var(--text-secondary)'
              : 'transparent',
            border: confLabel === 'med'
              ? '1.5px solid var(--text-secondary)'
              : confLabel === 'low'
              ? '1.5px dashed var(--text-tertiary)'
              : 'none',
            flexShrink: 0,
          }}
        />
      </button>

      {expanded && (
        <div style={{
          padding: '4px 14px 14px 32px',
          borderTop: '1px dashed var(--separator)',
          display: 'flex', flexDirection: 'column', gap: 10,
          fontSize: 12, color: 'var(--text-secondary)',
        }}>
          <DetailRow label="Preconditions">
            {behavior.preconditions.length === 0
              ? <span style={{ color: 'var(--text-tertiary)' }}>none</span>
              : (
                <ul style={{ listStyle: 'disc', paddingLeft: 18, margin: 0 }}>
                  {behavior.preconditions.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              )}
          </DetailRow>
          <DetailRow label="Inputs">
            <div>{behavior.inputs.description}</div>
            {behavior.inputs.generator && (
              <div style={{ marginTop: 4, fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-tertiary)' }}>
                generator: {behavior.inputs.generator}
              </div>
            )}
            {behavior.inputs.samples && behavior.inputs.samples.length > 0 && (
              <pre style={{
                margin: '6px 0 0', padding: '6px 8px',
                background: 'var(--bg-base)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 11, fontFamily: 'var(--font-mono)',
                color: 'var(--text-secondary)',
                overflowX: 'auto',
              }}>
                {JSON.stringify(behavior.inputs.samples, null, 2)}
              </pre>
            )}
          </DetailRow>
          <DetailRow label="Expected">
            <div>{behavior.expected.description}</div>
            {behavior.expected.assertion && (
              <pre style={{
                margin: '6px 0 0', padding: '6px 8px',
                background: 'var(--bg-base)',
                border: '1px solid var(--separator)',
                borderRadius: 'var(--radius-sm)',
                fontSize: 11, fontFamily: 'var(--font-mono)',
                color: 'var(--text-secondary)',
                overflowX: 'auto',
              }}>
                {behavior.expected.assertion}
              </pre>
            )}
          </DetailRow>
          <DetailRow label="Ground">
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <span>Confidence: <strong style={{ color: 'var(--text-primary)' }}>
                {(behavior.ground.confidence * 100).toFixed(0)}%
              </strong> ({confLabel})</span>
              <span>Files: {behavior.ground.files.length}</span>
              <span>Types: {behavior.ground.typesSeen.length}</span>
            </div>
            {behavior.ground.files.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                {behavior.ground.files.map((f) => (
                  <span key={f} style={{
                    fontSize: 11, fontFamily: 'var(--font-mono)',
                    padding: '2px 7px', borderRadius: 999,
                    background: 'var(--bg-elevated-3)',
                    color: 'var(--text-secondary)',
                  }}>
                    {f}
                  </span>
                ))}
              </div>
            )}
          </DetailRow>
          {(behavior.linkedFindingId || behavior.linkedIncidentId) && (
            <DetailRow label="Linked">
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {behavior.linkedFindingId && (
                  <Pill color="var(--accent)" border="1px solid var(--accent)" bg="transparent" mono>
                    finding:{behavior.linkedFindingId.slice(0, 8)}
                  </Pill>
                )}
                {behavior.linkedIncidentId && (
                  <Pill color="var(--color-error, #ef4444)" border="1px solid var(--color-error, #ef4444)" bg="transparent" mono>
                    incident:{behavior.linkedIncidentId.slice(0, 8)}
                  </Pill>
                )}
              </div>
            </DetailRow>
          )}
        </div>
      )}
    </article>
  );
}

// ── Cases tab ──────────────────────────────────────────────────────────

function CasesTab({
  casesByFile, expandedId, setExpandedId,
}: {
  casesByFile: Record<string, TestCase[]>;
  expandedId: string | null;
  setExpandedId: (id: string | null) => void;
}) {
  const files = Object.keys(casesByFile).sort();
  if (files.length === 0) {
    return (
      <div style={{
        padding: 24, textAlign: 'center',
        fontSize: 13, color: 'var(--text-tertiary)',
        background: 'var(--bg-elevated-2)',
        border: '1px dashed var(--separator)',
        borderRadius: 'var(--radius-md)',
      }}>
        No test cases yet. Run the spec to materialise cases.
      </div>
    );
  }

  return (
    <div>
      {files.map((file) => {
        const list = casesByFile[file];
        const totalMs = list.reduce((acc, c) => acc + c.estimatedMs, 0);
        return (
          <section key={file} style={{ marginBottom: 14 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 4px', marginBottom: 6,
            }}>
              <FileCode size={12} style={{ color: 'var(--text-tertiary)' }} aria-hidden="true" />
              <span style={{
                fontSize: 12, fontWeight: 600,
                color: 'var(--text-primary)',
                fontFamily: 'var(--font-mono)',
              }}>
                {file}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {list.length} case{list.length !== 1 ? 's' : ''} · ~{totalMs} ms
              </span>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {list.map((c) => (
                <CaseRow
                  key={c.id}
                  testCase={c}
                  expanded={expandedId === c.id}
                  onToggle={() => setExpandedId(expandedId === c.id ? null : c.id)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function CaseRow({ testCase, expanded, onToggle }: {
  testCase: TestCase;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <article
      style={{
        background: 'var(--bg-elevated-2)',
        border: '1px solid var(--separator)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden',
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', padding: '10px 12px',
          background: 'transparent', border: 'none',
          color: 'var(--text-primary)',
          fontSize: 12,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-tertiary)',
          minWidth: 60,
        }}>
          {testCase.id.slice(0, 10)}
        </span>
        <Pill>{testCase.framework}</Pill>
        <Pill color="var(--text-secondary)">{testCase.runtime}</Pill>
        <span style={{ marginLeft: 'auto',
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-tertiary)',
        }}>
          ~{testCase.estimatedMs} ms
        </span>
      </button>

      {expanded && (
        <pre style={{
          margin: 0, padding: '10px 14px',
          background: 'var(--bg-base)',
          borderTop: '1px dashed var(--separator)',
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: 'var(--text-secondary)',
          lineHeight: 1.5,
          whiteSpace: 'pre',
          overflowX: 'auto',
        }}>
          {testCase.code}
        </pre>
      )}
    </article>
  );
}

// ── Runs tab ───────────────────────────────────────────────────────────

function RunsTab({
  runs, expandedRunId, setExpandedRunId,
  showResolved, toggleShowResolved,
  onResolve, resolvingId,
}: {
  runs: TestRun[];
  expandedRunId: string | null;
  setExpandedRunId: (id: string | null) => void;
  showResolved: boolean;
  toggleShowResolved: () => void;
  onResolve: (findingId: string, resolution: Exclude<Resolution, 'pending'>) => void;
  resolvingId: string | null;
}) {
  if (runs.length === 0) {
    return (
      <div style={{
        padding: 24, textAlign: 'center',
        fontSize: 13, color: 'var(--text-tertiary)',
        background: 'var(--bg-elevated-2)',
        border: '1px dashed var(--separator)',
        borderRadius: 'var(--radius-md)',
      }}>
        No runs yet. Press <strong style={{ color: 'var(--text-secondary)' }}>Run spec</strong> above
        to execute this test spec.
      </div>
    );
  }

  const sorted = runs.slice().sort((a, b) =>
    (b.startedAt ?? '').localeCompare(a.startedAt ?? ''),
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {sorted.map((run) => (
        <RunRow
          key={run.id}
          run={run}
          expanded={expandedRunId === run.id}
          onToggle={() => setExpandedRunId(expandedRunId === run.id ? null : run.id)}
          showResolved={showResolved}
          toggleShowResolved={toggleShowResolved}
          onResolve={onResolve}
          resolvingId={resolvingId}
        />
      ))}
    </div>
  );
}

function RunRow({
  run, expanded, onToggle,
  showResolved, toggleShowResolved,
  onResolve, resolvingId,
}: {
  run: TestRun;
  expanded: boolean;
  onToggle: () => void;
  showResolved: boolean;
  toggleShowResolved: () => void;
  onResolve: (findingId: string, resolution: Exclude<Resolution, 'pending'>) => void;
  resolvingId: string | null;
}) {
  const verdictCfg = runVerdictConfig[run.verdict];
  const VerdictIcon = verdictCfg.icon;
  const durationMs = run.results.reduce((acc, r) => acc + r.durationMs, 0);
  const passCount = run.results.filter((r) => r.pass).length;
  const failCount = run.results.length - passCount;

  return (
    <article style={{
      background: 'var(--bg-elevated-2)',
      border: `1px solid ${run.status === 'running' ? 'var(--accent)' : 'var(--separator)'}`,
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden',
    }}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          display: 'flex', alignItems: 'center', gap: 10,
          width: '100%', padding: '10px 12px',
          background: 'transparent', border: 'none',
          color: 'var(--text-primary)',
          fontSize: 12,
          cursor: 'pointer',
          textAlign: 'left',
          fontFamily: 'var(--font-sans)',
        }}
      >
        {expanded ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
        <VerdictIcon size={14} style={{ color: verdictCfg.color }} aria-hidden="true" />
        <span style={{
          padding: '2px 8px', borderRadius: 999,
          fontSize: 10, fontWeight: 600,
          color: verdictCfg.color,
          background: verdictCfg.background,
          border: `1px solid ${verdictCfg.border}`,
          textTransform: 'uppercase',
          letterSpacing: 0.3,
        }}>
          {run.status === 'running' ? 'running' : verdictCfg.label}
        </span>

        <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
          {passCount}/{run.results.length} pass
          {failCount > 0 && <span style={{ color: 'var(--color-error, #ef4444)' }}> · {failCount} fail</span>}
        </span>

        {run.coverage && (
          <span
            title={`Lines ${run.coverage.lines.toFixed(1)}% / Branches ${run.coverage.branches.toFixed(1)}%`}
            style={{
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
            }}
          >
            cov {run.coverage.lines.toFixed(0)}%
            {run.coverage.delta && (
              <span style={{
                color: run.coverage.delta.lines >= 0
                  ? 'var(--color-success, #22c55e)'
                  : 'var(--color-error, #ef4444)',
                marginLeft: 3,
              }}>
                {run.coverage.delta.lines >= 0 ? '+' : ''}
                {run.coverage.delta.lines.toFixed(1)}
              </span>
            )}
          </span>
        )}

        {run.mutationScore && (
          <span
            title={`Mutation: ${run.mutationScore.killed}/${run.mutationScore.total}`}
            style={{
              fontSize: 11, fontFamily: 'var(--font-mono)',
              color: 'var(--text-secondary)',
            }}
          >
            mut {Math.round(run.mutationScore.score * 100)}%
          </span>
        )}

        <span style={{
          marginLeft: 'auto',
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: 11, color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
        }}>
          <Clock size={10} aria-hidden="true" />
          {durationMs} ms
        </span>

        <span style={{
          fontSize: 11, color: 'var(--text-tertiary)',
          fontFamily: 'var(--font-mono)',
        }}>
          {formatTimestamp(run.startedAt)}
        </span>
      </button>

      {expanded && (
        <div style={{
          padding: '10px 14px',
          borderTop: '1px dashed var(--separator)',
          display: 'flex', flexDirection: 'column', gap: 12,
        }}>
          {/* Per-case heatmap */}
          <RunHeatmap results={run.results} />

          {/* Spawn error — runner never launched */}
          {run.spawnError && (
            <div style={{
              padding: '8px 10px',
              borderRadius: 'var(--radius-sm)',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.35)',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-error, #ef4444)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              <div style={{
                fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                textTransform: 'uppercase', marginBottom: 4,
                color: 'var(--color-error, #ef4444)',
                fontFamily: 'var(--font-sans)',
              }}>
                Runner error
              </div>
              {run.spawnError}
            </div>
          )}

          {/* Per-case failure details */}
          <RunFailures results={run.results} />

          {/* Runner output (stdout/stderr tail) */}
          {run.rawOutput && <RunnerOutput text={run.rawOutput} />}

          {/* Quarantined list */}
          {run.flakyQuarantined.length > 0 && (
            <div>
              <div style={{
                fontSize: 11, color: 'var(--text-tertiary)',
                textTransform: 'uppercase', marginBottom: 4,
              }}>
                Quarantined ({run.flakyQuarantined.length})
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {run.flakyQuarantined.map((caseId) => (
                  <span key={caseId} style={{
                    fontSize: 11, fontFamily: 'var(--font-mono)',
                    padding: '2px 7px', borderRadius: 999,
                    background: 'rgba(245,158,11,0.12)',
                    color: 'var(--color-warning, #f59e0b)',
                    border: '1px solid rgba(245,158,11,0.35)',
                  }}>
                    {caseId.slice(0, 10)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Findings */}
          <RunFindings
            run={run}
            showResolved={showResolved}
            toggleShowResolved={toggleShowResolved}
            onResolve={onResolve}
            resolvingId={resolvingId}
          />
        </div>
      )}
    </article>
  );
}

function RunHeatmap({ results }: { results: TestRunResult[] }) {
  if (results.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
        No case results.
      </div>
    );
  }
  return (
    <div>
      <div style={{
        fontSize: 11, color: 'var(--text-tertiary)',
        textTransform: 'uppercase', marginBottom: 4,
      }}>
        Cases ({results.length})
      </div>
      <div
        role="list"
        aria-label="Case results"
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 3,
        }}
      >
        {results.map((r) => {
          const color = !r.pass
            ? 'var(--color-error, #ef4444)'
            : (r.flakyScore ?? 0) >= 0.3
            ? 'var(--color-warning, #f59e0b)'
            : 'var(--color-success, #22c55e)';
          const title = `${r.caseId} · ${r.pass ? 'pass' : 'fail'} · ${r.durationMs} ms`
            + (r.flakyScore != null ? ` · flaky ${(r.flakyScore * 100).toFixed(0)}%` : '')
            + (r.failure ? `\n${r.failure}` : '');
          return (
            <span
              key={r.caseId}
              role="listitem"
              title={title}
              style={{
                width: 12, height: 12, borderRadius: 3,
                background: color,
                flexShrink: 0,
                opacity: r.flakyScore != null && r.flakyScore > 0 ? 0.8 : 1,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

function RunFailures({ results }: { results: TestRunResult[] }) {
  const failing = results.filter((r) => !r.pass && r.failure);
  if (failing.length === 0) return null;
  return (
    <div>
      <div style={{
        fontSize: 11, color: 'var(--text-tertiary)',
        textTransform: 'uppercase', marginBottom: 4,
      }}>
        Failures ({failing.length})
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {failing.map((r) => (
          <details
            key={r.caseId}
            style={{
              background: 'var(--bg-elevated-1)',
              border: '1px solid var(--separator)',
              borderRadius: 'var(--radius-sm)',
              padding: '6px 10px',
              fontSize: 12,
            }}
          >
            <summary style={{
              cursor: 'pointer',
              fontFamily: 'var(--font-mono)',
              color: 'var(--color-error, #ef4444)',
              listStyle: 'revert',
            }}>
              {r.caseId}
              <span style={{ color: 'var(--text-tertiary)', marginLeft: 8 }}>
                {r.durationMs} ms
              </span>
            </summary>
            <pre style={{
              marginTop: 6, marginBottom: 0,
              padding: '6px 8px',
              background: 'var(--bg-base)',
              borderRadius: 'var(--radius-xs, 3px)',
              fontFamily: 'var(--font-mono)',
              fontSize: 11,
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 220,
              overflow: 'auto',
            }}>{r.failure}</pre>
          </details>
        ))}
      </div>
    </div>
  );
}

function RunnerOutput({ text }: { text: string }) {
  return (
    <details style={{
      background: 'var(--bg-elevated-1)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-sm)',
      padding: '6px 10px',
      fontSize: 12,
    }}>
      <summary style={{
        cursor: 'pointer',
        fontSize: 11, fontWeight: 600, letterSpacing: 0.3,
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
        listStyle: 'revert',
      }}>
        Runner output
      </summary>
      <pre style={{
        marginTop: 6, marginBottom: 0,
        padding: '6px 8px',
        background: 'var(--bg-base)',
        borderRadius: 'var(--radius-xs, 3px)',
        fontFamily: 'var(--font-mono)',
        fontSize: 11,
        color: 'var(--text-secondary)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: 320,
        overflow: 'auto',
      }}>{text}</pre>
    </details>
  );
}

function RunFindings({
  run, showResolved, toggleShowResolved,
  onResolve, resolvingId,
}: {
  run: TestRun;
  showResolved: boolean;
  toggleShowResolved: () => void;
  onResolve: (findingId: string, resolution: Exclude<Resolution, 'pending'>) => void;
  resolvingId: string | null;
}) {
  const groups: FindingGroup<TestFinding>[] = useMemo(() => {
    const order: TestCategory[] = ['security', 'edge-case', 'flakiness', 'perf', 'coverage', 'convention'];
    const grouped: Partial<Record<TestCategory, TestFinding[]>> = {};
    for (const f of run.findings) {
      if (!showResolved && f.resolution !== 'pending') continue;
      (grouped[f.category] ??= []).push(f);
    }
    return order
      .filter((c) => grouped[c]?.length)
      .map((c) => {
        const cfg = categoryConfig[c];
        return {
          key: c,
          label: cfg.label,
          color: cfg.color,
          findings: grouped[c]!,
        };
      });
  }, [run.findings, showResolved]);

  const resolvedCount = useMemo(() => {
    const counts = { addressed: 0, dismissed: 0, 'wont-fix': 0, total: 0 };
    for (const f of run.findings) {
      if (f.resolution === 'pending') continue;
      counts[f.resolution as 'addressed' | 'dismissed' | 'wont-fix']++;
      counts.total++;
    }
    return counts;
  }, [run.findings]);

  const renderCategoryPill = useCallback((f: TestFinding) => {
    const cfg = categoryConfig[f.category];
    return (
      <Pill color={cfg.color} border={`1px solid ${cfg.color}`} bg="transparent">
        {cfg.label}
      </Pill>
    );
  }, []);

  const renderPersonaPill = useCallback((f: TestFinding) => {
    if (!f.persona) return null;
    const cfg = personaConfig[f.persona];
    const Icon = cfg.icon;
    return (
      <Pill>
        <Icon size={10} strokeWidth={1.75} aria-hidden="true" />
        {cfg.label}
      </Pill>
    );
  }, []);

  const renderLocationTag = useCallback((f: TestFinding) => {
    if (!f.file) return null;
    return (
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 11,
        color: 'var(--text-secondary)',
      }}>
        {f.file}
        {f.line != null && <span style={{ color: 'var(--text-tertiary)' }}>:{f.line}</span>}
      </span>
    );
  }, []);

  return (
    <div>
      <div style={{
        fontSize: 11, color: 'var(--text-tertiary)',
        textTransform: 'uppercase', marginBottom: 6,
      }}>
        Findings
      </div>
      <FindingList<TestFinding>
        groups={groups}
        emptyMessage="No findings from test personas — looks clean."
        resolvedCount={resolvedCount}
        showResolved={showResolved}
        onToggleShowResolved={toggleShowResolved}
        onResolve={onResolve}
        resolvingId={resolvingId}
        renderCategoryPill={renderCategoryPill}
        renderPersonaPill={renderPersonaPill}
        renderLocationTag={renderLocationTag}
      />
    </div>
  );
}

// ── Spec switcher ──────────────────────────────────────────────────────

function SpecSwitcher({
  pointers, currentSlug, onSelect,
}: {
  pointers: TestSpecPointer[];
  currentSlug: string;
  onSelect: (slug: string) => void;
}) {
  return (
    <div style={{
      flexShrink: 0,
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '8px 0 0',
      borderTop: '1px solid var(--separator)',
      marginTop: 8,
    }}>
      <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
        Other specs:
      </span>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {pointers.map((pt) => {
          const active = pt.slug === currentSlug;
          return (
            <button
              key={pt.slug}
              onClick={() => onSelect(pt.slug)}
              disabled={active}
              style={{
                fontSize: 11, fontFamily: 'var(--font-mono)',
                padding: '3px 9px', borderRadius: 999,
                background: active ? 'var(--accent)' : 'var(--bg-elevated-3)',
                color: active ? 'var(--text-inverse)' : 'var(--text-secondary)',
                border: 'none',
                cursor: active ? 'default' : 'pointer',
              }}
            >
              {pt.slug} v{pt.version}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Small presentational helpers ───────────────────────────────────────

function Section({ title, right, children }: {
  title: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
      padding: '14px 16px',
      marginBottom: 12,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        marginBottom: 10,
      }}>
        <h3 style={{ fontSize: 14, fontWeight: 600, margin: 0, color: 'var(--text-primary)' }}>
          {title}
        </h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function KeyValueList({ items }: { items: Array<[string, string | number]> }) {
  return (
    <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontSize: 13, color: 'var(--text-secondary)' }}>
      {items.map(([k, v]) => (
        <li key={k} style={{ display: 'flex', gap: 8, margin: '3px 0' }}>
          <span style={{ color: 'var(--text-tertiary)', minWidth: 120 }}>{k}</span>
          <span style={{ color: 'var(--text-primary)', fontFamily: typeof v === 'string' && /^[a-z0-9_\-./]+$/i.test(v) ? 'var(--font-mono)' : 'var(--font-sans)' }}>
            {v}
          </span>
        </li>
      ))}
    </ul>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{
        fontSize: 10, color: 'var(--text-tertiary)',
        textTransform: 'uppercase', letterSpacing: 0.3,
        marginBottom: 3, fontWeight: 600,
      }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        {children}
      </div>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
}) {
  return (
    <label style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      fontSize: 11, color: 'var(--text-tertiary)',
    }}>
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          appearance: 'none', height: 24, padding: '0 8px',
          background: 'var(--bg-elevated-2)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-sm)',
          color: 'var(--text-secondary)',
          fontSize: 11, fontFamily: 'var(--font-sans)',
          cursor: 'pointer', outline: 'none',
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

function TabBadge({ count }: { count: number }) {
  return (
    <span style={{
      fontSize: 10, fontWeight: 600,
      padding: '1px 6px', borderRadius: 999,
      background: 'var(--bg-elevated-3)',
      color: 'var(--text-tertiary)',
    }}>
      {count}
    </span>
  );
}

// ── Loading ────────────────────────────────────────────────────────────

function LoadingPanel({ label }: { label: string }) {
  return (
    <div style={{
      padding: '32px 16px',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
      fontSize: 13, color: 'var(--text-secondary)',
    }}>
      <Loader2 size={14} style={{ animation: 'spin 1s linear infinite', color: 'var(--accent)' }} aria-hidden="true" />
      {label}
    </div>
  );
}

// Phase 3+4 overflow menu — compact three-dot popover so the toolbar stays sane.
function MoreActionsMenu(props: {
  canRegen: boolean;
  canFlakiness: boolean;
  canPublish: boolean;
  canSLA: boolean;
  canIntegration: boolean;
  onRegen: () => void;
  onContract: () => void;
  onIntegration: () => void;
  onFlakiness: () => void;
  onPublish: () => void;
  onShare: () => void;
  onParallel: () => void;
  onStale: () => void;
  onSLA: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const itemStyle: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8,
    width: '100%', padding: '6px 10px',
    background: 'transparent', border: 'none',
    color: 'var(--text-secondary)',
    fontSize: 12, fontFamily: 'var(--font-sans)',
    textAlign: 'left', cursor: 'pointer',
  };
  const disabledStyle: React.CSSProperties = { color: 'var(--text-tertiary)', cursor: 'not-allowed' };

  const click = (fn: () => void, enabled = true) => () => {
    if (!enabled) return;
    setOpen(false);
    fn();
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          height: 28, padding: '0 10px',
          fontSize: 11, fontWeight: 500,
          background: 'transparent',
          color: 'var(--text-secondary)',
          border: '1px solid var(--separator)',
          borderRadius: 'var(--radius-sm)',
          cursor: 'pointer',
          fontFamily: 'var(--font-sans)',
        }}
      >
        More
        <ChevronDown size={11} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: 32, right: 0,
            minWidth: 220, zIndex: 20,
            background: 'var(--bg-elevated-2)',
            border: '1px solid var(--separator)',
            borderRadius: 'var(--radius-md)',
            boxShadow: '0 8px 24px rgba(0,0,0,0.18)',
            padding: 4,
          }}
        >
          <MenuSection label="Phase 3 — Intelligence" />
          <button role="menuitem" style={{ ...itemStyle, ...(!props.canRegen ? disabledStyle : {}) }} onClick={click(props.onRegen, props.canRegen)}>
            Regenerate for surviving mutants
          </button>
          <button role="menuitem" style={itemStyle} onClick={click(props.onContract)}>
            Generate contract tests
          </button>
          <button role="menuitem" style={{ ...itemStyle, ...(!props.canIntegration ? disabledStyle : {}) }} onClick={click(props.onIntegration, props.canIntegration)}>
            Generate integration scenarios
          </button>
          <button role="menuitem" style={{ ...itemStyle, ...(!props.canFlakiness ? disabledStyle : {}) }} onClick={click(props.onFlakiness, props.canFlakiness)}>
            Analyze flakiness
          </button>
          <div style={{ height: 1, background: 'var(--separator)', margin: '4px 0' }} />
          <MenuSection label="Phase 4 — Ecosystem" />
          <button role="menuitem" style={{ ...itemStyle, ...(!props.canPublish ? disabledStyle : {}) }} onClick={click(props.onPublish, props.canPublish)}>
            Publish to GitHub Checks
          </button>
          <button role="menuitem" style={itemStyle} onClick={click(props.onShare)}>
            Share spec link
          </button>
          <button role="menuitem" style={itemStyle} onClick={click(props.onParallel)}>
            Plan CI parallelization
          </button>
          <button role="menuitem" style={itemStyle} onClick={click(props.onStale)}>
            Detect stale tests
          </button>
          <button role="menuitem" style={{ ...itemStyle, ...(!props.canSLA ? disabledStyle : {}) }} onClick={click(props.onSLA, props.canSLA)}>
            Check coverage SLA
          </button>
        </div>
      )}
    </div>
  );
}

function MenuSection({ label }: { label: string }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600,
      color: 'var(--text-tertiary)',
      textTransform: 'uppercase', letterSpacing: 0.4,
      padding: '6px 10px 4px',
    }}>
      {label}
    </div>
  );
}

export default TestSpecPage;
