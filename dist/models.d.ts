/**
 * Port of llm/models.py: Prompt, Response, Conversation, Model, Tool,
 * Toolbox, chains, and the pause/resume machinery.
 *
 * Sync/async notes (documented deviations from Python):
 * - execute_tool_calls, reply, log_to_db and everything chain-related are
 *   async in TS (Python runs async tools via asyncio.run inside sync code,
 *   which JS cannot do).
 * - Attachment.resolveType()/contentBytes() are async when they must hit
 *   the network (URL attachments); the sync checks still happen eagerly.
 */
import { Fragment } from "./utils.js";
import { BaseModel } from "./pydantic.js";
import type { ResponseDict } from "./serialization.js";
import { Message, Part, StreamEvent } from "./parts.js";
export declare const CONVERSATION_NAME_LENGTH = 32;
export declare class Usage {
    input: number | null;
    output: number | null;
    details: Record<string, unknown> | null;
    constructor({ input, output, details, }?: {
        input?: number | null;
        output?: number | null;
        details?: Record<string, unknown> | null;
    });
}
export interface AttachmentInit {
    type?: string | null;
    path?: string | null;
    url?: string | null;
    content?: Uint8Array | null;
    _id?: string | null;
}
export declare class Attachment {
    type: string | null;
    path: string | null;
    url: string | null;
    content: Uint8Array | null;
    _id: string | null;
    constructor({ type, path, url, content, _id, }?: AttachmentInit);
    id(): string;
    /**
     * Return the content type, guessing from content if not specified.
     * Async because URL attachments need a network round-trip; all other
     * sources resolve synchronously (use resolveTypeSync for those).
     */
    resolveType(): Promise<string | null>;
    /** Sync variant used where Python resolved types synchronously; throws
     * for URL attachments without an explicit type. */
    resolveTypeSync(): string | null;
    /** Return the binary content, reading from path or URL if needed. */
    contentBytes(): Promise<Uint8Array | null>;
    /** Return the content as a base64-encoded string. */
    base64Content(): Promise<string>;
    toString(): string;
    static fromRow(row: Record<string, unknown>): Attachment;
}
type AnyFunction = (...args: any[]) => any;
export interface ToolInit {
    name: string;
    description?: string | null;
    input_schema?: Record<string, unknown> | typeof BaseModel;
    implementation?: AnyFunction | null;
    plugin?: string | null;
}
export declare class Tool {
    name: string;
    description: string | null;
    input_schema: Record<string, unknown>;
    implementation: AnyFunction | null;
    plugin: string | null;
    constructor({ name, description, input_schema, implementation, plugin, }: ToolInit);
    hash(): string;
    /**
     * Turn a function into a Tool object. Type information is erased at
     * runtime in TS, so parameter types come from an optional
     * `fn.annotations = {param: "integer"}` map and default to "string";
     * descriptions come from `fn.description` (the docstring stand-in).
     */
    static function(fn: AnyFunction, { name, description, }?: {
        name?: string | null;
        description?: string | null;
    }): Tool;
}
export declare class Toolbox {
    static toolboxName: string | null;
    static plugin: string | null;
    instance_id: number | null;
    plugin: string | null;
    _extra_tools: Tool[];
    _config: Record<string, unknown>;
    _prepared: boolean;
    _async_prepared: boolean;
    /**
     * Python's __init_subclass__ wraps __init__ to capture constructor
     * kwargs into _config. TS constructors take a single options object by
     * convention; the base constructor stores it.
     */
    constructor(config?: Record<string, unknown>);
    static get name_(): string;
    static method_tools(): Tool[];
    /** An llm.Tool() for each class method, plus extras from add_tool(). */
    tools(): Generator<Tool>;
    /** Add a tool to this toolbox. */
    add_tool(toolOrFunction: Tool | AnyFunction, passSelf?: boolean): void;
    /**
     * Over-ride this to perform setup (and .add_tool() calls) before the
     * toolbox is used. Implement prepare_async() for async setup.
     */
    prepare(): void;
    prepare_async(): Promise<void>;
}
export declare class ToolCall {
    name: string;
    arguments: Record<string, unknown>;
    tool_call_id: string | null;
    constructor({ name, arguments: args, tool_call_id, }: {
        name: string;
        arguments: Record<string, unknown>;
        tool_call_id?: string | null;
    });
}
export declare class ToolResult {
    name: string;
    output: string;
    attachments: Attachment[];
    tool_call_id: string | null;
    instance: Toolbox | null;
    exception: Error | null;
    constructor({ name, output, attachments, tool_call_id, instance, exception, }: {
        name: string;
        output: string;
        attachments?: Attachment[];
        tool_call_id?: string | null;
        instance?: Toolbox | null;
        exception?: Error | null;
    });
}
export declare class ToolOutput {
    output: string | Record<string, unknown> | unknown[] | boolean | number | null;
    attachments: Attachment[];
    constructor({ output, attachments, }?: {
        output?: ToolOutput["output"];
        attachments?: Attachment[];
    });
}
export type ToolDef = Tool | Toolbox | AnyFunction;
export type BeforeCallSync = (tool: Tool | null, toolCall: ToolCall) => void | Promise<void>;
export type AfterCallSync = (tool: Tool, toolCall: ToolCall, toolResult: ToolResult) => void | Promise<void>;
export type BeforeCallAsync = BeforeCallSync;
export type AfterCallAsync = AfterCallSync;
export declare class CancelToolCall extends Error {
    constructor(message?: string);
}
/**
 * Raise inside a tool implementation to pause the chain. Before it is
 * re-raised the framework populates `tool_call` and `tool_results`.
 */
