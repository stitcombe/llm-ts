/**
 * Port of llm/default_plugins/openai_models.py.
 *
 * The Python `openai` client is replaced by the fetch-based client in
 * src/openaiClient.ts. All execute() implementations are async
 * generators (JS cannot do blocking HTTP), driven through the Response
 * async APIs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { hookimpl } from "../hookspecs.js";
import {
  AsyncConversation,
  AsyncKeyModel,
  AsyncResponse,
  Conversation,
  EmbeddingModel,
  KeyModel,
  Options as OptionsBase,
  Prompt,
  Response,
  ToolCall,
} from "../models.js";
import type { Response as SyncResponse } from "../models.js";
import { BaseModel, type FieldDef, type Validator } from "../pydantic.js";
import {
  AttachmentPart,
  ReasoningPart,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../parts.js";
import type { Attachment } from "../models.js";
import { removeDictNoneValues, simplifyUsageDict } from "../utils.js";
import { dumps } from "../pyjson.js";
import { OpenAIClient } from "../openaiClient.js";
import { userDir } from "../config.js";

// ---------------------------------------------------------------- Options

const validateLogitBias: Validator = (logitBias) => {
  if (logitBias === null) return null;

  let parsed: unknown = logitBias;
  if (typeof logitBias === "string") {
    try {
      parsed = JSON.parse(logitBias);
    } catch {
      throw new Error("Invalid JSON in logit_bias string");
    }
  }

  const validated: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    const intKey = parseInt(key, 10);
    const intValue =
      typeof value === "number" ? Math.trunc(value) : parseInt(String(value), 10);
    if (
      Number.isNaN(intKey) ||
      Number.isNaN(intValue) ||
      intValue < -100 ||
      intValue > 100
    ) {
      throw new Error("Invalid key-value pair in logit_bias dictionary");
    }
    validated[intKey] = intValue;
  }
  return validated;
};

export class SharedOptions extends OptionsBase {
  static override fields: Record<string, FieldDef> = {
    temperature: {
      type: "number",
      description:
        "What sampling temperature to use, between 0 and 2. Higher values like " +
        "0.8 will make the output more random, while lower values like 0.2 will " +
        "make it more focused and deterministic.",
      ge: 0,
      le: 2,
      default: null,
    },
    max_tokens: {
      type: "integer",
      description: "Maximum number of tokens to generate.",
      default: null,
    },
    top_p: {
      type: "number",
      description:
        "An alternative to sampling with temperature, called nucleus sampling, " +
        "where the model considers the results of the tokens with top_p " +
        "probability mass. So 0.1 means only the tokens comprising the top " +
        "10% probability mass are considered. Recommended to use top_p or " +
        "temperature but not both.",
      ge: 0,
      le: 1,
      default: null,
    },
    frequency_penalty: {
      type: "number",
      description:
        "Number between -2.0 and 2.0. Positive values penalize new tokens based " +
        "on their existing frequency in the text so far, decreasing the model's " +
        "likelihood to repeat the same line verbatim.",
      ge: -2,
      le: 2,
      default: null,
    },
    presence_penalty: {
      type: "number",
      description:
        "Number between -2.0 and 2.0. Positive values penalize new tokens based " +
        "on whether they appear in the text so far, increasing the model's " +
        "likelihood to talk about new topics.",
      ge: -2,
      le: 2,
      default: null,
    },
    stop: {
      type: "string",
      description: "A string where the API will stop generating further tokens.",
      default: null,
    },
    logit_bias: {
      type: ["object", "string"],
      description:
        "Modify the likelihood of specified tokens appearing in the completion. " +
        "Pass a JSON string like '{\"1712\":-100, \"892\":-100, \"1489\":-100}'",
      default: null,
    },
    seed: {
      type: "integer",
      description: "Integer seed to attempt to sample deterministically",
      default: null,
    },
  };

  static override validators: Record<string, Validator> = {
    logit_bias: validateLogitBias,
  };
}

const REASONING_EFFORT_VALUES = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];
const VERBOSITY_VALUES = ["low", "medium", "high"];
const IMAGE_DETAIL_VALUES = ["low", "high", "auto"];
const IMAGE_DETAIL_WITH_ORIGINAL_VALUES = ["low", "high", "original", "auto"];

function enumValuesSentence(values: string[]): string {
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

export function buildOptionsClass({
  reasoning = false,
  verbosity = false,
  image_detail_original = false,
  chat_completions = false,
}: {
  reasoning?: boolean;
  verbosity?: boolean;
  image_detail_original?: boolean;
  chat_completions?: boolean;
} = {}): typeof SharedOptions {
  const fields: Record<string, FieldDef> = {
    json_object: {
      type: "boolean",
      description: "Output a valid JSON object {...}. Prompt must mention JSON.",
      default: null,
    },
  };
  if (chat_completions) {
    fields.chat_completions = {
      type: "boolean",
      description:
        "Force the use of the older /v1/chat/completions endpoint " +
        "instead of /v1/responses. Most callers should leave this " +
        "off; set to true to fall back to the Chat Completions code " +
        "path for compatibility.",
      default: null,
    };
  }
  const imageDetailValues = image_detail_original
    ? IMAGE_DETAIL_WITH_ORIGINAL_VALUES
    : IMAGE_DETAIL_VALUES;
  fields.image_detail = {
    type: "string",
    enum: imageDetailValues,
    description:
      "Controls the detail level for image attachments. Supported values are " +
      `${enumValuesSentence(imageDetailValues)}.`,
    default: null,
  };
  if (reasoning) {
    fields.reasoning_effort = {
      type: "string",
      enum: REASONING_EFFORT_VALUES,
      description:
        "Constraints effort on reasoning for reasoning models. Currently " +
        "supported values are low, medium, and high. Reducing reasoning " +
        "effort can result in faster responses and fewer tokens used on " +
        "reasoning in a response.",
      default: null,
    };
  }
  if (verbosity) {
    fields.verbosity = {
      type: "string",
      enum: VERBOSITY_VALUES,
      description:
        "Controls how verbose the model's response should be. Supported " +
        "values are low, medium, and high.",
      default: null,
    };
  }
  const cls = class extends SharedOptions {};
  Object.defineProperty(cls, "name", { value: "Options" });
  cls.fields = fields;
  return cls;
}

// ------------------------------------------------------------ helpers

function notNulls(options: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries =
    options instanceof BaseModel
      ? Object.entries(options.modelDump())
      : Object.entries((options as Record<string, unknown>) ?? {});
  for (const [key, value] of entries) {
    if (value !== null && value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

export function combineChunks(chunks: any[]): Record<string, unknown> {
  let content = "";
  let role: unknown = null;
  let finishReason: unknown = null;
  const logprobs: Array<Record<string, unknown>> = [];
  let usage: Record<string, unknown> = {};

  for (const item of chunks) {
    if (item.usage) {
      usage = item.usage;
    }
    for (const choice of item.choices ?? []) {
      if (
        choice.logprobs &&
        typeof choice.logprobs === "object" &&
        "top_logprobs" in choice.logprobs
      ) {
        logprobs.push({
          text: "text" in choice ? choice.text : null,
          top_logprobs: choice.logprobs.top_logprobs,
        });
      }

      if (!("delta" in choice)) {
        content += choice.text ?? "";
        continue;
      }
      role = choice.delta?.role ?? null;
      if (choice.delta?.content !== null && choice.delta?.content !== undefined) {
        content += choice.delta.content;
      }
      if (choice.finish_reason !== null && choice.finish_reason !== undefined) {
        finishReason = choice.finish_reason;
      }
    }
  }

  // Imitations of the OpenAI API may be missing some of these fields
  const combined: Record<string, unknown> = {
    content,
    role,
    finish_reason: finishReason,
    usage,
  };
  if (logprobs.length) {
    combined.logprobs = logprobs;
  }
  if (chunks.length) {
    for (const key of ["id", "object", "model", "created", "index"]) {
      const value = chunks[0][key];
      if (value !== null && value !== undefined) {
        combined[key] = value;
      }
    }
  }
  return combined;
}

export function redactData(input: unknown): unknown {
  /**
   * Recursively search for 'image_url' keys and replace data: URLs with
   * 'data:...'. Also redact input_audio.data keys and Responses-API
   * image_url/file_data string values.
   */
  if (input && typeof input === "object" && !Array.isArray(input)) {
    const dict = input as Record<string, unknown>;
    for (const [key, value] of Object.entries(dict)) {
      if (
        key === "image_url" &&
        value &&
        typeof value === "object" &&
        "url" in (value as Record<string, unknown>) &&
        String((value as Record<string, unknown>).url).startsWith("data:")
      ) {
        (value as Record<string, unknown>).url = "data:...";
      } else if (
        key === "input_audio" &&
        value &&
        typeof value === "object" &&
        "data" in (value as Record<string, unknown>)
      ) {
        (value as Record<string, unknown>).data = "...";
      } else {
        redactData(value);
      }
    }
  } else if (Array.isArray(input)) {
    for (const item of input) {
      redactData(item);
    }
  }
  return input;
}

