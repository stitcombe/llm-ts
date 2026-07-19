/**
 * Port of llm/default_plugins/openai_models.py.
 *
 * The Python `openai` client is replaced by the fetch-based client in
 * src/openaiClient.ts. All execute() implementations are async
 * generators (JS cannot do blocking HTTP), driven through the Response
 * async APIs.
 */
import { AsyncConversation, AsyncKeyModel, AsyncResponse, Conversation, EmbeddingModel, KeyModel, Options as OptionsBase, Prompt } from "../models.js";
import type { Response as SyncResponse } from "../models.js";
import { type FieldDef, type Validator } from "../pydantic.js";
import { StreamEvent } from "../parts.js";
export declare class SharedOptions extends OptionsBase {
    static fields: Record<string, FieldDef>;
    static validators: Record<string, Validator>;
}
export declare function buildOptionsClass({ reasoning, verbosity, image_detail_original, chat_completions, }?: {
    reasoning?: boolean;
    verbosity?: boolean;
    image_detail_original?: boolean;
    chat_completions?: boolean;
}): typeof SharedOptions;
export declare function combineChunks(chunks: any[]): Record<string, unknown>;
export declare function redactData(input: unknown): unknown;
export interface SharedInit {
    model_id: string;
    key?: string | null;
    model_name?: string | null;
    api_base?: string | null;
    api_type?: string | null;
    api_version?: string | null;
    api_engine?: string | null;
    headers?: Record<string, string> | null;
    can_stream?: boolean;
    vision?: boolean;
    audio?: boolean;
    reasoning?: boolean;
    verbosity?: boolean;
    image_detail_original?: boolean;
    supports_schema?: boolean;
    supports_tools?: boolean;
    allows_system_prompt?: boolean;
}
export declare class Chat extends KeyModel {
    needs_key: string | null;
    key_env_var: string | null;
    default_max_tokens: number | null;
    model_name: string | null;
    api_base: string | null;
    api_type: string | null;
    api_version: string | null;
    api_engine: string | null;
    headers: Record<string, string> | null;
    vision: boolean;
    allows_system_prompt: boolean;
    static Options: typeof SharedOptions;
    constructor(modelIdOrInit: string | SharedInit, init?: Omit<SharedInit, "model_id">);
    toString(): string;
    /** Translate prompt.messages into OpenAI's wire format. */
    build_messages(prompt: Prompt, conversation: Conversation | null, imageDetail?: string | null): Promise<Array<Record<string, unknown>>>;
    /** Overridable in subclasses, as in the Python plugin. */
    build_kwargs(prompt: Prompt, stream: boolean): Record<string, unknown>;
    execute(prompt: Prompt, stream: boolean, response: SyncResponse, conversation: Conversation | null, key: string | null): AsyncGenerator<string | StreamEvent>;
}
export declare class AsyncChat extends AsyncKeyModel {
    needs_key: string | null;
    key_env_var: string | null;
    default_max_tokens: number | null;
    model_name: string | null;
    api_base: string | null;
    api_type: string | null;
    api_version: string | null;
    api_engine: string | null;
    headers: Record<string, string> | null;
    vision: boolean;
    allows_system_prompt: boolean;
    static Options: typeof SharedOptions;
    constructor(modelIdOrInit: string | SharedInit, init?: Omit<SharedInit, "model_id">);
    toString(): string;
    /** Translate prompt.messages into OpenAI's wire format. */
    build_messages(prompt: Prompt, conversation: AsyncConversation | null, imageDetail?: string | null): Promise<Array<Record<string, unknown>>>;
    /** Overridable in subclasses, as in the Python plugin. */
    build_kwargs(prompt: Prompt, stream: boolean): Record<string, unknown>;
    execute(prompt: Prompt, stream: boolean, response: AsyncResponse, conversation: AsyncConversation | null, key: string | null): AsyncGenerator<string | StreamEvent>;
}
export declare class Responses extends KeyModel {
    needs_key: string | null;
    key_env_var: string | null;
    default_max_tokens: number | null;
    model_name: string | null;
    api_base: string | null;
    api_type: string | null;
    api_version: string | null;
    api_engine: string | null;
    headers: Record<string, string> | null;
    vision: boolean;
    allows_system_prompt: boolean;
    _reasoning: boolean;
    _verbosity: boolean;
    _image_detail_original: boolean;
    constructor(modelIdOrInit: string | SharedInit, init?: Omit<SharedInit, "model_id">);
    toString(): string;
    /** Translate prompt.messages into Responses API input items. */
    _build_responses_input(prompt: Pick<Prompt, "messages">, imageDetail?: string | null): Promise<[Array<Record<string, unknown>>, string | null]>;
    /** Build the non-message kwargs for a Responses API call. */
    _build_responses_kwargs(prompt: Pick<Prompt, "options" | "tools" | "schema"> & {
        hide_reasoning?: boolean;
    }, stream: boolean): Record<string, unknown>;
    delegateChatKwargs(): SharedInit;
    execute(prompt: Prompt, stream: boolean, response: SyncResponse, conversation: Conversation | null, key: string | null): AsyncGenerator<string | StreamEvent>;
}
export declare class AsyncResponses extends AsyncKeyModel {
    needs_key: string | null;
    key_env_var: string | null;
    default_max_tokens: number | null;
    model_name: string | null;
    api_base: string | null;
    api_type: string | null;
    api_version: string | null;
    api_engine: string | null;
    headers: Record<string, string> | null;
    vision: boolean;
    allows_system_prompt: boolean;
    _reasoning: boolean;
    _verbosity: boolean;
    _image_detail_original: boolean;
    constructor(modelIdOrInit: string | SharedInit, init?: Omit<SharedInit, "model_id">);
    toString(): string;
    /** Translate prompt.messages into Responses API input items. */
    _build_responses_input(prompt: Pick<Prompt, "messages">, imageDetail?: string | null): Promise<[Array<Record<string, unknown>>, string | null]>;
    /** Build the non-message kwargs for a Responses API call. */
    _build_responses_kwargs(prompt: Pick<Prompt, "options" | "tools" | "schema"> & {
        hide_reasoning?: boolean;
    }, stream: boolean): Record<string, unknown>;
    delegateChatKwargs(): SharedInit;
    execute(prompt: Prompt, stream: boolean, response: AsyncResponse, conversation: AsyncConversation | null, key: string | null): AsyncGenerator<string | StreamEvent>;
}
declare class CompletionOptions extends SharedOptions {
    static fields: Record<string, FieldDef>;
}
export declare class Completion extends Chat {
    static Options: typeof CompletionOptions;
    constructor(modelIdOrInit: string | SharedInit, init?: Omit<SharedInit, "model_id"> & {
        default_max_tokens?: number | null;
    });
    toString(): string;
    execute(prompt: Prompt, stream: boolean, response: SyncResponse, conversation: Conversation | null, key: string | null): AsyncGenerator<string | StreamEvent>;
}
export declare class OpenAIEmbeddingModel extends EmbeddingModel {
    needs_key: string | null;
    key_env_var: string | null;
    batch_size: number | null;
    openai_model_id: string;
    dimensions: number | null;
    constructor(modelId: string, openaiModelId: string, dimensions?: number | null);
    embedBatch(items: Iterable<string | Uint8Array>): AsyncGenerator<number[]>;
}
export declare const register_commands: (cli: any) => void;
export declare const register_models: (register: (model: unknown, asyncModel?: unknown, aliases?: string[] | null) => void) => void;
export declare const register_embedding_models: (register: (model: unknown, aliases?: string[] | null) => void) => void;
export {};
