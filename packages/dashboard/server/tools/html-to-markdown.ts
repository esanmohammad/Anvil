/**
 * Minimal HTML → Markdown converter, focused on safety. Strips:
 *   - `<script>`, `<style>`, `<noscript>`, `<iframe>` content
 *   - `on*` event-handler attributes
 *   - `<svg>` / `<canvas>` (visual-only, no useful text)
 *
 * Then converts a small subset of structural tags to Markdown:
 *   - h1–h6 → `# … ###### …`
 *   - p, br → blank line + linebreak
 *   - ul, ol, li → `- …` / `1. …`
 *   - a[href] → `[text](href)`
 *   - code, pre → backticks / fenced
 *   - strong, em → bold/italic
 *
 * Everything else is unwrapped to its text content. The output is
 * collapsed to remove >2 consecutive blank lines and trimmed.
 *
 * Not a full Turndown — Anvil only needs enough fidelity for the
 * cheap-tier summarizer to extract facts. Adopting Turndown later is a
 * drop-in swap behind this seam.
 */

const STRIP_BLOCK_TAGS = ['script', 'style', 'noscript', 'iframe', 'svg', 'canvas'];

export function htmlToMarkdown(html: string): string {
  let s = html;

  // 1. Drop block-level "danger" tags (content + tag).
  for (const tag of STRIP_BLOCK_TAGS) {
    const re = new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}\\s*>`, 'gi');
    s = s.replace(re, '');
    // self-closing variants
    s = s.replace(new RegExp(`<${tag}\\b[^>]*/>`, 'gi'), '');
  }

  // 2. Drop comments.
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 3. Drop on* event handlers from any remaining tag (defense in depth).
  s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
  s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');

  // 4. Headings.
  for (let i = 6; i >= 1; i--) {
    const re = new RegExp(`<h${i}\\b[^>]*>([\\s\\S]*?)</h${i}\\s*>`, 'gi');
    const hashes = '#'.repeat(i);
    s = s.replace(re, (_m, body: string) => `\n\n${hashes} ${stripTags(body).trim()}\n\n`);
  }

  // 5. Anchors.
  s = s.replace(/<a\b[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, href: string, body: string) => `[${stripTags(body).trim()}](${href})`);
  s = s.replace(/<a\b[^>]*>([\s\S]*?)<\/a\s*>/gi,
    (_m, body: string) => stripTags(body).trim());

  // 6. Code/pre.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi,
    (_m, body: string) => '\n\n```\n' + decodeEntities(stripTags(body)) + '\n```\n\n');
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi,
    (_m, body: string) => '`' + decodeEntities(stripTags(body)) + '`');

  // 7. Bold / italic.
  s = s.replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)\s*>/gi,
    (_m, body: string) => `**${stripTags(body)}**`);
  s = s.replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)\s*>/gi,
    (_m, body: string) => `*${stripTags(body)}*`);

  // 8. Lists.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi,
    (_m, body: string) => `\n- ${stripTags(body).trim()}`);
  s = s.replace(/<\/?(?:ul|ol)\b[^>]*>/gi, '\n\n');

  // 9. Paragraphs / breaks / divs.
  s = s.replace(/<\/p\s*>/gi, '\n\n');
  s = s.replace(/<p\b[^>]*>/gi, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/?(?:div|section|article|nav|header|footer|main|aside)\b[^>]*>/gi, '\n');

  // 10. Strip remaining tags.
  s = stripTags(s);

  // 11. Decode entities.
  s = decodeEntities(s);

  // 12. Collapse 3+ newlines to 2.
  s = s.replace(/\n{3,}/g, '\n\n').trim();

  return s;
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, '');
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, n: string) => String.fromCodePoint(parseInt(n, 16)));
}

const SSR_LOWER_BOUND = 200;

/** Heuristic for "the body is a JS shell waiting on hydration". */
export function looksLikeSpaShell(markdown: string): boolean {
  const text = markdown.replace(/\s+/g, ' ').trim();
  if (text.length < SSR_LOWER_BOUND) return true;
  // Common React/Vue/Angular root markers with no surrounding text.
  if (/^[<\s]*$/.test(text)) return true;
  return false;
}
