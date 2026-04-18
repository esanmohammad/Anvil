/**
 * LLM-powered project graph builder.
 *
 * Assembles context from factory.yaml, per-repo graph reports, and
 * cross-repo edges, then sends a single LLM call to produce a semantic
 * understanding of the project architecture.
 *
 * The result is a ProjectGraph — stored as PROJECT_GRAPH.json and
 * PROJECT_SUMMARY.md — that agents use for cross-repo decision making.
 */

// Re-export legacy class for backward compat
export { ProjectGraphBuilder } from './project-graph-builder-legacy.js';

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execSync, execFileSync } from 'node:child_process';
import type {
  ProjectGraph,
  ProjectGraphMeta,
  ProjectGraphStatus,
  RepoRole,
  ProjectRelationship,
  KeyFlow,
  CommunityLabel,
} from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const KB_DIR = join(
  process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil'),
  'knowledge-base',
);

const PROJECT_GRAPH_FILE = 'PROJECT_GRAPH.json';
const PROJECT_SUMMARY_FILE = 'PROJECT_SUMMARY.md';

// ---------------------------------------------------------------------------
// LLM provider detection + calling
// ---------------------------------------------------------------------------

interface LLMCallResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  model: string;
  provider: string;
}

/**
 * Detect which LLM provider is available from environment variables.
 * Returns provider name and API key, preferring cheaper models.
 */
function detectProvider(preferredProvider?: string): { provider: string; apiKey: string; model: string; endpoint: string } {
  // If user specified a provider, try that first
  if (preferredProvider) {
    const found = tryProvider(preferredProvider);
    if (found) return found;
    throw new Error(`Provider "${preferredProvider}" not available. Check your API key.`);
  }

  // Auto-detect in order of preference (cost-effective first, then CLI tools)
  for (const p of ['openai', 'gemini', 'anthropic', 'openrouter', 'claude-cli', 'gemini-cli']) {
    const found = tryProvider(p);
    if (found) return found;
  }

  throw new Error(
    'No LLM provider available. Set an API key (OPENAI_API_KEY, ANTHROPIC_API_KEY, GOOGLE_API_KEY) or install claude/gemini CLI.',
  );
}

