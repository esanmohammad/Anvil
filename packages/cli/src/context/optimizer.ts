const CHARS_PER_TOKEN = 4;

export interface OptimizationResult {
  content: string;
  truncated: string[];
}

export function optimizeContext(context: string, maxTokens: number): OptimizationResult {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const truncated: string[] = [];

  if (context.length <= maxChars) {
    return { content: context, truncated: [] };
  }

  // Split into sections by ## headings
  const sections = context.split(/(?=^## )/m);
  let result = '';
  let remaining = maxChars;

  // Priority: persona prompt and project.yaml are never truncated
  // They typically come first, so process in order
  for (const section of sections) {
    if (remaining <= 0) {
      truncated.push(section.split('\n')[0].trim());
      continue;
    }

    if (section.length <= remaining) {
      result += section;
      remaining -= section.length;
    } else {
      // Truncate this section, keeping header + first paragraph
      const lines = section.split('\n');
      const header = lines[0];
      const firstParagraph = lines.slice(1, 5).join('\n');
      const truncatedSection = `${header}\n${firstParagraph}\n\n_[Truncated for context size]_\n\n`;
      result += truncatedSection;
      remaining -= truncatedSection.length;
      truncated.push(header.trim());
    }
  }

  return { content: result, truncated };
}
