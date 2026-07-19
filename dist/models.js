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
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { NeedsKeyException } from "./errors.js";
import { getKey } from "./config.js";
import { makeSchemaId, mimetypeFromPath, mimetypeFromString, monotonicUlid, tokenUsageString, } from "./utils.js";
import { condenseJson } from "./condense.js";
import { dumps } from "./pyjson.js";
import { BaseModel } from "./pydantic.js";
import { acceptsParam, callWithKwargs, parseParams } from "./introspect.js";
import { AttachmentPart, Message, ReasoningPart, StreamEvent, TextPart, ToolCallPart, ToolResultPart, } from "./parts.js";
export const CONVERSATION_NAME_LENGTH = 32;
export class Usage {
    // "Token usage information from a model response."
    input;
    output;
    details;
    constructor({ input = null, output = null, details = null, } = {}) {
        this.input = input;
        this.output = output;
        this.details = details;
    }
}
export class Attachment {
    // "An attachment (image, audio, etc) to include with a prompt."
    type;
    path;
    url;
    content;
    _id;
    constructor({ type = null, path = null, url = null, content = null, _id = null, } = {}) {
        this.type = type;
        this.path = path;
        this.url = url;
        this.content = content;
        this._id = _id;
    }
    id() {
        // Hash of the binary content, or of '{"url": "https://..."}' for URL attachments
        if (this._id === null) {
            if (this.content && this.content.length) {
                this._id = createHash("sha256").update(this.content).digest("hex");
            }
            else if (this.path) {
                this._id = createHash("sha256")
                    .update(fs.readFileSync(this.path))
                    .digest("hex");
            }
            else {
                this._id = createHash("sha256")
                    .update(dumps({ url: this.url }), "utf8")
                    .digest("hex");
            }
        }
        return this._id;
    }
    /**
     * Return the content type, guessing from content if not specified.
     * Async because URL attachments need a network round-trip; all other
     * sources resolve synchronously (use resolveTypeSync for those).
     */
    async resolveType() {
        if (this.type)
            return this.type;
        if (this.path)
            return mimetypeFromPath(this.path);
        if (this.url) {
            const response = await fetch(this.url, { method: "HEAD" });
            if (!response.ok) {
                throw new Error(`HTTP error ${response.status} while resolving type of ${this.url}`);
            }
            return response.headers.get("content-type");
        }
        if (this.content && this.content.length) {
            return mimetypeFromString(this.content);
        }
        throw new Error("Attachment has no type and no content to derive it from");
    }
    /** Sync variant used where Python resolved types synchronously; throws
     * for URL attachments without an explicit type. */
    resolveTypeSync() {
        if (this.type)
            return this.type;
        if (this.path)
            return mimetypeFromPath(this.path);
        if (this.content && this.content.length) {
            return mimetypeFromString(this.content);
        }
        if (this.url) {
            throw new Error("Attachment type for URL attachments must be resolved asynchronously");
        }
        throw new Error("Attachment has no type and no content to derive it from");
    }
    /** Return the binary content, reading from path or URL if needed. */
    async contentBytes() {
        let content = this.content;
        if (!content || !content.length) {
            if (this.path) {
                content = fs.readFileSync(this.path);
            }
            else if (this.url) {
                const response = await fetch(this.url);
                if (!response.ok) {
                    throw new Error(`HTTP error ${response.status} fetching ${this.url}`);
                }
                content = new Uint8Array(await response.arrayBuffer());
            }
        }
        return content;
    }
    /** Return the content as a base64-encoded string. */
    async base64Content() {
        const bytes = await this.contentBytes();
        return Buffer.from(bytes ?? new Uint8Array()).toString("base64");
    }
    toString() {
        const info = [`<Attachment: ${this.id()}`];
        if (this.type)
            info.push(`type="${this.type}"`);
        if (this.path)
            info.push(`path="${this.path}"`);
        if (this.url)
            info.push(`url="${this.url}"`);
        if (this.content && this.content.length) {
            info.push(`content=${this.content.length} bytes`);
        }
        return info.join(" ") + ">";
    }
    static fromRow(row) {
        return new Attachment({
            _id: row.id,
            type: row.type,
            path: row.path,
            url: row.url,
            content: row.content ?? null,
        });
    }
}
export class Tool {
    // "A tool that can be called by a model."
    name;
    description;
    input_schema;
    implementation;
    plugin; // plugin tool came from, e.g. 'llm_tools_sqlite'
    constructor({ name, description = null, input_schema = {}, implementation = null, plugin = null, }) {
        this.name = name;
        this.description = description;
        this.input_schema = ensureDictSchema(input_schema) ?? {};
        this.implementation = implementation;
        this.plugin = plugin;
    }
    hash() {
        // Hash for tool based on its name, description and input schema (preserving key order)
        const toHash = {
            name: this.name,
            description: this.description,
            input_schema: this.input_schema,
        };
        if (this.plugin) {
            toHash.plugin = this.plugin;
        }
        return createHash("sha256").update(dumps(toHash), "utf8").digest("hex");
    }
    /**
     * Turn a function into a Tool object. Type information is erased at
     * runtime in TS, so parameter types come from an optional
     * `fn.annotations = {param: "integer"}` map and default to "string";
     * descriptions come from `fn.description` (the docstring stand-in).
     */
    static function(fn, { name = null, description = null, } = {}) {
        const fnName = fn.__name__ ??
            (fn.__wrapped__?.name || fn.name);
        if (!name && !fnName) {
            throw new Error("Cannot create a Tool from a lambda function without providing name=");
        }
        return new Tool({
            name: name || fnName,
            description: description ??
                fn.description ??
                null,
            input_schema: getArgumentsInputSchema(fn),
            implementation: fn,
        });
    }
}
function getArgumentsInputSchema(fn) {
    const annotations = fn.annotations ?? {};
    const properties = {};
    const required = [];
    for (const param of parseParams(fn)) {
        if (param.name === "self" || param.name === "llm_tool_call") {
            // llm_tool_call is reserved: populated with the ToolCall object
            // at execution time, never exposed to the model.
            continue;
        }
        const ann = annotations[param.name];
        let prop;
        if (ann && typeof ann === "object") {
            prop = { ...ann };
        }
        else {
            prop = { type: ann ?? "string" };
        }
        if (param.hasDefault) {
            prop.default = param.default ?? null;
        }
        else {
            required.push(param.name);
        }
        properties[param.name] = prop;
    }
    const schema = { properties, type: "object" };
    if (required.length) {
        schema.required = required;
    }
    return schema;
}
function accepts_llm_tool_call(implementation) {
    if (!implementation)
        return false;
    return acceptsParam(implementation, "llm_tool_call");
}
function implementationArguments(tool, toolCall) {
    // Implementations with an explicit `llm_tool_call` parameter receive
    // the ToolCall object itself.
    const args = { ...toolCall.arguments };
    if (accepts_llm_tool_call(tool.implementation)) {
        args.llm_tool_call = toolCall;
    }
    return args;
}
const TOOLBOX_BLOCKED = new Set([
    "tools",
    "add_tool",
    "method_tools",
    "prepare",
    "prepare_async",
    "constructor",
]);
export class Toolbox {
    static toolboxName = null;
    static plugin = null;
    instance_id = null;
    plugin = null;
    _extra_tools = [];
    _config = {};
    _prepared = false;
    _async_prepared = false;
    /**
     * Python's __init_subclass__ wraps __init__ to capture constructor
     * kwargs into _config. TS constructors take a single options object by
     * convention; the base constructor stores it.
     */
    constructor(config = {}) {
        this._config = { ...config };
        this._extra_tools = [];
        const cls = this.constructor;
        if (cls.plugin)
            this.plugin = cls.plugin;
    }
    static get name_() {
        return this.toolboxName ?? this.name;
    }
    static method_tools() {
        const tools = [];
        for (const methodName of toolboxMethodNames(this)) {
            const method = this.prototype[methodName];
            tools.push(Tool.function(method, { name: `${this.name}_${methodName}` }));
        }
        return tools;
    }
    /** An llm.Tool() for each class method, plus extras from add_tool(). */
    *tools() {
        const cls = this.constructor;
        for (const name of toolboxMethodNames(cls)) {
            const method = this[name];
            if (typeof method !== "function")
                continue;
            const bound = Object.assign((...args) => method.apply(this, args), { __wrapped__: method, __self__: this, __name__: name });
            const tool = Tool.function(bound, {
                name: `${cls.name}_${name}`,
            });
            tool.plugin = this.plugin ?? null;
            yield tool;
        }
        yield* this._extra_tools;
    }
    /** Add a tool to this toolbox. */
    add_tool(toolOrFunction, passSelf = false) {
        if (toolOrFunction instanceof Tool) {
            this._extra_tools.push(toolOrFunction);
        }
        else if (typeof toolOrFunction === "function") {
            let fn = toolOrFunction;
            if (passSelf) {
                const original = toolOrFunction;
                fn = Object.assign((...args) => original.call(null, this, ...args), {
                    __wrapped__: original,
                    __self__: this,
                    __name__: original.name,
                    annotations: original.annotations,
                    description: original.description,
                });
                // Python's MethodType binds self as the first parameter, hiding
                // it from the schema. Mirror that by masking the first param.
                fn.__boundFirstParam__ = true;
            }
            this._extra_tools.push(toolFunctionSkippingFirst(fn, passSelf));
        }
        else {
            throw new Error("Tool must be an instance of Tool or a callable function");
        }
    }
    /**
     * Over-ride this to perform setup (and .add_tool() calls) before the
     * toolbox is used. Implement prepare_async() for async setup.
     */
    prepare() { }
    async prepare_async() { }
}
function toolFunctionSkippingFirst(fn, skipFirst) {
    if (!skipFirst)
        return Tool.function(fn);
    const original = fn.__wrapped__ ?? fn;
    const params = parseParams(original).slice(1); // drop bound self
    const annotations = original
        .annotations ?? {};
    const properties = {};
    const required = [];
    for (const param of params) {
        if (param.name === "llm_tool_call")
            continue;
        const ann = annotations[param.name];
        const prop = ann && typeof ann === "object"
            ? { ...ann }
            : { type: ann ?? "string" };
        if (param.hasDefault)
            prop.default = param.default ?? null;
        else
            required.push(param.name);
        properties[param.name] = prop;
    }
    const schema = { properties, type: "object" };
    if (required.length)
        schema.required = required;
    // Invocation maps kwargs onto the original params minus the bound self.
    const wrapper = Object.assign((...args) => fn(...args), {
        __wrapped2__: original,
        __self__: fn.__self__,
        __kwargNames__: params.map((p) => p.name),
    });
    return new Tool({
        name: original.__name__ ?? original.name,
        description: original.description ?? null,
        input_schema: schema,
        implementation: wrapper,
    });
}
function toolboxMethodNames(cls) {
    const names = [];
    const seen = new Set();
    let proto = cls.prototype;
    const chain = [];
    while (proto && proto !== Object.prototype) {
        chain.push(proto);
        proto = Object.getPrototypeOf(proto);
    }
    // Python's dir() sorts names; match that for deterministic ordering.
    for (const p of chain) {
        for (const name of Object.getOwnPropertyNames(p)) {
            if (seen.has(name))
                continue;
            seen.add(name);
            if (name.startsWith("_") || TOOLBOX_BLOCKED.has(name))
                continue;
            const desc = Object.getOwnPropertyDescriptor(p, name);
            if (!desc || typeof desc.value !== "function")
                continue;
            names.push(name);
        }
    }
    return names.sort();
}
export class ToolCall {
    // "A request by the model to call a tool."
    name;
    arguments;
    tool_call_id;
    constructor({ name, arguments: args, tool_call_id = null, }) {
        this.name = name;
        this.arguments = args;
        this.tool_call_id = tool_call_id;
    }
}
export class ToolResult {
    // "The result of executing a tool call."
    name;
    output;
    attachments;
    tool_call_id;
    instance;
    exception;
    constructor({ name, output, attachments = [], tool_call_id = null, instance = null, exception = null, }) {
        this.name = name;
        this.output = output;
        this.attachments = attachments;
        this.tool_call_id = tool_call_id;
        this.instance = instance;
        this.exception = exception;
    }
}
export class ToolOutput {
    // "Tool functions can return output with extra attachments"
    output;
    attachments;
    constructor({ output = null, attachments = [], } = {}) {
        this.output = output;
        this.attachments = attachments;
    }
}
export class CancelToolCall extends Error {
    constructor(message) {
        super(message);
        this.name = "CancelToolCall";
    }
}
/**
 * Raise inside a tool implementation to pause the chain. Before it is
 * re-raised the framework populates `tool_call` and `tool_results`.
 */