async function attachmentAsChatContent(
  attachment: Attachment,
  imageDetail: string | null = null,
): Promise<Record<string, unknown>> {
  let url = attachment.url;
  let base64Content = "";
  const resolvedType = (await attachment.resolveType()) ?? "";
  if (!url || resolvedType.startsWith("audio/")) {
    base64Content = await attachment.base64Content();
    url = `data:${resolvedType};base64,${base64Content}`;
  }
  if (resolvedType === "application/pdf") {
    if (!base64Content) {
      base64Content = await attachment.base64Content();
    }
    return {
      type: "file",
      file: {
        filename: `${attachment.id()}.pdf`,
        file_data: `data:application/pdf;base64,${base64Content}`,
      },
    };
  }
  if (resolvedType.startsWith("image/")) {
    const imageUrl: Record<string, unknown> = { url };
    if (imageDetail) {
      imageUrl.detail = imageDetail;
    }
    return { type: "image_url", image_url: imageUrl };
  }
  const format = resolvedType === "audio/wav" ? "wav" : "mp3";
  return {
    type: "input_audio",
    input_audio: {
      data: base64Content,
      format,
    },
  };
}

// -------------------------------------------------------- shared config

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

/** The subset of state/behavior shared by all OpenAI model classes. */
interface OpenAIShared {
  model_id: string;
  model_name: string | null;
  api_base: string | null;
  api_type: string | null;
  api_version: string | null;
  api_engine: string | null;
  headers: Record<string, string> | null;
  allows_system_prompt: boolean;
  default_max_tokens: number | null;
  needs_key: string | null;
  get_key(explicitKey?: string | null): string | null;
}

function initShared(self: any, init: SharedInit): void {
  const {
    model_id,
    key = null,
    model_name = null,
    api_base = null,
    api_type = null,
    api_version = null,
    api_engine = null,
    headers = null,
    can_stream = true,
    vision = false,
    audio = false,
    reasoning = false,
    verbosity = false,
    image_detail_original = false,
    supports_schema = false,
    supports_tools = false,
    allows_system_prompt = true,
  } = init;

  self.model_id = model_id;
  self.key = key;
  self.supports_schema = supports_schema;
  self.supports_tools = supports_tools;
  self.model_name = model_name;
  self.api_base = api_base;
  self.api_type = api_type;
  self.api_version = api_version;
  self.api_engine = api_engine;
  self.headers = headers;
  self.can_stream = can_stream;
  self.vision = vision;
  self.allows_system_prompt = allows_system_prompt;

  self.attachment_types = new Set<string>();

  if (reasoning || verbosity || image_detail_original) {
    self.Options = buildOptionsClass({
      reasoning,
      verbosity,
      image_detail_original,
    });
  }

  if (vision) {
    for (const t of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
    ]) {
      self.attachment_types.add(t);
    }
  }

  if (audio) {
    for (const t of ["audio/wav", "audio/mpeg"]) {
      self.attachment_types.add(t);
    }
  }
}

/** Translate one llm.Message into OpenAI message dicts appended to out. */
async function appendLlmMessage(
  out: Array<Record<string, unknown>>,
  message: { role: string; parts: unknown[] },
  currentSystem: string | null,
  imageDetail: string | null,
): Promise<string | null> {
  const textBits: string[] = [];
  const attachmentItems: Array<Record<string, unknown>> = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const toolResults: Array<Record<string, unknown>> = [];

  for (const part of message.parts) {
    if (part instanceof TextPart) {
      textBits.push(part.text);
    } else if (part instanceof AttachmentPart && part.attachment) {
      attachmentItems.push(
        await attachmentAsChatContent(part.attachment, imageDetail),
      );
    } else if (part instanceof ToolCallPart) {
      toolCalls.push({
        type: "function",
        id: part.tool_call_id,
        function: {
          name: part.name,
          arguments: dumps(part.arguments),
        },
      });
    } else if (part instanceof ToolResultPart) {
      toolResults.push({
        role: "tool",
        tool_call_id: part.tool_call_id,
        content: part.output,
      });
    }
  }

  // Role "tool" emits one OpenAI "tool" message per ToolResultPart.
  if (message.role === "tool") {
    out.push(...toolResults);
    return currentSystem;
  }

  // System dedup: skip if this text is already the active system prompt.
  if (message.role === "system") {
    const text = textBits.join("");
    if (text === currentSystem) {
      return currentSystem;
    }
    currentSystem = text;
  }

  let entry: Record<string, unknown>;
  if (attachmentItems.length) {
    const content: Array<Record<string, unknown>> = [];
    if (textBits.length) {
      content.push({ type: "text", text: textBits.join("") });
    }
    content.push(...attachmentItems);
    entry = { role: message.role, content };
  } else {
    entry = {
      role: message.role,
      content: textBits.length ? textBits.join("") : null,
    };
  }

  if (toolCalls.length) {
    entry.tool_calls = toolCalls;
    // OpenAI expects content=null when only tool_calls are present.
    if (!textBits.length) {
      entry.content = null;
    }
  } else if (entry.content === null && message.role !== "assistant") {
    // For user/system, an empty message is pointless — drop it.
    return currentSystem;
  }

  out.push(entry);
  return currentSystem;
}

async function buildMessages(
  prompt: Prompt,
  imageDetail: string | null,
): Promise<Array<Record<string, unknown>>> {
  const messages: Array<Record<string, unknown>> = [];
  let currentSystem: string | null = null;
  for (const msg of prompt.messages) {
    currentSystem = await appendLlmMessage(
      messages,
      msg,
      currentSystem,
      imageDetail,
    );
  }
  return messages;
}

function setChatUsage(
  response: SyncResponse | AsyncResponse,
  usage: Record<string, unknown> | null,
): void {
  if (!usage || !Object.keys(usage).length) {
    return;
  }
  const { prompt_tokens, completion_tokens, total_tokens, ...rest } = usage as {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    [key: string]: unknown;
  };
  void total_tokens;
  response.set_usage({
    input: prompt_tokens ?? null,
    output: completion_tokens ?? null,
    details: simplifyUsageDict(rest) as Record<string, unknown>,
  });
}