function tryProvider(name: string): { provider: string; apiKey: string; model: string; endpoint: string } | null {
  switch (name) {
    case 'openai': {
      const key = process.env.OPENAI_API_KEY;
      if (!key) return null;
      return { provider: 'openai', apiKey: key, model: 'gpt-4o-mini', endpoint: 'https://api.openai.com/v1/chat/completions' };
    }
    case 'gemini': {
      const key = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
      if (!key) return null;
      return { provider: 'gemini', apiKey: key, model: 'gemini-2.0-flash', endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}` };
    }
    case 'anthropic': {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return null;
      return { provider: 'anthropic', apiKey: key, model: 'claude-sonnet-4-20250514', endpoint: 'https://api.anthropic.com/v1/messages' };
    }
    case 'openrouter': {
      const key = process.env.OPENROUTER_API_KEY;
      if (!key) return null;
      return { provider: 'openrouter', apiKey: key, model: 'anthropic/claude-sonnet-4-20250514', endpoint: 'https://openrouter.ai/api/v1/chat/completions' };
    }
    case 'claude-cli': {
      try {
        execSync('claude --version', { stdio: 'pipe', timeout: 5000 });
        return { provider: 'claude-cli', apiKey: 'cli', model: 'claude-sonnet-4-20250514', endpoint: 'cli' };
      } catch { return null; }
    }
    case 'gemini-cli': {
      try {
        execSync('gemini --version', { stdio: 'pipe', timeout: 5000 });
        return { provider: 'gemini-cli', apiKey: 'cli', model: 'gemini-2.0-flash', endpoint: 'cli' };
      } catch { return null; }
    }
    default:
      return null;
  }
}

/**
 * Call an LLM via OpenAI-compatible API (works for OpenAI, OpenRouter)
 * or Anthropic/Gemini specific APIs.
 */
async function callLLM(
  provider: { provider: string; apiKey: string; model: string; endpoint: string },
  projectPrompt: string,
  userPrompt: string,
  modelOverride?: string,
): Promise<LLMCallResult> {
  const model = modelOverride || provider.model;

  if (provider.provider === 'claude-cli') {
    return callClaudeCli(projectPrompt, userPrompt);
  }
  if (provider.provider === 'gemini-cli') {
    return callGeminiCli(projectPrompt, userPrompt);
  }
  if (provider.provider === 'anthropic') {
    return callAnthropic(provider.apiKey, model, projectPrompt, userPrompt);
  }
  if (provider.provider === 'gemini') {
    return callGemini(provider.apiKey, model, projectPrompt, userPrompt);
  }
  // OpenAI-compatible (openai, openrouter)
  return callOpenAICompatible(provider, model, projectPrompt, userPrompt);
}

async function callOpenAICompatible(
  provider: { provider: string; apiKey: string; endpoint: string },
  model: string,
  projectPrompt: string,
  userPrompt: string,
): Promise<LLMCallResult> {
  const response = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'project', content: projectPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: 'json_object' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${provider.provider} API error (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json() as any;
  const content = json.choices?.[0]?.message?.content ?? '';
  const usage = json.usage ?? {};

  return {
    content,
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0,
    costUsd: estimateCost(provider.provider, model, usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0),
    model,
    provider: provider.provider,
  };
}

async function callAnthropic(
  apiKey: string,
  model: string,
  projectPrompt: string,
  userPrompt: string,
): Promise<LLMCallResult> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.2,
      project: projectPrompt,
      messages: [{ role: 'user', content: userPrompt + '\n\nRespond with valid JSON only.' }],
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Anthropic API error (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json() as any;
  const content = json.content?.[0]?.text ?? '';
  const usage = json.usage ?? {};

  return {
    content,
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    costUsd: estimateCost('anthropic', model, usage.input_tokens ?? 0, usage.output_tokens ?? 0),
    model,
    provider: 'anthropic',
  };
}

async function callGemini(
  apiKey: string,
  model: string,
  projectPrompt: string,
  userPrompt: string,
): Promise<LLMCallResult> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: projectPrompt + '\n\n' + userPrompt + '\n\nRespond with valid JSON only.' }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096, responseMimeType: 'application/json' },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini API error (${response.status}): ${body.slice(0, 300)}`);
  }

  const json = await response.json() as any;
  const content = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  const usage = json.usageMetadata ?? {};

  return {
    content,
    inputTokens: usage.promptTokenCount ?? 0,
    outputTokens: usage.candidatesTokenCount ?? 0,
    costUsd: estimateCost('gemini', model, usage.promptTokenCount ?? 0, usage.candidatesTokenCount ?? 0),
    model,
    provider: 'gemini',
  };
}

