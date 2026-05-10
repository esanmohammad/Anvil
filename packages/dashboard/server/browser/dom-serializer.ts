/**
 * Indexed-DOM serializer. Walks a structured DOM snapshot and produces
 * agent-visible text where each interactive element gets a stable
 * numeric index, e.g.:
 *
 *   [0]<a href="/login">Sign in</a>
 *   [1]<button>Submit</button>
 *   [2]<input type="text" placeholder="Email">
 *
 * Defenses (mirror Layer 3 of §H):
 *   - Strips `<script>` + `<style>` content.
 *   - Replaces in-page `[INST]…[/INST]`, `<system>…</system>`,
 *     `<|im_start|>…`, `Disregard…`, `Ignore prior…` patterns with a
 *     `[STRIPPED-INJECTION-CANDIDATE]` marker.
 *   - Caps text-node length per element (200 chars before `…`).
 *
 * The serializer takes a structured snapshot — Playwright's DOM is
 * walked into this shape elsewhere — so unit tests pass plain JS
 * objects without needing a real browser.
 */

const PER_ELEMENT_TEXT_CAP = 200;
const DEFAULT_DOM_TEXT_CAP = 40_000;

const INJECTION_PATTERNS: RegExp[] = [
  /\[INST\][\s\S]*?\[\/INST\]/g,
  /<system>[\s\S]*?<\/system>/gi,
  /<\|im_start\|>[\s\S]*?<\|im_end\|>/g,
  /\bdisregard (?:all |any |the |prior )?(?:above |previous )?(?:instructions?|directions?)\b/gi,
  /\bignore (?:all |any |the |prior |previous )(?:above |previous )?(?:instructions?|directions?)\b/gi,
];

export interface DomNode {
  /** Tag in lowercase, e.g. 'button', 'a', 'input'. */
  tag: string;
  attrs?: Record<string, string>;
  /** Direct text (not children). Used for leaves like `<button>Click</button>`. */
  text?: string;
  /** Children (recursive). */
  children?: DomNode[];
  /** True when the node should get an interactive index. */
  interactive?: boolean;
}

export interface SerializeOpts {
  /** Hard cap on the output string. Default 40 000. */
  charCap?: number;
}

export interface SerializeResult {
  /** Indexed-DOM text (`[i]<tag>text</tag>` per line). */
  domText: string;
  /** Raw count of interactive elements (the index range is [0, count)). */
  indexCount: number;
  /** Number of injection-candidate strips applied. */
  strips: number;
}

const INTERACTIVE_TAGS = new Set([
  'a', 'button', 'input', 'select', 'textarea', 'option', 'label',
  'summary', 'details',
]);
const STRIP_TAGS = new Set(['script', 'style', 'noscript', 'iframe', 'svg', 'canvas']);

export function serializeDom(root: DomNode, opts: SerializeOpts = {}): SerializeResult {
  const charCap = opts.charCap ?? DEFAULT_DOM_TEXT_CAP;
  const lines: string[] = [];
  let strips = 0;
  let nextIndex = 0;
  let totalLen = 0;

  const visit = (node: DomNode, depth: number): void => {
    const tag = node.tag.toLowerCase();
    if (STRIP_TAGS.has(tag)) return;
    const interactive = node.interactive ?? INTERACTIVE_TAGS.has(tag);
    const text = node.text ? cleanText(node.text) : undefined;
    const cleaned = text ? stripInjections(text, (n) => { strips += n; }) : undefined;
    const truncated = cleaned ? capText(cleaned) : undefined;
    const attrStr = formatAttrs(node.attrs);

    if (interactive) {
      const line = `[${nextIndex}]<${tag}${attrStr}>${truncated ?? ''}</${tag}>`;
      if (totalLen + line.length + 1 <= charCap) {
        lines.push(line);
        totalLen += line.length + 1;
      } else {
        return;
      }
      nextIndex += 1;
    } else if (truncated) {
      const indent = '  '.repeat(Math.min(depth, 4));
      const line = `${indent}${truncated}`;
      if (totalLen + line.length + 1 <= charCap) {
        lines.push(line);
        totalLen += line.length + 1;
      } else {
        return;
      }
    }

    for (const child of node.children ?? []) visit(child, depth + 1);
  };

  visit(root, 0);
  return { domText: lines.join('\n'), indexCount: nextIndex, strips };
}

function formatAttrs(attrs: Record<string, string> | undefined): string {
  if (!attrs) return '';
  const out: string[] = [];
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) continue;
    if (k === 'href' || k === 'placeholder' || k === 'aria-label' || k === 'name' || k === 'type') {
      out.push(` ${k}="${escapeAttrValue(v)}"`);
    }
  }
  return out.join('');
}

function escapeAttrValue(v: string): string {
  return v.replace(/"/g, '&quot;').replace(/\n/g, ' ').slice(0, 80);
}

function cleanText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function capText(s: string): string {
  if (s.length <= PER_ELEMENT_TEXT_CAP) return s;
  return s.slice(0, PER_ELEMENT_TEXT_CAP) + '…';
}

function stripInjections(s: string, onStrip: (count: number) => void): string {
  let out = s;
  let strips = 0;
  for (const re of INJECTION_PATTERNS) {
    out = out.replace(re, () => {
      strips += 1;
      return '[STRIPPED-INJECTION-CANDIDATE]';
    });
  }
  if (strips > 0) onStrip(strips);
  return out;
}