function getClient(self: OpenAIShared, key: string | null): OpenAIClient {
  return new OpenAIClient({
    apiKey: self.needs_key ? (self.get_key(key) ?? "") : "DUMMY_KEY",
    baseUrl: self.api_base,
    defaultHeaders: self.headers,
    logResponses: Boolean(process.env.LLM_OPENAI_SHOW_RESPONSES),
  });
}

function buildKwargs(
  self: OpenAIShared,
  prompt: Prompt,
  stream: boolean,
): Record<string, unknown> {
  const kwargs = notNulls(prompt.options);
  const jsonObject = kwargs.json_object;
  delete kwargs.json_object;
  delete kwargs.image_detail;
  delete kwargs.chat_completions;
  if (!("max_tokens" in kwargs) && self.default_max_tokens !== null) {
    kwargs.max_tokens = self.default_max_tokens;
  }
  if (jsonObject) {
    kwargs.response_format = { type: "json_object" };
  }
  if (prompt.schema) {
    kwargs.response_format = {
      type: "json_schema",
      json_schema: { name: "output", schema: prompt.schema },
    };
  }
  if (prompt.tools.length) {
    kwargs.tools = prompt.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description || null,
        parameters: tool.input_schema,
      },
    }));
  }
  if (stream) {
    kwargs.stream_options = { include_usage: true };
  }
  return kwargs;
}

/** Shared chat execution (both Chat and AsyncChat use this). */
async function* chatExecute(
  self: Chat | AsyncChat,
  prompt: Prompt,
  stream: boolean,
  response: SyncResponse | AsyncResponse,
  key: string | null,
): AsyncGenerator<string | StreamEvent> {
  if (prompt.system && !self.allows_system_prompt) {
    throw new Error("Model does not support system prompts");
  }
  const imageDetail =
    ((prompt.options as Record<string, unknown>).image_detail as
      | string
      | null
      | undefined) ?? null;
  const messages = await buildMessages(prompt, imageDetail);
  // Method dispatch so subclasses (e.g. the OpenRouter plugin) can
  // override build_kwargs the way the Python mixin does.
  const kwargs = self.build_kwargs(prompt, stream);
  const client = getClient(self, key);
  let usage: Record<string, unknown> | null = null;

  if (stream) {
    const completion = client.chat.completions.create({
      model: self.model_name || self.model_id,
      messages,
      stream: true,
      ...kwargs,
    }) as AsyncGenerator<any>;
    const chunks: any[] = [];
    const toolCalls: Record<number, any> = {};
    for await (const chunk of completion) {
      chunks.push(chunk);
      if (chunk.usage) {
        usage = chunk.usage;
      }
      if (chunk.choices?.length && chunk.choices[0].delta) {
        for (const toolCall of chunk.choices[0].delta.tool_calls ?? []) {
          if (
            toolCall.function.arguments === null ||
            toolCall.function.arguments === undefined
          ) {
            toolCall.function.arguments = "";
          }
          const idx = toolCall.index;
          if (!(idx in toolCalls)) {
            toolCalls[idx] = toolCall;
            yield new StreamEvent({
              type: "tool_call_name",
              chunk: toolCall.function.name || "",
              tool_call_id: toolCall.id ?? null,
            });
          } else {
            toolCalls[idx].function.arguments += toolCall.function.arguments;
          }
          if (toolCall.function.arguments) {
            yield new StreamEvent({
              type: "tool_call_args",
              chunk: toolCall.function.arguments,
              tool_call_id: toolCalls[idx].id ?? null,
            });
          }
        }
      }
      const content = chunk.choices?.[0]?.delta?.content;
      if (content) {
        // Empty strings are noise (OpenAI's first chunk with
        // role=assistant has content="").
        yield new StreamEvent({ type: "text", chunk: content });
      }
    }
    response.response_json = removeDictNoneValues(
      combineChunks(chunks),
    ) as Record<string, unknown>;
    for (const value of Object.values(toolCalls)) {
      response.add_tool_call(
        new ToolCall({
          tool_call_id: value.id ?? null,
          name: value.function.name,
          arguments: JSON.parse(value.function.arguments || "{}"),
        }),
      );
    }
  } else {
    const completion = (await client.chat.completions.create({
      model: self.model_name || self.model_id,
      messages,
      stream: false,
      ...kwargs,
    })) as any;
    usage = completion.usage ?? null;
    response.response_json = removeDictNoneValues(completion) as Record<
      string,
      unknown
    >;
    for (const toolCall of completion.choices[0].message.tool_calls ?? []) {
      response.add_tool_call(
        new ToolCall({
          tool_call_id: toolCall.id ?? null,
          name: toolCall.function.name,
          arguments: JSON.parse(toolCall.function.arguments || "{}"),
        }),
      );
      yield new StreamEvent({
        type: "tool_call_name",
        chunk: toolCall.function.name || "",
        tool_call_id: toolCall.id ?? null,
      });
      yield new StreamEvent({
        type: "tool_call_args",
        chunk: toolCall.function.arguments || "",
        tool_call_id: toolCall.id ?? null,
      });
    }
    const messageContent = completion.choices[0].message.content;
    if (messageContent !== null && messageContent !== undefined) {
      yield new StreamEvent({ type: "text", chunk: messageContent });
    }
  }
  setChatUsage(response, usage);
  if (
    usage &&
    ((usage.completion_tokens_details as Record<string, unknown>) ?? {})
      .reasoning_tokens
  ) {
    yield new StreamEvent({ type: "reasoning", chunk: "", redacted: true });
  }
  response._prompt_json = redactData({ messages });
}

// ------------------------------------------------------------ Chat models

export class Chat extends KeyModel {
  override needs_key: string | null = "openai";
  override key_env_var: string | null = "OPENAI_API_KEY";
  default_max_tokens: number | null = null;

  model_name: string | null = null;
  api_base: string | null = null;
  api_type: string | null = null;
  api_version: string | null = null;
  api_engine: string | null = null;
  headers: Record<string, string> | null = null;
  vision = false;
  allows_system_prompt = true;

  static override Options = buildOptionsClass();

  constructor(modelIdOrInit: string | SharedInit, init: Omit<SharedInit, "model_id"> = {}) {
    super();
    const fullInit: SharedInit =
      typeof modelIdOrInit === "string"
        ? { model_id: modelIdOrInit, ...init }
        : modelIdOrInit;
    initShared(this, fullInit);
  }

  override toString(): string {
    return `OpenAI Chat: ${this.model_id}`;
  }

  /** Translate prompt.messages into OpenAI's wire format. */
  build_messages(
    prompt: Prompt,
    conversation: Conversation | null,
    imageDetail: string | null = null,
  ): Promise<Array<Record<string, unknown>>> {
    void conversation;
    return buildMessages(prompt, imageDetail);
  }

  /** Overridable in subclasses, as in the Python plugin. */
  build_kwargs(prompt: Prompt, stream: boolean): Record<string, unknown> {
    return buildKwargs(this, prompt, stream);
  }

  execute(
    prompt: Prompt,
    stream: boolean,
    response: SyncResponse,
    conversation: Conversation | null,
    key: string | null,
  ): AsyncGenerator<string | StreamEvent> {
    void conversation;
    return chatExecute(this, prompt, stream, response, key);
  }
}

export class AsyncChat extends AsyncKeyModel {
  override needs_key: string | null = "openai";
  override key_env_var: string | null = "OPENAI_API_KEY";
  default_max_tokens: number | null = null;