export class PauseChain extends Error {
    tool_call = null;
    tool_results = [];
    constructor(message) {
        super(message);
        this.name = "PauseChain";
    }
}
export class Prompt {
    // "The prompt being sent to the model."
    _prompt;
    model;
    fragments;
    attachments;
    _system;
    system_fragments;
    prompt_json;
    schema;
    tools;
    tool_results;
    options;
    hide_reasoning;
    _explicit_messages;
    constructor(prompt, model, { fragments = null, attachments = null, system = null, system_fragments = null, prompt_json = null, options = null, schema = null, tools = null, tool_results = null, messages = null, hide_reasoning = false, } = {}) {
        this._prompt = prompt;
        this.model = model;
        this.attachments = [...(attachments ?? [])];
        this.fragments = fragments ?? [];
        this._system = system;
        this.system_fragments = system_fragments ?? [];
        this.prompt_json = prompt_json;
        // Unlike Tool (which strips titles), Prompt keeps the schema verbatim;
        // a pydantic-style class converts via modelJsonSchema().
        if (schema &&
            typeof schema === "function" &&
            schema.prototype instanceof BaseModel) {
            this.schema = schema.modelJsonSchema();
        }
        else {
            this.schema = schema ?? null;
        }
        this.tools = wrapTools(tools ?? []);
        this.tool_results = tool_results ?? [];
        this.options = options ?? {};
        this.hide_reasoning = hide_reasoning;
        // Explicit messages= list, if the caller supplied one. Copied so
        // later mutation by the caller doesn't alter the Prompt.
        this._explicit_messages = messages !== null ? [...messages] : null;
    }
    /** The text of the prompt, with any fragments concatenated. */
    get prompt() {
        const bits = this.fragments.map((f) => String(f));
        if (this._prompt)
            bits.push(String(this._prompt));
        return bits.join("\n");
    }
    /** The system prompt, with any system fragments concatenated. */
    get system() {
        return combineSystem(this._system, this.system_fragments);
    }
    /**
     * Canonical list of Message objects for this prompt. See the Python
     * docstring: if messages= was passed explicitly it is authoritative;
     * otherwise the list is synthesized from the legacy kwargs.
     */
    get messages() {
        if (this._explicit_messages !== null) {
            return [...this._explicit_messages];
        }
        const result = [];
        if (this.system) {
            result.push(new Message({
                role: "system",
                parts: [new TextPart({ text: this.system })],
            }));
        }
        if (this.tool_results.length) {
            result.push(new Message({
                role: "tool",
                parts: this.tool_results.map((tr) => new ToolResultPart({
                    name: tr.name,
                    output: tr.output,
                    tool_call_id: tr.tool_call_id,
                })),
            }));
        }
        const userParts = [];
        if (this.prompt) {
            userParts.push(new TextPart({ text: this.prompt }));
        }
        for (const att of this.attachments) {
            userParts.push(new AttachmentPart({ attachment: att }));
        }
        if (userParts.length) {
            result.push(new Message({ role: "user", parts: userParts }));
        }
        return result;
    }
}
function wrapTools(tools) {
    const wrapped = [];
    for (const tool of tools) {
        if (tool instanceof Tool) {
            wrapped.push(tool);
        }
        else if (tool instanceof Toolbox) {
            wrapped.push(...tool.tools());
        }
        else if (typeof tool === "function") {
            wrapped.push(Tool.function(tool));
        }
        else {
            throw new Error(`Invalid tool: ${String(tool)}`);
        }
    }
    return wrapped;
}
function combineSystem(system, systemFragments) {
    // Concatenate the system prompt and any system fragments into one string.
    const bits = [...(systemFragments ?? []), system ?? ""]
        .map((bit) => String(bit).trim())
        .filter(Boolean);
    return bits.join("\n\n");
}
function mergeOptions(options, kwargs) {
    if (!options)
        return kwargs;
    const overlap = Object.keys(options).filter((k) => k in kwargs);
    if (overlap.length) {
        throw new TypeError(`Got values for these options both in options= and as keyword arguments: ${JSON.stringify(overlap.sort())}`);
    }
    return { ...options, ...kwargs };
}
function utcNowIso() {
    // Python datetime.now(timezone.utc).isoformat() style: +00:00 suffix
    return new Date().toISOString().replace("Z", "+00:00");
}
function monotonicSeconds() {
    return performance.now() / 1000;
}
export class _BaseConversation {
    model;
    id;
    name;
    responses;
    tools;
    chain_limit;
    constructor({ model, id, name = null, responses, tools = null, chain_limit = null, }) {
        this.model = model;
        this.id = id ?? monotonicUlid().toString().toLowerCase();
        this.name = name;
        this.responses = responses ?? [];
        this.tools = tools;
        this.chain_limit = chain_limit;
    }
    /**
     * Build the full message chain for the next turn. See Python
     * _BaseConversation._build_full_chain.
     */
    buildFullChain({ prompt, attachments, tool_results, explicit_messages, system = null, system_fragments = null, }) {
        if (explicit_messages != null) {
            return [...explicit_messages];
        }
        const chain = [];
        if (this.responses.length) {
            const last = this.responses[this.responses.length - 1];
            // last.prompt.messages already contains the full input chain
            // under the invariant, so use the last response only and then
            // append that response's structured output.
            chain.push(...last.prompt.messages);
            chain.push(...last.messagesNow());
        }
        else {
            // Start with the system prompt as the first message so adapters
            // that build from prompt.messages see it.
            const systemText = combineSystem(system, system_fragments ?? []);
            if (systemText) {
                chain.push(new Message({
                    role: "system",
                    parts: [new TextPart({ text: systemText })],
                }));
            }
        }
        // Append the new turn's input
        if (tool_results && tool_results.length) {
            chain.push(new Message({
                role: "tool",
                parts: tool_results.map((tr) => new ToolResultPart({
                    name: tr.name,
                    output: tr.output,
                    tool_call_id: tr.tool_call_id,
                })),
            }));
        }
        const userParts = [];
        if (prompt) {
            userParts.push(new TextPart({ text: prompt }));
        }
        for (const att of attachments ?? []) {
            userParts.push(new AttachmentPart({ attachment: att }));
        }
        if (userParts.length) {
            chain.push(new Message({ role: "user", parts: userParts }));
        }
        return chain;
    }
    toString() {
        const count = this.responses.length;
        const s = count === 1 ? "s" : "";
        return `<${this.constructor.name}: ${this.id} - ${count} response${s}`;
    }
}
const PROMPT_KWARG_KEYS = new Set([
    "fragments",
    "attachments",
    "system",
    "schema",
    "tools",
    "tool_results",
    "system_fragments",
    "messages",
    "stream",
    "key",
    "options",
    "hide_reasoning",
    "chain_limit",
    "before_call",
    "after_call",
]);
function extraOptionKwargs(opts) {
    const extras = {};
    for (const [k, v] of Object.entries(opts)) {
        if (!PROMPT_KWARG_KEYS.has(k) && v !== undefined) {
            extras[k] = v;
        }
    }
    return extras;
}
export class Conversation extends _BaseConversation {
    before_call;
    after_call;
    constructor(init) {
        super(init);
        this.before_call = init.before_call ?? null;
        this.after_call = init.after_call ?? null;
    }
    prompt(prompt = null, opts = {}) {
        const { fragments = null, attachments = null, system = null, schema = null, tools = null, tool_results = null, system_fragments = null, messages = null, stream = true, key = null, options = null, hide_reasoning = false, } = opts;
        const merged = mergeOptions(options, extraOptionKwargs(opts));
        // Build the authoritative chain so response.prompt.messages
        // equals exactly what the model sees for this turn.
        const chain = this.buildFullChain({
            prompt,
            attachments,
            tool_results,
            explicit_messages: messages,
            system,
            system_fragments,
        });
        return new Response(new Prompt(prompt, this.model, {
            fragments,
            attachments,
            system,
            schema,
            tools: tools ?? this.tools,
            tool_results,
            system_fragments,
            messages: chain,
            options: this.model.makeOptions(merged),
            hide_reasoning,
        }), this.model, stream, this, key);
    }
    chain(prompt = null, opts = {}) {
        const { fragments = null, attachments = null, system = null, system_fragments = null, messages = null, stream = true, schema = null, tools = null, tool_results = null, chain_limit = null, before_call = null, after_call = null, key = null, options = null, hide_reasoning = false, } = opts;
        this.model.validateAttachmentsSync(attachments);
        const chainMessages = this.buildFullChain({
            prompt,
            attachments,
            tool_results,
            explicit_messages: messages,
            system,
            system_fragments,
        });
        return new ChainResponse(new Prompt(prompt, this.model, {
            fragments,
            attachments,
            system,
            schema,
            tools: tools ?? this.tools,
            tool_results,
            system_fragments,
            messages: chainMessages,
            options: this.model.makeOptions(options ?? {}),
            hide_reasoning,
        }), this.model, stream, this, key, chain_limit !== null ? chain_limit : this.chain_limit, before_call ?? this.before_call, after_call ?? this.after_call);
    }
    static async fromRow(row) {
        const { getModel } = await import("./index.js");
        return new Conversation({
            model: getModel(row.model),
            id: row.id,
            name: row.name,
        });
    }
}
export class AsyncConversation extends _BaseConversation {
    before_call;
    after_call;
    constructor(init) {
        super(init);
        this.before_call = init.before_call ?? null;
        this.after_call = init.after_call ?? null;
    }
    chain(prompt = null, opts = {}) {
        const { fragments = null, attachments = null, system = null, system_fragments = null, messages = null, stream = true, schema = null, tools = null, tool_results = null, chain_limit = null, before_call = null, after_call = null, key = null, options = null, hide_reasoning = false, } = opts;
        this.model.validateAttachmentsSync(attachments);
        const chainMessages = this.buildFullChain({
            prompt,
            attachments,
            tool_results,
            explicit_messages: messages,
            system,
            system_fragments,
        });
        return new AsyncChainResponse(new Prompt(prompt, this.model, {
            fragments,
            attachments,
            system,
            schema,
            tools: tools ?? this.tools,
            tool_results,
            system_fragments,
            messages: chainMessages,
            options: this.model.makeOptions(options ?? {}),
            hide_reasoning,
        }), this.model, stream, this, key, chain_limit !== null ? chain_limit : this.chain_limit, before_call ?? this.before_call, after_call ?? this.after_call);
    }
    prompt(prompt = null, opts = {}) {
        const { fragments = null, attachments = null, system = null, schema = null, tools = null, tool_results = null, system_fragments = null, messages = null, stream = true, key = null, options = null, hide_reasoning = false, } = opts;
        const merged = mergeOptions(options, extraOptionKwargs(opts));
        const chain = this.buildFullChain({
            prompt,
            attachments,
            tool_results,
            explicit_messages: messages,
            system,
            system_fragments,
        });
        return new AsyncResponse(new Prompt(prompt, this.model, {
            fragments,
            attachments,
            system,
            schema,
            tools,
            tool_results,
            system_fragments,
            messages: chain,
            options: this.model.makeOptions(merged),
            hide_reasoning,
        }), this.model, stream, this, key);
    }
    toSyncConversation() {
        return new Conversation({
            model: this.model,
            id: this.id,
            name: this.name,
            responses: [], // Because we only use this in logging
            tools: this.tools,
            chain_limit: this.chain_limit,
        });
    }
    static async fromRow(row) {
        const { getAsyncModel } = await import("./index.js");
        return new AsyncConversation({
            model: getAsyncModel(row.model),
            id: row.id,
            name: row.name,
        });
    }
}
export const FRAGMENT_SQL = `
select
    'prompt' as fragment_type,
    fragments.content,
    pf."order" as ord
from prompt_fragments pf
join fragments on pf.fragment_id = fragments.id
where pf.response_id = :response_id
union all
select
    'system' as fragment_type,
    fragments.content,
    sf."order" as ord
from system_fragments sf
join fragments on sf.fragment_id = fragments.id
where sf.response_id = :response_id
order by fragment_type desc, ord asc;
`;
export class _BaseResponse {
    id;
    prompt;
    model;
    stream;
    resolved_model = null;
    conversation = null;
    _key;
    _prompt_json = null;
    _chunks = [];
    _stream_events = [];
    _auto_index_max = -1;
    _auto_last_index = null;
    _auto_last_family = null;
    _auto_tool_id_to_index = {};
    _done = false;
    _tool_calls = [];
    response_json = null;
    attachments = [];
    _start = null;
    _end = null;
    _start_utcnow = null;
    input_tokens = null;
    output_tokens = null;
    token_details = null;
    done_callbacks = [];
    _loaded_messages = null;
    constructor(prompt, model, stream, conversation = null, key = null) {
        this.id = monotonicUlid().toString().toLowerCase();
        this.prompt = prompt;
        this.model = model;
        this.stream = stream;
        this._key = key;
        this.conversation = conversation;
        if (this.prompt.schema && !this.model.supports_schema) {
            throw new Error(`${this.model} does not support schemas`);
        }
        if (this.prompt.tools.length && !this.model.supports_tools) {
            throw new Error(`${this.model} does not support tools`);
        }
    }
    /** Assemble messages assuming the response is already drained. */
    messagesNow() {
        if (this._loaded_messages !== null) {
            return [...this._loaded_messages];
        }
        const parts = this.buildParts();
        if (!parts.length)
            return [];
        return [new Message({ role: "assistant", parts })];
    }
    static eventFamily(eventType) {
        if (eventType === "tool_call_name" || eventType === "tool_call_args") {
            return "tool_call";
        }
        return eventType;
    }
    /** Mutate event.part_index in place when the plugin left it null. */
    resolvePartIndex(event) {
        const fam = _BaseResponse.eventFamily(event.type);
        if (event.part_index !== null) {
            if (event.part_index > this._auto_index_max) {
                this._auto_index_max = event.part_index;
            }
            if ((event.type === "tool_call_name" || event.type === "tool_call_args") &&
                event.tool_call_id) {
                this._auto_tool_id_to_index[event.tool_call_id] = event.part_index;
            }
            this._auto_last_index = event.part_index;
            this._auto_last_family = fam;
            return;
        }
        if (event.type === "tool_call_name" || event.type === "tool_call_args") {
            if (event.tool_call_id) {
                const existing = this._auto_tool_id_to_index[event.tool_call_id];
                if (existing !== undefined) {
                    event.part_index = existing;
                    this._auto_last_index = existing;
                    this._auto_last_family = "tool_call";
                    return;
                }
                this._auto_index_max += 1;
                const newIdx = this._auto_index_max;
                this._auto_tool_id_to_index[event.tool_call_id] = newIdx;
                event.part_index = newIdx;
                this._auto_last_index = newIdx;
                this._auto_last_family = "tool_call";
                return;
            }
            // No tool_call_id — tool_call_args glue onto the most recent
            // tool-call index; a fresh tool_call_name starts a new part.
            if (event.type === "tool_call_args" &&
                this._auto_last_family === "tool_call" &&
                this._auto_last_index !== null) {
                event.part_index = this._auto_last_index;
                return;
            }
            this._auto_index_max += 1;
            const newIdx = this._auto_index_max;
            event.part_index = newIdx;
            this._auto_last_index = newIdx;
            this._auto_last_family = "tool_call";
            return;
        }
        if (event.type === "tool_result") {
            this._auto_index_max += 1;
            const newIdx = this._auto_index_max;
            event.part_index = newIdx;
            this._auto_last_index = newIdx;
            this._auto_last_family = "tool_result";
            return;
        }
        // text / reasoning: same family as previous → reuse, else new.
        if (this._auto_last_family === fam && this._auto_last_index !== null) {
            event.part_index = this._auto_last_index;
            return;
        }
        this._auto_index_max += 1;
        const newIdx = this._auto_index_max;
        event.part_index = newIdx;
        this._auto_last_index = newIdx;
        this._auto_last_family = fam;
    }
    /**
     * Normalize a chunk from execute() into a StreamEvent and return the
     * text string (or null) that iteration should yield.
     */
    processChunk(chunk) {
        if (chunk instanceof StreamEvent) {
            this.resolvePartIndex(chunk);
            this._stream_events.push(chunk);
            if (chunk.type === "text") {
                this._chunks.push(chunk.chunk);
                return chunk.chunk;
            }
            return null;
        }
        // Legacy plain-str plugin.
        const event = new StreamEvent({ type: "text", chunk });
        this.resolvePartIndex(event);
        this._stream_events.push(event);
        this._chunks.push(chunk);
        return chunk;
    }
    /** Assemble Part objects from the accumulated stream events. */
    buildParts() {
        if (!this._stream_events.length) {
            // Rehydrated-from-SQLite path.
            const fallbackParts = [];
            const text = this._chunks.join("");
            if (text) {
                fallbackParts.push(new TextPart({ text }));
            }
            for (const tc of this._tool_calls) {
                fallbackParts.push(new ToolCallPart({
                    name: tc.name,
                    arguments: tc.arguments ?? {},
                    tool_call_id: tc.tool_call_id,
                }));
            }
            return fallbackParts;
        }
        // Group events by their (resolved) part_index, preserving the order
        // in which each index was first seen.
        const groups = new Map();
        for (const event of this._stream_events) {
            const pi = event.part_index;
            if (!groups.has(pi)) {
                groups.set(pi, []);
            }
            groups.get(pi).push(event);
        }
        let parts = [];
        for (const [pi, evs] of groups) {
            const famFirst = _BaseResponse.eventFamily(evs[0].type);
            for (const e of evs) {
                if (_BaseResponse.eventFamily(e.type) !== famFirst) {
                    throw new Error(`StreamEvent type '${e.type}' is incompatible with prior type at part_index=${pi}. ` +
                        "Allocate a new part_index for a different content type.");
                }
            }
            let pmMerged = null;
            for (const e of evs) {
                if (e.provider_metadata) {
                    pmMerged = { ...(pmMerged ?? {}), ...e.provider_metadata };
                }
            }
            if (famFirst === "text") {
                const text = evs.map((e) => e.chunk).join("");
                if (text) {
                    parts.push(new TextPart({ text, provider_metadata: pmMerged }));
                }
            }
            else if (famFirst === "reasoning") {
                const text = evs.map((e) => e.chunk).join("");
                const redacted = evs.some((e) => e.redacted);
                if (text || redacted) {
                    parts.push(new ReasoningPart({ text, redacted, provider_metadata: pmMerged }));
                }
            }
            else if (famFirst === "tool_call") {
                const toolName = evs
                    .filter((e) => e.type === "tool_call_name")
                    .map((e) => e.chunk)
                    .join("");
                const argsStr = evs
                    .filter((e) => e.type === "tool_call_args")
                    .map((e) => e.chunk)
                    .join("");
                let args;
                try {
                    args = argsStr ? JSON.parse(argsStr) : {};
                }
                catch {
                    args = { _raw: argsStr };
                }
                const toolCallId = evs.find((e) => e.tool_call_id)?.tool_call_id ?? null;
                const serverExecuted = evs.some((e) => e.server_executed);
                parts.push(new ToolCallPart({
                    name: toolName,
                    arguments: args,
                    tool_call_id: toolCallId,
                    server_executed: serverExecuted,
                    provider_metadata: pmMerged,
                }));
            }
            else if (famFirst === "tool_result") {
                const toolResultName = evs.find((e) => e.tool_name)?.tool_name ?? "";
                const toolCallId = evs.find((e) => e.tool_call_id)?.tool_call_id ?? null;
                const serverExecuted = evs.some((e) => e.server_executed);
                parts.push(new ToolResultPart({
                    name: toolResultName,
                    output: evs.map((e) => e.chunk).join(""),
                    tool_call_id: toolCallId,
                    server_executed: serverExecuted,
                    provider_metadata: pmMerged,
                }));
            }
        }
        // Merge in tool calls registered via add_tool_call() that the plugin
        // didn't also emit as StreamEvents. Dedup by tool_call_id.
        const seenIds = new Set(parts
            .filter((p) => p instanceof ToolCallPart)
            .map((p) => p.tool_call_id)
            .filter((id) => id !== null));
        for (const tc of this._tool_calls) {
            if (tc.tool_call_id !== null && seenIds.has(tc.tool_call_id)) {
                continue;
            }
            parts.push(new ToolCallPart({
                name: tc.name,
                arguments: tc.arguments ?? {},
                tool_call_id: tc.tool_call_id,
            }));
        }
        // Hoist redacted reasoning Parts to the start of the message.
        const redactedParts = parts.filter((p) => p instanceof ReasoningPart && p.redacted);
        if (redactedParts.length) {
            const otherParts = parts.filter((p) => !(p instanceof ReasoningPart && p.redacted));
            parts = [...redactedParts, ...otherParts];
        }
        return parts;
    }
    add_tool_call(toolCall) {
        if (toolCall.tool_call_id === null) {
            // Guarantee every locally-executable tool call has a unique id.
            toolCall = new ToolCall({
                name: toolCall.name,
                arguments: toolCall.arguments,
                tool_call_id: `tc_${monotonicUlid().toString().toLowerCase()}`,
            });
        }
        this._tool_calls.push(toolCall);
    }
    set_usage({ input = null, output = null, details = null, } = {}) {
        this.input_tokens = input;
        this.output_tokens = output;
        this.token_details = details;
    }
    set_resolved_model(modelId) {
        this.resolved_model = modelId;
    }
    token_usage() {
        return tokenUsageString(this.input_tokens, this.output_tokens, this.token_details);
    }
    /**
     * Log this response to the database. Async in TS because attachment
     * type resolution may require a network fetch.
     */
    async logToDb(db) {
        const { ensureFragment, ensureTool } = await import("./dbutils.js");
        let conversation = this.conversation;
        if (!conversation) {
            conversation = new Conversation({ model: this.model });
        }
        db.table("conversations").insert({
            id: conversation.id,
            name: conversationName(this.prompt.prompt || this.prompt.system || ""),
            model: conversation.model.model_id,
        }, { ignore: true });
        let schemaId = null;
        if (this.prompt.schema) {
            const [sid, schemaJson] = makeSchemaId(this.prompt.schema);
            schemaId = sid;
            db.table("schemas").insert({ id: schemaId, content: schemaJson }, { ignore: true });
        }
        const responseId = this.id;
        const replacements = {};
        // Include replacements from previous responses
        for (const previousResponse of conversation.responses.slice(0, -1)) {
            for (const fragment of [
                ...(previousResponse.prompt.fragments ?? []),
                ...(previousResponse.prompt.system_fragments ?? []),
            ]) {
                const fragmentId = ensureFragment(db, fragment);
                replacements[`f:${fragmentId}`] = String(fragment);
                replacements[`r:${previousResponse.id}`] =
                    previousResponse.text_or_raise();
            }
        }
        this.prompt.fragments.forEach((fragment, i) => {
            const fragmentId = ensureFragment(db, fragment);
            replacements[`f${fragmentId}`] = String(fragment);
            db.table("prompt_fragments").insert({
                response_id: responseId,
                fragment_id: fragmentId,
                order: i,
            });
        });
        this.prompt.system_fragments.forEach((fragment, i) => {
            const fragmentId = ensureFragment(db, fragment);
            replacements[`f${fragmentId}`] = String(fragment);
            db.table("system_fragments").insert({
                response_id: responseId,
                fragment_id: fragmentId,
                order: i,
            });
        });
        const responseText = this.text_or_raise();
        replacements[`r:${responseId}`] = responseText;
        const reasoningText = this.messagesNow()
            .flatMap((m) => m.parts)
            .filter((p) => p instanceof ReasoningPart && !!p.text)
            .map((p) => p.text)
            .join("");
        const jsonData = this.response_json;
        const optionsDump = this.prompt.options instanceof BaseModel
            ? this.prompt.options.modelDump()
            : { ...this.prompt.options };
        const response = {
            id: responseId,
            model: this.model.model_id,
            prompt: this.prompt._prompt,
            system: this.prompt._system,
            prompt_json: condenseJson(this._prompt_json, replacements),
            options_json: Object.fromEntries(Object.entries(optionsDump).filter(([, v]) => v !== null && v !== undefined)),
            response: responseText,
            reasoning: reasoningText || null,
            response_json: condenseJson(jsonData, replacements),
            conversation_id: conversation.id,
            duration_ms: this.durationMsNow(),
            datetime_utc: this.datetimeUtcNow(),
            input_tokens: this.input_tokens,
            output_tokens: this.output_tokens,
            token_details: this.token_details ? dumps(this.token_details) : null,
            schema_id: schemaId,
            resolved_model: this.resolved_model,
        };
        db.table("responses").insert(response);
        // Persist any attachments - loop through with index
        for (let index = 0; index < this.prompt.attachments.length; index++) {
            const attachment = this.prompt.attachments[index];
            const attachmentId = attachment.id();
            db.table("attachments").insert({
                id: attachmentId,
                type: await attachment.resolveType(),
                path: attachment.path,
                url: attachment.url,
                content: attachment.content,
            }, { replace: true });
            db.table("prompt_attachments").insert({
                response_id: responseId,
                attachment_id: attachmentId,
                order: index,
            });
        }
        // Persist any tools, tool calls and tool results
        const toolIdsByName = {};
        let lastTool = null;
        for (const tool of this.prompt.tools) {
            lastTool = tool;
            const toolId = ensureTool(db, tool);
            toolIdsByName[tool.name] = toolId;
            db.table("tool_responses").insert({
                tool_id: toolId,
                response_id: responseId,
            });
        }
        for (const toolCall of this._tool_calls) {
            db.table("tool_calls").insert({
                response_id: responseId,
                tool_id: toolIdsByName[toolCall.name] ?? null,
                name: toolCall.name,
                arguments: dumps(toolCall.arguments),
                tool_call_id: toolCall.tool_call_id,
            });
        }
        for (const toolResult of this.prompt.tool_results) {
            let instanceId = null;
            if (toolResult.instance) {
                if (!toolResult.instance.instance_id) {
                    toolResult.instance.instance_id = db
                        .table("tool_instances")
                        .insert({
                        plugin: lastTool?.plugin ?? null,
                        name: lastTool ? lastTool.name.split("_")[0] : null,
                        arguments: dumps(toolResult.instance._config),
                    }).lastPk;
                }
                instanceId = toolResult.instance.instance_id;
            }
            const toolResultId = db.table("tool_results").insert({
                response_id: responseId,
                tool_id: toolIdsByName[toolResult.name] ?? null,
                name: toolResult.name,
                output: toolResult.output,
                tool_call_id: toolResult.tool_call_id,
                instance_id: instanceId,
                exception: toolResult.exception
                    ? `${toolResult.exception.constructor.name}: ${toolResult.exception.message}`
                    : null,
            }).lastPk;
            // Persist attachments for tool results
            for (let index = 0; index < toolResult.attachments.length; index++) {
                const attachment = toolResult.attachments[index];
                const attachmentId = attachment.id();
                db.table("attachments").insert({
                    id: attachmentId,
                    type: await attachment.resolveType(),
                    path: attachment.path,
                    url: attachment.url,
                    content: attachment.content,
                }, { replace: true });
                db.table("tool_results_attachments").insert({
                    tool_result_id: toolResultId,
                    attachment_id: attachmentId,
                    order: index,
                });
            }
        }
    }
    durationMsNow() {
        return Math.floor(((this._end ?? 0) - (this._start ?? 0)) * 1000);
    }
    datetimeUtcNow() {
        return this._start_utcnow ?? "";
    }
    static async fromRowBase(cls, db, row, _async = false) {
        const { getModel, getAsyncModel } = await import("./index.js");
        const model = _async
            ? getAsyncModel(row.model)
            : getModel(row.model);
        // Schema
        let schema = null;
        if (row.schema_id) {
            schema = JSON.parse(db.table("schemas").get(row.schema_id).content);
        }
        // Tool definitions and results for prompt
        const tools = db
            .query(`
                select tools.* from tools
                join tool_responses on tools.id = tool_responses.tool_id
                where tool_responses.response_id = ?
            `, [row.id])
            .map((toolRow) => new Tool({
            name: toolRow.name,
            description: toolRow.description,
            input_schema: JSON.parse(toolRow.input_schema),
            implementation: null,
            plugin: toolRow.plugin,
        }));
        const toolResults = db
            .query(`
                select * from tool_results
                where response_id = ?
            `, [row.id])
            .map((trRow) => new ToolResult({
            name: trRow.name,
            output: trRow.output,
            tool_call_id: trRow.tool_call_id,
        }));
        const allFragments = db.query(FRAGMENT_SQL, { response_id: row.id });
        const fragments = allFragments
            .filter((r) => r.fragment_type === "prompt")
            .map((r) => r.content);
        const systemFragments = allFragments
            .filter((r) => r.fragment_type === "system")
            .map((r) => r.content);
        const response = new cls(new Prompt(row.prompt, model, {
            fragments,
            attachments: [],
            system: row.system,
            schema,
            tools,
            tool_results: toolResults,
            system_fragments: systemFragments,
            options: model.makeOptions(JSON.parse(row.options_json || "{}")),
        }), model, false);
        response._prompt_json = JSON.parse(row.prompt_json || "null");
        response.id = row.id;
        response.response_json = JSON.parse(row.response_json || "null");
        response._done = true;
        response._chunks = [row.response];
        // Attachments
        response.attachments = db
            .query(`
                select attachments.* from attachments
                join prompt_attachments on attachments.id = prompt_attachments.attachment_id
                where prompt_attachments.response_id = ?
                order by prompt_attachments."order"
            `, [row.id])
            .map((attachmentRow) => Attachment.fromRow(attachmentRow));
        // Tool calls
        response._tool_calls = db
            .query(`
                select * from tool_calls
                where response_id = ?
                order by tool_call_id
            `, [row.id])
            .map((toolRow) => new ToolCall({
            name: toolRow.name,
            arguments: JSON.parse(toolRow.arguments),
            tool_call_id: toolRow.tool_call_id,
        }));
        return response;
    }
}
/** Shared serializer for Response.toDict / AsyncResponse.toDict. */
function responseToDict(response) {
    const optionsDump = response.prompt.options instanceof BaseModel
        ? response.prompt.options.modelDump()
        : { ...response.prompt.options };
    const options = Object.fromEntries(Object.entries(optionsDump).filter(([, v]) => v !== null && v !== undefined));
    const payload = {
        model: response.model.model_id,
        prompt: {
            messages: response.prompt.messages.map((m) => m.toDict()),
        },
        messages: response.messagesNow().map((m) => m.toDict()),
    };
    if (Object.keys(options).length) {
        payload.prompt.options = options;
    }
    if (response.prompt._system) {
        payload.prompt.system = response.prompt._system;
    }
    if (response.id) {
        payload.id = response.id;
    }
    if (response._done) {
        if (response.input_tokens !== null || response.output_tokens !== null) {
            const usage = {};
            if (response.input_tokens !== null)
                usage.input = response.input_tokens;
            if (response.output_tokens !== null)
                usage.output = response.output_tokens;
            if (response.token_details !== null)
                usage.details = response.token_details;
            payload.usage = usage;
        }
        if (response._start_utcnow !== null) {
            payload.datetime_utc = response._start_utcnow;
        }
    }
    return payload;
}
/** Shared deserializer for Response.fromDict / AsyncResponse.fromDict. */
async function responseFromDict(data, cls, { model = null, async_ = false, } = {}) {
    if (model === null) {
        const { getAsyncModel, getModel } = await import("./index.js");
        model = async_
            ? getAsyncModel(data.model)
            : getModel(data.model);
    }
    const promptData = data.prompt ?? { messages: [] };
    const inputMessages = (promptData.messages ?? []).map((m) => Message.fromDict(m));
    const outputMessages = (data.messages ?? []).map((m) => Message.fromDict(m));
    const optionsKwargs = promptData.options ?? {};
    const system = promptData.system ?? null;
    const prompt = new Prompt(null, model, {
        messages: inputMessages,
        system,
        options: model.makeOptions(optionsKwargs),
    });
    const response = new cls(prompt, model, false);
    if (data.id !== undefined) {
        response.id = data.id;
    }
    response._chunks = outputMessages
        .flatMap((m) => m.parts)
        .filter((p) => p instanceof TextPart && !!p.text)
        .map((p) => p.text);
    response._loaded_messages = outputMessages;
    response._done = true;
    const usage = data.usage;
    if (usage) {
        response.input_tokens = usage.input ?? null;
        response.output_tokens = usage.output ?? null;
        response.token_details = usage.details ?? null;
    }
    return response;
}
async function executeToolCallsShared(response, toolCallsList, beforeCall, afterCall, syncMode) {
    const toolResults = [];
    const toolsByName = {};
    for (const tool of response.prompt.tools) {
        toolsByName[tool.name] = tool;
    }
    // Run prepare() on all Toolbox instances that need it
    const instancesToPrepare = [];
    for (const toolToPrep of Object.values(toolsByName)) {
        const inst = getInstance(toolToPrep.implementation);
        if (inst instanceof Toolbox) {
            if (syncMode ? !inst._prepared : !inst._async_prepared) {
                if (!instancesToPrepare.includes(inst)) {
                    instancesToPrepare.push(inst);
                }
            }
        }
    }
    for (const inst of instancesToPrepare) {
        if (syncMode) {
            inst.prepare();
            inst._prepared = true;
        }
        else {
            await inst.prepare_async();
            inst._async_prepared = true;
        }
    }
    for (const toolCall of toolCallsList) {
        const tool = toolsByName[toolCall.name];
        // Tool could be undefined, but we still call the before_call method:
        if (beforeCall) {
            try {
                const cbResult = beforeCall(tool ?? null, toolCall);
                if (cbResult instanceof Promise) {
                    await cbResult;
                }
            }
            catch (ex) {
                if (ex instanceof CancelToolCall) {
                    toolResults.push(new ToolResult({
                        name: toolCall.name,
                        output: "Cancelled: " + ex.message,
                        tool_call_id: toolCall.tool_call_id,
                        exception: ex,
                    }));
                    continue;
                }
                throw ex;
            }
        }
        if (tool === undefined) {
            const msg = `tool "${toolCall.name}" does not exist`;
            toolResults.push(new ToolResult({
                name: toolCall.name,
                output: "Error: " + msg,
                tool_call_id: toolCall.tool_call_id,
                exception: new Error(msg),
            }));
            continue;
        }
        if (!tool.implementation) {
            throw new Error(`No implementation available for tool: ${toolCall.name}`);
        }
        let attachments = [];
        let exception = null;
        let result;
        try {
            const implementationArgs = implementationArguments(tool, toolCall);
            result = invokeImplementation(tool.implementation, implementationArgs);
            if (result instanceof Promise) {
                result = await result;
            }
            if (result instanceof ToolOutput) {
                attachments = result.attachments;
                result = result.output;
            }
            if (typeof result !== "string") {
                result = dumps(result, { fallback: (v) => String(v) });
            }
        }
        catch (ex) {
            if (ex instanceof PauseChain) {
                // Pause: propagate instead of converting to an error result.
                ex.tool_call = toolCall;
                ex.tool_results = [...toolResults];
                throw ex;
            }
            result = `Error: ${ex.message}`;
            exception = ex;
        }
        const toolResultObj = new ToolResult({
            name: toolCall.name,
            output: result,
            attachments,
            tool_call_id: toolCall.tool_call_id,
            instance: getInstance(tool.implementation),
            exception,
        });
        if (afterCall) {
            const cbResult = afterCall(tool, toolCall, toolResultObj);
            if (cbResult instanceof Promise) {
                await cbResult;
            }
        }
        toolResults.push(toolResultObj);
    }
    return toolResults;
}
function invokeImplementation(implementation, kwargs) {
    const kwargNames = implementation
        .__kwargNames__;
    if (kwargNames) {
        return implementation(...kwargNames.map((n) => kwargs[n]));
    }
    const target = implementation
        .__wrapped__ ?? implementation;
    const self = implementation.__self__;
    if (self !== undefined && target !== implementation) {
        return callWithKwargs(target, kwargs, self);
    }
    return callWithKwargs(implementation, kwargs);
}
export class Response extends _BaseResponse {
    /**
     * Continue the conversation from this response. Async in TS because it
     * may auto-execute tool calls.
     */
    async reply(prompt = null, { messages = null, tool_results = null, options = null, ...kwargs } = {}) {
        this._force();
        let toolResults = tool_results;
        if (toolResults === null && this._tool_calls.length) {
            toolResults = await this.execute_tool_calls();
        }
        if (!("tools" in kwargs) && this.prompt.tools.length) {
            kwargs.tools = this.prompt.tools;
        }
        const chain = [...this.prompt.messages, ...this.messagesNow()];
        if (toolResults && toolResults.length) {
            chain.push(new Message({
                role: "tool",
                parts: toolResults.map((tr) => new ToolResultPart({
                    name: tr.name,
                    output: tr.output,
                    tool_call_id: tr.tool_call_id,
                })),
            }));
        }
        if (prompt) {
            chain.push(new Message({ role: "user", parts: [new TextPart({ text: prompt })] }));
        }
        if (messages) {
            chain.push(...messages);
        }
        return this.model.prompt(null, { messages: chain, options, ...kwargs });
    }
    /** Serialize this response for JSON persistence. */
    toDict() {
        return responseToDict(this);
    }
    static async fromDict(data, { model = null } = {}) {
        return (await responseFromDict(data, Response, {
            model,
            async_: false,
        }));
    }
    static async fromRow(db, row) {
        return (await _BaseResponse.fromRowBase(Response, db, row, false));
    }
    /** Register a callback to be called when the response is complete. */
    on_done(callback) {
        if (!this._done) {
            this.done_callbacks.push(callback);
        }
        else {
            callback(this);
        }
    }
    onDone() {
        for (const callback of this.done_callbacks) {
            callback(this);
        }
    }
    _force() {
        if (!this._done) {
            for (const _ of this) {
                // drain
            }
        }
    }
    /** Return the full text of the response, executing the prompt if needed. */
    text() {
        this._force();
        return this._chunks.join("");
    }
    text_or_raise() {
        return this.text();
    }
    /**
     * Execute tool calls using this response's tools. Async in TS (Python
     * used asyncio.run for coroutine tools inside sync code).
     */
    async execute_tool_calls({ before_call = null, after_call = null, tool_calls_list = null, } = {}) {
        const list = tool_calls_list ?? this.tool_calls();
        return executeToolCallsShared(this, list, before_call, after_call, true);
    }
    /** Return the list of tool calls made during this response. */
    tool_calls() {
        this._force();
        return this._tool_calls;
    }
    tool_calls_or_raise() {
        return this.tool_calls();
    }
    /** Return the raw JSON response from the model, if available. */
    json() {
        this._force();
        return this.response_json;
    }
    duration_ms() {
        this._force();
        return this.durationMsNow();
    }
    datetime_utc() {
        this._force();
        return this.datetimeUtcNow();
    }
    /** Return token usage information for this response. */
    usage() {
        this._force();
        return new Usage({
            input: this.input_tokens,
            output: this.output_tokens,
            details: this.token_details,
        });
    }
    rawGenerator() {
        if (this.model instanceof KeyModel) {
            return this.model.execute(this.prompt, this.stream, this, this.conversation, this.model.get_key(this._key));
        }
        else if (this.model instanceof Model) {
            return this.model.execute(this.prompt, this.stream, this, this.conversation);
        }
        throw new Error("self.model must be a Model or KeyModel");
    }
    *iterEvents() {
        const generator = this.rawGenerator();
        if (typeof generator[Symbol.iterator] !== "function") {
            // Python's sync models do blocking HTTP; JS cannot. Models backed
            // by fetch() return async generators and must be driven with the
            // async APIs (for await, textAsync(), ...).
            throw new Error(`Model ${this.model.model_id} executes asynchronously — use ` +
                "'for await' / await response.textAsync() instead of sync iteration");
        }
        for (const chunk of generator) {
            if (chunk === null || chunk === undefined) {
                throw new Error("Model returned a null chunk");
            }
            yield chunk;
        }
    }
    async *iterEventsAsync() {
        const generator = this.rawGenerator();
        for await (const chunk of generator) {
            if (chunk === null || chunk === undefined) {
                throw new Error("Model returned a null chunk");
            }
            yield chunk;
        }
    }
    /** Async counterpart of _force() for fetch-backed sync-API models. */
    async forceAsync() {
        if (!this._done) {
            for await (const _ of this) {
                // drain
            }
        }
    }
    /** Async counterpart of text(). */
    async textAsync() {
        await this.forceAsync();
        return this._chunks.join("");
    }
    /** Async iteration works for both sync and async model generators. */
    async *[Symbol.asyncIterator]() {
        this._start = monotonicSeconds();
        this._start_utcnow = utcNowIso();
        if (this._done) {
            yield* this._chunks;
            return;
        }
        for await (const chunk of this.iterEventsAsync()) {
            const text = this.processChunk(chunk);
            if (text !== null) {
                yield text;
            }
        }
        if (this.conversation) {
            this.conversation.responses.push(this);
        }
        this._end = monotonicSeconds();
        this._done = true;
        this.onDone();
    }
    /** Async counterpart of stream_events(). */
    async *streamEventsAsync() {
        if (this._done) {
            yield* this._stream_events;
            return;
        }
        this._start = monotonicSeconds();
        this._start_utcnow = utcNowIso();
        for await (const chunk of this.iterEventsAsync()) {
            this.processChunk(chunk);
            yield this._stream_events[this._stream_events.length - 1];
        }
        if (this.conversation) {
            this.conversation.responses.push(this);
        }
        this._end = monotonicSeconds();
        this._done = true;
        this.onDone();
    }
    /** Async counterpart of messages(). */
    async messagesAsync() {
        await this.forceAsync();
        return this.messagesNow();
    }
    *[Symbol.iterator]() {
        this._start = monotonicSeconds();
        this._start_utcnow = utcNowIso();
        if (this._done) {
            yield* this._chunks;
            return;
        }
        for (const chunk of this.iterEvents()) {
            const text = this.processChunk(chunk);
            if (text !== null) {
                yield text;
            }
        }
        if (this.conversation) {
            this.conversation.responses.push(this);
        }
        this._end = monotonicSeconds();
        this._done = true;
        this.onDone();
    }
    /** Yield StreamEvent objects as the model produces them. */
    *stream_events() {
        if (this._done) {
            yield* this._stream_events;
            return;
        }
        this._start = monotonicSeconds();
        this._start_utcnow = utcNowIso();
        for (const chunk of this.iterEvents()) {
            this.processChunk(chunk);
            yield this._stream_events[this._stream_events.length - 1];
        }
        if (this.conversation) {
            this.conversation.responses.push(this);
        }
        this._end = monotonicSeconds();
        this._done = true;
        this.onDone();
    }
    /** List of Message objects produced by this response. */
    messages() {
        this._force();
        return this.messagesNow();
    }
    toString() {
        let text = "... not yet done ...";
        if (this._done) {
            text = this._chunks.join("");
        }
        return `<Response prompt='${this.prompt.prompt}' text='${text}'>`;
    }
}
export class AsyncResponse extends _BaseResponse {
    _generator;
    _iter_chunks;
    /** Async counterpart of Response.reply(). Requires awaiting first. */
    async reply(prompt = null, { messages = null, tool_results = null, options = null, ...kwargs } = {}) {
        if (!this._done) {
            throw new Error("Response not yet awaited — call `await response` before reply()");
        }
        let toolResults = tool_results;
        if (toolResults === null && this._tool_calls.length) {
            toolResults = await this.execute_tool_calls();
        }
        if (!("tools" in kwargs) && this.prompt.tools.length) {
            kwargs.tools = this.prompt.tools;
        }
        const chain = [...this.prompt.messages, ...this.messagesNow()];
        if (toolResults && toolResults.length) {
            chain.push(new Message({
                role: "tool",
                parts: toolResults.map((tr) => new ToolResultPart({
                    name: tr.name,
                    output: tr.output,
                    tool_call_id: tr.tool_call_id,
                })),
            }));
        }
        if (prompt) {
            chain.push(new Message({ role: "user", parts: [new TextPart({ text: prompt })] }));
        }
        if (messages) {
            chain.push(...messages);
        }
        return this.model.prompt(null, { messages: chain, options, ...kwargs });
    }
    toDict() {
        if (!this._done) {
            throw new Error("Response not yet awaited — call `await response` before to_dict()");
        }
        return responseToDict(this);
    }
    static async fromDict(data, { model = null } = {}) {
        return (await responseFromDict(data, AsyncResponse, {
            model,
            async_: true,
        }));
    }
    static async fromRow(db, row) {
        return (await _BaseResponse.fromRowBase(AsyncResponse, db, row, true));
    }
    /** Register a callback to be called when the response is complete. */
    async on_done(callback) {
        if (!this._done) {
            this.done_callbacks.push(callback);
        }
        else {
            if (typeof callback === "function") {
                const processed = callback(this);
                if (processed instanceof Promise) {
                    await processed;
                }
            }
            else if (callback instanceof Promise) {
                await callback;
            }
        }
    }
    async onDoneAsync() {
        for (const callbackFunc of this.done_callbacks) {
            if (typeof callbackFunc === "function") {
                const processed = callbackFunc(this);
                if (processed instanceof Promise) {
                    await processed;
                }
            }
            else if (callbackFunc instanceof Promise) {
                await callbackFunc;
            }
        }
    }
    /** Execute tool calls using this response's tools. */
    async execute_tool_calls({ before_call = null, after_call = null, tool_calls_list = null, } = {}) {
        const list = tool_calls_list ?? (await this.tool_calls());
        const toolsByName = {};
        for (const tool of this.prompt.tools) {
            toolsByName[tool.name] = tool;
        }
        // Run async prepare_async() on all Toolbox instances that need it
        const instancesToPrepare = [];
        for (const toolToPrep of Object.values(toolsByName)) {
            const inst = getInstance(toolToPrep.implementation);
            if (inst instanceof Toolbox &&
                !inst._async_prepared &&
                !instancesToPrepare.includes(inst)) {
                instancesToPrepare.push(inst);
            }
        }
        for (const inst of instancesToPrepare) {
            await inst.prepare_async();
            inst._async_prepared = true;
        }
        const indexedResults = [];
        const asyncTasks = [];
        // Defined failure semantics: a pause or error in one call must not
        // orphan concurrently-running siblings.
        const paused = [];
        const failures = [];
        let broke = false;
        for (let idx = 0; idx < list.length && !broke; idx++) {
            const tc = list[idx];
            const tool = toolsByName[tc.name];
            if (tool === undefined || !tool.implementation) {
                if (before_call) {
                    try {
                        const cb = before_call(tool ?? null, tc);
                        if (cb instanceof Promise)
                            await cb;
                    }
                    catch (ex) {
                        if (ex instanceof CancelToolCall) {
                            indexedResults.push([
                                idx,
                                new ToolResult({
                                    name: tc.name,
                                    output: "Cancelled: " + ex.message,
                                    tool_call_id: tc.tool_call_id,
                                    exception: ex,
                                }),
                            ]);
                            continue;
                        }
                        failures.push([idx, ex]);
                        break;
                    }
                }
                const reason = tool === undefined ? "does not exist" : "has no implementation";
                const msg = `tool "${tc.name}" ${reason}`;
                indexedResults.push([
                    idx,
                    new ToolResult({
                        name: tc.name,
                        output: "Error: " + msg,
                        tool_call_id: tc.tool_call_id,
                        exception: new Error(msg),
                    }),
                ]);
                continue;
            }
            const isAsyncImpl = (tool.implementation.__wrapped__ ??
                tool.implementation).constructor.name === "AsyncFunction";
            if (isAsyncImpl) {
                const runAsync = async () => {
                    if (before_call) {
                        try {
                            const cb = before_call(tool, tc);
                            if (cb instanceof Promise)
                                await cb;
                        }
                        catch (ex) {
                            if (ex instanceof CancelToolCall) {
                                return [
                                    idx,
                                    new ToolResult({
                                        name: tc.name,
                                        output: "Cancelled: " + ex.message,
                                        tool_call_id: tc.tool_call_id,
                                        exception: ex,
                                    }),
                                ];
                            }
                            throw ex;
                        }
                    }
                    let exception = null;
                    const attachments = [];
                    let output;
                    try {
                        let result = invokeImplementation(tool.implementation, implementationArguments(tool, tc));
                        if (result instanceof Promise)
                            result = await result;
                        if (result instanceof ToolOutput) {
                            attachments.push(...result.attachments);
                            result = result.output;
                        }
                        output =
                            typeof result === "string"
                                ? result
                                : dumps(result, { fallback: (v) => String(v) });
                    }
                    catch (ex) {
                        if (ex instanceof PauseChain) {
                            ex.tool_call = tc;
                            throw ex;
                        }
                        output = `Error: ${ex.message}`;
                        exception = ex;
                    }
                    const tr = new ToolResult({
                        name: tc.name,
                        output,
                        attachments,
                        tool_call_id: tc.tool_call_id,
                        instance: getInstance(tool.implementation),
                        exception,
                    });
                    if (after_call) {
                        const cb2 = after_call(tool, tc, tr);
                        if (cb2 instanceof Promise)
                            await cb2;
                    }
                    return [idx, tr];
                };
                asyncTasks.push(runAsync().then((result) => result, (err) => {
                    throw Object.assign(err, { __taskIndex__: idx });
                }));
            }
            else {
                // Sync implementation: do hooks and call inline
                if (before_call) {
                    try {
                        const cb = before_call(tool, tc);
                        if (cb instanceof Promise)
                            await cb;
                    }
                    catch (ex) {
                        if (ex instanceof CancelToolCall) {
                            indexedResults.push([
                                idx,
                                new ToolResult({
                                    name: tc.name,
                                    output: "Cancelled: " + ex.message,
                                    tool_call_id: tc.tool_call_id,
                                    exception: ex,
                                }),
                            ]);
                            continue;
                        }
                        failures.push([idx, ex]);
                        break;
                    }
                }
                let exception = null;
                const attachments = [];
                let output = null;
                try {
                    let res = invokeImplementation(tool.implementation, implementationArguments(tool, tc));
                    if (res instanceof Promise) {
                        res = await res;
                    }
                    if (res instanceof ToolOutput) {
                        attachments.push(...res.attachments);
                        res = res.output;
                    }
                    output =
                        typeof res === "string"
                            ? res
                            : dumps(res, { fallback: (v) => String(v) });
                }
                catch (ex) {
                    if (ex instanceof PauseChain) {
                        // Inline execution stops here; later calls never start.
                        ex.tool_call = tc;
                        paused.push([idx, ex]);
                        broke = true;
                        break;
                    }
                    output = `Error: ${ex.message}`;
                    exception = ex;
                }
                const tr = new ToolResult({
                    name: tc.name,
                    output: output,
                    attachments,
                    tool_call_id: tc.tool_call_id,
                    instance: getInstance(tool.implementation),
                    exception,
                });
                try {
                    if (after_call) {
                        const cb2 = after_call(tool, tc, tr);
                        if (cb2 instanceof Promise)
                            await cb2;
                    }
                }
                catch (ex) {
                    failures.push([idx, ex]);
                    break;
                }
                indexedResults.push([idx, tr]);
            }
        }
        // Await every task that was started; a pause or hook failure in one
        // task cannot orphan its siblings mid-flight.
        if (asyncTasks.length) {
            const outcomes = await Promise.allSettled(asyncTasks);
            for (const outcome of outcomes) {
                if (outcome.status === "fulfilled") {
                    indexedResults.push(outcome.value);
                }
                else {
                    const err = outcome.reason;
                    const taskIdx = err.__taskIndex__ ?? 0;
                    if (err instanceof PauseChain) {
                        paused.push([taskIdx, err]);
                    }
                    else {
                        failures.push([taskIdx, err]);
                    }
                }
            }
        }
        // Reorder by original index
        indexedResults.sort((a, b) => a[0] - b[0]);
        const results = indexedResults.map(([, tr]) => tr);
        // Hook failures are bugs: raise the first by call order.
        if (failures.length) {
            failures.sort((a, b) => a[0] - b[0]);
            throw failures[0][1];
        }
        // Pauses propagate with the completed sibling results attached.
        if (paused.length) {
            paused.sort((a, b) => a[0] - b[0]);
            const pause = paused[0][1];
            pause.tool_results = results;
            throw pause;
        }
        return results;
    }
    ensureAsyncGenerator() {
        if (!this._generator) {
            if (this.model instanceof AsyncKeyModel) {
                this._generator = this.model.execute(this.prompt, this.stream, this, this.conversation, this.model.get_key(this._key));
            }
            else if (this.model instanceof AsyncModel) {
                this._generator = this.model.execute(this.prompt, this.stream, this, this.conversation);
            }
            else {
                throw new Error("self.model must be an AsyncModel or AsyncKeyModel");
            }
        }
    }
    async asyncFinalize() {
        if (this.conversation) {
            this.conversation.responses.push(this);
        }
        this._end = monotonicSeconds();
        this._done = true;
        delete this._generator;
        await this.onDoneAsync();
    }
    [Symbol.asyncIterator]() {
        this._start = monotonicSeconds();
        this._start_utcnow = utcNowIso();
        if (this._done) {
            this._iter_chunks = [...this._chunks];
        }
        return {
            next: async () => {
                if (this._done) {
                    if (this._iter_chunks && this._iter_chunks.length) {
                        return { value: this._iter_chunks.shift(), done: false };
                    }
                    return { value: undefined, done: true };
                }
                this.ensureAsyncGenerator();
                // Skip non-text events — iteration yields only text.
                while (true) {
                    const result = await this._generator.next();
                    if (result.done) {
                        await this.asyncFinalize();
                        return { value: undefined, done: true };
                    }
                    const chunk = result.value;
                    if (chunk === null || chunk === undefined) {
                        throw new Error("Model returned a null chunk");
                    }
                    const text = this.processChunk(chunk);
                    if (text !== null) {
                        return { value: text, done: false };
                    }
                }
            },
        };
    }
    /** Yield StreamEvent objects as the model produces them (async). */
    async *astream_events() {
        if (this._done) {
            for (const event of this._stream_events) {
                yield event;
            }
            return;
        }
        this._start = monotonicSeconds();
        this._start_utcnow = utcNowIso();
        this.ensureAsyncGenerator();
        while (true) {
            const result = await this._generator.next();
            if (result.done) {
                await this.asyncFinalize();
                return;
            }
            const chunk = result.value;
            if (chunk === null || chunk === undefined) {
                throw new Error("Model returned a null chunk");
            }
            this.processChunk(chunk);
            yield this._stream_events[this._stream_events.length - 1];
        }
    }
    /** List of Message objects produced by this response. */
    async messages() {
        await this._force();
        return this.messagesNow();
    }
    async _force() {
        if (!this._done) {
            for await (const _ of this) {
                // drain; populates self._chunks
            }
        }
    }
    text_or_raise() {
        if (!this._done) {
            throw new Error("Response not yet awaited");
        }
        return this._chunks.join("");
    }
    /** Return the full text of the response, executing the prompt if needed. */
    async text() {
        await this._force();
        return this._chunks.join("");
    }
    /** Return the list of tool calls made during this response. */
    async tool_calls() {
        await this._force();
        return this._tool_calls;
    }
    tool_calls_or_raise() {
        if (!this._done) {
            throw new Error("Response not yet awaited");
        }
        return this._tool_calls;
    }
    /** Return the raw JSON response from the model, if available. */
    async json() {
        await this._force();
        return this.response_json;
    }
    async duration_ms() {
        await this._force();
        return this.durationMsNow();
    }
    async datetime_utc() {
        await this._force();
        return this.datetimeUtcNow();
    }
    /** Return token usage information for this response. */
    async usage() {
        await this._force();
        return new Usage({
            input: this.input_tokens,
            output: this.output_tokens,
            details: this.token_details,
        });
    }
    /**
     * Makes `await response` work like Python's `__await__` (resolves to
     * the drained response). JS promise resolution would recurse forever
     * on a thenable that resolves to itself, so the fulfilled value is a
     * prototype-delegating view of this response with `then` masked off —
     * it behaves identically (instanceof, methods, state) but is not
     * itself thenable.
     */
    then(onfulfilled, onrejected) {
        return this._force().then(() => {
            if (!onfulfilled)
                return undefined;
            const settled = Object.create(this);
            Object.defineProperty(settled, "then", { value: undefined });
            return onfulfilled(settled);
        }, onrejected);
    }
    async toSyncResponse() {
        await this._force();
        const response = new Response(this.prompt, this.model, this.stream, this.conversation ? this.conversation.toSyncConversation() : null);
        response.id = this.id;
        response._chunks = [...this._chunks];
        response._done = this._done;
        response._end = this._end;
        response._start = this._start;
        response._start_utcnow = this._start_utcnow;
        response.input_tokens = this.input_tokens;
        response.output_tokens = this.output_tokens;
        response.token_details = this.token_details;
        response._prompt_json = this._prompt_json;
        response.response_json = this.response_json;
        response._tool_calls = [...this._tool_calls];
        response.attachments = [...this.attachments];
        response.resolved_model = this.resolved_model;
        return response;
    }
    /** Utility method to help with writing tests. */
    static fake({ model, prompt, attachments = [], system, response, }) {
        const responseObj = new AsyncResponse(new Prompt(prompt, model, { attachments, system }), model, false);
        responseObj._done = true;
        responseObj._chunks = [response];
        return responseObj;
    }
    toString() {
        let text = "... not yet awaited ...";
        if (this._done) {
            text = this._chunks.join("");
        }
        return `<AsyncResponse prompt='${this.prompt.prompt}' text='${text}'>`;
    }
}
function appendToolResultsToChain(chain, toolResults, attachments) {
    if (toolResults.length) {
        chain.push(new Message({
            role: "tool",
            parts: toolResults.map((tr) => new ToolResultPart({
                name: tr.name,
                output: tr.output,
                tool_call_id: tr.tool_call_id,
            })),
        }));
    }
    if (attachments.length) {
        chain.push(new Message({
            role: "user",
            parts: attachments.map((a) => new AttachmentPart({ attachment: a })),
        }));
    }
    return chain;
}
function chainForToolResults(priorResponse, toolResults, attachments) {
    const chain = [
        ...priorResponse.prompt.messages,
        ...priorResponse.messagesNow(),
    ];
    return appendToolResultsToChain(chain, toolResults, attachments);
}
/** Find unresolved tool calls at the end of a message history. */
function trailingPendingToolCalls(messages) {
    let lastIndex = null;
    let callParts = [];
    (messages ?? []).forEach((msg, i) => {
        const parts = msg.parts ?? [];
        const calls = parts.filter((p) => p instanceof ToolCallPart && !p.server_executed);
        if (msg.role === "assistant" && calls.length) {
            lastIndex = i;
            callParts = calls;
        }
    });
    if (lastIndex === null) {
        return [];
    }
    const results = [];
    for (const msg of messages.slice(lastIndex + 1)) {
        if (msg.role === "tool") {
            results.push(...(msg.parts ?? []).filter((p) => p instanceof ToolResultPart));
        }
        else {
            // Conversation moved on past these calls
            return [];
        }
    }
    const matchedIds = new Set(results.map((r) => r.tool_call_id).filter((id) => !!id));
    const unmatchedNames = results
        .filter((r) => !r.tool_call_id)
        .map((r) => r.name);
    const pending = [];
    for (const part of callParts) {
        if (part.tool_call_id) {
            if (matchedIds.has(part.tool_call_id)) {
                continue;
            }
        }
        else if (unmatchedNames.includes(part.name)) {
            unmatchedNames.splice(unmatchedNames.indexOf(part.name), 1);
            continue;
        }
        pending.push(new ToolCall({
            name: part.name,
            arguments: part.arguments ?? {},
            tool_call_id: part.tool_call_id,
        }));
    }
    return pending;
}
export class _BaseChainResponse {
    prompt;
    model;
    stream;
    conversation;
    _key;
    _responses = [];
    chain_limit;
    before_call;
    after_call;
    constructor(prompt, model, stream, conversation, key = null, chain_limit = 10, before_call = null, after_call = null) {
        this.prompt = prompt;
        this.model = model;
        this.stream = stream;
        this._key = key;
        this.conversation = conversation;
        this.chain_limit = chain_limit;
        this.before_call = before_call;
        this.after_call = after_call;
    }
    async logToDb(db) {
        for (const response of this._responses) {
            let syncResponse;
            if (response instanceof AsyncResponse) {
                syncResponse = await response.toSyncResponse();
            }
            else if (response instanceof Response) {
                syncResponse = response;
            }
            else {
                throw new Error("Should have been a Response or AsyncResponse");
            }
            await syncResponse.logToDb(db);
        }
    }
    /** Unresolved tool calls at the end of this chain's history. */
    pendingToolCalls() {
        if (!this.prompt.tools.length) {
            return [];
        }
        return trailingPendingToolCalls(this.prompt.messages);
    }
    /** The first prompt for a resumed chain. */
    resumePrompt(toolResults) {
        const prompt = this.prompt;
        const attachments = [];
        for (const toolResult of toolResults) {
            attachments.push(...toolResult.attachments);
        }
        const nextChain = appendToolResultsToChain([...prompt.messages], toolResults, attachments);
        return new Prompt("", this.model, {
            tools: prompt.tools,
            tool_results: toolResults,
            messages: nextChain,
            system: prompt._system,
            system_fragments: prompt.system_fragments,
            options: prompt.options,
            attachments,
            hide_reasoning: prompt.hide_reasoning,
        });
    }
}
export class ChainResponse extends _BaseChainResponse {
    /**
     * Async generator in TS (Python's is sync) because tool execution is
     * async. Yields each Response in the chain.
     */
    async *responses() {
        let count = 0;
        let initialResponse = new Response(this.prompt, this.model, this.stream, this.conversation, this._key);
        // Resume: a history ending in unresolved tool calls means a previous
        // run stopped before executing them.
        const pendingToolCalls = this.pendingToolCalls();
        if (pendingToolCalls.length) {
            const toolResults = await initialResponse.execute_tool_calls({
                before_call: this.before_call,
                after_call: this.after_call,
                tool_calls_list: pendingToolCalls,
            });
            initialResponse = new Response(this.resumePrompt(toolResults), this.model, this.stream, this.conversation, this._key);
        }
        let currentResponse = initialResponse;
        while (currentResponse) {
            count += 1;
            yield currentResponse;
            this._responses.push(currentResponse);
            if (this.chain_limit && count >= this.chain_limit) {
                throw new Error(`Chain limit of ${this.chain_limit} exceeded.`);
            }
            // This could raise llm.CancelToolCall:
            const toolResults = await currentResponse.execute_tool_calls({
                before_call: this.before_call,
                after_call: this.after_call,
            });
            const attachments = [];
            for (const toolResult of toolResults) {
                attachments.push(...toolResult.attachments);
            }
            if (toolResults.length) {
                // Pre-bake the full chain for the tool-result turn.
                const nextChain = chainForToolResults(currentResponse, toolResults, attachments);
                currentResponse = new Response(new Prompt("", this.model, {
                    tools: currentResponse.prompt.tools,
                    tool_results: toolResults,
                    messages: nextChain,
                    system: this.prompt._system,
                    system_fragments: this.prompt.system_fragments,
                    options: this.prompt.options,
                    attachments,
                    hide_reasoning: currentResponse.prompt.hide_reasoning,
                }), this.model, this.stream, this.conversation, this._key);
            }
            else {
                currentResponse = null;
                break;
            }
        }
    }
    async *[Symbol.asyncIterator]() {
        for await (const responseItem of this.responses()) {
            yield* responseItem;
        }
    }
    /** Yield StreamEvents from every response in the chain. */
    async *stream_events() {
        for await (const responseItem of this.responses()) {
            yield* responseItem.stream_events();
        }
    }
    async text() {
        const chunks = [];
        for await (const chunk of this) {
            chunks.push(chunk);
        }
        return chunks.join("");
    }
}
export class AsyncChainResponse extends _BaseChainResponse {
    async *responses() {
        let count = 0;
        let initialResponse = new AsyncResponse(this.prompt, this.model, this.stream, this.conversation, this._key);
        const pendingToolCalls = this.pendingToolCalls();
        if (pendingToolCalls.length) {
            const toolResults = await initialResponse.execute_tool_calls({
                before_call: this.before_call,
                after_call: this.after_call,
                tool_calls_list: pendingToolCalls,
            });
            initialResponse = new AsyncResponse(this.resumePrompt(toolResults), this.model, this.stream, this.conversation, this._key);
        }
        let currentResponse = initialResponse;
        while (currentResponse) {
            count += 1;
            yield currentResponse;
            this._responses.push(currentResponse);
            if (this.chain_limit && count >= this.chain_limit) {
                throw new Error(`Chain limit of ${this.chain_limit} exceeded.`);
            }
            // This could raise llm.CancelToolCall:
            const toolResults = await currentResponse.execute_tool_calls({
                before_call: this.before_call,
                after_call: this.after_call,
            });
            if (toolResults.length) {
                const attachments = [];
                for (const toolResult of toolResults) {
                    attachments.push(...toolResult.attachments);
                }
                const nextChain = chainForToolResults(currentResponse, toolResults, attachments);
                const prompt = new Prompt("", this.model, {
                    tools: currentResponse.prompt.tools,
                    tool_results: toolResults,
                    messages: nextChain,
                    system: this.prompt._system,
                    system_fragments: this.prompt.system_fragments,
                    options: this.prompt.options,
                    attachments,
                    hide_reasoning: currentResponse.prompt.hide_reasoning,
                });
                currentResponse = new AsyncResponse(prompt, this.model, this.stream, this.conversation, this._key);
            }
            else {
                currentResponse = null;
                break;
            }
        }
    }
    async *[Symbol.asyncIterator]() {
        for await (const responseItem of this.responses()) {
            for await (const chunk of responseItem) {
                yield chunk;
            }
        }
    }
    /** Yield StreamEvents from every response in the chain. */
    async *astream_events() {
        for await (const responseItem of this.responses()) {
            for await (const event of responseItem.astream_events()) {
                yield event;
            }
        }
    }
    async text() {
        const allChunks = [];
        for await (const chunk of this) {
            allChunks.push(chunk);
        }
        return allChunks.join("");
    }
}
export class Options extends BaseModel {
}
const _Options = Options;
export class _getKeyMixin {
    needs_key = null;
    key = null;
    key_env_var = null;
    get_key(explicitKey = null) {
        if (this.needs_key === null) {
            // This model doesn't use an API key
            return null;
        }
        if (this.key !== null) {
            // Someone already set model.key='...'
            return this.key;
        }
        // Attempt to load a key using llm.getKey()
        const keyValue = getKey({
            explicitKey,
            keyAlias: this.needs_key,
            envVar: this.key_env_var,
        });
        if (keyValue) {
            return keyValue;
        }
        // Show a useful error message
        let message = `No key found - add one using 'llm keys set ${this.needs_key}'`;
        if (this.key_env_var) {
            message += ` or set the ${this.key_env_var} environment variable`;
        }
        throw new NeedsKeyException(message);
    }
}
export class _BaseModel extends _getKeyMixin {
    model_id;
    can_stream = false;
    attachment_types = new Set();
    supports_schema = false;
    supports_tools = false;
    static Options = _Options;
    /**
     * The Options class for this model. Instance-level so constructors can
     * override it per instance (matching Python's `self.Options = ...`);
     * initialized from the class-level static.
     */
    Options = this.constructor.Options ??
        _Options;
    /** Build an Options instance for this model (`self.Options(**merged)`). */
    makeOptions(data) {
        return new this.Options(data);
    }
    /**
     * Synchronous attachment validation: catches the checks Python did
     * eagerly, minus URL type resolution which requires the network (that
     * happens at execution/logging time in TS).
     */
    validateAttachmentsSync(attachments) {
        if (attachments && attachments.length && !this.attachment_types.size) {
            throw new Error("This model does not support attachments");
        }
        for (const attachment of attachments ?? []) {
            if (!attachment.type && attachment.url) {
                continue; // resolved asynchronously later
            }
            const attachmentType = attachment.resolveTypeSync();
            if (attachmentType && !this.attachment_types.has(attachmentType)) {
                throw new Error(`This model does not support attachments of type '${attachmentType}', ` +
                    `only ${[...this.attachment_types].join(", ")}`);
            }
        }
    }
    async validateAttachments(attachments) {
        if (attachments && attachments.length && !this.attachment_types.size) {
            throw new Error("This model does not support attachments");
        }
        for (const attachment of attachments ?? []) {
            const attachmentType = await attachment.resolveType();
            if (attachmentType && !this.attachment_types.has(attachmentType)) {
                throw new Error(`This model does not support attachments of type '${attachmentType}', ` +
                    `only ${[...this.attachment_types].join(", ")}`);
            }
        }
    }
    toString() {
        const isAsync = this instanceof _AsyncModel;
        return `${this.constructor.name}${isAsync ? " (async)" : ""}: ${this.model_id}`;
    }
}
export class _Model extends _BaseModel {
    conversation({ tools = null, before_call = null, after_call = null, chain_limit = null, } = {}) {
        return new Conversation({
            model: this,
            tools,
            before_call,
            after_call,
            chain_limit,
        });
    }
    prompt(prompt = null, opts = {}) {
        const { fragments = null, attachments = null, system = null, system_fragments = null, messages = null, stream = true, schema = null, tools = null, tool_results = null, options = null, hide_reasoning = false, key = null, } = opts;
        const merged = mergeOptions(options, extraOptionKwargs(opts));
        this.validateAttachmentsSync(attachments);
        return new Response(new Prompt(prompt, this, {
            fragments,
            attachments,
            system,
            schema,
            tools,
            tool_results,
            system_fragments,
            messages,
            options: this.makeOptions(merged),
            hide_reasoning,
        }), this, stream, null, key);
    }
    chain(prompt = null, opts = {}) {
        return this.conversation().chain(prompt, opts);
    }
}
export class Model extends _Model {
}
export class KeyModel extends _Model {
}
export class _AsyncModel extends _BaseModel {
    conversation({ tools = null, before_call = null, after_call = null, chain_limit = null, } = {}) {
        return new AsyncConversation({
            model: this,
            tools,
            before_call,
            after_call,
            chain_limit,
        });
    }
    prompt(prompt = null, opts = {}) {
        const { fragments = null, attachments = null, system = null, schema = null, tools = null, tool_results = null, system_fragments = null, messages = null, stream = true, options = null, hide_reasoning = false, key = null, } = opts;
        const merged = mergeOptions(options, extraOptionKwargs(opts));
        this.validateAttachmentsSync(attachments);
        return new AsyncResponse(new Prompt(prompt, this, {
            fragments,
            attachments,
            system,
            schema,
            tools,
            tool_results,
            system_fragments,
            messages,
            options: this.makeOptions(merged),
            hide_reasoning,
        }), this, stream, null, key);
    }
    chain(prompt = null, opts = {}) {
        return this.conversation().chain(prompt, opts);
    }
}
export class AsyncModel extends _AsyncModel {
}
export class AsyncKeyModel extends _AsyncModel {
}
export class EmbeddingModel extends _getKeyMixin {
    model_id;
    supports_text = true;
    supports_binary = false;
    batch_size = null;
    check(item) {
        if (!this.supports_binary && item instanceof Uint8Array) {
            throw new Error("This model does not support binary data, only text strings");
        }
        if (!this.supports_text && typeof item === "string") {
            throw new Error("This model does not support text strings, only binary data");
        }
    }
    /** Embed a single text string or binary blob, return a list of floats.
     * Async in TS: embedding models hit the network. */
    async embed(item) {
        this.check(item);
        for await (const result of this.embedBatch([item])) {
            return result;
        }
        throw new Error("embed_batch returned no results");
    }
    /** Embed multiple items in batches according to the model batch_size. */
    async *embedMulti(items, batchSize = null) {
        const effectiveBatchSize = batchSize === null ? this.batch_size : batchSize;
        const allItems = [...items];
        if (!this.supports_binary || !this.supports_text) {
            for (const item of allItems) {
                this.check(item);
            }
        }
        if (effectiveBatchSize === null) {
            yield* this.embedBatch(allItems);
            return;
        }
        for (let i = 0; i < allItems.length; i += effectiveBatchSize) {
            yield* this.embedBatch(allItems.slice(i, i + effectiveBatchSize));
        }
    }
    toString() {
        return `${this.constructor.name}: ${this.model_id}`;
    }
}
export class ModelWithAliases {
    // "A model with its optional async counterpart and aliases."
    model;
    async_model;
    aliases;
    constructor(model, asyncModel, aliases) {
        this.model = model;
        this.async_model = asyncModel;
        this.aliases = aliases;
    }
    matches(query) {
        const queryLower = query.toLowerCase();
        const allStrings = [...this.aliases];
        if (this.model) {
            allStrings.push(String(this.model));
        }
        if (this.async_model) {
            allStrings.push(String(this.async_model.model_id));
        }
        return allStrings.some((alias) => alias.toLowerCase().includes(queryLower));
    }
}
export class EmbeddingModelWithAliases {
    model;
    aliases;
    constructor(model, aliases) {
        this.model = model;
        this.aliases = aliases;
    }
    matches(query) {
        const queryLower = query.toLowerCase();
        const allStrings = [...this.aliases, String(this.model)];
        return allStrings.some((alias) => alias.toLowerCase().includes(queryLower));
    }
}
function conversationName(text) {
    // Collapse whitespace, including newlines
    const collapsed = text.replace(/\s+/g, " ");
    const chars = [...collapsed];
    if (chars.length <= CONVERSATION_NAME_LENGTH) {
        return collapsed;
    }
    return chars.slice(0, CONVERSATION_NAME_LENGTH - 1).join("") + "…";
}
function ensureDictSchema(schema) {
    // Convert a pydantic-style model class to a JSON schema dict if needed.
    if (schema &&
        typeof schema === "function" &&
        schema.prototype instanceof BaseModel) {
        const schemaDict = schema.modelJsonSchema();
        removeTitlesRecursively(schemaDict);
        return schemaDict;
    }
    if (schema && typeof schema === "object") {
        return schema;
    }
    return schema ?? null;
}
function removeTitlesRecursively(obj) {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        delete obj.title;
        for (const value of Object.values(obj)) {
            removeTitlesRecursively(value);
        }
    }
    else if (Array.isArray(obj)) {
        for (const item of obj) {
            removeTitlesRecursively(item);
        }
    }
}
function getInstance(implementation) {
    if (implementation && "__self__" in implementation) {
        const self = implementation.__self__;
        return self ?? null;
    }
    return null;
}