export declare class PauseChain extends Error {
    tool_call: ToolCall | null;
    tool_results: ToolResult[];
    constructor(message?: string);
}
export interface PromptInit {
    fragments?: Array<string | Fragment> | null;
    attachments?: Attachment[] | null;
    system?: string | null;
    system_fragments?: Array<string | Fragment> | null;
    prompt_json?: string | null;
    options?: BaseModel | Record<string, unknown> | null;
    schema?: Record<string, unknown> | typeof BaseModel | null;
    tools?: ToolDef[] | null;
    tool_results?: ToolResult[] | null;
    messages?: Message[] | null;
    hide_reasoning?: boolean;
}
export declare class Prompt {
    _prompt: string | null;
    model: _BaseModel;
    fragments: Array<string | Fragment>;
    attachments: Attachment[];
    _system: string | null;
    system_fragments: Array<string | Fragment>;
    prompt_json: string | null;
    schema: Record<string, unknown> | null;
    tools: Tool[];
    tool_results: ToolResult[];
    options: BaseModel | Record<string, unknown>;
    hide_reasoning: boolean;
    _explicit_messages: Message[] | null;
    constructor(prompt: string | null, model: _BaseModel, { fragments, attachments, system, system_fragments, prompt_json, options, schema, tools, tool_results, messages, hide_reasoning, }?: PromptInit);
    /** The text of the prompt, with any fragments concatenated. */
    get prompt(): string;
    /** The system prompt, with any system fragments concatenated. */
    get system(): string;
    /**
     * Canonical list of Message objects for this prompt. See the Python
     * docstring: if messages= was passed explicitly it is authoritative;
     * otherwise the list is synthesized from the legacy kwargs.
     */
    get messages(): Message[];
}
export interface ConversationInit {
    model: _BaseModel;
    id?: string;
    name?: string | null;
    responses?: _BaseResponse[];
    tools?: ToolDef[] | null;
    chain_limit?: number | null;
    before_call?: BeforeCallSync | null;
    after_call?: AfterCallSync | null;
}
export declare abstract class _BaseConversation {
    model: _BaseModel;
    id: string;
    name: string | null;
    responses: _BaseResponse[];
    tools: ToolDef[] | null;
    chain_limit: number | null;
    constructor({ model, id, name, responses, tools, chain_limit, }: ConversationInit);
    /**
     * Build the full message chain for the next turn. See Python
     * _BaseConversation._build_full_chain.
     */
    protected buildFullChain({ prompt, attachments, tool_results, explicit_messages, system, system_fragments, }: {
        prompt: string | null;
        attachments: Attachment[] | null | undefined;
        tool_results: ToolResult[] | null | undefined;
        explicit_messages: Message[] | null | undefined;
        system?: string | null;
        system_fragments?: Array<string | Fragment> | null;
    }): Message[];
    toString(): string;
}
export interface PromptOptions {
    fragments?: Array<string | Fragment> | null;
    attachments?: Attachment[] | null;
    system?: string | null;
    schema?: Record<string, unknown> | typeof BaseModel | null;
    tools?: ToolDef[] | null;
    tool_results?: ToolResult[] | null;
    system_fragments?: Array<string | Fragment> | null;
    messages?: Message[] | null;
    stream?: boolean;
    key?: string | null;
    options?: Record<string, unknown> | null;
    hide_reasoning?: boolean;
    [option: string]: unknown;
}
export interface ChainOptions extends PromptOptions {
    chain_limit?: number | null;
    before_call?: BeforeCallSync | null;
    after_call?: AfterCallSync | null;
}
export declare class Conversation extends _BaseConversation {
    before_call: BeforeCallSync | null;
    after_call: AfterCallSync | null;
    model: _Model;
    responses: Response[];
    constructor(init: ConversationInit);
    prompt(prompt?: string | null, opts?: PromptOptions): Response;
    chain(prompt?: string | null, opts?: ChainOptions): ChainResponse;
    static fromRow(row: Record<string, unknown>): Promise<Conversation>;
}
export declare class AsyncConversation extends _BaseConversation {
    before_call: BeforeCallAsync | null;
    after_call: AfterCallAsync | null;
    model: _AsyncModel;
    responses: AsyncResponse[];
    constructor(init: ConversationInit);
    chain(prompt?: string | null, opts?: ChainOptions): AsyncChainResponse;
    prompt(prompt?: string | null, opts?: PromptOptions): AsyncResponse;
    toSyncConversation(): Conversation;
    static fromRow(row: Record<string, unknown>): Promise<AsyncConversation>;
}
export declare const FRAGMENT_SQL = "\nselect\n    'prompt' as fragment_type,\n    fragments.content,\n    pf.\"order\" as ord\nfrom prompt_fragments pf\njoin fragments on pf.fragment_id = fragments.id\nwhere pf.response_id = :response_id\nunion all\nselect\n    'system' as fragment_type,\n    fragments.content,\n    sf.\"order\" as ord\nfrom system_fragments sf\njoin fragments on sf.fragment_id = fragments.id\nwhere sf.response_id = :response_id\norder by fragment_type desc, ord asc;\n";
type EventFamily = "text" | "reasoning" | "tool_call" | "tool_result";
export declare abstract class _BaseResponse {
    id: string;
    prompt: Prompt;
    model: _BaseModel;
    stream: boolean;
    resolved_model: string | null;
    conversation: _BaseConversation | null;
    _key: string | null;
    _prompt_json: unknown;
    _chunks: string[];
    _stream_events: StreamEvent[];
    _auto_index_max: number;
    _auto_last_index: number | null;
    _auto_last_family: string | null;
    _auto_tool_id_to_index: Record<string, number>;
    _done: boolean;
    _tool_calls: ToolCall[];
    response_json: Record<string, unknown> | null;
    attachments: Attachment[];
    _start: number | null;
    _end: number | null;
    _start_utcnow: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    token_details: Record<string, unknown> | null;
    done_callbacks: Array<(response: any) => unknown>;
    _loaded_messages: Message[] | null;
    constructor(prompt: Prompt, model: _BaseModel, stream: boolean, conversation?: _BaseConversation | null, key?: string | null);
    /** Assemble messages assuming the response is already drained. */
    messagesNow(): Message[];
    protected static eventFamily(eventType: string): EventFamily;
    /** Mutate event.part_index in place when the plugin left it null. */
    protected resolvePartIndex(event: StreamEvent): void;
    /**
     * Normalize a chunk from execute() into a StreamEvent and return the
     * text string (or null) that iteration should yield.
     */
    protected processChunk(chunk: string | StreamEvent): string | null;
    /** Assemble Part objects from the accumulated stream events. */
    protected buildParts(): Part[];
    add_tool_call(toolCall: ToolCall): void;
    set_usage({ input, output, details, }?: {
        input?: number | null;
        output?: number | null;
        details?: Record<string, unknown> | null;
    }): void;
    set_resolved_model(modelId: string): void;
    token_usage(): string;
    abstract text_or_raise(): string;
    /**
     * Log this response to the database. Async in TS because attachment
     * type resolution may require a network fetch.
     */
    logToDb(db: any): Promise<void>;
    protected durationMsNow(): number;
    protected datetimeUtcNow(): string;
    static fromRowBase(cls: new (prompt: Prompt, model: _BaseModel, stream: boolean) => _BaseResponse, db: any, row: Record<string, unknown>, _async?: boolean): Promise<_BaseResponse>;
}
export declare class Response extends _BaseResponse {
    model: _Model;
    conversation: Conversation | null;
    /**
     * Continue the conversation from this response. Async in TS because it
     * may auto-execute tool calls.
     */
    reply(prompt?: string | null, { messages, tool_results, options, ...kwargs }?: {
        messages?: Message[] | null;
        tool_results?: ToolResult[] | null;
        options?: Record<string, unknown> | null;
        [key: string]: unknown;
    }): Promise<Response>;
    /** Serialize this response for JSON persistence. */
    toDict(): ResponseDict;
    static fromDict(data: ResponseDict, { model }?: {
        model?: Model | null;
    }): Promise<Response>;
    static fromRow(db: any, row: Record<string, unknown>): Promise<Response>;
    /** Register a callback to be called when the response is complete. */
    on_done(callback: (response: Response) => unknown): void;
    protected onDone(): void;
    _force(): void;
    /** Return the full text of the response, executing the prompt if needed. */
    text(): string;
    text_or_raise(): string;
    /**
     * Execute tool calls using this response's tools. Async in TS (Python
     * used asyncio.run for coroutine tools inside sync code).
     */
    execute_tool_calls({ before_call, after_call, tool_calls_list, }?: {
        before_call?: BeforeCallSync | null;
        after_call?: AfterCallSync | null;
        tool_calls_list?: ToolCall[] | null;
    }): Promise<ToolResult[]>;
    /** Return the list of tool calls made during this response. */
    tool_calls(): ToolCall[];
    tool_calls_or_raise(): ToolCall[];
    /** Return the raw JSON response from the model, if available. */
    json(): Record<string, unknown> | null;
    duration_ms(): number;
    datetime_utc(): string;
    /** Return token usage information for this response. */
    usage(): Usage;
    protected rawGenerator(): Generator<string | StreamEvent> | AsyncGenerator<string | StreamEvent>;
    protected iterEvents(): Generator<string | StreamEvent>;
    protected iterEventsAsync(): AsyncGenerator<string | StreamEvent>;
    /** Async counterpart of _force() for fetch-backed sync-API models. */
    forceAsync(): Promise<void>;
    /** Async counterpart of text(). */
    textAsync(): Promise<string>;
    /** Async iteration works for both sync and async model generators. */
    [Symbol.asyncIterator](): AsyncGenerator<string>;
    /** Async counterpart of stream_events(). */
    streamEventsAsync(): AsyncGenerator<StreamEvent>;
    /** Async counterpart of messages(). */
    messagesAsync(): Promise<Message[]>;
    [Symbol.iterator](): Generator<string>;
    /** Yield StreamEvent objects as the model produces them. */
    stream_events(): Generator<StreamEvent>;
    /** List of Message objects produced by this response. */
    messages(): Message[];
    toString(): string;
}
export declare class AsyncResponse extends _BaseResponse {
    model: _AsyncModel;
    conversation: AsyncConversation | null;
    private _generator?;
    private _iter_chunks?;
    /** Async counterpart of Response.reply(). Requires awaiting first. */
    reply(prompt?: string | null, { messages, tool_results, options, ...kwargs }?: {
        messages?: Message[] | null;
        tool_results?: ToolResult[] | null;
        options?: Record<string, unknown> | null;
        [key: string]: unknown;
    }): Promise<AsyncResponse>;
    toDict(): ResponseDict;
    static fromDict(data: ResponseDict, { model }?: {
        model?: AsyncModel | null;
    }): Promise<AsyncResponse>;
    static fromRow(db: any, row: Record<string, unknown>): Promise<AsyncResponse>;
    /** Register a callback to be called when the response is complete. */
    on_done(callback: ((response: AsyncResponse) => unknown) | Promise<unknown>): Promise<void>;
    protected onDoneAsync(): Promise<void>;
    /** Execute tool calls using this response's tools. */
    execute_tool_calls({ before_call, after_call, tool_calls_list, }?: {
        before_call?: BeforeCallAsync | null;
        after_call?: AfterCallAsync | null;
        tool_calls_list?: ToolCall[] | null;
    }): Promise<ToolResult[]>;
    private ensureAsyncGenerator;
    private asyncFinalize;
    [Symbol.asyncIterator](): AsyncIterator<string>;
    /** Yield StreamEvent objects as the model produces them (async). */
    astream_events(): AsyncGenerator<StreamEvent>;
    /** List of Message objects produced by this response. */
    messages(): Promise<Message[]>;
    _force(): Promise<void>;
    text_or_raise(): string;
    /** Return the full text of the response, executing the prompt if needed. */
    text(): Promise<string>;
    /** Return the list of tool calls made during this response. */
    tool_calls(): Promise<ToolCall[]>;
    tool_calls_or_raise(): ToolCall[];
    /** Return the raw JSON response from the model, if available. */
    json(): Promise<Record<string, unknown> | null>;
    duration_ms(): Promise<number>;
    datetime_utc(): Promise<string>;
    /** Return token usage information for this response. */
    usage(): Promise<Usage>;
    /**
     * Makes `await response` work like Python's `__await__` (resolves to
     * the drained response). JS promise resolution would recurse forever
     * on a thenable that resolves to itself, so the fulfilled value is a
     * prototype-delegating view of this response with `then` masked off —
     * it behaves identically (instanceof, methods, state) but is not
     * itself thenable.
     */
    then(onfulfilled?: ((value: any) => any) | null, onrejected?: ((reason: unknown) => any) | null): Promise<any>;
    toSyncResponse(): Promise<Response>;
    /** Utility method to help with writing tests. */
    static fake({ model, prompt, attachments, system, response, }: {
        model: AsyncModel;
        prompt: string;
        attachments?: Attachment[];
        system: string | null;
        response: string;
    }): AsyncResponse;
    toString(): string;
}
export declare abstract class _BaseChainResponse {
    prompt: Prompt;
    model: _BaseModel;
    stream: boolean;
    conversation: _BaseConversation | null;
    _key: string | null;
    _responses: _BaseResponse[];
    chain_limit: number | null;
    before_call: BeforeCallSync | null;
    after_call: AfterCallSync | null;
    constructor(prompt: Prompt, model: _BaseModel, stream: boolean, conversation: _BaseConversation, key?: string | null, chain_limit?: number | null, before_call?: BeforeCallSync | null, after_call?: AfterCallSync | null);
    logToDb(db: any): Promise<void>;
    /** Unresolved tool calls at the end of this chain's history. */
    protected pendingToolCalls(): ToolCall[];
    /** The first prompt for a resumed chain. */
    protected resumePrompt(toolResults: ToolResult[]): Prompt;
}
export declare class ChainResponse extends _BaseChainResponse {
    _responses: Response[];
    /**
     * Async generator in TS (Python's is sync) because tool execution is
     * async. Yields each Response in the chain.
     */
    responses(): AsyncGenerator<Response>;
    [Symbol.asyncIterator](): AsyncGenerator<string>;
    /** Yield StreamEvents from every response in the chain. */
    stream_events(): AsyncGenerator<StreamEvent>;
    text(): Promise<string>;
}
export declare class AsyncChainResponse extends _BaseChainResponse {
    _responses: AsyncResponse[];
    responses(): AsyncGenerator<AsyncResponse>;
    [Symbol.asyncIterator](): AsyncGenerator<string>;
    /** Yield StreamEvents from every response in the chain. */
    astream_events(): AsyncGenerator<StreamEvent>;
    text(): Promise<string>;
}
export declare class Options extends BaseModel {
}
export declare abstract class _getKeyMixin {
    needs_key: string | null;
    key: string | null;
    key_env_var: string | null;
    get_key(explicitKey?: string | null): string | null;
}
export declare abstract class _BaseModel extends _getKeyMixin {
    model_id: string;
    can_stream: boolean;
    attachment_types: Set<string>;
    supports_schema: boolean;
    supports_tools: boolean;
    static Options: typeof Options;
    /**
     * The Options class for this model. Instance-level so constructors can
     * override it per instance (matching Python's `self.Options = ...`);
     * initialized from the class-level static.
     */
    Options: typeof Options;
    /** Build an Options instance for this model (`self.Options(**merged)`). */
    makeOptions(data: Record<string, unknown>): BaseModel;
    /**
     * Synchronous attachment validation: catches the checks Python did
     * eagerly, minus URL type resolution which requires the network (that
     * happens at execution/logging time in TS).
     */
    validateAttachmentsSync(attachments: Attachment[] | null | undefined): void;
    validateAttachments(attachments: Attachment[] | null | undefined): Promise<void>;
    toString(): string;
}
export declare abstract class _Model extends _BaseModel {
    conversation({ tools, before_call, after_call, chain_limit, }?: {
        tools?: ToolDef[] | null;
        before_call?: BeforeCallSync | null;
        after_call?: AfterCallSync | null;
        chain_limit?: number | null;
    }): Conversation;
    prompt(prompt?: string | null, opts?: PromptOptions): Response;
    chain(prompt?: string | null, opts?: ChainOptions): ChainResponse;
}
export declare abstract class Model extends _Model {
    /**
     * May return an async generator (fetch-backed models); such models
     * must be driven via the Response async APIs.
     */
    abstract execute(prompt: Prompt, stream: boolean, response: Response, conversation: Conversation | null): Generator<string | StreamEvent> | AsyncGenerator<string | StreamEvent>;
}
export declare abstract class KeyModel extends _Model {
    abstract execute(prompt: Prompt, stream: boolean, response: Response, conversation: Conversation | null, key: string | null): Generator<string | StreamEvent> | AsyncGenerator<string | StreamEvent>;
}
export declare abstract class _AsyncModel extends _BaseModel {
    conversation({ tools, before_call, after_call, chain_limit, }?: {
        tools?: ToolDef[] | null;
        before_call?: BeforeCallAsync | null;
        after_call?: AfterCallAsync | null;
        chain_limit?: number | null;
    }): AsyncConversation;
    prompt(prompt?: string | null, opts?: PromptOptions): AsyncResponse;
    chain(prompt?: string | null, opts?: ChainOptions): AsyncChainResponse;
}
export declare abstract class AsyncModel extends _AsyncModel {
    abstract execute(prompt: Prompt, stream: boolean, response: AsyncResponse, conversation: AsyncConversation | null): AsyncGenerator<string | StreamEvent>;
}
export declare abstract class AsyncKeyModel extends _AsyncModel {
    abstract execute(prompt: Prompt, stream: boolean, response: AsyncResponse, conversation: AsyncConversation | null, key: string | null): AsyncGenerator<string | StreamEvent>;
}
export declare abstract class EmbeddingModel extends _getKeyMixin {
    model_id: string;
    supports_text: boolean;
    supports_binary: boolean;
    batch_size: number | null;
    protected check(item: string | Uint8Array): void;
    /** Embed a single text string or binary blob, return a list of floats.
     * Async in TS: embedding models hit the network. */
    embed(item: string | Uint8Array): Promise<number[]>;
    /** Embed multiple items in batches according to the model batch_size. */
    embedMulti(items: Iterable<string | Uint8Array>, batchSize?: number | null): AsyncGenerator<number[]>;
    /** Embed a batch of strings or blobs, yield lists of floats. */
    abstract embedBatch(items: Iterable<string | Uint8Array>): AsyncGenerator<number[]>;
    toString(): string;
}
export declare class ModelWithAliases {
    model: Model;
    async_model: AsyncModel;
    aliases: string[];
    constructor(model: Model, asyncModel: AsyncModel, aliases: string[]);
    matches(query: string): boolean;
}
export declare class EmbeddingModelWithAliases {
    model: EmbeddingModel;
    aliases: string[];
    constructor(model: EmbeddingModel, aliases: string[]);
    matches(query: string): boolean;
}
export {};