  model_name: string | null = null;
  api_base: string | null = null;
  api_type: string | null = null;
  api_version: string | null = null;
  api_engine: string | null = null;
  headers: Record<string, string> | null = null;
  vision = false;
  allows_system_prompt = true;

  static override Options = buildOptionsClass();

  constructor(modelIdOrInit: string | SharedInit, init: Omit<SharedInit, "model_id"> = {}) {
    super();
    const fullInit: SharedInit =
      typeof modelIdOrInit === "string"
        ? { model_id: modelIdOrInit, ...init }
        : modelIdOrInit;
    initShared(this, fullInit);
  }

  override toString(): string {
    return `OpenAI Chat: ${this.model_id}`;
  }

  /** Translate prompt.messages into OpenAI's wire format. */
  build_messages(
    prompt: Prompt,
    conversation: AsyncConversation | null,
    imageDetail: string | null = null,
  ): Promise<Array<Record<string, unknown>>> {
    void conversation;
    return buildMessages(prompt, imageDetail);
  }

  /** Overridable in subclasses, as in the Python plugin. */
  build_kwargs(prompt: Prompt, stream: boolean): Record<string, unknown> {
    return buildKwargs(this, prompt, stream);
  }

  execute(
    prompt: Prompt,
    stream: boolean,
    response: AsyncResponse,
    conversation: AsyncConversation | null,
    key: string | null,
  ): AsyncGenerator<string | StreamEvent> {
    void conversation;
    return chatExecute(this, prompt, stream, response, key);
  }
}

// ----------------------------------------------------------- Responses API

function responsesAttachmentSync(
  attachment: Attachment,
  imageDetail: string | null,
): Promise<Record<string, unknown>> {
  return (async () => {
    let url = attachment.url;
    let base64Content = "";
    const resolvedType = (await attachment.resolveType()) ?? "";
    if (!url || resolvedType.startsWith("audio/")) {
      base64Content = await attachment.base64Content();
      url = `data:${resolvedType};base64,${base64Content}`;
    }
    if (resolvedType === "application/pdf") {
      if (!base64Content) {
        base64Content = await attachment.base64Content();
      }
      return {
        type: "input_file",
        filename: `${attachment.id()}.pdf`,
        file_data: `data:application/pdf;base64,${base64Content}`,
      };
    }
    if (resolvedType.startsWith("image/")) {
      const item: Record<string, unknown> = {
        type: "input_image",
        image_url: url,
      };
      if (imageDetail) {
        item.detail = imageDetail;
      }
      return item;
    }
    // Fall back to image_url for unknown types so we don't drop content.
    return { type: "input_image", image_url: url };
  })();
}

async function buildResponsesInput(
  prompt: Prompt,
  imageDetail: string | null,
): Promise<[Array<Record<string, unknown>>, string | null]> {
  const items: Array<Record<string, unknown>> = [];
  let instructions: string | null = null;

  for (const msg of prompt.messages) {
    if (msg.role === "system") {
      const text = msg.parts
        .filter((p): p is TextPart => p instanceof TextPart)
        .map((p) => p.text)
        .join("");
      if (text) {
        instructions = text;
      }
      continue;
    }

    const textBits: string[] = [];
    const attachmentItems: Array<Record<string, unknown>> = [];
    const toolCallItems: Array<Record<string, unknown>> = [];
    const toolResultItems: Array<Record<string, unknown>> = [];
    const reasoningItems: Array<Record<string, unknown>> = [];

    for (const part of msg.parts) {
      if (part instanceof TextPart) {
        textBits.push(part.text);
      } else if (part instanceof AttachmentPart && part.attachment) {
        attachmentItems.push(
          await responsesAttachmentSync(part.attachment, imageDetail),
        );
      } else if (part instanceof ToolCallPart) {
        toolCallItems.push({
          type: "function_call",
          call_id: part.tool_call_id,
          name: part.name,
          arguments: dumps(part.arguments),
        });
      } else if (part instanceof ToolResultPart) {
        toolResultItems.push({
          type: "function_call_output",
          call_id: part.tool_call_id,
          output: part.output,
        });
      } else if (part instanceof ReasoningPart) {
        const pm =
          ((part.provider_metadata ?? {}).openai as Record<string, unknown>) ??
          {};
        const enc = pm.encrypted_content;
        const rid = pm.id;
        if (enc || rid) {
          // Round-trip a previous reasoning item so the model can pick
          // up where it left off mid-tool-call.
          const item: Record<string, unknown> = { type: "reasoning" };
          if (rid) item.id = rid;
          if (enc) item.encrypted_content = enc;
          item.summary = pm.summary ?? [];
          reasoningItems.push(item);
        }
      }
    }

    // Reasoning items must precede the assistant message / function call
    // they belonged to.
    items.push(...reasoningItems);

    if (msg.role === "tool") {
      items.push(...toolResultItems);
      continue;
    }

    if (msg.role === "user") {
      if (attachmentItems.length) {
        const content: Array<Record<string, unknown>> = [];
        if (textBits.length) {
          content.push({ type: "input_text", text: textBits.join("") });
        }
        content.push(...attachmentItems);
        items.push({ role: "user", content });
      } else if (textBits.length) {
        items.push({ role: "user", content: textBits.join("") });
      }
    } else if (msg.role === "assistant") {
      if (textBits.length) {
        items.push({ role: "assistant", content: textBits.join("") });
      }
      items.push(...toolCallItems);
    }
  }

  return [items, instructions];
}

function buildResponsesKwargs(
  self: Responses | AsyncResponses,
  prompt: Prompt,
  stream: boolean,
): Record<string, unknown> {
  void stream;
  const opts = notNulls(prompt.options);
  delete opts.json_object;
  delete opts.chat_completions;
  delete opts.image_detail;
  let maxTokens = (opts.max_tokens as number | undefined) ?? null;
  delete opts.max_tokens;
  const reasoningEffort = opts.reasoning_effort as string | undefined;
  delete opts.reasoning_effort;
  const verbosity = opts.verbosity as string | undefined;
  delete opts.verbosity;
  const temperature = opts.temperature as number | undefined;
  delete opts.temperature;
  const topP = opts.top_p as number | undefined;
  delete opts.top_p;
  const seed = opts.seed as number | undefined;
  delete opts.seed;

  const kwargs: Record<string, unknown> = {};
  if (maxTokens === null && self.default_max_tokens !== null) {
    maxTokens = self.default_max_tokens;
  }
  if (maxTokens !== null) {
    kwargs.max_output_tokens = maxTokens;
  }
  if (temperature !== undefined) {
    kwargs.temperature = temperature;
  }
  if (topP !== undefined) {
    kwargs.top_p = topP;
  }
  if (seed !== undefined) {
    kwargs.seed = seed;
  }
  if (self._reasoning) {
    const reasoning: Record<string, unknown> = {};
    if (!prompt.hide_reasoning) {
      reasoning.summary = "auto";
    }
    if (reasoningEffort) {
      reasoning.effort = reasoningEffort;
    }
    if (Object.keys(reasoning).length) {
      kwargs.reasoning = reasoning;
    }
  }

  const text: Record<string, unknown> = {};
  if (verbosity) {
    text.verbosity = verbosity;
  }
  if ((prompt.options as Record<string, unknown>).json_object) {
    text.format = { type: "json_object" };
  }
  if (prompt.schema) {
    // strict: False mirrors the looser /v1/chat/completions behavior.
    text.format = {
      type: "json_schema",
      name: "output",
      schema: prompt.schema,
      strict: false,
    };
  }
  if (Object.keys(text).length) {
    kwargs.text = text;
  }

  if (prompt.tools.length) {
    kwargs.tools = prompt.tools.map((tool) => ({
      type: "function",
      name: tool.name,
      description: tool.description || null,
      parameters: tool.input_schema,
    }));
  }

  // Pass anything we did not consume through verbatim.
  Object.assign(kwargs, opts);
  return kwargs;
}

