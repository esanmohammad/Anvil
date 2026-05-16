/**
 * Cheap-tier DOM extractor. Same pattern as `web.fetch`'s summarizer:
 * page DOM → markdown → cheap-tier model → structured answer. The
 * main agent never sees raw page content — only the validated extract.
 *
 * Routes through `resolveModelForStage('browser-extractor')` (Phase H0)
 * with a graceful fallback to `research`.
 */
import type { BrowserExtractArgs, BrowserExtractResult } from '@esankhan3/anvil-core-pipeline';
import type { SummarizerInvoker } from '../tools/summarizer.js';
export interface ExtractorCallOpts {
    /** Pre-rendered page text (from the DOM serializer). */
    pageText: string;
    /** Caller-supplied LLM caller (test seam + dashboard wiring). */
    invoke: SummarizerInvoker;
    /** Skip resolver (test seam). */
    modelOverride?: string;
}
export declare function extract(args: BrowserExtractArgs, opts: ExtractorCallOpts): Promise<BrowserExtractResult>;
//# sourceMappingURL=extractor.d.ts.map