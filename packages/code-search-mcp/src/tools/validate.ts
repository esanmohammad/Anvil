/**
 * Tool results + argument validation against each tool's own `inputSchema`,
 * so what a tool advertises and what it accepts cannot drift apart.
 */

export interface ToolResult { content: Array<{ type: string; text: string }>; isError?: boolean }

export const toolText = (text: string): ToolResult => ({ content: [{ type: 'text', text }] });
export const toolError = (text: string): ToolResult => ({ content: [{ type: 'text', text }], isError: true });

interface PropSchema {
  type: string;
  description?: string;
  enum?: string[];
  items?: PropSchema;
  minimum?: number;
  maximum?: number;
  minLength?: number;
}
export interface InputSchema { type: 'object'; properties: Record<string, PropSchema>; required?: string[] }

function checkValue(name: string, v: unknown, p: PropSchema): string | null {
  switch (p.type) {
    case 'string':
      if (typeof v !== 'string') return `"${name}" must be a string.`;
      // minLength counts non-blank characters: a whitespace-only query is empty.
      if (p.minLength !== undefined && v.trim().length < p.minLength) return `"${name}" must not be empty.`;
      break;
    case 'boolean':
      if (typeof v !== 'boolean') return `"${name}" must be a boolean.`;
      break;
    case 'integer':
      if (typeof v !== 'number' || !Number.isInteger(v)) return `"${name}" must be an integer.`;
      if (p.minimum !== undefined && v < p.minimum) return `"${name}" must be at least ${p.minimum}.`;
      if (p.maximum !== undefined && v > p.maximum) return `"${name}" must be at most ${p.maximum}.`;
      break;
    case 'array':
      if (!Array.isArray(v)) return `"${name}" must be an array.`;
      for (const item of v) {
        const err = p.items ? checkValue(`${name}[]`, item, p.items) : null;
        if (err) return err;
      }
      break;
  }
  if (p.enum && !p.enum.includes(v as string)) return `"${name}" must be one of: ${p.enum.join(', ')} (got ${JSON.stringify(v)}).`;
  return null;
}

/** First problem with `args` against `schema`, or null when they are valid. */
export function validateArgs(schema: InputSchema, args: Record<string, unknown>): string | null {
  for (const k of schema.required ?? []) {
    if (args[k] === undefined || args[k] === null) return `Missing required argument "${k}".`;
  }
  for (const [k, p] of Object.entries(schema.properties)) {
    if (args[k] === undefined || args[k] === null) continue;
    const err = checkValue(k, args[k], p);
    if (err) return err;
  }
  return null;
}