function setUsageResponses(
  response: SyncResponse | AsyncResponse,
  usage: Record<string, unknown> | null,
): void {
  if (!usage || !Object.keys(usage).length) {
    return;
  }
  const inputTokens = (usage.input_tokens as number) || 0;
  const outputTokens = (usage.output_tokens as number) || 0;
  const details: Record<string, unknown> = {};
  for (const key of ["input_tokens_details", "output_tokens_details"]) {
    const value = usage[key];
    if (value && Object.keys(value as object).length) {
      details[key] = value;
    }
  }
  response.set_usage({
    input: inputTokens,
    output: outputTokens,
    details: Object.keys(details).length ? details : null,
  });
}

function reasoningTextFromItem(item: any): string {
  const bits: string[] = [];
  for (const attr of ["summary", "content"]) {
    for (const part of item[attr] ?? []) {
      const text =
        part && typeof part === "object" ? (part.text ?? null) : null;
      if (text) {
        bits.push(text);
      }
    }
  }
  return bits.join("");
}

function reasoningEvent(item: any, includeText = true): StreamEvent {
  const rid = item.id ?? null;
  const enc = item.encrypted_content ?? null;
  const summary = item.summary ?? null;
  const text = includeText ? reasoningTextFromItem(item) : "";
  const meta: Record<string, unknown> = {};
  if (rid) meta.id = rid;
  if (enc) meta.encrypted_content = enc;
  if (summary && (summary as unknown[]).length) {
    meta.summary = (summary as unknown[]).map((s) =>
      s && typeof s === "object" ? { ...(s as object) } : s,
    );
  }
  return new StreamEvent({
    type: "reasoning",
    chunk: text,
    redacted: includeText && !text,
    provider_metadata: Object.keys(meta).length ? { openai: meta } : null,
  });
}

async function* responsesExecute(
  self: Responses | AsyncResponses,
  prompt: Prompt,
  stream: boolean,
  response: SyncResponse | AsyncResponse,
  key: string | null,
): AsyncGenerator<string | StreamEvent> {
  if ((prompt.options as Record<string, unknown>).chat_completions) {
    const chat =
      self instanceof AsyncResponses
        ? new AsyncChat(self.delegateChatKwargs())
        : new Chat(self.delegateChatKwargs());
    yield* chatExecute(chat as Chat, prompt, stream, response, key);
    return;
  }

  if (prompt.system && !self.allows_system_prompt) {
    throw new Error("Model does not support system prompts");
  }

  const imageDetail =
    ((prompt.options as Record<string, unknown>).image_detail as
      | string
      | null
      | undefined) ?? null;
  const [inputItems, instructions] = await buildResponsesInput(
    prompt,
    imageDetail,
  );
  const kwargs = buildResponsesKwargs(self, prompt, stream);
  if (instructions !== null) {
    kwargs.instructions = instructions;
  }
  kwargs.store = false;
  if (self._reasoning) {
    kwargs.include = ["reasoning.encrypted_content"];
  }

  const client = getClient(self, key);
  let usage: Record<string, unknown> | null = null;
  let hadReasoning = false;

  if (stream) {
    const streamObj = client.responses.create({
      model: self.model_name || self.model_id,
      input: inputItems,
      stream: true,
      ...kwargs,
    }) as AsyncGenerator<any>;
    const toolCallMeta: Record<string, Record<string, string>> = {};
    let finalResponseDict: Record<string, unknown> | null = null;
    const reasoningItemsWithStreamedText = new Set<string>();
    for await (const event of streamObj) {
      const etype = event.type;
      if (etype === "response.output_item.added") {
        const item = event.item;
        if (item.type === "function_call") {
          toolCallMeta[item.id] = {
            id: item.id,
            call_id: item.call_id,
            name: item.name,
          };
          yield new StreamEvent({
            type: "tool_call_name",
            chunk: item.name || "",
            tool_call_id: item.call_id ?? null,
          });
        }
      } else if (etype === "response.output_text.delta") {
        yield new StreamEvent({ type: "text", chunk: event.delta || "" });
      } else if (etype === "response.function_call_arguments.delta") {
        const itemId = event.item_id ?? null;
        const meta = itemId ? toolCallMeta[itemId] : undefined;
        const callId = meta ? meta.call_id : null;
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: event.delta || "",
          tool_call_id: callId,
        });
      } else if (
        etype === "response.reasoning_summary_text.delta" ||
        etype === "response.reasoning_text.delta"
      ) {
        const itemId = event.item_id ?? null;
        if (itemId) {
          reasoningItemsWithStreamedText.add(itemId);
        }
        yield new StreamEvent({ type: "reasoning", chunk: event.delta || "" });
      } else if (
        etype === "response.reasoning_summary_text.done" ||
        etype === "response.reasoning_text.done"
      ) {
        const itemId = event.item_id ?? null;
        if (!itemId || !reasoningItemsWithStreamedText.has(itemId)) {
          const text = event.text || "";
          if (text) {
            if (itemId) {
              reasoningItemsWithStreamedText.add(itemId);
            }
            yield new StreamEvent({ type: "reasoning", chunk: text });
          }
        }
      } else if (etype === "response.output_item.done") {
        const item = event.item;
        if (item.type === "reasoning") {
          hadReasoning = true;
          const itemId = item.id ?? null;
          yield reasoningEvent(
            item,
            !itemId || !reasoningItemsWithStreamedText.has(itemId),
          );
        } else if (item.type === "function_call") {
          let args: Record<string, unknown>;
          try {
            args = item.arguments ? JSON.parse(item.arguments) : {};
          } catch {
            args = { _raw: item.arguments };
          }
          response.add_tool_call(
            new ToolCall({
              tool_call_id: item.call_id ?? null,
              name: item.name,
              arguments: args,
            }),
          );
        }
      } else if (etype === "response.completed") {
        finalResponseDict = event.response as Record<string, unknown>;
        if (finalResponseDict.usage) {
          usage = finalResponseDict.usage as Record<string, unknown>;
        }
      }
    }
    if (finalResponseDict !== null) {
      response.response_json = removeDictNoneValues(
        finalResponseDict,
      ) as Record<string, unknown>;
    }
  } else {
    const completion = (await client.responses.create({
      model: self.model_name || self.model_id,
      input: inputItems,
      stream: false,
      ...kwargs,
    })) as any;
    response.response_json = removeDictNoneValues(completion) as Record<
      string,
      unknown
    >;
    usage = completion.usage ?? null;
    for (const item of completion.output ?? []) {
      if (item.type === "reasoning") {
        hadReasoning = true;
        yield reasoningEvent(item);
      } else if (item.type === "function_call") {
        let args: Record<string, unknown>;
        try {
          args = item.arguments ? JSON.parse(item.arguments) : {};
        } catch {
          args = { _raw: item.arguments };
        }
        response.add_tool_call(
          new ToolCall({
            tool_call_id: item.call_id ?? null,
            name: item.name,
            arguments: args,
          }),
        );
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: item.name || "",
          tool_call_id: item.call_id ?? null,
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: item.arguments || "",
          tool_call_id: item.call_id ?? null,
        });
      } else if (item.type === "message") {
        for (const content of item.content ?? []) {
          if (content.type === "output_text" && content.text) {
            yield new StreamEvent({ type: "text", chunk: content.text });
          }
        }
      }
    }
  }

  setUsageResponses(response, usage);
  // Fallback: usage said reasoning happened but the API gave us no
  // reasoning items. Emit the opaque marker for UI / token accounting.
  if (
    !hadReasoning &&
    usage &&
    ((usage.output_tokens_details as Record<string, unknown>) ?? {})
      .reasoning_tokens
  ) {
    yield new StreamEvent({ type: "reasoning", chunk: "", redacted: true });
  }
  response._prompt_json = redactData({
    input: inputItems,
    instructions,
  });
}

