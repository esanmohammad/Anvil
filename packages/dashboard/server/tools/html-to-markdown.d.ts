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
export declare function htmlToMarkdown(html: string): string;
/** Heuristic for "the body is a JS shell waiting on hydration". */
export declare function looksLikeSpaShell(markdown: string): boolean;
//# sourceMappingURL=html-to-markdown.d.ts.map