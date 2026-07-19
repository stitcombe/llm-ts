/**
 * Minimal fetch-based OpenAI API client covering what llm uses from the
 * Python `openai` package: chat completions, legacy completions, the
 * Responses API, and embeddings — with SSE streaming support.
 *
 * Responses are plain parsed-JSON objects (the analog of the Python
 * client's model_dump()).
 */
export declare class APIError extends Error {
    status: number | null;
    body: unknown;
    constructor(message: string, status?: number | null, body?: unknown);
}
export interface OpenAIClientOptions {
    apiKey: string;
    baseUrl?: string | null;
    defaultHeaders?: Record<string, string> | null;
    /** Log requests/responses to stderr (LLM_OPENAI_SHOW_RESPONSES). */
    logResponses?: boolean;
}
export declare class OpenAIClient {
    apiKey: string;
    baseUrl: string;
    defaultHeaders: Record<string, string>;
    logResponses: boolean;
    constructor({ apiKey, baseUrl, defaultHeaders, logResponses, }: OpenAIClientOptions);
    private headers;
    private logRequest;
    private post;
    /** POST with stream: parse the SSE response into JSON chunk objects. */
    private postStream;
    chat: {
        completions: {
            create: (params: Record<string, unknown> & {
                stream?: boolean;
            }) => Promise<any> | AsyncGenerator<any>;
        };
    };
    completions: {
        create: (params: Record<string, unknown> & {
            stream?: boolean;
        }) => Promise<any> | AsyncGenerator<any>;
    };
    responses: {
        create: (params: Record<string, unknown> & {
            stream?: boolean;
        }) => Promise<any> | AsyncGenerator<any>;
    };
    embeddings: {
        create: (params: Record<string, unknown>) => Promise<any>;
    };
}