export class Responses extends KeyModel {
  override needs_key: string | null = "openai";
  override key_env_var: string | null = "OPENAI_API_KEY";
  default_max_tokens: number | null = null;

  model_name: string | null = null;
  api_base: string | null = null;
  api_type: string | null = null;
  api_version: string | null = null;
  api_engine: string | null = null;
  headers: Record<string, string> | null = null;
  vision = false;
  allows_system_prompt = true;
  _reasoning = false;
  _verbosity = false;
  _image_detail_original = false;

  constructor(
    modelIdOrInit: string | SharedInit,
    init: Omit<SharedInit, "model_id"> = {},
  ) {
    super();
    const fullInit: SharedInit =
      typeof modelIdOrInit === "string"
        ? { model_id: modelIdOrInit, ...init }
        : modelIdOrInit;
    initShared(this, fullInit);
    this._reasoning = fullInit.reasoning ?? false;
    this._verbosity = fullInit.verbosity ?? false;
    this._image_detail_original = fullInit.image_detail_original ?? false;
    // -o chat_completions 1 is always available on Responses models.
    this.Options = buildOptionsClass({
      reasoning: this._reasoning,
      verbosity: this._verbosity,
      image_detail_original: this._image_detail_original,
      chat_completions: true,
    });
  }

  override toString(): string {
    return `OpenAI Responses: ${this.model_id}`;
  }

  /** Translate prompt.messages into Responses API input items. */
  _build_responses_input(
    prompt: Pick<Prompt, "messages">,
    imageDetail: string | null = null,
  ): Promise<[Array<Record<string, unknown>>, string | null]> {
    return buildResponsesInput(prompt as Prompt, imageDetail);
  }

  /** Build the non-message kwargs for a Responses API call. */
  _build_responses_kwargs(
    prompt: Pick<Prompt, "options" | "tools" | "schema"> & {
      hide_reasoning?: boolean;
    },
    stream: boolean,
  ): Record<string, unknown> {
    return buildResponsesKwargs(this, prompt as Prompt, stream);
  }

  delegateChatKwargs(): SharedInit {
    return {
      model_id: this.model_id,
      key: this.key,
      model_name: this.model_name,
      api_base: this.api_base,
      api_type: this.api_type,
      api_version: this.api_version,
      api_engine: this.api_engine,
      headers: this.headers,
      can_stream: this.can_stream,
      vision: this.vision,
      reasoning: this._reasoning,
      verbosity: this._verbosity,
      image_detail_original: this._image_detail_original,
      supports_schema: this.supports_schema,
      supports_tools: this.supports_tools,
      allows_system_prompt: this.allows_system_prompt,
    };
  }

  execute(
    prompt: Prompt,
    stream: boolean,
    response: SyncResponse,
    conversation: Conversation | null,
    key: string | null,
  ): AsyncGenerator<string | StreamEvent> {
    void conversation;
    return responsesExecute(this, prompt, stream, response, key);
  }
}

export class AsyncResponses extends AsyncKeyModel {
  override needs_key: string | null = "openai";
  override key_env_var: string | null = "OPENAI_API_KEY";
  default_max_tokens: number | null = null;

  model_name: string | null = null;
  api_base: string | null = null;
  api_type: string | null = null;
  api_version: string | null = null;
  api_engine: string | null = null;
  headers: Record<string, string> | null = null;
  vision = false;
  allows_system_prompt = true;
  _reasoning = false;
  _verbosity = false;
  _image_detail_original = false;

  constructor(
    modelIdOrInit: string | SharedInit,
    init: Omit<SharedInit, "model_id"> = {},
  ) {
    super();
    const fullInit: SharedInit =
      typeof modelIdOrInit === "string"
        ? { model_id: modelIdOrInit, ...init }
        : modelIdOrInit;
    initShared(this, fullInit);
    this._reasoning = fullInit.reasoning ?? false;
    this._verbosity = fullInit.verbosity ?? false;
    this._image_detail_original = fullInit.image_detail_original ?? false;
    this.Options = buildOptionsClass({
      reasoning: this._reasoning,
      verbosity: this._verbosity,
      image_detail_original: this._image_detail_original,
      chat_completions: true,
    });
  }

  override toString(): string {
    return `OpenAI Responses: ${this.model_id}`;
  }

  /** Translate prompt.messages into Responses API input items. */
  _build_responses_input(
    prompt: Pick<Prompt, "messages">,
    imageDetail: string | null = null,
  ): Promise<[Array<Record<string, unknown>>, string | null]> {
    return buildResponsesInput(prompt as Prompt, imageDetail);
  }

  /** Build the non-message kwargs for a Responses API call. */
  _build_responses_kwargs(
    prompt: Pick<Prompt, "options" | "tools" | "schema"> & {
      hide_reasoning?: boolean;
    },
    stream: boolean,
  ): Record<string, unknown> {
    return buildResponsesKwargs(this, prompt as Prompt, stream);
  }

  delegateChatKwargs(): SharedInit {
    return Responses.prototype.delegateChatKwargs.call(this) as SharedInit;
  }

  execute(
    prompt: Prompt,
    stream: boolean,
    response: AsyncResponse,
    conversation: AsyncConversation | null,
    key: string | null,
  ): AsyncGenerator<string | StreamEvent> {
    void conversation;
    return responsesExecute(this, prompt, stream, response, key);
  }
}

// ------------------------------------------------------------- Completion

class CompletionOptions extends SharedOptions {
  static override fields: Record<string, FieldDef> = {
    logprobs: {
      type: "integer",
      description: "Include the log probabilities of most likely N per token",
      default: null,
      le: 5,
    },
  };
}

export class Completion extends Chat {
  static override Options = CompletionOptions;

  constructor(
    modelIdOrInit: string | SharedInit,
    init: Omit<SharedInit, "model_id"> & { default_max_tokens?: number | null } = {},
  ) {
    const { default_max_tokens = null, ...rest } = init;
    super(modelIdOrInit, rest);
    this.default_max_tokens = default_max_tokens;
    this.Options = CompletionOptions;
  }

  override toString(): string {
    return `OpenAI Completion: ${this.model_id}`;
  }

