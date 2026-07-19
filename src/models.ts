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
import {
  Fragment,
  makeSchemaId,
  mimetypeFromPath,
  mimetypeFromString,
  monotonicUlid,
  tokenUsageString,
} from "./utils.js";
import { condenseJson } from "./condense.js";
import { dumps } from "./pyjson.js";
import { BaseModel, FieldDef } from "./pydantic.js";
import { acceptsParam, callWithKwargs, parseParams } from "./introspect.js";
import type { ResponseDict } from "./serialization.js";
import {
  AttachmentPart,
  Message,
  Part,
  ReasoningPart,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "./parts.js";

export const CONVERSATION_NAME_LENGTH = 32;

export class Usage {
  // "Token usage information from a model response."
  input: number | null;
  output: number | null;
  details: Record<string, unknown> | null;

  constructor({
    input = null,
    output = null,
    details = null,
  }: {
    input?: number | null;
    output?: number | null;
    details?: Record<string, unknown> | null;
  } = {}) {
    this.input = input;
    this.output = output;
    this.details = details;
  }
}

export interface AttachmentInit {
  type?: string | null;
  path?: string | null;
  url?: string | null;
  content?: Uint8Array | null;
  _id?: string | null;
}

export class Attachment {
  // "An attachment (image, audio, etc) to include with a prompt."
  type: string | null;
  path: string | null;
  url: string | null;
  content: Uint8Array | null;
  _id: string | null;

  constructor({
    type = null,
    path = null,
    url = null,
    content = null,
    _id = null,
  }: AttachmentInit = {}) {
    this.type = type;
    this.path = path;
    this.url = url;
    this.content = content;
    this._id = _id;
  }

  id(): string {
    // Hash of the binary content, or of '{"url": "https://..."}' for URL attachments
    if (this._id === null) {
      if (this.content && this.content.length) {
        this._id = createHash("sha256").update(this.content).digest("hex");
      } else if (this.path) {
        this._id = createHash("sha256")
          .update(fs.readFileSync(this.path))
          .digest("hex");
      } else {
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
  async resolveType(): Promise<string | null> {
    if (this.type) return this.type;
    if (this.path) return mimetypeFromPath(this.path);
    if (this.url) {
      const response = await fetch(this.url, { method: "HEAD" });
      if (!response.ok) {
        throw new Error(
          `HTTP error ${response.status} while resolving type of ${this.url}`,
        );
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
  resolveTypeSync(): string | null {
    if (this.type) return this.type;
    if (this.path) return mimetypeFromPath(this.path);
    if (this.content && this.content.length) {
      return mimetypeFromString(this.content);
    }
    if (this.url) {
      throw new Error(
        "Attachment type for URL attachments must be resolved asynchronously",
      );
    }
    throw new Error("Attachment has no type and no content to derive it from");
  }

  /** Return the binary content, reading from path or URL if needed. */
  async contentBytes(): Promise<Uint8Array | null> {
    let content = this.content;
    if (!content || !content.length) {
      if (this.path) {
        content = fs.readFileSync(this.path);
      } else if (this.url) {
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
  async base64Content(): Promise<string> {
    const bytes = await this.contentBytes();
    return Buffer.from(bytes ?? new Uint8Array()).toString("base64");
  }

  toString(): string {
    const info = [`<Attachment: ${this.id()}`];
    if (this.type) info.push(`type="${this.type}"`);
    if (this.path) info.push(`path="${this.path}"`);
    if (this.url) info.push(`url="${this.url}"`);
    if (this.content && this.content.length) {
      info.push(`content=${this.content.length} bytes`);
    }
    return info.join(" ") + ">";
  }

  static fromRow(row: Record<string, unknown>): Attachment {
    return new Attachment({
      _id: row.id as string | null,
      type: row.type as string | null,
      path: row.path as string | null,
      url: row.url as string | null,
      content: (row.content as Uint8Array | null) ?? null,
    });
  }
}

type AnyFunction = (...args: any[]) => any;

export interface ToolInit {
  name: string;
  description?: string | null;
  input_schema?: Record<string, unknown> | typeof BaseModel;
  implementation?: AnyFunction | null;
  plugin?: string | null;
}

export class Tool {
  // "A tool that can be called by a model."
  name: string;
  description: string | null;
  input_schema: Record<string, unknown>;
  implementation: AnyFunction | null;
  plugin: string | null; // plugin tool came from, e.g. 'llm_tools_sqlite'

  constructor({
    name,
    description = null,
    input_schema = {},
    implementation = null,
    plugin = null,
  }: ToolInit) {
    this.name = name;
    this.description = description;
    this.input_schema = ensureDictSchema(input_schema) ?? {};
    this.implementation = implementation;
    this.plugin = plugin;
  }

  hash(): string {
    // Hash for tool based on its name, description and input schema (preserving key order)
    const toHash: Record<string, unknown> = {
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
  static function(
    fn: AnyFunction,
    {
      name = null,
      description = null,
    }: { name?: string | null; description?: string | null } = {},
  ): Tool {
    const fnName =
      (fn as { __name__?: string }).__name__ ??
      ((fn as { __wrapped__?: AnyFunction }).__wrapped__?.name || fn.name);
    if (!name && !fnName) {
      throw new Error(
        "Cannot create a Tool from a lambda function without providing name=",
      );
    }
    return new Tool({
      name: name || fnName,
      description:
        description ??
        (fn as { description?: string }).description ??
        null,
      input_schema: getArgumentsInputSchema(fn),
      implementation: fn,
    });
  }
}

function getArgumentsInputSchema(fn: AnyFunction): Record<string, unknown> {
  const annotations =
    ((fn as { annotations?: Record<string, unknown> }).annotations as
      | Record<string, string | Record<string, unknown>>
      | undefined) ?? {};
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const param of parseParams(fn)) {
    if (param.name === "self" || param.name === "llm_tool_call") {
      // llm_tool_call is reserved: populated with the ToolCall object
      // at execution time, never exposed to the model.
      continue;
    }
    const ann = annotations[param.name];
    let prop: Record<string, unknown>;
    if (ann && typeof ann === "object") {
      prop = { ...(ann as Record<string, unknown>) };
    } else {
      prop = { type: (ann as string) ?? "string" };
    }
    if (param.hasDefault) {
      prop.default = param.default ?? null;
    } else {
      required.push(param.name);
    }
    properties[param.name] = prop;
  }
  const schema: Record<string, unknown> = { properties, type: "object" };
  if (required.length) {
    schema.required = required;
  }
  return schema;
}

function accepts_llm_tool_call(implementation: AnyFunction | null): boolean {
  if (!implementation) return false;
  return acceptsParam(implementation, "llm_tool_call");
}

function implementationArguments(
  tool: Tool,
  toolCall: ToolCall,
): Record<string, unknown> {
  // Implementations with an explicit `llm_tool_call` parameter receive
  // the ToolCall object itself.
  const args: Record<string, unknown> = { ...toolCall.arguments };
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
  static toolboxName: string | null = null;
  static plugin: string | null = null;
  instance_id: number | null = null;
  plugin: string | null = null;
  _extra_tools: Tool[] = [];
  _config: Record<string, unknown> = {};
  _prepared = false;
  _async_prepared = false;

  /**
   * Python's __init_subclass__ wraps __init__ to capture constructor
   * kwargs into _config. TS constructors take a single options object by
   * convention; the base constructor stores it.
   */
  constructor(config: Record<string, unknown> = {}) {
    this._config = { ...config };
    this._extra_tools = [];
    const cls = this.constructor as typeof Toolbox;
    if (cls.plugin) this.plugin = cls.plugin;
  }

  static get name_(): string {
    return this.toolboxName ?? this.name;
  }

  static method_tools(): Tool[] {
    const tools: Tool[] = [];
    for (const methodName of toolboxMethodNames(this)) {
      const method = (this.prototype as unknown as Record<string, unknown>)[
        methodName
      ] as AnyFunction;
      tools.push(
        Tool.function(method, { name: `${this.name}_${methodName}` }),
      );
    }
    return tools;
  }

  /** An llm.Tool() for each class method, plus extras from add_tool(). */
  *tools(): Generator<Tool> {
    const cls = this.constructor as typeof Toolbox;
    for (const name of toolboxMethodNames(cls)) {
      const method = (this as unknown as Record<string, AnyFunction>)[name];
      if (typeof method !== "function") continue;
      const bound = Object.assign(
        (...args: unknown[]) => method.apply(this, args),
        { __wrapped__: method, __self__: this, __name__: name },
      );
      const tool = Tool.function(bound as AnyFunction, {
        name: `${cls.name}_${name}`,
      });
      tool.plugin = this.plugin ?? null;
      yield tool;
    }
    yield* this._extra_tools;
  }

  /** Add a tool to this toolbox. */
  add_tool(toolOrFunction: Tool | AnyFunction, passSelf = false): void {
    if (toolOrFunction instanceof Tool) {
      this._extra_tools.push(toolOrFunction);
    } else if (typeof toolOrFunction === "function") {
      let fn = toolOrFunction;
      if (passSelf) {
        const original = toolOrFunction;
        fn = Object.assign(
          (...args: unknown[]) => original.call(null, this, ...args),
          {
            __wrapped__: original,
            __self__: this,
            __name__: original.name,
            annotations: (original as { annotations?: unknown }).annotations,
            description: (original as { description?: string }).description,
          },
        ) as AnyFunction;
        // Python's MethodType binds self as the first parameter, hiding
        // it from the schema. Mirror that by masking the first param.
        (fn as { __boundFirstParam__?: boolean }).__boundFirstParam__ = true;
      }
      this._extra_tools.push(toolFunctionSkippingFirst(fn, passSelf));
    } else {
      throw new Error("Tool must be an instance of Tool or a callable function");
    }
  }

  /**
   * Over-ride this to perform setup (and .add_tool() calls) before the
   * toolbox is used. Implement prepare_async() for async setup.
   */
  prepare(): void {}

  async prepare_async(): Promise<void> {}
}

function toolFunctionSkippingFirst(fn: AnyFunction, skipFirst: boolean): Tool {
  if (!skipFirst) return Tool.function(fn);
  const original =
    ((fn as { __wrapped__?: AnyFunction }).__wrapped__ as AnyFunction) ?? fn;
  const params = parseParams(original).slice(1); // drop bound self
  const annotations =
    ((original as { annotations?: Record<string, unknown> })
      .annotations as Record<string, string | Record<string, unknown>>) ?? {};
  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  for (const param of params) {
    if (param.name === "llm_tool_call") continue;
    const ann = annotations[param.name];
    const prop: Record<string, unknown> =
      ann && typeof ann === "object"
        ? { ...(ann as Record<string, unknown>) }
        : { type: (ann as string) ?? "string" };
    if (param.hasDefault) prop.default = param.default ?? null;
    else required.push(param.name);
    properties[param.name] = prop;
  }
  const schema: Record<string, unknown> = { properties, type: "object" };
  if (required.length) schema.required = required;
  // Invocation maps kwargs onto the original params minus the bound self.
  const wrapper = Object.assign(
    (...args: unknown[]) => fn(...args),
    {
      __wrapped2__: original,
      __self__: (fn as { __self__?: unknown }).__self__,
      __kwargNames__: params.map((p) => p.name),
    },
  );
  return new Tool({
    name:
      (original as { __name__?: string }).__name__ ?? original.name,
    description: (original as { description?: string }).description ?? null,
    input_schema: schema,
    implementation: wrapper as AnyFunction,
  });
}

function toolboxMethodNames(cls: typeof Toolbox): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  let proto = cls.prototype;
  const chain: object[] = [];
  while (proto && proto !== Object.prototype) {
    chain.push(proto);
    proto = Object.getPrototypeOf(proto);
  }
  // Python's dir() sorts names; match that for deterministic ordering.
  for (const p of chain) {
    for (const name of Object.getOwnPropertyNames(p)) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (name.startsWith("_") || TOOLBOX_BLOCKED.has(name)) continue;
      const desc = Object.getOwnPropertyDescriptor(p, name);
      if (!desc || typeof desc.value !== "function") continue;
      names.push(name);
    }
  }
  return names.sort();
}

export class ToolCall {
  // "A request by the model to call a tool."
  name: string;
  arguments: Record<string, unknown>;
  tool_call_id: string | null;

  constructor({
    name,
    arguments: args,
    tool_call_id = null,
  }: {
    name: string;
    arguments: Record<string, unknown>;
    tool_call_id?: string | null;
  }) {
    this.name = name;
    this.arguments = args;
    this.tool_call_id = tool_call_id;
  }
}

export class ToolResult {
  // "The result of executing a tool call."
  name: string;
  output: string;
  attachments: Attachment[];
  tool_call_id: string | null;
  instance: Toolbox | null;
  exception: Error | null;

  constructor({
    name,
    output,
    attachments = [],
    tool_call_id = null,
    instance = null,
    exception = null,
  }: {
    name: string;
    output: string;
    attachments?: Attachment[];
    tool_call_id?: string | null;
    instance?: Toolbox | null;
    exception?: Error | null;
  }) {
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
  output: string | Record<string, unknown> | unknown[] | boolean | number | null;
  attachments: Attachment[];

  constructor({
    output = null,
    attachments = [],
  }: {
    output?: ToolOutput["output"];
    attachments?: Attachment[];
  } = {}) {
    this.output = output;
    this.attachments = attachments;
  }
}

export type ToolDef = Tool | Toolbox | AnyFunction;
export type BeforeCallSync = (
  tool: Tool | null,
  toolCall: ToolCall,
) => void | Promise<void>;
export type AfterCallSync = (
  tool: Tool,
  toolCall: ToolCall,
  toolResult: ToolResult,
) => void | Promise<void>;
export type BeforeCallAsync = BeforeCallSync;
export type AfterCallAsync = AfterCallSync;

export class CancelToolCall extends Error {
  constructor(message?: string) {
    super(message);
    this.name = "CancelToolCall";
  }
}

/**
 * Raise inside a tool implementation to pause the chain. Before it is
 * re-raised the framework populates `tool_call` and `tool_results`.
 */
export class PauseChain extends Error {
  tool_call: ToolCall | null = null;
  tool_results: ToolResult[] = [];

  constructor(message?: string) {
    super(message);
    this.name = "PauseChain";
  }
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

export class Prompt {
  // "The prompt being sent to the model."
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

  constructor(
    prompt: string | null,
    model: _BaseModel,
    {
      fragments = null,
      attachments = null,
      system = null,
      system_fragments = null,
      prompt_json = null,
      options = null,
      schema = null,
      tools = null,
      tool_results = null,
      messages = null,
      hide_reasoning = false,
    }: PromptInit = {},
  ) {
    this._prompt = prompt;
    this.model = model;
    this.attachments = [...(attachments ?? [])];
    this.fragments = fragments ?? [];
    this._system = system;
    this.system_fragments = system_fragments ?? [];
    this.prompt_json = prompt_json;
    // Unlike Tool (which strips titles), Prompt keeps the schema verbatim;
    // a pydantic-style class converts via modelJsonSchema().
    if (
      schema &&
      typeof schema === "function" &&
      (schema as typeof BaseModel).prototype instanceof BaseModel
    ) {
      this.schema = (schema as typeof BaseModel).modelJsonSchema();
    } else {
      this.schema = (schema as Record<string, unknown> | null) ?? null;
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
  get prompt(): string {
    const bits = this.fragments.map((f) => String(f));
    if (this._prompt) bits.push(String(this._prompt));
    return bits.join("\n");
  }

  /** The system prompt, with any system fragments concatenated. */
  get system(): string {
    return combineSystem(this._system, this.system_fragments);
  }

  /**
   * Canonical list of Message objects for this prompt. See the Python
   * docstring: if messages= was passed explicitly it is authoritative;
   * otherwise the list is synthesized from the legacy kwargs.
   */
  get messages(): Message[] {
    if (this._explicit_messages !== null) {
      return [...this._explicit_messages];
    }

    const result: Message[] = [];

    if (this.system) {
      result.push(
        new Message({
          role: "system",
          parts: [new TextPart({ text: this.system })],
        }),
      );
    }

    if (this.tool_results.length) {
      result.push(
        new Message({
          role: "tool",
          parts: this.tool_results.map(
            (tr) =>
              new ToolResultPart({
                name: tr.name,
                output: tr.output,
                tool_call_id: tr.tool_call_id,
              }),
          ),
        }),
      );
    }

    const userParts: Part[] = [];
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

function wrapTools(tools: ToolDef[]): Tool[] {
  const wrapped: Tool[] = [];
  for (const tool of tools) {
    if (tool instanceof Tool) {
      wrapped.push(tool);
    } else if (tool instanceof Toolbox) {
      wrapped.push(...tool.tools());
    } else if (typeof tool === "function") {
      wrapped.push(Tool.function(tool));
    } else {
      throw new Error(`Invalid tool: ${String(tool)}`);
    }
  }
  return wrapped;
}

function combineSystem(
  system: string | null,
  systemFragments: Array<string | Fragment>,
): string {
  // Concatenate the system prompt and any system fragments into one string.
  const bits = [...(systemFragments ?? []), system ?? ""]
    .map((bit) => String(bit).trim())
    .filter(Boolean);
  return bits.join("\n\n");
}

function mergeOptions(
  options: Record<string, unknown> | null | undefined,
  kwargs: Record<string, unknown>,
): Record<string, unknown> {
  if (!options) return kwargs;
  const overlap = Object.keys(options).filter((k) => k in kwargs);
  if (overlap.length) {
    throw new TypeError(
      `Got values for these options both in options= and as keyword arguments: ${JSON.stringify(
        overlap.sort(),
      )}`,
    );
  }
  return { ...options, ...kwargs };
}

function utcNowIso(): string {
  // Python datetime.now(timezone.utc).isoformat() style: +00:00 suffix
  return new Date().toISOString().replace("Z", "+00:00");
}

function monotonicSeconds(): number {
  return performance.now() / 1000;
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

export abstract class _BaseConversation {
  model: _BaseModel;
  id: string;
  name: string | null;
  responses: _BaseResponse[];
  tools: ToolDef[] | null;
  chain_limit: number | null;

  constructor({
    model,
    id,
    name = null,
    responses,
    tools = null,
    chain_limit = null,
  }: ConversationInit) {
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
  protected buildFullChain({
    prompt,
    attachments,
    tool_results,
    explicit_messages,
    system = null,
    system_fragments = null,
  }: {
    prompt: string | null;
    attachments: Attachment[] | null | undefined;
    tool_results: ToolResult[] | null | undefined;
    explicit_messages: Message[] | null | undefined;
    system?: string | null;
    system_fragments?: Array<string | Fragment> | null;
  }): Message[] {
    if (explicit_messages != null) {
      return [...explicit_messages];
    }

    const chain: Message[] = [];
    if (this.responses.length) {
      const last = this.responses[this.responses.length - 1];
      // last.prompt.messages already contains the full input chain
      // under the invariant, so use the last response only and then
      // append that response's structured output.
      chain.push(...last.prompt.messages);
      chain.push(...last.messagesNow());
    } else {
      // Start with the system prompt as the first message so adapters
      // that build from prompt.messages see it.
      const systemText = combineSystem(system, system_fragments ?? []);
      if (systemText) {
        chain.push(
          new Message({
            role: "system",
            parts: [new TextPart({ text: systemText })],
          }),
        );
      }
    }

    // Append the new turn's input
    if (tool_results && tool_results.length) {
      chain.push(
        new Message({
          role: "tool",
          parts: tool_results.map(
            (tr) =>
              new ToolResultPart({
                name: tr.name,
                output: tr.output,
                tool_call_id: tr.tool_call_id,
              }),
          ),
        }),
      );
    }

    const userParts: Part[] = [];
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

  toString(): string {
    const count = this.responses.length;
    const s = count === 1 ? "s" : "";
    return `<${this.constructor.name}: ${this.id} - ${count} response${s}`;
  }
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

function extraOptionKwargs(
  opts: Record<string, unknown>,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (!PROMPT_KWARG_KEYS.has(k) && v !== undefined) {
      extras[k] = v;
    }
  }
  return extras;
}

export class Conversation extends _BaseConversation {
  before_call: BeforeCallSync | null;
  after_call: AfterCallSync | null;
  declare model: _Model;
  declare responses: Response[];

  constructor(init: ConversationInit) {
    super(init);
    this.before_call = init.before_call ?? null;
    this.after_call = init.after_call ?? null;
  }

  prompt(prompt: string | null = null, opts: PromptOptions = {}): Response {
    const {
      fragments = null,
      attachments = null,
      system = null,
      schema = null,
      tools = null,
      tool_results = null,
      system_fragments = null,
      messages = null,
      stream = true,
      key = null,
      options = null,
      hide_reasoning = false,
    } = opts;
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
    return new Response(
      new Prompt(prompt, this.model, {
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
      }),
      this.model,
      stream,
      this,
      key,
    );
  }

  chain(prompt: string | null = null, opts: ChainOptions = {}): ChainResponse {
    const {
      fragments = null,
      attachments = null,
      system = null,
      system_fragments = null,
      messages = null,
      stream = true,
      schema = null,
      tools = null,
      tool_results = null,
      chain_limit = null,
      before_call = null,
      after_call = null,
      key = null,
      options = null,
      hide_reasoning = false,
    } = opts;
    this.model.validateAttachmentsSync(attachments);
    const chainMessages = this.buildFullChain({
      prompt,
      attachments,
      tool_results,
      explicit_messages: messages,
      system,
      system_fragments,
    });
    return new ChainResponse(
      new Prompt(prompt, this.model, {
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
      }),
      this.model,
      stream,
      this,
      key,
      chain_limit !== null ? chain_limit : this.chain_limit,
      before_call ?? this.before_call,
      after_call ?? this.after_call,
    );
  }

  static async fromRow(row: Record<string, unknown>): Promise<Conversation> {
    const { getModel } = await import("./index.js");
    return new Conversation({
      model: getModel(row.model as string) as _Model,
      id: row.id as string,
      name: row.name as string | null,
    });
  }
}

export class AsyncConversation extends _BaseConversation {
  before_call: BeforeCallAsync | null;
  after_call: AfterCallAsync | null;
  declare model: _AsyncModel;
  declare responses: AsyncResponse[];

  constructor(init: ConversationInit) {
    super(init);
    this.before_call = init.before_call ?? null;
    this.after_call = init.after_call ?? null;
  }

  chain(
    prompt: string | null = null,
    opts: ChainOptions = {},
  ): AsyncChainResponse {
    const {
      fragments = null,
      attachments = null,
      system = null,
      system_fragments = null,
      messages = null,
      stream = true,
      schema = null,
      tools = null,
      tool_results = null,
      chain_limit = null,
      before_call = null,
      after_call = null,
      key = null,
      options = null,
      hide_reasoning = false,
    } = opts;
    this.model.validateAttachmentsSync(attachments);
    const chainMessages = this.buildFullChain({
      prompt,
      attachments,
      tool_results,
      explicit_messages: messages,
      system,
      system_fragments,
    });
    return new AsyncChainResponse(
      new Prompt(prompt, this.model, {
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
      }),
      this.model,
      stream,
      this,
      key,
      chain_limit !== null ? chain_limit : this.chain_limit,
      before_call ?? this.before_call,
      after_call ?? this.after_call,
    );
  }

  prompt(prompt: string | null = null, opts: PromptOptions = {}): AsyncResponse {
    const {
      fragments = null,
      attachments = null,
      system = null,
      schema = null,
      tools = null,
      tool_results = null,
      system_fragments = null,
      messages = null,
      stream = true,
      key = null,
      options = null,
      hide_reasoning = false,
    } = opts;
    const merged = mergeOptions(options, extraOptionKwargs(opts));
    const chain = this.buildFullChain({
      prompt,
      attachments,
      tool_results,
      explicit_messages: messages,
      system,
      system_fragments,
    });
    return new AsyncResponse(
      new Prompt(prompt, this.model, {
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
      }),
      this.model,
      stream,
      this,
      key,
    );
  }

  toSyncConversation(): Conversation {
    return new Conversation({
      model: this.model as unknown as _Model,
      id: this.id,
      name: this.name,
      responses: [], // Because we only use this in logging
      tools: this.tools,
      chain_limit: this.chain_limit,
    });
  }

  static async fromRow(row: Record<string, unknown>): Promise<AsyncConversation> {
    const { getAsyncModel } = await import("./index.js");
    return new AsyncConversation({
      model: getAsyncModel(row.model as string) as _AsyncModel,
      id: row.id as string,
      name: row.name as string | null,
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

type EventFamily = "text" | "reasoning" | "tool_call" | "tool_result";

export abstract class _BaseResponse {
  id: string;
  prompt: Prompt;
  model: _BaseModel;
  stream: boolean;
  resolved_model: string | null = null;
  conversation: _BaseConversation | null = null;
  _key: string | null;
  _prompt_json: unknown = null;
  _chunks: string[] = [];
  _stream_events: StreamEvent[] = [];
  _auto_index_max = -1;
  _auto_last_index: number | null = null;
  _auto_last_family: string | null = null;
  _auto_tool_id_to_index: Record<string, number> = {};
  _done = false;
  _tool_calls: ToolCall[] = [];
  response_json: Record<string, unknown> | null = null;
  attachments: Attachment[] = [];
  _start: number | null = null;
  _end: number | null = null;
  _start_utcnow: string | null = null;
  input_tokens: number | null = null;
  output_tokens: number | null = null;
  token_details: Record<string, unknown> | null = null;
  done_callbacks: Array<(response: any) => unknown> = [];
  _loaded_messages: Message[] | null = null;

  constructor(
    prompt: Prompt,
    model: _BaseModel,
    stream: boolean,
    conversation: _BaseConversation | null = null,
    key: string | null = null,
  ) {
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
  messagesNow(): Message[] {
    if (this._loaded_messages !== null) {
      return [...this._loaded_messages];
    }
    const parts = this.buildParts();
    if (!parts.length) return [];
    return [new Message({ role: "assistant", parts })];
  }

  protected static eventFamily(eventType: string): EventFamily {
    if (eventType === "tool_call_name" || eventType === "tool_call_args") {
      return "tool_call";
    }
    return eventType as EventFamily;
  }

  /** Mutate event.part_index in place when the plugin left it null. */
  protected resolvePartIndex(event: StreamEvent): void {
    const fam = _BaseResponse.eventFamily(event.type);

    if (event.part_index !== null) {
      if (event.part_index > this._auto_index_max) {
        this._auto_index_max = event.part_index;
      }
      if (
        (event.type === "tool_call_name" || event.type === "tool_call_args") &&
        event.tool_call_id
      ) {
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
      if (
        event.type === "tool_call_args" &&
        this._auto_last_family === "tool_call" &&
        this._auto_last_index !== null
      ) {
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
  protected processChunk(chunk: string | StreamEvent): string | null {
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
  protected buildParts(): Part[] {
    if (!this._stream_events.length) {
      // Rehydrated-from-SQLite path.
      const fallbackParts: Part[] = [];
      const text = this._chunks.join("");
      if (text) {
        fallbackParts.push(new TextPart({ text }));
      }
      for (const tc of this._tool_calls) {
        fallbackParts.push(
          new ToolCallPart({
            name: tc.name,
            arguments: tc.arguments ?? {},
            tool_call_id: tc.tool_call_id,
          }),
        );
      }
      return fallbackParts;
    }

    // Group events by their (resolved) part_index, preserving the order
    // in which each index was first seen.
    const groups = new Map<number, StreamEvent[]>();
    for (const event of this._stream_events) {
      const pi = event.part_index as number;
      if (!groups.has(pi)) {
        groups.set(pi, []);
      }
      groups.get(pi)!.push(event);
    }

    let parts: Part[] = [];
    for (const [pi, evs] of groups) {
      const famFirst = _BaseResponse.eventFamily(evs[0].type);
      for (const e of evs) {
        if (_BaseResponse.eventFamily(e.type) !== famFirst) {
          throw new Error(
            `StreamEvent type '${e.type}' is incompatible with prior type at part_index=${pi}. ` +
              "Allocate a new part_index for a different content type.",
          );
        }
      }

      let pmMerged: Record<string, unknown> | null = null;
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
      } else if (famFirst === "reasoning") {
        const text = evs.map((e) => e.chunk).join("");
        const redacted = evs.some((e) => e.redacted);
        if (text || redacted) {
          parts.push(
            new ReasoningPart({ text, redacted, provider_metadata: pmMerged }),
          );
        }
      } else if (famFirst === "tool_call") {
        const toolName = evs
          .filter((e) => e.type === "tool_call_name")
          .map((e) => e.chunk)
          .join("");
        const argsStr = evs
          .filter((e) => e.type === "tool_call_args")
          .map((e) => e.chunk)
          .join("");
        let args: Record<string, unknown>;
        try {
          args = argsStr ? JSON.parse(argsStr) : {};
        } catch {
          args = { _raw: argsStr };
        }
        const toolCallId = evs.find((e) => e.tool_call_id)?.tool_call_id ?? null;
        const serverExecuted = evs.some((e) => e.server_executed);
        parts.push(
          new ToolCallPart({
            name: toolName,
            arguments: args,
            tool_call_id: toolCallId,
            server_executed: serverExecuted,
            provider_metadata: pmMerged,
          }),
        );
      } else if (famFirst === "tool_result") {
        const toolResultName = evs.find((e) => e.tool_name)?.tool_name ?? "";
        const toolCallId = evs.find((e) => e.tool_call_id)?.tool_call_id ?? null;
        const serverExecuted = evs.some((e) => e.server_executed);
        parts.push(
          new ToolResultPart({
            name: toolResultName,
            output: evs.map((e) => e.chunk).join(""),
            tool_call_id: toolCallId,
            server_executed: serverExecuted,
            provider_metadata: pmMerged,
          }),
        );
      }
    }

    // Merge in tool calls registered via add_tool_call() that the plugin
    // didn't also emit as StreamEvents. Dedup by tool_call_id.
    const seenIds = new Set(
      parts
        .filter((p): p is ToolCallPart => p instanceof ToolCallPart)
        .map((p) => p.tool_call_id)
        .filter((id): id is string => id !== null),
    );
    for (const tc of this._tool_calls) {
      if (tc.tool_call_id !== null && seenIds.has(tc.tool_call_id)) {
        continue;
      }
      parts.push(
        new ToolCallPart({
          name: tc.name,
          arguments: tc.arguments ?? {},
          tool_call_id: tc.tool_call_id,
        }),
      );
    }

    // Hoist redacted reasoning Parts to the start of the message.
    const redactedParts = parts.filter(
      (p): p is ReasoningPart => p instanceof ReasoningPart && p.redacted,
    );
    if (redactedParts.length) {
      const otherParts = parts.filter(
        (p) => !(p instanceof ReasoningPart && p.redacted),
      );
      parts = [...redactedParts, ...otherParts];
    }

    return parts;
  }

  add_tool_call(toolCall: ToolCall): void {
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

  set_usage({
    input = null,
    output = null,
    details = null,
  }: {
    input?: number | null;
    output?: number | null;
    details?: Record<string, unknown> | null;
  } = {}): void {
    this.input_tokens = input;
    this.output_tokens = output;
    this.token_details = details;
  }

  set_resolved_model(modelId: string): void {
    this.resolved_model = modelId;
  }

  token_usage(): string {
    return tokenUsageString(
      this.input_tokens,
      this.output_tokens,
      this.token_details,
    );
  }

  abstract text_or_raise(): string;

  /**
   * Log this response to the database. Async in TS because attachment
   * type resolution may require a network fetch.
   */
  async logToDb(db: any): Promise<void> {
    const { ensureFragment, ensureTool } = await import("./dbutils.js");
    let conversation = this.conversation;
    if (!conversation) {
      conversation = new Conversation({ model: this.model as _Model });
    }
    db.table("conversations").insert(
      {
        id: conversation.id,
        name: conversationName(this.prompt.prompt || this.prompt.system || ""),
        model: conversation.model.model_id,
      },
      { ignore: true },
    );
    let schemaId: string | null = null;
    if (this.prompt.schema) {
      const [sid, schemaJson] = makeSchemaId(this.prompt.schema);
      schemaId = sid;
      db.table("schemas").insert(
        { id: schemaId, content: schemaJson },
        { ignore: true },
      );
    }

    const responseId = this.id;
    const replacements: Record<string, string> = {};
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
      .filter((p): p is ReasoningPart => p instanceof ReasoningPart && !!p.text)
      .map((p) => p.text)
      .join("");
    const jsonData = this.response_json;

    const optionsDump =
      this.prompt.options instanceof BaseModel
        ? this.prompt.options.modelDump()
        : { ...this.prompt.options };
    const response: Record<string, unknown> = {
      id: responseId,
      model: this.model.model_id,
      prompt: this.prompt._prompt,
      system: this.prompt._system,
      prompt_json: condenseJson(this._prompt_json, replacements),
      options_json: Object.fromEntries(
        Object.entries(optionsDump).filter(([, v]) => v !== null && v !== undefined),
      ),
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
      db.table("attachments").insert(
        {
          id: attachmentId,
          type: await attachment.resolveType(),
          path: attachment.path,
          url: attachment.url,
          content: attachment.content,
        },
        { replace: true },
      );
      db.table("prompt_attachments").insert({
        response_id: responseId,
        attachment_id: attachmentId,
        order: index,
      });
    }

    // Persist any tools, tool calls and tool results
    const toolIdsByName: Record<string, number> = {};
    let lastTool: Tool | null = null;
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
      let instanceId: number | null = null;
      if (toolResult.instance) {
        if (!toolResult.instance.instance_id) {
          toolResult.instance.instance_id = db
            .table("tool_instances")
            .insert({
              plugin: lastTool?.plugin ?? null,
              name: lastTool ? lastTool.name.split("_")[0] : null,
              arguments: dumps(toolResult.instance._config),
            }).lastPk as number;
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
      }).lastPk as number;
      // Persist attachments for tool results
      for (let index = 0; index < toolResult.attachments.length; index++) {
        const attachment = toolResult.attachments[index];
        const attachmentId = attachment.id();
        db.table("attachments").insert(
          {
            id: attachmentId,
            type: await attachment.resolveType(),
            path: attachment.path,
            url: attachment.url,
            content: attachment.content,
          },
          { replace: true },
        );
        db.table("tool_results_attachments").insert({
          tool_result_id: toolResultId,
          attachment_id: attachmentId,
          order: index,
        });
      }
    }
  }

  protected durationMsNow(): number {
    return Math.floor(((this._end ?? 0) - (this._start ?? 0)) * 1000);
  }

  protected datetimeUtcNow(): string {
    return this._start_utcnow ?? "";
  }

  static async fromRowBase(
    cls: new (
      prompt: Prompt,
      model: _BaseModel,
      stream: boolean,
    ) => _BaseResponse,
    db: any,
    row: Record<string, unknown>,
    _async = false,
  ): Promise<_BaseResponse> {
    const { getModel, getAsyncModel } = await import("./index.js");
    const model: _BaseModel = _async
      ? (getAsyncModel(row.model as string) as _BaseModel)
      : (getModel(row.model as string) as _BaseModel);

    // Schema
    let schema: Record<string, unknown> | null = null;
    if (row.schema_id) {
      schema = JSON.parse(
        db.table("schemas").get(row.schema_id as string).content as string,
      );
    }

    // Tool definitions and results for prompt
    const tools = db
      .query(
        `
                select tools.* from tools
                join tool_responses on tools.id = tool_responses.tool_id
                where tool_responses.response_id = ?
            `,
        [row.id],
      )
      .map(
        (toolRow: Record<string, unknown>) =>
          new Tool({
            name: toolRow.name as string,
            description: toolRow.description as string | null,
            input_schema: JSON.parse(toolRow.input_schema as string),
            implementation: null,
            plugin: toolRow.plugin as string | null,
          }),
      );
    const toolResults = db
      .query(
        `
                select * from tool_results
                where response_id = ?
            `,
        [row.id],
      )
      .map(
        (trRow: Record<string, unknown>) =>
          new ToolResult({
            name: trRow.name as string,
            output: trRow.output as string,
            tool_call_id: trRow.tool_call_id as string | null,
          }),
      );

    const allFragments = db.query(FRAGMENT_SQL, { response_id: row.id });
    const fragments = allFragments
      .filter((r: Record<string, unknown>) => r.fragment_type === "prompt")
      .map((r: Record<string, unknown>) => r.content as string);
    const systemFragments = allFragments
      .filter((r: Record<string, unknown>) => r.fragment_type === "system")
      .map((r: Record<string, unknown>) => r.content as string);

    const response = new cls(
      new Prompt(row.prompt as string | null, model, {
        fragments,
        attachments: [],
        system: row.system as string | null,
        schema,
        tools,
        tool_results: toolResults,
        system_fragments: systemFragments,
        options: model.makeOptions(
          JSON.parse((row.options_json as string) || "{}"),
        ),
      }),
      model,
      false,
    );
    response._prompt_json = JSON.parse((row.prompt_json as string) || "null");
    response.id = row.id as string;
    response.response_json = JSON.parse((row.response_json as string) || "null");
    response._done = true;
    response._chunks = [row.response as string];
    // Attachments
    response.attachments = db
      .query(
        `
                select attachments.* from attachments
                join prompt_attachments on attachments.id = prompt_attachments.attachment_id
                where prompt_attachments.response_id = ?
                order by prompt_attachments."order"
            `,
        [row.id],
      )
      .map((attachmentRow: Record<string, unknown>) =>
        Attachment.fromRow(attachmentRow),
      );
    // Tool calls
    response._tool_calls = db
      .query(
        `
                select * from tool_calls
                where response_id = ?
                order by tool_call_id
            `,
        [row.id],
      )
      .map(
        (toolRow: Record<string, unknown>) =>
          new ToolCall({
            name: toolRow.name as string,
            arguments: JSON.parse(toolRow.arguments as string),
            tool_call_id: toolRow.tool_call_id as string | null,
          }),
      );

    return response;
  }
}

/** Shared serializer for Response.toDict / AsyncResponse.toDict. */
function responseToDict(response: _BaseResponse): ResponseDict {
  const optionsDump =
    response.prompt.options instanceof BaseModel
      ? response.prompt.options.modelDump()
      : { ...(response.prompt.options as Record<string, unknown>) };
  const options = Object.fromEntries(
    Object.entries(optionsDump).filter(
      ([, v]) => v !== null && v !== undefined,
    ),
  );
  const payload: ResponseDict = {
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
      const usage: Record<string, unknown> = {};
      if (response.input_tokens !== null) usage.input = response.input_tokens;
      if (response.output_tokens !== null) usage.output = response.output_tokens;
      if (response.token_details !== null) usage.details = response.token_details;
      payload.usage = usage;
    }
    if (response._start_utcnow !== null) {
      payload.datetime_utc = response._start_utcnow;
    }
  }
  return payload;
}

/** Shared deserializer for Response.fromDict / AsyncResponse.fromDict. */
async function responseFromDict(
  data: ResponseDict,
  cls: new (
    prompt: Prompt,
    model: _BaseModel,
    stream: boolean,
  ) => _BaseResponse,
  {
    model = null,
    async_ = false,
  }: { model?: _BaseModel | null; async_?: boolean } = {},
): Promise<_BaseResponse> {
  if (model === null) {
    const { getAsyncModel, getModel } = await import("./index.js");
    model = async_
      ? (getAsyncModel(data.model) as _BaseModel)
      : (getModel(data.model) as _BaseModel);
  }

  const promptData = data.prompt ?? { messages: [] };
  const inputMessages = (promptData.messages ?? []).map((m) =>
    Message.fromDict(m),
  );
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
    .filter((p): p is TextPart => p instanceof TextPart && !!p.text)
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

async function executeToolCallsShared(
  response: _BaseResponse,
  toolCallsList: ToolCall[],
  beforeCall: BeforeCallSync | null,
  afterCall: AfterCallSync | null,
  syncMode: boolean,
): Promise<ToolResult[]> {
  const toolResults: ToolResult[] = [];
  const toolsByName: Record<string, Tool> = {};
  for (const tool of response.prompt.tools) {
    toolsByName[tool.name] = tool;
  }

  // Run prepare() on all Toolbox instances that need it
  const instancesToPrepare: Toolbox[] = [];
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
    } else {
      await inst.prepare_async();
      inst._async_prepared = true;
    }
  }

  for (const toolCall of toolCallsList) {
    const tool: Tool | undefined = toolsByName[toolCall.name];
    // Tool could be undefined, but we still call the before_call method:
    if (beforeCall) {
      try {
        const cbResult = beforeCall(tool ?? null, toolCall);
        if (cbResult instanceof Promise) {
          await cbResult;
        }
      } catch (ex) {
        if (ex instanceof CancelToolCall) {
          toolResults.push(
            new ToolResult({
              name: toolCall.name,
              output: "Cancelled: " + ex.message,
              tool_call_id: toolCall.tool_call_id,
              exception: ex,
            }),
          );
          continue;
        }
        throw ex;
      }
    }

    if (tool === undefined) {
      const msg = `tool "${toolCall.name}" does not exist`;
      toolResults.push(
        new ToolResult({
          name: toolCall.name,
          output: "Error: " + msg,
          tool_call_id: toolCall.tool_call_id,
          exception: new Error(msg),
        }),
      );
      continue;
    }

    if (!tool.implementation) {
      throw new Error(
        `No implementation available for tool: ${toolCall.name}`,
      );
    }

    let attachments: Attachment[] = [];
    let exception: Error | null = null;
    let result: unknown;

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
    } catch (ex) {
      if (ex instanceof PauseChain) {
        // Pause: propagate instead of converting to an error result.
        ex.tool_call = toolCall;
        ex.tool_results = [...toolResults];
        throw ex;
      }
      result = `Error: ${(ex as Error).message}`;
      exception = ex as Error;
    }

    const toolResultObj = new ToolResult({
      name: toolCall.name,
      output: result as string,
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

function invokeImplementation(
  implementation: AnyFunction,
  kwargs: Record<string, unknown>,
): unknown {
  const kwargNames = (implementation as { __kwargNames__?: string[] })
    .__kwargNames__;
  if (kwargNames) {
    return implementation(...kwargNames.map((n) => kwargs[n]));
  }
  const target =
    ((implementation as { __wrapped__?: AnyFunction })
      .__wrapped__ as AnyFunction) ?? implementation;
  const self = (implementation as { __self__?: unknown }).__self__;
  if (self !== undefined && target !== implementation) {
    return callWithKwargs(target, kwargs, self);
  }
  return callWithKwargs(implementation, kwargs);
}

export class Response extends _BaseResponse {
  declare model: _Model;
  declare conversation: Conversation | null;

  /**
   * Continue the conversation from this response. Async in TS because it
   * may auto-execute tool calls.
   */
  async reply(
    prompt: string | null = null,
    {
      messages = null,
      tool_results = null,
      options = null,
      ...kwargs
    }: {
      messages?: Message[] | null;
      tool_results?: ToolResult[] | null;
      options?: Record<string, unknown> | null;
      [key: string]: unknown;
    } = {},
  ): Promise<Response> {
    this._force();
    let toolResults = tool_results;
    if (toolResults === null && this._tool_calls.length) {
      toolResults = await this.execute_tool_calls();
    }
    if (!("tools" in kwargs) && this.prompt.tools.length) {
      kwargs.tools = this.prompt.tools;
    }
    const chain: Message[] = [...this.prompt.messages, ...this.messagesNow()];
    if (toolResults && toolResults.length) {
      chain.push(
        new Message({
          role: "tool",
          parts: toolResults.map(
            (tr) =>
              new ToolResultPart({
                name: tr.name,
                output: tr.output,
                tool_call_id: tr.tool_call_id,
              }),
          ),
        }),
      );
    }
    if (prompt) {
      chain.push(
        new Message({ role: "user", parts: [new TextPart({ text: prompt })] }),
      );
    }
    if (messages) {
      chain.push(...messages);
    }
    return this.model.prompt(null, { messages: chain, options, ...kwargs });
  }

  /** Serialize this response for JSON persistence. */
  toDict(): ResponseDict {
    return responseToDict(this);
  }

  static async fromDict(
    data: ResponseDict,
    { model = null }: { model?: Model | null } = {},
  ): Promise<Response> {
    return (await responseFromDict(data, Response as any, {
      model,
      async_: false,
    })) as Response;
  }

  static async fromRow(
    db: any,
    row: Record<string, unknown>,
  ): Promise<Response> {
    return (await _BaseResponse.fromRowBase(
      Response as any,
      db,
      row,
      false,
    )) as Response;
  }

  /** Register a callback to be called when the response is complete. */
  on_done(callback: (response: Response) => unknown): void {
    if (!this._done) {
      this.done_callbacks.push(callback as (response: this) => unknown);
    } else {
      callback(this);
    }
  }

  protected onDone(): void {
    for (const callback of this.done_callbacks) {
      callback(this);
    }
  }

  _force(): void {
    if (!this._done) {
      for (const _ of this) {
        // drain
      }
    }
  }

  /** Return the full text of the response, executing the prompt if needed. */
  text(): string {
    this._force();
    return this._chunks.join("");
  }

  text_or_raise(): string {
    return this.text();
  }

  /**
   * Execute tool calls using this response's tools. Async in TS (Python
   * used asyncio.run for coroutine tools inside sync code).
   */
  async execute_tool_calls({
    before_call = null,
    after_call = null,
    tool_calls_list = null,
  }: {
    before_call?: BeforeCallSync | null;
    after_call?: AfterCallSync | null;
    tool_calls_list?: ToolCall[] | null;
  } = {}): Promise<ToolResult[]> {
    const list = tool_calls_list ?? this.tool_calls();
    return executeToolCallsShared(this, list, before_call, after_call, true);
  }

  /** Return the list of tool calls made during this response. */
  tool_calls(): ToolCall[] {
    this._force();
    return this._tool_calls;
  }

  tool_calls_or_raise(): ToolCall[] {
    return this.tool_calls();
  }

  /** Return the raw JSON response from the model, if available. */
  json(): Record<string, unknown> | null {
    this._force();
    return this.response_json;
  }

  duration_ms(): number {
    this._force();
    return this.durationMsNow();
  }

  datetime_utc(): string {
    this._force();
    return this.datetimeUtcNow();
  }

  /** Return token usage information for this response. */
  usage(): Usage {
    this._force();
    return new Usage({
      input: this.input_tokens,
      output: this.output_tokens,
      details: this.token_details,
    });
  }

  protected rawGenerator():
    | Generator<string | StreamEvent>
    | AsyncGenerator<string | StreamEvent> {
    if (this.model instanceof KeyModel) {
      return this.model.execute(
        this.prompt,
        this.stream,
        this,
        this.conversation,
        this.model.get_key(this._key),
      );
    } else if (this.model instanceof Model) {
      return this.model.execute(
        this.prompt,
        this.stream,
        this,
        this.conversation,
      );
    }
    throw new Error("self.model must be a Model or KeyModel");
  }

  protected *iterEvents(): Generator<string | StreamEvent> {
    const generator = this.rawGenerator();
    if (typeof (generator as Generator)[Symbol.iterator] !== "function") {
      // Python's sync models do blocking HTTP; JS cannot. Models backed
      // by fetch() return async generators and must be driven with the
      // async APIs (for await, textAsync(), ...).
      throw new Error(
        `Model ${this.model.model_id} executes asynchronously — use ` +
          "'for await' / await response.textAsync() instead of sync iteration",
      );
    }
    for (const chunk of generator as Generator<string | StreamEvent>) {
      if (chunk === null || chunk === undefined) {
        throw new Error("Model returned a null chunk");
      }
      yield chunk;
    }
  }

  protected async *iterEventsAsync(): AsyncGenerator<string | StreamEvent> {
    const generator = this.rawGenerator();
    for await (const chunk of generator as AsyncGenerator<
      string | StreamEvent
    >) {
      if (chunk === null || chunk === undefined) {
        throw new Error("Model returned a null chunk");
      }
      yield chunk;
    }
  }

  /** Async counterpart of _force() for fetch-backed sync-API models. */
  async forceAsync(): Promise<void> {
    if (!this._done) {
      for await (const _ of this) {
        // drain
      }
    }
  }

  /** Async counterpart of text(). */
  async textAsync(): Promise<string> {
    await this.forceAsync();
    return this._chunks.join("");
  }

  /** Async iteration works for both sync and async model generators. */
  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
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
  async *streamEventsAsync(): AsyncGenerator<StreamEvent> {
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
  async messagesAsync(): Promise<Message[]> {
    await this.forceAsync();
    return this.messagesNow();
  }

  *[Symbol.iterator](): Generator<string> {
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
  *stream_events(): Generator<StreamEvent> {
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
  messages(): Message[] {
    this._force();
    return this.messagesNow();
  }

  toString(): string {
    let text = "... not yet done ...";
    if (this._done) {
      text = this._chunks.join("");
    }
    return `<Response prompt='${this.prompt.prompt}' text='${text}'>`;
  }
}

export class AsyncResponse extends _BaseResponse {
  declare model: _AsyncModel;
  declare conversation: AsyncConversation | null;
  private _generator?: AsyncGenerator<string | StreamEvent>;
  private _iter_chunks?: string[];

  /** Async counterpart of Response.reply(). Requires awaiting first. */
  async reply(
    prompt: string | null = null,
    {
      messages = null,
      tool_results = null,
      options = null,
      ...kwargs
    }: {
      messages?: Message[] | null;
      tool_results?: ToolResult[] | null;
      options?: Record<string, unknown> | null;
      [key: string]: unknown;
    } = {},
  ): Promise<AsyncResponse> {
    if (!this._done) {
      throw new Error(
        "Response not yet awaited — call `await response` before reply()",
      );
    }
    let toolResults = tool_results;
    if (toolResults === null && this._tool_calls.length) {
      toolResults = await this.execute_tool_calls();
    }
    if (!("tools" in kwargs) && this.prompt.tools.length) {
      kwargs.tools = this.prompt.tools;
    }
    const chain: Message[] = [...this.prompt.messages, ...this.messagesNow()];
    if (toolResults && toolResults.length) {
      chain.push(
        new Message({
          role: "tool",
          parts: toolResults.map(
            (tr) =>
              new ToolResultPart({
                name: tr.name,
                output: tr.output,
                tool_call_id: tr.tool_call_id,
              }),
          ),
        }),
      );
    }
    if (prompt) {
      chain.push(
        new Message({ role: "user", parts: [new TextPart({ text: prompt })] }),
      );
    }
    if (messages) {
      chain.push(...messages);
    }
    return this.model.prompt(null, { messages: chain, options, ...kwargs });
  }

  toDict(): ResponseDict {
    if (!this._done) {
      throw new Error(
        "Response not yet awaited — call `await response` before to_dict()",
      );
    }
    return responseToDict(this);
  }

  static async fromDict(
    data: ResponseDict,
    { model = null }: { model?: AsyncModel | null } = {},
  ): Promise<AsyncResponse> {
    return (await responseFromDict(data, AsyncResponse as any, {
      model,
      async_: true,
    })) as AsyncResponse;
  }

  static async fromRow(
    db: any,
    row: Record<string, unknown>,
  ): Promise<AsyncResponse> {
    return (await _BaseResponse.fromRowBase(
      AsyncResponse as any,
      db,
      row,
      true,
    )) as AsyncResponse;
  }

  /** Register a callback to be called when the response is complete. */
  async on_done(
    callback: ((response: AsyncResponse) => unknown) | Promise<unknown>,
  ): Promise<void> {
    if (!this._done) {
      this.done_callbacks.push(callback as (response: this) => unknown);
    } else {
      if (typeof callback === "function") {
        const processed = callback(this);
        if (processed instanceof Promise) {
          await processed;
        }
      } else if (callback instanceof Promise) {
        await callback;
      }
    }
  }

  protected async onDoneAsync(): Promise<void> {
    for (const callbackFunc of this.done_callbacks) {
      if (typeof callbackFunc === "function") {
        const processed = callbackFunc(this);
        if (processed instanceof Promise) {
          await processed;
        }
      } else if ((callbackFunc as unknown) instanceof Promise) {
        await (callbackFunc as unknown as Promise<unknown>);
      }
    }
  }

  /** Execute tool calls using this response's tools. */
  async execute_tool_calls({
    before_call = null,
    after_call = null,
    tool_calls_list = null,
  }: {
    before_call?: BeforeCallAsync | null;
    after_call?: AfterCallAsync | null;
    tool_calls_list?: ToolCall[] | null;
  } = {}): Promise<ToolResult[]> {
    const list = tool_calls_list ?? (await this.tool_calls());
    const toolsByName: Record<string, Tool> = {};
    for (const tool of this.prompt.tools) {
      toolsByName[tool.name] = tool;
    }

    // Run async prepare_async() on all Toolbox instances that need it
    const instancesToPrepare: Toolbox[] = [];
    for (const toolToPrep of Object.values(toolsByName)) {
      const inst = getInstance(toolToPrep.implementation);
      if (
        inst instanceof Toolbox &&
        !inst._async_prepared &&
        !instancesToPrepare.includes(inst)
      ) {
        instancesToPrepare.push(inst);
      }
    }
    for (const inst of instancesToPrepare) {
      await inst.prepare_async();
      inst._async_prepared = true;
    }

    const indexedResults: Array<[number, ToolResult]> = [];
    const asyncTasks: Array<Promise<[number, ToolResult]>> = [];
    // Defined failure semantics: a pause or error in one call must not
    // orphan concurrently-running siblings.
    const paused: Array<[number, PauseChain]> = [];
    const failures: Array<[number, Error]> = [];

    let broke = false;
    for (let idx = 0; idx < list.length && !broke; idx++) {
      const tc = list[idx];
      const tool: Tool | undefined = toolsByName[tc.name];

      if (tool === undefined || !tool.implementation) {
        if (before_call) {
          try {
            const cb = before_call(tool ?? null, tc);
            if (cb instanceof Promise) await cb;
          } catch (ex) {
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
            failures.push([idx, ex as Error]);
            break;
          }
        }
        const reason =
          tool === undefined ? "does not exist" : "has no implementation";
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

      const isAsyncImpl =
        (
          ((tool.implementation as { __wrapped__?: AnyFunction }).__wrapped__ ??
            tool.implementation) as { constructor: { name: string } }
        ).constructor.name === "AsyncFunction";

      if (isAsyncImpl) {
        const runAsync = async (): Promise<[number, ToolResult]> => {
          if (before_call) {
            try {
              const cb = before_call(tool, tc);
              if (cb instanceof Promise) await cb;
            } catch (ex) {
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

          let exception: Error | null = null;
          const attachments: Attachment[] = [];
          let output: string;

          try {
            let result: unknown = invokeImplementation(
              tool.implementation!,
              implementationArguments(tool, tc),
            );
            if (result instanceof Promise) result = await result;
            if (result instanceof ToolOutput) {
              attachments.push(...result.attachments);
              result = result.output;
            }
            output =
              typeof result === "string"
                ? result
                : dumps(result, { fallback: (v) => String(v) });
          } catch (ex) {
            if (ex instanceof PauseChain) {
              ex.tool_call = tc;
              throw ex;
            }
            output = `Error: ${(ex as Error).message}`;
            exception = ex as Error;
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
            if (cb2 instanceof Promise) await cb2;
          }

          return [idx, tr];
        };
        asyncTasks.push(
          runAsync().then(
            (result) => result,
            (err) => {
              throw Object.assign(err, { __taskIndex__: idx });
            },
          ),
        );
      } else {
        // Sync implementation: do hooks and call inline
        if (before_call) {
          try {
            const cb = before_call(tool, tc);
            if (cb instanceof Promise) await cb;
          } catch (ex) {
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
            failures.push([idx, ex as Error]);
            break;
          }
        }

        let exception: Error | null = null;
        const attachments: Attachment[] = [];
        let output: string | null = null;

        try {
          let res: unknown = invokeImplementation(
            tool.implementation,
            implementationArguments(tool, tc),
          );
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
        } catch (ex) {
          if (ex instanceof PauseChain) {
            // Inline execution stops here; later calls never start.
            ex.tool_call = tc;
            paused.push([idx, ex]);
            broke = true;
            break;
          }
          output = `Error: ${(ex as Error).message}`;
          exception = ex as Error;
        }

        const tr = new ToolResult({
          name: tc.name,
          output: output!,
          attachments,
          tool_call_id: tc.tool_call_id,
          instance: getInstance(tool.implementation),
          exception,
        });

        try {
          if (after_call) {
            const cb2 = after_call(tool, tc, tr);
            if (cb2 instanceof Promise) await cb2;
          }
        } catch (ex) {
          failures.push([idx, ex as Error]);
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
        } else {
          const err = outcome.reason as Error & { __taskIndex__?: number };
          const taskIdx = err.__taskIndex__ ?? 0;
          if (err instanceof PauseChain) {
            paused.push([taskIdx, err]);
          } else {
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

  private ensureAsyncGenerator(): void {
    if (!this._generator) {
      if (this.model instanceof AsyncKeyModel) {
        this._generator = this.model.execute(
          this.prompt,
          this.stream,
          this,
          this.conversation,
          this.model.get_key(this._key),
        );
      } else if (this.model instanceof AsyncModel) {
        this._generator = this.model.execute(
          this.prompt,
          this.stream,
          this,
          this.conversation,
        );
      } else {
        throw new Error("self.model must be an AsyncModel or AsyncKeyModel");
      }
    }
  }

  private async asyncFinalize(): Promise<void> {
    if (this.conversation) {
      this.conversation.responses.push(this);
    }
    this._end = monotonicSeconds();
    this._done = true;
    delete this._generator;
    await this.onDoneAsync();
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    this._start = monotonicSeconds();
    this._start_utcnow = utcNowIso();
    if (this._done) {
      this._iter_chunks = [...this._chunks];
    }
    return {
      next: async (): Promise<IteratorResult<string>> => {
        if (this._done) {
          if (this._iter_chunks && this._iter_chunks.length) {
            return { value: this._iter_chunks.shift()!, done: false };
          }
          return { value: undefined, done: true };
        }
        this.ensureAsyncGenerator();
        // Skip non-text events — iteration yields only text.
        while (true) {
          const result = await this._generator!.next();
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
  async *astream_events(): AsyncGenerator<StreamEvent> {
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
      const result = await this._generator!.next();
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
  async messages(): Promise<Message[]> {
    await this._force();
    return this.messagesNow();
  }

  async _force(): Promise<void> {
    if (!this._done) {
      for await (const _ of this) {
        // drain; populates self._chunks
      }
    }
  }

  text_or_raise(): string {
    if (!this._done) {
      throw new Error("Response not yet awaited");
    }
    return this._chunks.join("");
  }

  /** Return the full text of the response, executing the prompt if needed. */
  async text(): Promise<string> {
    await this._force();
    return this._chunks.join("");
  }

  /** Return the list of tool calls made during this response. */
  async tool_calls(): Promise<ToolCall[]> {
    await this._force();
    return this._tool_calls;
  }

  tool_calls_or_raise(): ToolCall[] {
    if (!this._done) {
      throw new Error("Response not yet awaited");
    }
    return this._tool_calls;
  }

  /** Return the raw JSON response from the model, if available. */
  async json(): Promise<Record<string, unknown> | null> {
    await this._force();
    return this.response_json;
  }

  async duration_ms(): Promise<number> {
    await this._force();
    return this.durationMsNow();
  }

  async datetime_utc(): Promise<string> {
    await this._force();
    return this.datetimeUtcNow();
  }

  /** Return token usage information for this response. */
  async usage(): Promise<Usage> {
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
  then(
    onfulfilled?: ((value: any) => any) | null,
    onrejected?: ((reason: unknown) => any) | null,
  ): Promise<any> {
    return this._force().then(() => {
      if (!onfulfilled) return undefined;
      const settled = Object.create(this) as AsyncResponse & {
        then: undefined;
      };
      Object.defineProperty(settled, "then", { value: undefined });
      return onfulfilled(settled);
    }, onrejected);
  }

  async toSyncResponse(): Promise<Response> {
    await this._force();
    const response = new Response(
      this.prompt,
      this.model as unknown as _Model,
      this.stream,
      this.conversation ? this.conversation.toSyncConversation() : null,
    );
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
  static fake({
    model,
    prompt,
    attachments = [],
    system,
    response,
  }: {
    model: AsyncModel;
    prompt: string;
    attachments?: Attachment[];
    system: string | null;
    response: string;
  }): AsyncResponse {
    const responseObj = new AsyncResponse(
      new Prompt(prompt, model, { attachments, system }),
      model,
      false,
    );
    responseObj._done = true;
    responseObj._chunks = [response];
    return responseObj;
  }

  toString(): string {
    let text = "... not yet awaited ...";
    if (this._done) {
      text = this._chunks.join("");
    }
    return `<AsyncResponse prompt='${this.prompt.prompt}' text='${text}'>`;
  }
}

function appendToolResultsToChain(
  chain: Message[],
  toolResults: ToolResult[],
  attachments: Attachment[],
): Message[] {
  if (toolResults.length) {
    chain.push(
      new Message({
        role: "tool",
        parts: toolResults.map(
          (tr) =>
            new ToolResultPart({
              name: tr.name,
              output: tr.output,
              tool_call_id: tr.tool_call_id,
            }),
        ),
      }),
    );
  }
  if (attachments.length) {
    chain.push(
      new Message({
        role: "user",
        parts: attachments.map((a) => new AttachmentPart({ attachment: a })),
      }),
    );
  }
  return chain;
}

function chainForToolResults(
  priorResponse: _BaseResponse,
  toolResults: ToolResult[],
  attachments: Attachment[],
): Message[] {
  const chain: Message[] = [
    ...priorResponse.prompt.messages,
    ...priorResponse.messagesNow(),
  ];
  return appendToolResultsToChain(chain, toolResults, attachments);
}

/** Find unresolved tool calls at the end of a message history. */
function trailingPendingToolCalls(messages: Message[]): ToolCall[] {
  let lastIndex: number | null = null;
  let callParts: ToolCallPart[] = [];
  (messages ?? []).forEach((msg, i) => {
    const parts = msg.parts ?? [];
    const calls = parts.filter(
      (p): p is ToolCallPart => p instanceof ToolCallPart && !p.server_executed,
    );
    if (msg.role === "assistant" && calls.length) {
      lastIndex = i;
      callParts = calls;
    }
  });
  if (lastIndex === null) {
    return [];
  }

  const results: ToolResultPart[] = [];
  for (const msg of messages.slice(lastIndex + 1)) {
    if (msg.role === "tool") {
      results.push(
        ...(msg.parts ?? []).filter(
          (p): p is ToolResultPart => p instanceof ToolResultPart,
        ),
      );
    } else {
      // Conversation moved on past these calls
      return [];
    }
  }

  const matchedIds = new Set(
    results.map((r) => r.tool_call_id).filter((id): id is string => !!id),
  );
  const unmatchedNames = results
    .filter((r) => !r.tool_call_id)
    .map((r) => r.name);
  const pending: ToolCall[] = [];
  for (const part of callParts) {
    if (part.tool_call_id) {
      if (matchedIds.has(part.tool_call_id)) {
        continue;
      }
    } else if (unmatchedNames.includes(part.name)) {
      unmatchedNames.splice(unmatchedNames.indexOf(part.name), 1);
      continue;
    }
    pending.push(
      new ToolCall({
        name: part.name,
        arguments: part.arguments ?? {},
        tool_call_id: part.tool_call_id,
      }),
    );
  }
  return pending;
}

export abstract class _BaseChainResponse {
  prompt: Prompt;
  model: _BaseModel;
  stream: boolean;
  conversation: _BaseConversation | null;
  _key: string | null;
  _responses: _BaseResponse[] = [];
  chain_limit: number | null;
  before_call: BeforeCallSync | null;
  after_call: AfterCallSync | null;

  constructor(
    prompt: Prompt,
    model: _BaseModel,
    stream: boolean,
    conversation: _BaseConversation,
    key: string | null = null,
    chain_limit: number | null = 10,
    before_call: BeforeCallSync | null = null,
    after_call: AfterCallSync | null = null,
  ) {
    this.prompt = prompt;
    this.model = model;
    this.stream = stream;
    this._key = key;
    this.conversation = conversation;
    this.chain_limit = chain_limit;
    this.before_call = before_call;
    this.after_call = after_call;
  }

  async logToDb(db: any): Promise<void> {
    for (const response of this._responses) {
      let syncResponse: Response;
      if (response instanceof AsyncResponse) {
        syncResponse = await response.toSyncResponse();
      } else if (response instanceof Response) {
        syncResponse = response;
      } else {
        throw new Error("Should have been a Response or AsyncResponse");
      }
      await syncResponse.logToDb(db);
    }
  }

  /** Unresolved tool calls at the end of this chain's history. */
  protected pendingToolCalls(): ToolCall[] {
    if (!this.prompt.tools.length) {
      return [];
    }
    return trailingPendingToolCalls(this.prompt.messages);
  }

  /** The first prompt for a resumed chain. */
  protected resumePrompt(toolResults: ToolResult[]): Prompt {
    const prompt = this.prompt;
    const attachments: Attachment[] = [];
    for (const toolResult of toolResults) {
      attachments.push(...toolResult.attachments);
    }
    const nextChain = appendToolResultsToChain(
      [...prompt.messages],
      toolResults,
      attachments,
    );
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
  declare _responses: Response[];

  /**
   * Async generator in TS (Python's is sync) because tool execution is
   * async. Yields each Response in the chain.
   */
  async *responses(): AsyncGenerator<Response> {
    let count = 0;
    let initialResponse = new Response(
      this.prompt,
      this.model as _Model,
      this.stream,
      this.conversation as Conversation | null,
      this._key,
    );
    // Resume: a history ending in unresolved tool calls means a previous
    // run stopped before executing them.
    const pendingToolCalls = this.pendingToolCalls();
    if (pendingToolCalls.length) {
      const toolResults = await initialResponse.execute_tool_calls({
        before_call: this.before_call,
        after_call: this.after_call,
        tool_calls_list: pendingToolCalls,
      });
      initialResponse = new Response(
        this.resumePrompt(toolResults),
        this.model as _Model,
        this.stream,
        this.conversation as Conversation | null,
        this._key,
      );
    }
    let currentResponse: Response | null = initialResponse;
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
      const attachments: Attachment[] = [];
      for (const toolResult of toolResults) {
        attachments.push(...toolResult.attachments);
      }
      if (toolResults.length) {
        // Pre-bake the full chain for the tool-result turn.
        const nextChain = chainForToolResults(
          currentResponse,
          toolResults,
          attachments,
        );
        currentResponse = new Response(
          new Prompt("", this.model, {
            tools: currentResponse.prompt.tools,
            tool_results: toolResults,
            messages: nextChain,
            system: this.prompt._system,
            system_fragments: this.prompt.system_fragments,
            options: this.prompt.options,
            attachments,
            hide_reasoning: currentResponse.prompt.hide_reasoning,
          }),
          this.model as _Model,
          this.stream,
          this.conversation as Conversation | null,
          this._key,
        );
      } else {
        currentResponse = null;
        break;
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for await (const responseItem of this.responses()) {
      yield* responseItem;
    }
  }

  /** Yield StreamEvents from every response in the chain. */
  async *stream_events(): AsyncGenerator<StreamEvent> {
    for await (const responseItem of this.responses()) {
      yield* responseItem.stream_events();
    }
  }

  async text(): Promise<string> {
    const chunks: string[] = [];
    for await (const chunk of this) {
      chunks.push(chunk);
    }
    return chunks.join("");
  }
}

export class AsyncChainResponse extends _BaseChainResponse {
  declare _responses: AsyncResponse[];

  async *responses(): AsyncGenerator<AsyncResponse> {
    let count = 0;
    let initialResponse = new AsyncResponse(
      this.prompt,
      this.model as _AsyncModel,
      this.stream,
      this.conversation as AsyncConversation | null,
      this._key,
    );
    const pendingToolCalls = this.pendingToolCalls();
    if (pendingToolCalls.length) {
      const toolResults = await initialResponse.execute_tool_calls({
        before_call: this.before_call,
        after_call: this.after_call,
        tool_calls_list: pendingToolCalls,
      });
      initialResponse = new AsyncResponse(
        this.resumePrompt(toolResults),
        this.model as _AsyncModel,
        this.stream,
        this.conversation as AsyncConversation | null,
        this._key,
      );
    }
    let currentResponse: AsyncResponse | null = initialResponse;
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
        const attachments: Attachment[] = [];
        for (const toolResult of toolResults) {
          attachments.push(...toolResult.attachments);
        }
        const nextChain = chainForToolResults(
          currentResponse,
          toolResults,
          attachments,
        );
        const prompt: Prompt = new Prompt("", this.model, {
          tools: currentResponse.prompt.tools,
          tool_results: toolResults,
          messages: nextChain,
          system: this.prompt._system,
          system_fragments: this.prompt.system_fragments,
          options: this.prompt.options,
          attachments,
          hide_reasoning: currentResponse.prompt.hide_reasoning,
        });
        currentResponse = new AsyncResponse(
          prompt,
          this.model as _AsyncModel,
          this.stream,
          this.conversation as AsyncConversation | null,
          this._key,
        );
      } else {
        currentResponse = null;
        break;
      }
    }
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<string> {
    for await (const responseItem of this.responses()) {
      for await (const chunk of responseItem) {
        yield chunk;
      }
    }
  }

  /** Yield StreamEvents from every response in the chain. */
  async *astream_events(): AsyncGenerator<StreamEvent> {
    for await (const responseItem of this.responses()) {
      for await (const event of responseItem.astream_events()) {
        yield event;
      }
    }
  }

  async text(): Promise<string> {
    const allChunks: string[] = [];
    for await (const chunk of this) {
      allChunks.push(chunk);
    }
    return allChunks.join("");
  }
}

export class Options extends BaseModel {
  // model_config = ConfigDict(extra="forbid") — BaseModel forbids extras.
}

const _Options = Options;

export abstract class _getKeyMixin {
  needs_key: string | null = null;
  key: string | null = null;
  key_env_var: string | null = null;

  get_key(explicitKey: string | null = null): string | null {
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

export abstract class _BaseModel extends _getKeyMixin {
  model_id!: string;
  can_stream = false;
  attachment_types: Set<string> = new Set();

  supports_schema = false;
  supports_tools = false;

  static Options: typeof Options = _Options;

  /**
   * The Options class for this model. Instance-level so constructors can
   * override it per instance (matching Python's `self.Options = ...`);
   * initialized from the class-level static.
   */
  Options: typeof Options =
    ((this.constructor as typeof _BaseModel).Options as typeof Options) ??
    _Options;

  /** Build an Options instance for this model (`self.Options(**merged)`). */
  makeOptions(data: Record<string, unknown>): BaseModel {
    return new this.Options(data);
  }

  /**
   * Synchronous attachment validation: catches the checks Python did
   * eagerly, minus URL type resolution which requires the network (that
   * happens at execution/logging time in TS).
   */
  validateAttachmentsSync(attachments: Attachment[] | null | undefined): void {
    if (attachments && attachments.length && !this.attachment_types.size) {
      throw new Error("This model does not support attachments");
    }
    for (const attachment of attachments ?? []) {
      if (!attachment.type && attachment.url) {
        continue; // resolved asynchronously later
      }
      const attachmentType = attachment.resolveTypeSync();
      if (attachmentType && !this.attachment_types.has(attachmentType)) {
        throw new Error(
          `This model does not support attachments of type '${attachmentType}', ` +
            `only ${[...this.attachment_types].join(", ")}`,
        );
      }
    }
  }

  async validateAttachments(
    attachments: Attachment[] | null | undefined,
  ): Promise<void> {
    if (attachments && attachments.length && !this.attachment_types.size) {
      throw new Error("This model does not support attachments");
    }
    for (const attachment of attachments ?? []) {
      const attachmentType = await attachment.resolveType();
      if (attachmentType && !this.attachment_types.has(attachmentType)) {
        throw new Error(
          `This model does not support attachments of type '${attachmentType}', ` +
            `only ${[...this.attachment_types].join(", ")}`,
        );
      }
    }
  }

  toString(): string {
    const isAsync = this instanceof _AsyncModel;
    return `${this.constructor.name}${isAsync ? " (async)" : ""}: ${this.model_id}`;
  }
}

export abstract class _Model extends _BaseModel {
  conversation({
    tools = null,
    before_call = null,
    after_call = null,
    chain_limit = null,
  }: {
    tools?: ToolDef[] | null;
    before_call?: BeforeCallSync | null;
    after_call?: AfterCallSync | null;
    chain_limit?: number | null;
  } = {}): Conversation {
    return new Conversation({
      model: this,
      tools,
      before_call,
      after_call,
      chain_limit,
    });
  }

  prompt(prompt: string | null = null, opts: PromptOptions = {}): Response {
    const {
      fragments = null,
      attachments = null,
      system = null,
      system_fragments = null,
      messages = null,
      stream = true,
      schema = null,
      tools = null,
      tool_results = null,
      options = null,
      hide_reasoning = false,
      key = null,
    } = opts;
    const merged = mergeOptions(options, extraOptionKwargs(opts));
    this.validateAttachmentsSync(attachments);
    return new Response(
      new Prompt(prompt, this, {
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
      }),
      this,
      stream,
      null,
      key,
    );
  }

  chain(prompt: string | null = null, opts: ChainOptions = {}): ChainResponse {
    return this.conversation().chain(prompt, opts);
  }
}

export abstract class Model extends _Model {
  /**
   * May return an async generator (fetch-backed models); such models
   * must be driven via the Response async APIs.
   */
  abstract execute(
    prompt: Prompt,
    stream: boolean,
    response: Response,
    conversation: Conversation | null,
  ): Generator<string | StreamEvent> | AsyncGenerator<string | StreamEvent>;
}

export abstract class KeyModel extends _Model {
  abstract execute(
    prompt: Prompt,
    stream: boolean,
    response: Response,
    conversation: Conversation | null,
    key: string | null,
  ): Generator<string | StreamEvent> | AsyncGenerator<string | StreamEvent>;
}

export abstract class _AsyncModel extends _BaseModel {
  conversation({
    tools = null,
    before_call = null,
    after_call = null,
    chain_limit = null,
  }: {
    tools?: ToolDef[] | null;
    before_call?: BeforeCallAsync | null;
    after_call?: AfterCallAsync | null;
    chain_limit?: number | null;
  } = {}): AsyncConversation {
    return new AsyncConversation({
      model: this,
      tools,
      before_call,
      after_call,
      chain_limit,
    });
  }

  prompt(prompt: string | null = null, opts: PromptOptions = {}): AsyncResponse {
    const {
      fragments = null,
      attachments = null,
      system = null,
      schema = null,
      tools = null,
      tool_results = null,
      system_fragments = null,
      messages = null,
      stream = true,
      options = null,
      hide_reasoning = false,
      key = null,
    } = opts;
    const merged = mergeOptions(options, extraOptionKwargs(opts));
    this.validateAttachmentsSync(attachments);
    return new AsyncResponse(
      new Prompt(prompt, this, {
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
      }),
      this,
      stream,
      null,
      key,
    );
  }

  chain(
    prompt: string | null = null,
    opts: ChainOptions = {},
  ): AsyncChainResponse {
    return this.conversation().chain(prompt, opts);
  }
}

export abstract class AsyncModel extends _AsyncModel {
  abstract execute(
    prompt: Prompt,
    stream: boolean,
    response: AsyncResponse,
    conversation: AsyncConversation | null,
  ): AsyncGenerator<string | StreamEvent>;
}

export abstract class AsyncKeyModel extends _AsyncModel {
  abstract execute(
    prompt: Prompt,
    stream: boolean,
    response: AsyncResponse,
    conversation: AsyncConversation | null,
    key: string | null,
  ): AsyncGenerator<string | StreamEvent>;
}

export abstract class EmbeddingModel extends _getKeyMixin {
  model_id!: string;
  supports_text = true;
  supports_binary = false;
  batch_size: number | null = null;

  protected check(item: string | Uint8Array): void {
    if (!this.supports_binary && item instanceof Uint8Array) {
      throw new Error(
        "This model does not support binary data, only text strings",
      );
    }
    if (!this.supports_text && typeof item === "string") {
      throw new Error(
        "This model does not support text strings, only binary data",
      );
    }
  }

  /** Embed a single text string or binary blob, return a list of floats.
   * Async in TS: embedding models hit the network. */
  async embed(item: string | Uint8Array): Promise<number[]> {
    this.check(item);
    for await (const result of this.embedBatch([item])) {
      return result;
    }
    throw new Error("embed_batch returned no results");
  }

  /** Embed multiple items in batches according to the model batch_size. */
  async *embedMulti(
    items: Iterable<string | Uint8Array>,
    batchSize: number | null = null,
  ): AsyncGenerator<number[]> {
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

  /** Embed a batch of strings or blobs, yield lists of floats. */
  abstract embedBatch(
    items: Iterable<string | Uint8Array>,
  ): AsyncGenerator<number[]>;

  toString(): string {
    return `${this.constructor.name}: ${this.model_id}`;
  }
}

export class ModelWithAliases {
  // "A model with its optional async counterpart and aliases."
  model: Model;
  async_model: AsyncModel;
  aliases: string[];

  constructor(model: Model, asyncModel: AsyncModel, aliases: string[]) {
    this.model = model;
    this.async_model = asyncModel;
    this.aliases = aliases;
  }

  matches(query: string): boolean {
    const queryLower = query.toLowerCase();
    const allStrings: string[] = [...this.aliases];
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
  model: EmbeddingModel;
  aliases: string[];

  constructor(model: EmbeddingModel, aliases: string[]) {
    this.model = model;
    this.aliases = aliases;
  }

  matches(query: string): boolean {
    const queryLower = query.toLowerCase();
    const allStrings: string[] = [...this.aliases, String(this.model)];
    return allStrings.some((alias) => alias.toLowerCase().includes(queryLower));
  }
}

function conversationName(text: string): string {
  // Collapse whitespace, including newlines
  const collapsed = text.replace(/\s+/g, " ");
  const chars = [...collapsed];
  if (chars.length <= CONVERSATION_NAME_LENGTH) {
    return collapsed;
  }
  return chars.slice(0, CONVERSATION_NAME_LENGTH - 1).join("") + "…";
}

function ensureDictSchema(
  schema: Record<string, unknown> | typeof BaseModel | null | undefined,
): Record<string, unknown> | null {
  // Convert a pydantic-style model class to a JSON schema dict if needed.
  if (
    schema &&
    typeof schema === "function" &&
    schema.prototype instanceof BaseModel
  ) {
    const schemaDict = (schema as typeof BaseModel).modelJsonSchema();
    removeTitlesRecursively(schemaDict);
    return schemaDict;
  }
  if (schema && typeof schema === "object") {
    return schema as Record<string, unknown>;
  }
  return (schema as null | undefined) ?? null;
}

function removeTitlesRecursively(obj: unknown): void {
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    delete (obj as Record<string, unknown>).title;
    for (const value of Object.values(obj)) {
      removeTitlesRecursively(value);
    }
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      removeTitlesRecursively(item);
    }
  }
}

function getInstance(implementation: AnyFunction | null): Toolbox | null {
  if (implementation && "__self__" in implementation) {
    const self = (implementation as { __self__?: unknown }).__self__;
    return (self as Toolbox) ?? null;
  }
  return null;
}
