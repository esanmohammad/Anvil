export function renderTemplate(
  template: string,
  variables: Record<string, string>,
  requiredVars: string[] = [],
): string {
  // Check required variables
  for (const name of requiredVars) {
    if (!(name in variables)) {
      throw new Error(`Missing required template variable: {{${name}}}`);
    }
  }

  // Replace variables, but skip inside code blocks
  const codeBlockRegex = /```[\s\S]*?```/g;
  const codeBlocks: string[] = [];
  let processed = template.replace(codeBlockRegex, (match) => {
    codeBlocks.push(match);
    return `__CODE_BLOCK_${codeBlocks.length - 1}__`;
  });

  // Replace all {{var}} patterns
  processed = processed.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (name in variables) return variables[name];
    // Optional variable — remove placeholder
    return '';
  });

  // Restore code blocks
  processed = processed.replace(/__CODE_BLOCK_(\d+)__/g, (_, idx) => {
    return codeBlocks[parseInt(idx)];
  });

  // Trim excessive whitespace (3+ blank lines -> 2)
  processed = processed.replace(/\n{4,}/g, '\n\n\n');

  return processed;
}