  override execute(
    prompt: Prompt,
    stream: boolean,
    response: SyncResponse,
    conversation: Conversation | null,
    key: string | null,
  ): AsyncGenerator<string | StreamEvent> {
    const self = this;
    return (async function* (): AsyncGenerator<string | StreamEvent> {
      if (prompt.system) {
        throw new Error(
          "System prompts are not supported for OpenAI completion models",
        );
      }
      const messages: string[] = [];
      if (conversation !== null) {
        for (const prevResponse of conversation.responses) {
          messages.push(prevResponse.prompt.prompt);
          messages.push((prevResponse as SyncResponse).text());
        }
      }
      messages.push(prompt.prompt);
      const kwargs = buildKwargs(self, prompt, stream);
      const client = getClient(self, key);
      if (stream) {
        const completion = client.completions.create({
          model: self.model_name || self.model_id,
          prompt: messages.join("\n"),
          stream: true,
          ...kwargs,
        }) as AsyncGenerator<any>;
        const chunks: any[] = [];
        for await (const chunk of completion) {
          chunks.push(chunk);
          const content = chunk.choices?.[0]?.text;
          if (content !== null && content !== undefined) {
            yield content;
          }
        }
        const combined = combineChunks(chunks);
        response.response_json = removeDictNoneValues(combined) as Record<
          string,
          unknown
        >;
      } else {
        const completion = (await client.completions.create({
          model: self.model_name || self.model_id,
          prompt: messages.join("\n"),
          stream: false,
          ...kwargs,
        })) as any;
        response.response_json = removeDictNoneValues(completion) as Record<
          string,
          unknown
        >;
        yield completion.choices[0].text;
      }
      response._prompt_json = redactData({ messages });
    })();
  }
}

// ------------------------------------------------------------- Embeddings

export class OpenAIEmbeddingModel extends EmbeddingModel {
  override needs_key: string | null = "openai";
  override key_env_var: string | null = "OPENAI_API_KEY";
  override batch_size: number | null = 100;

  openai_model_id: string;
  dimensions: number | null;

  constructor(
    modelId: string,
    openaiModelId: string,
    dimensions: number | null = null,
  ) {
    super();
    this.model_id = modelId;
    this.openai_model_id = openaiModelId;
    this.dimensions = dimensions;
  }

  async *embedBatch(
    items: Iterable<string | Uint8Array>,
  ): AsyncGenerator<number[]> {
    const kwargs: Record<string, unknown> = {
      input: [...items].map((item) =>
        typeof item === "string" ? item : Buffer.from(item).toString(),
      ),
      model: this.openai_model_id,
    };
    if (this.dimensions) {
      kwargs.dimensions = this.dimensions;
    }
    const client = new OpenAIClient({ apiKey: this.get_key() ?? "" });
    const results = ((await client.embeddings.create(kwargs)) as any).data;
    for (const result of results) {
      yield (result.embedding as number[]).map((r) => Number(r));
    }
  }
}

// ---------------------------------------------------------- CLI commands

export const register_commands = hookimpl(function register_commands(
  cli: any,
) {
  // Deferred import (cli.ts imports this module's model classes at load).
  const registerOpenAICommands = async () => {
    const click = await import("../click/index.js");
    const { getKey } = await import("../config.js");
    const { dictsToTableString } = await import("../utils.js");
    const openaiGroup = new click.Group({
      name: "openai",
      help: "Commands for working directly with the OpenAI API",
    });
    cli.addCommand(openaiGroup);
    openaiGroup.command({
      name: "models",
      help: "List models available to you from the OpenAI API",
      options: [
        new click.Option({
          flags: ["--json"],
          name: "json_",
          isFlag: true,
          help: "Output as JSON",
        }),
        new click.Option({ flags: ["--key"], help: "OpenAI API key" }),
      ],
      handler: async (params: Record<string, unknown>) => {
        const apiKey = getKey({
          explicitKey: params.key as string | null,
          keyAlias: "openai",
          envVar: "OPENAI_API_KEY",
        });
        const response = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (response.status !== 200) {
          throw new click.ClickException(
            `Error ${response.status} from OpenAI API: ${await response.text()}`,
          );
        }
        const models = ((await response.json()) as { data: any[] }).data;
        if (params.json_) {
          click.echo(dumps(models, { indent: 4 }));
        } else {
          const toPrint = models.map((model) => ({
            id: model.id,
            owned_by: model.owned_by,
            created: new Date(model.created * 1000)
              .toISOString()
              .replace(".000Z", "+00:00"),
          }));
          const done = dictsToTableString(
            ["id", "owned_by", "created"],
            toPrint,
          );
          click.echo(done.join("\n"));
        }
      },
    });
  };
  // The hook call is synchronous; command registration completes on the
  // microtask queue before any CLI invocation runs.
  void registerOpenAICommands();
});

// ------------------------------------------------------------ registration