async function callClaudeCli(
  projectPrompt: string,
  userPrompt: string,
): Promise<LLMCallResult> {
  const fullPrompt = projectPrompt + '\n\n' + userPrompt + '\n\nRespond with valid JSON only.';

  const startTime = Date.now();
  const output = execFileSync('claude', ['-p', fullPrompt, '--output-format', 'text'], {
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const durationMs = Date.now() - startTime;
  const estimatedTokens = Math.ceil(fullPrompt.length / 4);
  const estimatedOutputTokens = Math.ceil(output.length / 4);

  return {
    content: output,
    inputTokens: estimatedTokens,
    outputTokens: estimatedOutputTokens,
    costUsd: estimateCost('anthropic', 'claude-sonnet-4-20250514', estimatedTokens, estimatedOutputTokens),
    model: 'claude-sonnet-4-20250514',
    provider: 'claude-cli',
  };
}

async function callGeminiCli(
  projectPrompt: string,
  userPrompt: string,
): Promise<LLMCallResult> {
  const fullPrompt = projectPrompt + '\n\n' + userPrompt + '\n\nRespond with valid JSON only.';

  const startTime = Date.now();
  const output = execFileSync('gemini', ['-p', fullPrompt], {
    encoding: 'utf-8',
    timeout: 120_000,
    maxBuffer: 10 * 1024 * 1024,
  });

  const durationMs = Date.now() - startTime;
  const estimatedTokens = Math.ceil(fullPrompt.length / 4);
  const estimatedOutputTokens = Math.ceil(output.length / 4);

  return {
    content: output,
    inputTokens: estimatedTokens,
    outputTokens: estimatedOutputTokens,
    costUsd: estimateCost('gemini', 'gemini-2.0-flash', estimatedTokens, estimatedOutputTokens),
    model: 'gemini-2.0-flash',
    provider: 'gemini-cli',
  };
}

function estimateCost(provider: string, model: string, inputTokens: number, outputTokens: number): number {
  // Approximate pricing per 1M tokens [input, output]
  const pricing: Record<string, [number, number]> = {
    'gpt-4o-mini': [0.15, 0.60],
    'gpt-4o': [2.50, 10.00],
    'claude-sonnet-4-20250514': [3.00, 15.00],
    'claude-haiku-4-5-20251001': [0.80, 4.00],
    'gemini-2.0-flash': [0.10, 0.40],
  };
  const [inputRate, outputRate] = pricing[model] ?? [1.00, 3.00];
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a senior software architect analyzing a multi-repo project.
Given the project definition, per-repo code analysis reports, and detected cross-repo relationships,
produce a structured JSON analysis of the project architecture.

Your analysis helps engineers understand how repos work together so they can make correct
cross-repo changes. Focus on: data flows, ownership boundaries, communication patterns,
and what breaks if a component changes.

Respond with ONLY valid JSON matching this exact structure:
{
  "architectureSummary": "2-3 paragraph overview of the project architecture",
  "repoRoles": {
    "<repo-name>": {
      "role": "one-line role description",
      "responsibilities": ["responsibility 1", "responsibility 2"],
      "ownsData": ["data owned by this repo"],
      "criticality": "high|medium|low"
    }
  },
  "communityLabels": {
    "<community-id>": {
      "label": "semantic name for this cluster",
      "description": "what this community does",
      "repos": ["repo names involved"]
    }
  },
  "relationships": [
    {
      "from": "source-repo",
      "to": "target-repo",
      "type": "sync-http|async-event|shared-db|shared-types|deploys-to|other",
      "description": "what this connection does",
      "contract": "where the contract is defined (file, schema, etc)",
      "criticality": "high|medium|low",
      "direction": "unidirectional|bidirectional"
    }
  ],
  "keyFlows": [
    {
      "name": "flow name",
      "trigger": "what starts this flow",
      "steps": [
        {
          "repo": "repo-name",
          "component": "path or module",
          "action": "what happens here",
          "protocol": "http|kafka|grpc|db|etc",
          "nextStep": "what happens next"
        }
      ],
      "failureMode": "what happens when this flow fails"
    }
  ]
}`;

/**
 * Assemble the user prompt from available project data.
 */
function assembleUserPrompt(
  factoryYaml: string,
  graphReports: Array<{ repo: string; report: string }>,
  crossRepoEdges: Array<{ source: string; target: string; type: string; evidence: string }>,
): string {
  const sections: string[] = [];

  sections.push('## Project Definition (factory.yaml)\n');
  sections.push(factoryYaml.slice(0, 4000));

  if (graphReports.length > 0) {
    sections.push('\n## Per-Repo Code Analysis Reports\n');
    for (const { repo, report } of graphReports) {
      // Truncate each report to ~800 tokens to keep total input manageable
      const truncated = report.length > 3200 ? report.slice(0, 3200) + '\n[... truncated]' : report;
      sections.push(`### ${repo}\n${truncated}\n`);
    }
  }

  if (crossRepoEdges.length > 0) {
    sections.push('\n## Detected Cross-Repo Relationships\n');
    for (const edge of crossRepoEdges.slice(0, 30)) {
      sections.push(`- ${edge.source} → ${edge.target} (${edge.type}): ${edge.evidence}`);
    }
  }

  sections.push('\n\nAnalyze this project and produce the structured JSON response.');
  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BuildProjectGraphOptions {
  provider?: string;
  model?: string;
  dryRun?: boolean;
  onProgress?: (message: string) => void;
}

/**
 * Build an LLM-powered project graph for the given project.
 */
export async function buildProjectGraph(
  project: string,
  factoryYamlPath: string,
  options?: BuildProjectGraphOptions,
): Promise<ProjectGraph> {
  const log = options?.onProgress ?? (() => {});
  const projectDir = join(KB_DIR, project);
  const startTime = Date.now();

  // 1. Read factory.yaml
  log('Reading project configuration...');
  if (!existsSync(factoryYamlPath)) {
    throw new Error(`factory.yaml not found at ${factoryYamlPath}`);
  }
  const factoryYaml = readFileSync(factoryYamlPath, 'utf-8');

  // 2. Collect per-repo graph reports
  log('Collecting per-repo graph reports...');
  const graphReports: Array<{ repo: string; report: string }> = [];
  if (existsSync(projectDir)) {
    const { readdirSync, statSync } = await import('node:fs');
    for (const entry of readdirSync(projectDir)) {
      const reportPath = join(projectDir, entry, 'GRAPH_REPORT.md');
      if (existsSync(reportPath)) {
        try {
          const report = readFileSync(reportPath, 'utf-8');
          graphReports.push({ repo: entry, report });
        } catch { /* skip unreadable */ }
      }
    }
  }

  if (graphReports.length === 0) {
    log('Warning: No per-repo graph reports found. Run "anvil index" or refresh KB first for better results.');
  }

  // 3. Collect cross-repo edges from project graph
  log('Reading cross-repo relationships...');
  const crossRepoEdges: Array<{ source: string; target: string; type: string; evidence: string }> = [];
  const projectGraphPath = join(projectDir, 'system_graph_v2.json');
  if (existsSync(projectGraphPath)) {
    try {
      const graphData = JSON.parse(readFileSync(projectGraphPath, 'utf-8'));
      // graphology export format
      const edges = graphData.edges ?? [];
      for (const e of edges) {
        if (e.attributes?.crossRepo) {
          crossRepoEdges.push({
            source: e.source,
            target: e.target,
            type: e.attributes.type ?? 'unknown',
            evidence: e.attributes.evidence ?? '',
          });
        }
      }
    } catch { /* skip */ }
  }

  // 4. Assemble prompt
  const userPrompt = assembleUserPrompt(factoryYaml, graphReports, crossRepoEdges);
  const estimatedInputTokens = Math.ceil((SYSTEM_PROMPT.length + userPrompt.length) / 4);
  log(`Assembled prompt: ~${estimatedInputTokens} input tokens`);

  if (options?.dryRun) {
    log('Dry run — not calling LLM. Prompt assembled successfully.');
    const dryGraph: ProjectGraph = {
      meta: {
        generatedAt: new Date().toISOString(),
        model: 'dry-run',
        provider: 'none',
        costUsd: 0,
        inputTokens: estimatedInputTokens,
        outputTokens: 0,
        durationMs: 0,
      },
      architectureSummary: '(dry run — no LLM call made)',
      repoRoles: {},
      communityLabels: {},
      relationships: [],
      keyFlows: [],
    };
    return dryGraph;
  }

  // 5. Detect provider and call LLM
  const providerConfig = detectProvider(options?.provider);
  log(`Using ${providerConfig.provider} (${options?.model || providerConfig.model})...`);

  const result = await callLLM(providerConfig, SYSTEM_PROMPT, userPrompt, options?.model);
  log(`LLM response: ${result.inputTokens} input, ${result.outputTokens} output tokens ($${result.costUsd.toFixed(4)})`);

  // 6. Parse response
  let parsed: any;
  try {
    // Strip markdown code fences if present
    let content = result.content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    }
    parsed = JSON.parse(content);
  } catch (err) {
    // Retry once with a nudge
    log('First response was not valid JSON. Retrying...');
    const retryResult = await callLLM(
      providerConfig,
      SYSTEM_PROMPT,
      userPrompt + '\n\nIMPORTANT: Your previous response was not valid JSON. Return ONLY the JSON object, no markdown fences or extra text.',
      options?.model,
    );
    try {
      let content = retryResult.content.trim();
      if (content.startsWith('```')) {
        content = content.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      }
      parsed = JSON.parse(content);
      result.inputTokens += retryResult.inputTokens;
      result.outputTokens += retryResult.outputTokens;
      result.costUsd += retryResult.costUsd;
    } catch {
      throw new Error(`LLM returned invalid JSON after retry: ${retryResult.content.slice(0, 200)}`);
    }
  }

  // 7. Build ProjectGraph with validated fields
  const meta: ProjectGraphMeta = {
    generatedAt: new Date().toISOString(),
    model: result.model,
    provider: result.provider,
    costUsd: result.costUsd,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    durationMs: Date.now() - startTime,
  };

  const graph: ProjectGraph = {
    meta,
    architectureSummary: parsed.architectureSummary ?? '(no summary generated)',
    repoRoles: parsed.repoRoles ?? {},
    communityLabels: parsed.communityLabels ?? {},
    relationships: Array.isArray(parsed.relationships) ? parsed.relationships : [],
    keyFlows: Array.isArray(parsed.keyFlows) ? parsed.keyFlows : [],
  };

  // 8. Save
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, PROJECT_GRAPH_FILE), JSON.stringify(graph, null, 2), 'utf-8');
  const summary = renderProjectSummary(project, graph);
  writeFileSync(join(projectDir, PROJECT_SUMMARY_FILE), summary, 'utf-8');
  log(`Saved PROJECT_GRAPH.json and PROJECT_SUMMARY.md to ${projectDir}`);

  return graph;
}

