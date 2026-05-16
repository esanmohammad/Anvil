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
export declare function serializeDom(root: DomNode, opts?: SerializeOpts): SerializeResult;
//# sourceMappingURL=dom-serializer.d.ts.map