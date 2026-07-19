/**
 * Minimal fetch-based Anthropic Messages API client, standing in for the
 * Python `anthropic` package used by llm-anthropic.
 *
 * Covers what the plugin needs:
 *  - messages.create(...) — non-streaming, returns the parsed JSON body
 *    normalized to the shape the SDK's `model_dump()` produces
 *  - messages.stream(...) — SSE streaming; the returned object is async
 *    iterable over raw events and exposes getFinalMessage(), which
 *    accumulates content blocks the way the SDK's stream helper does
 *
 * `betas` and `extra_body` entries in the params are handled the way the
 * Python SDK handles them: `betas` becomes the anthropic-beta header (and
 * selects the /v1/messages beta client), `extra_body` is merged into the
 * request body.
 */
export declare class AnthropicAPIError extends Error {
    status: number | null;
    body: unknown;
    constructor(message: string, status?: number | null, body?: unknown);
}
export declare const ANTHROPIC_VERSION = "2023-06-01";
export interface AnthropicClientOptions {
    apiKey: string;
    baseUrl?: string | null;
}
type Json = Record<string, any>;
/**
 * Add the fields the SDK's pydantic models default to null but that the
 * wire format omits. Only the fields the plugin (and its tests) actually
 * observe are filled in.
 */
export declare function normalizeMessage(message: Json): Json;
export interface MessageStream extends AsyncIterable<Json> {
    getFinalMessage(): Json;
}
export declare class AnthropicClient {
    apiKey: string;
    baseUrl: string;
    constructor({ apiKey, baseUrl }: AnthropicClientOptions);
    /**
     * Split the plugin's kwargs into (body, betas), applying the Python SDK's
     * handling of the `betas` and `extra_body` pseudo-parameters.
     */
    private prepare;
    private headers;
    private request;
    messages: {
        create: (params: Json) => Promise<Json>;
        stream: (params: Json) => MessageStream;
    };
}
export {};
