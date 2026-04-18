/**
 * WS-2: Service Mesh Inference
 *
 * After all repos are profiled (WS-1 produces RepoProfile objects), this module
 * infers the service mesh — how services connect to each other. It replaces the
 * manual `connects:` section in project.yaml.
 *
 * Phase A: Deterministic bottom-up matching of exposed/consumed endpoints.
 * Phase B: LLM gap-filling for orphan repos with no detected connections.
 */

import { runLLM } from './claude-runner.js';
import type { RepoProfile, ServiceEndpoint, CrossRepoEdge } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SEPARATOR = '/';

/**
 * Normalize a topic, path, or identifier for fuzzy matching.
 * - Lowercase
 * - Replace dots, dashes, underscores with a common separator
 * - Strip leading/trailing slashes
 * - Strip version prefixes like /api/v1/ or /api/v2/
 */
export function normalizeIdentifier(id: string): string {
  let normalized = id.toLowerCase();

  // Replace common separators with a single canonical separator
  normalized = normalized.replace(/[.\-_]+/g, SEPARATOR);

  // Strip leading/trailing slashes
  normalized = normalized.replace(/^\/+|\/+$/g, '');

  // Strip version prefixes: api/v1/, api/v2/, v1/, etc.
  normalized = normalized.replace(/^(?:api\/)?v\d+\//i, '');

  // Normalize path params: :id, {id}, <id> -> :param
  normalized = normalized.replace(/:[a-zA-Z_]+/g, ':param');
  normalized = normalized.replace(/\{[a-zA-Z_]+\}/g, ':param');
  normalized = normalized.replace(/<[a-zA-Z_]+>/g, ':param');

  return normalized;
}

/**
 * Return a 0-1 similarity score between two identifiers.
 * - Exact match after normalization -> 1.0
 * - One is a substring of the other -> 0.8
 * - Jaccard similarity on path segments -> 0-0.7
 */
export function identifierSimilarity(a: string, b: string): number {
  const na = normalizeIdentifier(a);
  const nb = normalizeIdentifier(b);

  // Exact match
  if (na === nb) return 1.0;

  // Substring match (one contains the other)
  if (na.includes(nb) || nb.includes(na)) return 0.8;

  // Jaccard similarity on path segments
  const segsA = new Set(na.split(SEPARATOR).filter(Boolean));
  const segsB = new Set(nb.split(SEPARATOR).filter(Boolean));

  if (segsA.size === 0 || segsB.size === 0) return 0;

  let intersection = 0;
  for (const seg of segsA) {
    if (segsB.has(seg)) intersection++;
  }

  const union = new Set([...segsA, ...segsB]).size;
  return Math.min(0.7, intersection / union);
}

// ---------------------------------------------------------------------------
// Phase A: Deterministic endpoint matching
// ---------------------------------------------------------------------------

/** Mapping from endpoint type pair to edge type and base confidence */
interface MatchRule {
  producerType: ServiceEndpoint['type'];
  consumerType: ServiceEndpoint['type'];
  edgeType: CrossRepoEdge['edgeType'];
  baseConfidence: number;
  /** Minimum similarity threshold to produce an edge */
  threshold: number;
}

const MATCH_RULES: MatchRule[] = [
  // Kafka: producer -> consumer on same topic
  { producerType: 'kafka-producer', consumerType: 'kafka-consumer', edgeType: 'kafka', baseConfidence: 0.95, threshold: 0.8 },

  // HTTP: exposed path -> consumed path
  { producerType: 'http', consumerType: 'http', edgeType: 'http', baseConfidence: 0.85, threshold: 0.6 },

  // gRPC: exposed service -> consumed service
  { producerType: 'grpc', consumerType: 'grpc', edgeType: 'grpc', baseConfidence: 0.95, threshold: 0.8 },

  // Database: shared table references
  { producerType: 'database', consumerType: 'database', edgeType: 'database', baseConfidence: 0.8, threshold: 0.8 },

  // Redis: shared key patterns
  { producerType: 'redis', consumerType: 'redis', edgeType: 'redis', baseConfidence: 0.75, threshold: 0.7 },

  // S3: shared bucket identifiers
  { producerType: 's3', consumerType: 's3', edgeType: 's3', baseConfidence: 0.8, threshold: 0.8 },
];

/**
 * Phase A: Bottom-up deterministic matching of endpoints across repos.
 * Matches `exposes` from one repo with `consumes` from another using
 * type-specific rules and fuzzy identifier comparison.
 */
export function matchEndpoints(profiles: RepoProfile[]): CrossRepoEdge[] {
  const edges: CrossRepoEdge[] = [];
  const seen = new Set<string>();

  for (const rule of MATCH_RULES) {
    // Database/Redis/S3: bidirectional — both sides "consume" the same resource.
    // Use exposes-to-exposes matching as well as exposes-to-consumes.
    const isBidirectional = ['database', 'redis', 's3'].includes(rule.producerType);

    for (let i = 0; i < profiles.length; i++) {
      for (let j = 0; j < profiles.length; j++) {
        if (i === j) continue;

        const repoA = profiles[i];
        const repoB = profiles[j];

        // For bidirectional resources, only match i < j to avoid duplicates
        if (isBidirectional && i > j) continue;

        // Collect endpoints by matching type
        const exposedA = repoA.exposes.filter(e => e.type === rule.producerType);
        const consumedB = isBidirectional
          // For shared resources, also look in exposes of the other repo
          ? [...repoB.consumes.filter(e => e.type === rule.consumerType), ...repoB.exposes.filter(e => e.type === rule.producerType)]
          : repoB.consumes.filter(e => e.type === rule.consumerType);

        for (const exposed of exposedA) {
          for (const consumed of consumedB) {
            const similarity = identifierSimilarity(exposed.identifier, consumed.identifier);
            if (similarity < rule.threshold) continue;

            const confidence = rule.baseConfidence * similarity;
            const edgeKey = `${repoA.name}:${repoB.name}:${rule.edgeType}:${normalizeIdentifier(exposed.identifier)}`;

            if (seen.has(edgeKey)) continue;
            seen.add(edgeKey);

            edges.push({
              sourceRepo: repoA.name,
              sourceNode: exposed.identifier,
              targetRepo: repoB.name,
              targetNode: consumed.identifier,
              edgeType: rule.edgeType,
              evidence: `${repoA.name} exposes ${exposed.type}:${exposed.identifier} matched with ${repoB.name} ${isBidirectional ? 'exposes' : 'consumes'} ${consumed.type}:${consumed.identifier} (similarity: ${similarity.toFixed(2)})`,
              confidence: Math.round(confidence * 100) / 100,
            });
          }
        }
      }
    }
  }

  return edges;
}

// ---------------------------------------------------------------------------
// Phase B: LLM gap-filling for orphan repos
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a software architect analyzing an organization's service architecture.
You will be given profiles of repositories that have NO detected connections to other repos.
Based on their roles, technologies, domains, and descriptions, identify likely connections.

Consider:
- Shared databases (same DB tech + similar domain = likely shared DB)
- Config-driven routing (gateway -> backend services)
- Cron/scheduler -> worker relationships
- Shared infrastructure services (logging, auth, notifications)
- Domain proximity (repos in same domain likely interact)

Respond with ONLY valid JSON array:
[
  {
    "source": "repo-name-a",
    "target": "repo-name-b",
    "type": "http|kafka|grpc|database|redis|s3|other",
    "evidence": "Both repos are in email-delivery domain, A is gateway, B is worker",
    "confidence": 0.7
  }
]

Rules:
- Only suggest connections with confidence >= 0.6
- Be conservative — better to miss a connection than hallucinate one
- Use the repo descriptions to understand actual purpose, not just names`;

/** Slim profile shape sent to the LLM (no fingerprints or full endpoint lists) */
interface SlimProfile {
  name: string;
  role: string;
  domain: string;
  description: string;
  technologies: string[];
}

interface LLMInferredEdge {
  source: string;
  target: string;
  type: string;
  evidence: string;
  confidence: number;
}

/**
 * Parse a JSON array from LLM output, handling markdown fences and partial JSON.
 */
function parseJsonArray(raw: string): LLMInferredEdge[] {
  // Strip markdown code fences if present
  let cleaned = raw.trim();
  cleaned = cleaned.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '');
  cleaned = cleaned.trim();

  // Try direct parse
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    // Attempt to extract first JSON array from the text
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        return JSON.parse(arrayMatch[0]);
      } catch {
        return [];
      }
    }
    return [];
  }
}

/**
 * Map a raw type string from the LLM to a valid edgeType, falling back to 'llm-inferred'.
 */
function toEdgeType(raw: string): CrossRepoEdge['edgeType'] {
  const valid: CrossRepoEdge['edgeType'][] = [
    'http', 'kafka', 'grpc', 'database', 'redis', 's3',
  ];
  const lower = raw.toLowerCase();
  const match = valid.find(v => v === lower);
  return match ?? 'llm-inferred';
}

/**
 * Phase B: Use an LLM to infer connections for orphan repos (repos with no
 * edges after deterministic matching). Batches orphans by domain proximity.
 */
export async function inferOrphanConnections(
  profiles: RepoProfile[],
  existingEdges: CrossRepoEdge[],
  opts?: { model?: string; provider?: 'claude' | 'gemini' },
): Promise<CrossRepoEdge[]> {
  // Identify repos that appear in no edges
  const connectedRepos = new Set<string>();
  for (const edge of existingEdges) {
    connectedRepos.add(edge.sourceRepo);
    connectedRepos.add(edge.targetRepo);
  }

  const orphans = profiles.filter(p => !connectedRepos.has(p.name));
  if (orphans.length === 0) return [];

  // Build slim profiles: orphans + their domain neighbors for context
  const orphanDomains = new Set(orphans.map(p => p.domain));
  const contextProfiles = profiles.filter(
    p => orphanDomains.has(p.domain) || !connectedRepos.has(p.name),
  );

  const slimProfiles: SlimProfile[] = contextProfiles.map(p => ({
    name: p.name,
    role: p.role,
    domain: p.domain,
    description: p.description,
    technologies: p.technologies,
  }));

  const orphanNames = orphans.map(p => p.name);

  const userPrompt = `The following repos have NO detected connections to any other repo:\n${JSON.stringify(orphanNames, null, 2)}\n\nHere are profiles of those repos and their domain neighbors:\n${JSON.stringify(slimProfiles, null, 2)}\n\nIdentify likely connections between these orphan repos and any other repo listed above.`;

  const model = opts?.model ?? 'claude-sonnet-4-6';

  const result = await runLLM(
    userPrompt,
    SYSTEM_PROMPT,
    { model, provider: opts?.provider, timeoutMs: 600_000 },
  );

  const inferred = parseJsonArray(result.result);

  // Validate repo names exist and confidence threshold
  const profileNames = new Set(profiles.map(p => p.name));

  return inferred
    .filter(
      e =>
        e.confidence >= 0.6 &&
        profileNames.has(e.source) &&
        profileNames.has(e.target) &&
        e.source !== e.target,
    )
    .map(e => ({
      sourceRepo: e.source,
      sourceNode: 'inferred',
      targetRepo: e.target,
      targetNode: 'inferred',
      edgeType: toEdgeType(e.type),
      evidence: `[LLM-inferred] ${e.evidence}`,
      confidence: Math.round(e.confidence * 100) / 100,
    }));
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Infer the service mesh from a set of repo profiles.
 *
 * 1. Phase A: Deterministic endpoint matching (no LLM)
 * 2. Identify orphan repos (no connections)
 * 3. Phase B: LLM gap-filling for orphans (optional)
 * 4. Merge and deduplicate edges
 *
 * @returns All inferred CrossRepoEdge connections
 */
export async function inferServiceMesh(
  profiles: RepoProfile[],
  opts?: {
    model?: string;
    provider?: 'claude' | 'gemini';
    onProgress?: (msg: string) => void;
    skipLlm?: boolean;
  },
): Promise<CrossRepoEdge[]> {
  const progress = opts?.onProgress ?? (() => {});

  // Phase A: Deterministic matching
  progress(`Matching endpoints across ${profiles.length} repos...`);
  const deterministicEdges = matchEndpoints(profiles);
  progress(`Phase A: Found ${deterministicEdges.length} deterministic edges.`);

  // Identify orphans
  const connectedRepos = new Set<string>();
  for (const edge of deterministicEdges) {
    connectedRepos.add(edge.sourceRepo);
    connectedRepos.add(edge.targetRepo);
  }
  const orphanCount = profiles.filter(p => !connectedRepos.has(p.name)).length;

  // Phase B: LLM gap-filling
  let llmEdges: CrossRepoEdge[] = [];
  if (orphanCount > 0 && opts?.skipLlm !== true) {
    progress(`Phase B: ${orphanCount} orphan repo(s) detected. Inferring connections via LLM...`);
    try {
      llmEdges = await inferOrphanConnections(profiles, deterministicEdges, {
        model: opts?.model,
        provider: opts?.provider,
      });
      progress(`Phase B: Inferred ${llmEdges.length} additional edges.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      progress(`Phase B: LLM inference failed — ${message}. Continuing with deterministic edges only.`);
    }
  } else if (orphanCount === 0) {
    progress('Phase B: No orphan repos — skipping LLM inference.');
  } else {
    progress('Phase B: Skipped (skipLlm=true).');
  }

  // Merge and deduplicate
  const allEdges = [...deterministicEdges, ...llmEdges];
  const deduped = deduplicateEdges(allEdges);

  progress(`Service mesh: ${deduped.length} total edges (${deterministicEdges.length} deterministic, ${llmEdges.length} LLM-inferred).`);
  return deduped;
}

/**
 * Deduplicate edges by (sourceRepo, targetRepo, edgeType, normalizedIdentifier).
 * When duplicates exist, keep the one with higher confidence.
 */
function deduplicateEdges(edges: CrossRepoEdge[]): CrossRepoEdge[] {
  const map = new Map<string, CrossRepoEdge>();

  for (const edge of edges) {
    const key = [
      edge.sourceRepo,
      edge.targetRepo,
      edge.edgeType,
      normalizeIdentifier(edge.sourceNode),
      normalizeIdentifier(edge.targetNode),
    ].join('::');

    const existing = map.get(key);
    if (!existing || edge.confidence > existing.confidence) {
      map.set(key, edge);
    }
  }

  return Array.from(map.values());
}