export const register_models = hookimpl(function register_models(
  register: (
    model: unknown,
    asyncModel?: unknown,
    aliases?: string[] | null,
  ) => void,
) {
  // GPT-4o
  register(
    new Chat("gpt-4o", { vision: true, supports_schema: true, supports_tools: true }),
    new AsyncChat("gpt-4o", {
      vision: true,
      supports_schema: true,
      supports_tools: true,
    }),
    ["4o"],
  );
  register(
    new Chat("chatgpt-4o-latest", { vision: true }),
    new AsyncChat("chatgpt-4o-latest", { vision: true }),
    ["chatgpt-4o"],
  );
  register(
    new Chat("gpt-4o-mini", {
      vision: true,
      supports_schema: true,
      supports_tools: true,
    }),
    new AsyncChat("gpt-4o-mini", {
      vision: true,
      supports_schema: true,
      supports_tools: true,
    }),
    ["4o-mini"],
  );
  for (const audioModelId of [
    "gpt-4o-audio-preview",
    "gpt-4o-audio-preview-2024-12-17",
    "gpt-4o-audio-preview-2024-10-01",
    "gpt-4o-mini-audio-preview",
    "gpt-4o-mini-audio-preview-2024-12-17",
  ]) {
    register(
      new Chat(audioModelId, { audio: true }),
      new AsyncChat(audioModelId, { audio: true }),
    );
  }
  // GPT-4.1
  for (const modelId of ["gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano"]) {
    register(
      new Chat(modelId, {
        vision: true,
        supports_schema: true,
        supports_tools: true,
      }),
      new AsyncChat(modelId, {
        vision: true,
        supports_schema: true,
        supports_tools: true,
      }),
      [modelId.replace("gpt-", "")],
    );
  }
  // 3.5 and 4
  register(new Chat("gpt-3.5-turbo"), new AsyncChat("gpt-3.5-turbo"), [
    "3.5",
    "chatgpt",
  ]);
  register(new Chat("gpt-3.5-turbo-16k"), new AsyncChat("gpt-3.5-turbo-16k"), [
    "chatgpt-16k",
    "3.5-16k",
  ]);
  register(new Chat("gpt-4"), new AsyncChat("gpt-4"), ["4", "gpt4"]);
  register(new Chat("gpt-4-32k"), new AsyncChat("gpt-4-32k"), ["4-32k"]);
  // GPT-4 Turbo models
  register(new Chat("gpt-4-1106-preview"), new AsyncChat("gpt-4-1106-preview"));
  register(new Chat("gpt-4-0125-preview"), new AsyncChat("gpt-4-0125-preview"));
  register(
    new Chat("gpt-4-turbo-2024-04-09"),
    new AsyncChat("gpt-4-turbo-2024-04-09"),
  );
  register(new Chat("gpt-4-turbo"), new AsyncChat("gpt-4-turbo"), [
    "gpt-4-turbo-preview",
    "4-turbo",
    "4t",
  ]);
  // GPT-4.5
  register(
    new Chat("gpt-4.5-preview-2025-02-27", {
      vision: true,
      supports_schema: true,
      supports_tools: true,
    }),
    new AsyncChat("gpt-4.5-preview-2025-02-27", {
      vision: true,
      supports_schema: true,
      supports_tools: true,
    }),
  );
  register(
    new Chat("gpt-4.5-preview", {
      vision: true,
      supports_schema: true,
      supports_tools: true,
    }),
    new AsyncChat("gpt-4.5-preview", {
      vision: true,
      supports_schema: true,
      supports_tools: true,
    }),
    ["gpt-4.5"],
  );
  // o1
  for (const modelId of ["o1", "o1-2024-12-17"]) {
    register(
      new Responses(modelId, {
        vision: true,
        can_stream: false,
        reasoning: true,
        supports_schema: true,
        supports_tools: true,
      }),
      new AsyncResponses(modelId, {
        vision: true,
        can_stream: false,
        reasoning: true,
        supports_schema: true,
        supports_tools: true,
      }),
    );
  }

  register(
    new Chat("o1-preview", { allows_system_prompt: false }),
    new AsyncChat("o1-preview", { allows_system_prompt: false }),
  );
  register(
    new Chat("o1-mini", { allows_system_prompt: false }),
    new AsyncChat("o1-mini", { allows_system_prompt: false }),
  );
  register(
    new Responses("o3-mini", {
      reasoning: true,
      supports_schema: true,
      supports_tools: true,
    }),
    new AsyncResponses("o3-mini", {
      reasoning: true,
      supports_schema: true,
      supports_tools: true,
    }),
  );
  register(
    new Responses("o3", {
      vision: true,
      reasoning: true,
      supports_schema: true,
      supports_tools: true,
    }),
    new AsyncResponses("o3", {
      vision: true,
      reasoning: true,
      supports_schema: true,
      supports_tools: true,
    }),
  );
  register(
    new Responses("o4-mini", {
      vision: true,
      reasoning: true,
      supports_schema: true,
      supports_tools: true,
    }),
    new AsyncResponses("o4-mini", {
      vision: true,
      reasoning: true,
      supports_schema: true,
      supports_tools: true,
    }),
  );
  // GPT-5
  for (const modelId of [
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5-2025-08-07",
    "gpt-5-mini-2025-08-07",
    "gpt-5-nano-2025-08-07",
  ]) {
    register(
      new Responses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        supports_schema: true,
        supports_tools: true,
      }),
      new AsyncResponses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        supports_schema: true,
        supports_tools: true,
      }),
    );
  }
  // GPT-5.1
  for (const modelId of ["gpt-5.1", "gpt-5.1-chat-latest"]) {
    register(
      new Responses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        supports_schema: true,
        supports_tools: true,
      }),
      new AsyncResponses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        supports_schema: true,
        supports_tools: true,
      }),
    );
  }
  // GPT-5.2
  for (const modelId of ["gpt-5.2", "gpt-5.2-chat-latest"]) {
    register(
      new Responses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        supports_schema: true,
        supports_tools: true,
      }),
      new AsyncResponses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        supports_schema: true,
        supports_tools: true,
      }),
    );
    // "gpt-5.2-pro" is Responses API only
  }

  // GPT-5.4
  for (const modelId of [
    "gpt-5.4",
    "gpt-5.4-2026-03-05",
    "gpt-5.4-mini",
    "gpt-5.4-mini-2026-03-17",
    "gpt-5.4-nano",
    "gpt-5.4-nano-2026-03-17",
  ]) {
    register(
      new Responses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        image_detail_original: true,
        supports_schema: true,
        supports_tools: true,
      }),
      new AsyncResponses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        image_detail_original: true,
        supports_schema: true,
        supports_tools: true,
      }),
    );
  }
  // GPT-5.5 — Responses API by default; -o chat_completions 1 opts out.
  for (const modelId of ["gpt-5.5", "gpt-5.5-2026-04-23"]) {
    register(
      new Responses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        image_detail_original: true,
        supports_schema: true,
        supports_tools: true,
      }),
      new AsyncResponses(modelId, {
        vision: true,
        reasoning: true,
        verbosity: true,
        image_detail_original: true,
        supports_schema: true,
        supports_tools: true,
      }),
    );
  }

  // The -instruct completion model
  register(
    new Completion("gpt-3.5-turbo-instruct", { default_max_tokens: 256 }),
    null,
    ["3.5-instruct", "chatgpt-instruct"],
  );

  // Load extra models
  const extraPath = path.join(userDir(), "extra-openai-models.yaml");
  if (!fs.existsSync(extraPath)) {
    return;
  }
  const extraModels = yaml.load(fs.readFileSync(extraPath, "utf-8")) as Array<
    Record<string, unknown>
  >;
  for (const extraModel of extraModels ?? []) {
    const modelId = extraModel.model_id as string;
    const aliases = (extraModel.aliases as string[]) ?? [];
    const modelName = extraModel.model_name as string;
    const apiBase = (extraModel.api_base as string) ?? null;
    const apiType = (extraModel.api_type as string) ?? null;
    const apiVersion = (extraModel.api_version as string) ?? null;
    const apiEngine = (extraModel.api_engine as string) ?? null;
    const headers = (extraModel.headers as Record<string, string>) ?? null;
    const reasoning = Boolean(extraModel.reasoning);
    const kwargs: Partial<SharedInit> = {};
    if (extraModel.can_stream === false) {
      kwargs.can_stream = false;
    }
    if (extraModel.supports_schema === true) {
      kwargs.supports_schema = true;
    }
    if (extraModel.supports_tools === true) {
      kwargs.supports_tools = true;
    }
    if (extraModel.vision === true) {
      kwargs.vision = true;
    }
    if (extraModel.audio === true) {
      kwargs.audio = true;
    }
    const modelKwargs: SharedInit = {
      model_id: modelId,
      model_name: modelName,
      api_base: apiBase,
      api_type: apiType,
      api_version: apiVersion,
      api_engine: apiEngine,
      headers,
      reasoning,
      ...kwargs,
    };
    let chatModel: Chat | Responses | Completion;
    let asyncModel: AsyncChat | AsyncResponses | null;
    if (extraModel.completion) {
      chatModel = new Completion(modelKwargs);
      asyncModel = null;
    } else if (extraModel.responses) {
      chatModel = new Responses(modelKwargs);
      asyncModel = new AsyncResponses(modelKwargs);
    } else {
      chatModel = new Chat(modelKwargs);
      asyncModel = new AsyncChat(modelKwargs);
    }
    if (apiBase) {
      chatModel.needs_key = null;
      if (asyncModel) {
        asyncModel.needs_key = null;
      }
    }
    if (extraModel.api_key_name) {
      chatModel.needs_key = extraModel.api_key_name as string;
      if (asyncModel) {
        asyncModel.needs_key = extraModel.api_key_name as string;
      }
    }
    register(chatModel, asyncModel, aliases);
  }
});

export const register_embedding_models = hookimpl(
  function register_embedding_models(
    register: (model: unknown, aliases?: string[] | null) => void,
  ) {
    register(
      new OpenAIEmbeddingModel("text-embedding-ada-002", "text-embedding-ada-002"),
      ["ada", "ada-002"],
    );
    register(
      new OpenAIEmbeddingModel("text-embedding-3-small", "text-embedding-3-small"),
      ["3-small"],
    );
    register(
      new OpenAIEmbeddingModel("text-embedding-3-large", "text-embedding-3-large"),
      ["3-large"],
    );
    // With varying dimensions
    register(
      new OpenAIEmbeddingModel(
        "text-embedding-3-small-512",
        "text-embedding-3-small",
        512,
      ),
      ["3-small-512"],
    );
    register(
      new OpenAIEmbeddingModel(
        "text-embedding-3-large-256",
        "text-embedding-3-large",
        256,
      ),
      ["3-large-256"],
    );
    register(
      new OpenAIEmbeddingModel(
        "text-embedding-3-large-1024",
        "text-embedding-3-large",
        1024,
      ),
      ["3-large-1024"],
    );
  },
);
