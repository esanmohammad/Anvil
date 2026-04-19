import type { Project } from '../project/types.js';
import type { PersonaName } from '../personas/types.js';
import { loadPersonaPrompt } from '../personas/loader.js';
import { loadConventions } from './conventions.js';
import { loadMemories } from './memories.js';
import { collectPriorArtifacts } from './artifacts.js';
import { extractProjectContext, projectContextToMarkdown } from './project-context.js';
import { loadKnowledgeGraph } from './knowledge-graph.js';
import { renderTemplate } from '../templates/renderer.js';
import { getRequiredVariables } from '../templates/variables.js';
import YAML from 'yaml';

// Byte-size guard rails for assembled context (not a model token limit — see model-catalog).
// Override with ANVIL_CONTEXT_WARN_KB / ANVIL_CONTEXT_ERROR_KB if you want different thresholds.
const WARN_SIZE = (parseInt(process.env.ANVIL_CONTEXT_WARN_KB ?? '', 10) || 400) * 1024;
const ERROR_SIZE = (parseInt(process.env.ANVIL_CONTEXT_ERROR_KB ?? '', 10) || 1200) * 1024;

export interface AssemblyResult {
  prompt: string;
  warnings: string[];
}

export async function assembleContext(
  persona: PersonaName,
  project: Project,
  runDir: string,
  featureRequest: string,
  stage?: string,
): Promise<AssemblyResult> {
  const warnings: string[] = [];

  // Load persona prompt
  const personaPrompt = await loadPersonaPrompt(persona);

  // Extract project context
  const sysContext = extractProjectContext(project);
  const sysContextMd = projectContextToMarkdown(sysContext);

  // Load conventions
  let conventions = '';
  try {
    conventions = await loadConventions(project.project);
  } catch { /* ok if missing */ }

  // Load memories
  let memories = '';
  try {
    const mems = await loadMemories(project.project);
    if (mems.length > 0) {
      memories = mems.map(m => `- [${m.type}] ${m.content}`).join('\n');
    }
  } catch { /* ok if missing */ }

  // Load knowledge graph
  let knowledgeGraph = '';
  try {
    knowledgeGraph = await loadKnowledgeGraph(project.project);
  } catch { /* ok if missing */ }

  // Collect prior artifacts
  const currentStage = stage || persona;
  let priorArtifacts: Record<string, string> = {};
  try {
    priorArtifacts = await collectPriorArtifacts(runDir, currentStage);
  } catch { /* ok if no prior artifacts */ }

  // Build variables map
  const variables: Record<string, string> = {
    project_yaml: YAML.stringify(project),
    feature_request: featureRequest,
    conventions,
    memories,
    knowledge_graph: knowledgeGraph || '(no knowledge base available)',
    invariants: sysContext.invariants.map(i => `${i.id}: ${i.statement}`).join('\n'),
    sharp_edges: sysContext.sharpEdges.map(s => `${s.id}: ${s.statement}`).join('\n'),
    clarification_md: priorArtifacts['clarify'] || '',
    requirements_md: priorArtifacts['requirements'] || priorArtifacts['high-level-requirements'] || '',
    spec_md: priorArtifacts['spec'] || '',
    task: priorArtifacts['tasks'] || '',
    repo_context: sysContextMd,
    existing_code: '',
    code_changes: priorArtifacts['build'] || '',
    existing_clarifications: '',
  };

  // Render template
  const requiredVars = getRequiredVariables(persona);
  const rendered = renderTemplate(personaPrompt, variables, requiredVars);

  // Check size
  const size = Buffer.byteLength(rendered, 'utf-8');
  if (size > ERROR_SIZE) {
    throw new Error(`Assembled context exceeds ${Math.round(ERROR_SIZE / 1024)}KB limit (${Math.round(size / 1024)}KB)`);
  }
  if (size > WARN_SIZE) {
    warnings.push(`Assembled context is large: ${Math.round(size / 1024)}KB (warn threshold: ${Math.round(WARN_SIZE / 1024)}KB)`);
  }

  return { prompt: rendered, warnings };
}
