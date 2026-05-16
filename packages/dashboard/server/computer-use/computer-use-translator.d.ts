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
export type CanonicalProvider = 'anthropic' | 'openai' | 'gemini' | 'ollama' | 'unsupported';
export interface CanonicalComputerToolSpec {
    display: {
        width_px: number;
        height_px: number;
        allowZoom?: boolean;
    };
}
export type ProviderToolSchema = {
    provider: 'anthropic';
    schema: {
        type: 'computer_20251124';
        name: 'computer';
        display_width_px: number;
        display_height_px: number;
    };
} | {
    provider: 'openai';
    schema: {
        type: 'computer_use_preview';
        display_width: number;
        display_height: number;
        environment: 'browser';
    };
} | {
    provider: 'gemini';
    schema: {
        name: 'computer';
        description: string;
        parameters: object;
    };
} | {
    provider: 'unsupported';
    schema: null;
};
/**
 * Map a known model id (or shorthand) to its provider family. Mirrors
 * agent-core's `resolveProvider` heuristics but lives here because we
 * don't import agent-core to avoid a build cycle.
 */
export declare function detectProvider(model: string): CanonicalProvider;
/**
 * Whether a model has the `pixel-browser` capability. Most models
 * don't; this is the minimum gate before exposing computer.* tools.
 */
export declare function hasPixelBrowser(model: string): boolean;
export declare function translateComputerTool(spec: CanonicalComputerToolSpec, model: string): ProviderToolSchema;
export type ComputerAction = {
    action: 'screenshot';
} | {
    action: 'click';
    coordinate: [number, number];
    button?: 'left' | 'middle' | 'right';
    modifiers?: string[];
} | {
    action: 'double_click';
    coordinate: [number, number];
} | {
    action: 'right_click';
    coordinate: [number, number];
} | {
    action: 'type';
    text: string;
} | {
    action: 'key';
    text: string;
} | {
    action: 'scroll';
    coordinate: [number, number];
    direction: 'up' | 'down' | 'left' | 'right';
    amount: number;
} | {
    action: 'mouse_move';
    coordinate: [number, number];
} | {
    action: 'left_mouse_down';
    coordinate: [number, number];
} | {
    action: 'left_mouse_up';
    coordinate: [number, number];
} | {
    action: 'drag';
    path: Array<[number, number]>;
} | {
    action: 'wait';
    durationMs?: number;
};
/**
 * Translate canonical actions into the per-provider native shape that
 * an agent emits and Anvil expects to receive back. The executor
 * normalizes incoming agent actions through this when the provider
 * uses a divergent shape.
 */
export declare function translateActionToProvider(action: ComputerAction, provider: CanonicalProvider): unknown;
//# sourceMappingURL=computer-use-translator.d.ts.map