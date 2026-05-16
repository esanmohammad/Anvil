/**
 * Provider-agnostic translator for the canonical Anvil pixel-browser
 * tool spec → per-provider native tool schema.
 *
 * Anvil declares ONE canonical shape:
 *   { name: 'computer-use', kind: 'pixel-browser',
 *     display: { width_px, height_px, allowZoom } }
 *
 * Active provider determines the on-the-wire JSON. Models without
 * pixel-browser support (Ollama Llama, non-vision Claude tiers) cause
 * `unsupported` to be returned; the executor reports back to the user.
 */
/**
 * Map a known model id (or shorthand) to its provider family. Mirrors
 * agent-core's `resolveProvider` heuristics but lives here because we
 * don't import agent-core to avoid a build cycle.
 */
export function detectProvider(model) {
    const m = model.toLowerCase();
    if (m.includes('claude') || m.startsWith('opus') || m.startsWith('sonnet') || m.startsWith('haiku'))
        return 'anthropic';
    if (m.includes('gpt') || m.includes('o1-') || m.includes('o3-') || m.includes('cua'))
        return 'openai';
    if (m.includes('gemini'))
        return 'gemini';
    if (m.startsWith('ollama/') || m.includes('llama') || m.includes('mistral'))
        return 'ollama';
    return 'unsupported';
}
/**
 * Whether a model has the `pixel-browser` capability. Most models
 * don't; this is the minimum gate before exposing computer.* tools.
 */
export function hasPixelBrowser(model) {
    const provider = detectProvider(model);
    if (provider === 'unsupported' || provider === 'ollama')
        return false;
    // Intentionally permissive — the schema translator surfaces the
    // canonical shape; the actual model decides at runtime if it can
    // call the tool. Capability matrix lives in agent-core's
    // model-catalog (extension follow-up: `summarize` + `pixel-browser` flags).
    return true;
}
export function translateComputerTool(spec, model) {
    const provider = detectProvider(model);
    switch (provider) {
        case 'anthropic':
            return {
                provider: 'anthropic',
                schema: {
                    type: 'computer_20251124',
                    name: 'computer',
                    display_width_px: spec.display.width_px,
                    display_height_px: spec.display.height_px,
                },
            };
        case 'openai':
            return {
                provider: 'openai',
                schema: {
                    type: 'computer_use_preview',
                    display_width: spec.display.width_px,
                    display_height: spec.display.height_px,
                    environment: 'browser',
                },
            };
        case 'gemini':
            return {
                provider: 'gemini',
                schema: {
                    name: 'computer',
                    description: 'Pixel-coordinate browser tool (Gemini 2.5 Computer Use).',
                    parameters: {
                        type: 'OBJECT',
                        properties: {
                            action: { type: 'STRING' },
                            coordinate: { type: 'ARRAY', items: { type: 'NUMBER' } },
                        },
                    },
                },
            };
        default:
            return { provider: 'unsupported', schema: null };
    }
}
/**
 * Translate canonical actions into the per-provider native shape that
 * an agent emits and Anvil expects to receive back. The executor
 * normalizes incoming agent actions through this when the provider
 * uses a divergent shape.
 */
export function translateActionToProvider(action, provider) {
    switch (provider) {
        case 'anthropic':
            return translateForAnthropic(action);
        case 'openai':
            return translateForOpenAI(action);
        default:
            return action;
    }
}
function translateForAnthropic(action) {
    switch (action.action) {
        case 'click':
            return {
                action: action.button === 'right' ? 'right_click' : action.button === 'middle' ? 'middle_click' : 'left_click',
                coordinate: action.coordinate,
            };
        case 'scroll':
            return {
                action: 'scroll',
                coordinate: action.coordinate,
                scroll_direction: action.direction,
                scroll_amount: action.amount,
            };
        default:
            return action;
    }
}
function translateForOpenAI(action) {
    switch (action.action) {
        case 'click':
            return { action: 'click', x: action.coordinate[0], y: action.coordinate[1], button: action.button ?? 'left' };
        case 'scroll': {
            // OpenAI uses pixel deltas, not "1 page".
            const delta = action.amount * 100;
            const sx = action.direction === 'left' ? -delta : action.direction === 'right' ? delta : 0;
            const sy = action.direction === 'up' ? -delta : action.direction === 'down' ? delta : 0;
            return { action: 'scroll', x: action.coordinate[0], y: action.coordinate[1], scroll_x: sx, scroll_y: sy };
        }
        case 'type':
            return { action: 'type', text: action.text };
        default:
            return action;
    }
}
//# sourceMappingURL=computer-use-translator.js.map