// ---------------------------------------------------------------------------
// Load existing project graph
// ---------------------------------------------------------------------------

export function loadProjectGraph(project: string): ProjectGraph | null {
  const path = join(KB_DIR, project, PROJECT_GRAPH_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
}

export function loadProjectSummary(project: string): string | null {
  const path = join(KB_DIR, project, PROJECT_SUMMARY_FILE);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

export function getProjectGraphStatus(project: string): ProjectGraphStatus {
  const graph = loadProjectGraph(project);
  if (!graph) {
    return { exists: false, generatedAt: null, model: null, costUsd: null };
  }
  return {
    exists: true,
    generatedAt: graph.meta.generatedAt,
    model: graph.meta.model,
    costUsd: graph.meta.costUsd,
  };
}

// ---------------------------------------------------------------------------
// Cost estimation (no LLM call)
// ---------------------------------------------------------------------------

export function estimateProjectGraphCost(
  project: string,
  factoryYamlPath: string,
  provider?: string,
): { estimatedInputTokens: number; estimatedOutputTokens: number; estimatedCostUsd: number; model: string; provider: string } {
  const factoryYaml = existsSync(factoryYamlPath)
    ? readFileSync(factoryYamlPath, 'utf-8')
    : '';

  const graphReports: Array<{ repo: string; report: string }> = [];
  const projectDir = join(KB_DIR, project);
  if (existsSync(projectDir)) {
    try {
      const { readdirSync } = require('node:fs');
      for (const entry of readdirSync(projectDir)) {
        const reportPath = join(projectDir, entry, 'GRAPH_REPORT.md');
        if (existsSync(reportPath)) {
          graphReports.push({ repo: entry, report: readFileSync(reportPath, 'utf-8') });
        }
      }
    } catch { /* skip */ }
  }

  const userPrompt = assembleUserPrompt(factoryYaml, graphReports, []);
  const inputTokens = Math.ceil((SYSTEM_PROMPT.length + userPrompt.length) / 4);
  const outputTokens = 2000; // Estimate ~2K output tokens

  const detected = detectProvider(provider);
  const cost = estimateCost(detected.provider, detected.model, inputTokens, outputTokens);

  return {
    estimatedInputTokens: inputTokens,
    estimatedOutputTokens: outputTokens,
    estimatedCostUsd: cost,
    model: detected.model,
    provider: detected.provider,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

export function renderProjectSummary(project: string, graph: ProjectGraph): string {
  const sections: string[] = [];

  sections.push(`# Project Graph: ${project}`);
  sections.push(`\n> Generated ${graph.meta.generatedAt} using ${graph.meta.model} ($${graph.meta.costUsd.toFixed(4)})\n`);

  // Architecture summary
  sections.push(`## Architecture\n`);
  sections.push(graph.architectureSummary);

  // Repo roles
  const repoEntries = Object.entries(graph.repoRoles);
  if (repoEntries.length > 0) {
    sections.push(`\n## Repo Roles\n`);
    for (const [repo, role] of repoEntries) {
      sections.push(`### ${repo} (${role.criticality} criticality)`);
      sections.push(`**Role:** ${role.role}\n`);
      if (role.responsibilities.length > 0) {
        sections.push('**Responsibilities:**');
        for (const r of role.responsibilities) {
          sections.push(`- ${r}`);
        }
      }
      if (role.ownsData.length > 0) {
        sections.push(`\n**Owns:** ${role.ownsData.join(', ')}`);
      }
      sections.push('');
    }
  }

  // Relationships
  if (graph.relationships.length > 0) {
    sections.push(`## Cross-Repo Relationships\n`);
    sections.push('| From | To | Type | Description | Criticality |');
    sections.push('|------|-----|------|-------------|-------------|');
    for (const rel of graph.relationships) {
      sections.push(`| ${rel.from} | ${rel.to} | ${rel.type} | ${rel.description} | ${rel.criticality} |`);
    }
  }

  // Key flows
  if (graph.keyFlows.length > 0) {
    sections.push(`\n## Key Flows\n`);
    for (const flow of graph.keyFlows) {
      sections.push(`### ${flow.name}`);
      sections.push(`**Trigger:** ${flow.trigger}\n`);
      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i];
        const arrow = i < flow.steps.length - 1 ? ' →' : '';
        sections.push(`${i + 1}. **${step.repo}** (${step.component}): ${step.action} [${step.protocol}]${arrow}`);
      }
      if (flow.failureMode) {
        sections.push(`\n**Failure mode:** ${flow.failureMode}`);
      }
      sections.push('');
    }
  }

  // Community labels
  const communities = Object.entries(graph.communityLabels);
  if (communities.length > 0) {
    sections.push(`## Module Communities\n`);
    for (const [id, community] of communities) {
      sections.push(`- **${community.label}** (${community.repos.join(', ')}): ${community.description}`);
    }
  }

  return sections.join('\n');
}

/**
 * Format project graph for injection into agent prompts.
 * Returns a compact version (~200-400 tokens) suitable for L0+L1 identity.
 */
export function formatProjectGraphForPrompt(graph: ProjectGraph): string {
  const lines: string[] = [];

  // Architecture summary (truncated)
  const summary = graph.architectureSummary.length > 600
    ? graph.architectureSummary.slice(0, 600) + '...'
    : graph.architectureSummary;
  lines.push(`Architecture: ${summary}`);

  // Repo roles (compact)
  const roles = Object.entries(graph.repoRoles);
  if (roles.length > 0) {
    lines.push('\nRepo roles:');
    for (const [repo, role] of roles) {
      const data = role.ownsData.length > 0 ? ` Owns: ${role.ownsData.join(', ')}.` : '';
      lines.push(`- ${repo}: ${role.role}${data} Criticality: ${role.criticality}.`);
    }
  }

  // Key flows (compact)
  if (graph.keyFlows.length > 0) {
    lines.push('\nKey flows:');
    for (const flow of graph.keyFlows.slice(0, 5)) {
      const path = flow.steps.map(s => s.repo).join(' → ');
      lines.push(`- ${flow.name}: ${path}`);
    }
  }

  return lines.join('\n');
}
