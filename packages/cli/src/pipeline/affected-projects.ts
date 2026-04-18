// Detect affected projects from high-level requirements markdown

import type { AffectedProject } from './types.js';

/**
 * Detects which projects are affected based on high-level requirements text.
 * Parses markdown, cross-references against known project names,
 * ignores names found inside code blocks, and deduplicates.
 */
export function detectAffectedProjects(
  highLevelRequirements: string,
  projectNames: string[],
  projectRegistry: Map<string, { repos: string[] }>,
): AffectedProject[] {
  if (!highLevelRequirements || projectNames.length === 0) {
    return [];
  }

  // Remove fenced code blocks (``` ... ```) to avoid false matches
  const withoutCodeBlocks = highLevelRequirements.replace(
    /```[\s\S]*?```/g,
    '',
  );

  // Also remove inline code (`...`)
  const cleaned = withoutCodeBlocks.replace(/`[^`]*`/g, '');

  const found = new Map<string, AffectedProject>();

  for (const name of projectNames) {
    if (found.has(name)) continue;

    // Search for the project name as a whole word (case-insensitive)
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');

    if (regex.test(cleaned)) {
      const registryEntry = projectRegistry.get(name);
      const repos = registryEntry?.repos ?? [];

      // Extract context around the match for the reason
      const match = cleaned.match(regex);
      const matchIndex = match?.index ?? 0;
      const contextStart = Math.max(0, matchIndex - 50);
      const contextEnd = Math.min(cleaned.length, matchIndex + name.length + 50);
      const context = cleaned.slice(contextStart, contextEnd).trim();

      found.set(name, {
        name,
        repos,
        reason: `Referenced in requirements: "...${context}..."`,
      });
    }
  }

  return Array.from(found.values());
}
