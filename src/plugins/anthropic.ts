/**
 * Port of llm-anthropic's llm_anthropic.py.
 *
 * The Python `anthropic` SDK is replaced by the fetch-based client in
 * src/anthropicClient.ts. Both execute() implementations are async
 * generators (JS cannot do blocking HTTP), so responses from these models
 * must be driven through the Response async APIs.
 *
 * `transform_schema` (from the SDK) is reimplemented locally as
 * transformSchema().
 */

import { hookimpl } from "../hookspecs.js";
import {
  AsyncConversation,
  AsyncKeyModel,
  AsyncModel,
  AsyncResponse,
  Attachment,
  Conversation,
  KeyModel,
  Model,
  Options as OptionsBase,
  Prompt,
  Response,
  ToolCall,
} from "../models.js";
import type { BaseModel, FieldDef, ModelValidator, Validator } from "../pydantic.js";
import {
  AttachmentPart,
  Message,
  Part,
  ReasoningPart,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../parts.js";
import { AnthropicClient } from "../anthropicClient.js";

const DEFAULT_THINKING_TOKENS = 1024;
const DEFAULT_TEMPERATURE = 1.0;

const THINKING_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

type Json = Record<string, any>;

// ------------------------------------------------------------- schemas

/**
 * Stand-in for anthropic.transform_schema: JSON schemas sent as
 * output_config.format must close every object with
 * additionalProperties: false.
 */
export function transformSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map(transformSchema);
  }
  if (!schema || typeof schema !== "object") {
    return schema;
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(schema as Json)) {
    out[key] = transformSchema(value);
  }
  if (out.type === "object" && !("additionalProperties" in out)) {
    out.additionalProperties = false;
  }
  return out;
}

// ------------------------------------------------------------- options

const validateStopSequences: Validator = (stopSequences) => {
  const errorMsg = "stop_sequences must be a list of strings or a single string";
  if (typeof stopSequences === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stopSequences);
    } catch {
      return [stopSequences];
    }
    if (
      !Array.isArray(parsed) ||
      !parsed.every((seq) => typeof seq === "string")
    ) {
      throw new Error(errorMsg);
    }
    return parsed;
  }
  if (Array.isArray(stopSequences)) {
    if (!stopSequences.every((seq) => typeof seq === "string")) {
      throw new Error(errorMsg);
    }
    return stopSequences;
  }
  throw new Error(errorMsg);
};

const validateTemperature: Validator = (temperature) => {
  const value = temperature as number;
  if (!(value >= 0.0 && value <= 1.0)) {
    throw new Error("temperature must be in range 0.0-1.0");
  }
  return value;
};

const validateTopP: Validator = (topP) => {
  if (topP !== null && !((topP as number) >= 0.0 && (topP as number) <= 1.0)) {
    throw new Error("top_p must be in range 0.0-1.0");
  }
  return topP;
};

const validateTopK: Validator = (topK) => {
  if (topK !== null && (topK as number) <= 0) {
    throw new Error("top_k must be a positive integer");
  }
  return topK;
};

const validateWebSearchMaxUses: Validator = (maxUses) => {
  if (maxUses !== null && (maxUses as number) <= 0) {
    throw new Error("web_search_max_uses must be a positive integer");
  }
  return maxUses;
};

const validateWebSearchDomains: Validator = (domains) => {
  if (domains !== null) {
    if (
      !Array.isArray(domains) ||
      !domains.every((domain) => typeof domain === "string")
    ) {
      throw new Error("web_search domains must be a list of strings");
    }
  }
  return domains;
};

const validateWebSearchLocation: Validator = (location) => {
  if (location !== null) {
    if (
      typeof location !== "object" ||
      Array.isArray(location)
    ) {
      throw new Error("web_search_location must be a dictionary");
    }
    const requiredFields = ["city", "region", "country", "timezone"];
    if (!requiredFields.every((field) => field in (location as Json))) {
      throw new Error(
        `web_search_location must contain: {${requiredFields
          .map((f) => `'${f}'`)
          .join(", ")}}`,
      );
    }
  }
  return location;
};

const validateTemperatureTopP: ModelValidator = (self) => {
  if (self.temperature !== 1.0 && self.top_p !== null && self.top_p !== undefined) {
    throw new Error("Only one of temperature and top_p can be set");
  }
};

const validateWebSearchDomainsConflict: ModelValidator = (self) => {
  if (
    self.web_search_allowed_domains !== null &&
    self.web_search_allowed_domains !== undefined &&
    self.web_search_blocked_domains !== null &&
    self.web_search_blocked_domains !== undefined
  ) {
    throw new Error(
      "Cannot use both web_search_allowed_domains and web_search_blocked_domains",
    );
  }
};

export class ClaudeOptions extends OptionsBase {
  static override fields: Record<string, FieldDef> = {
    max_tokens: {
      type: "integer",
      description:
        "The maximum number of tokens to generate before stopping",
      default: null,
    },
    temperature: {
      type: "number",
      description:
        "Amount of randomness injected into the response. Defaults to 1.0. " +
        "Ranges from 0.0 to 1.0. Use temperature closer to 0.0 for analytical / " +
        "multiple choice, and closer to 1.0 for creative and generative tasks. " +
        "Note that even with temperature of 0.0, the results will not be fully " +
        "deterministic.",
      default: null,
    },
    top_p: {
      type: "number",
      description:
        "Use nucleus sampling. In nucleus sampling, we compute the cumulative " +
        "distribution over all the options for each subsequent token in " +
        "decreasing probability order and cut it off once it reaches a " +
        "particular probability specified by top_p. You should either alter " +
        "temperature or top_p, but not both. Recommended for advanced use cases " +
        "only. You usually only need to use temperature.",
      default: null,
    },
    top_k: {
      type: "integer",
      description:
        "Only sample from the top K options for each subsequent token. Used to " +
        "remove 'long tail' low probability responses. Recommended for advanced " +
        "use cases only. You usually only need to use temperature.",
      default: null,
    },
    user_id: {
      type: "string",
      description:
        "An external identifier for the user who is associated with the request",
      default: null,
    },
    prefill: {
      type: "string",
      description: "A prefill to use for the response",
      default: null,
    },
    hide_prefill: {
      type: "boolean",
      description:
        "Do not repeat the prefill value at the start of the response",
      default: null,
    },
    stop_sequences: {
      type: ["array", "string"],
      description:
        "Custom text sequences that will cause the model to stop generating - " +
        "pass either a list of strings or a single string",
      default: null,
      items: { type: "string" },
    },
    cache: {
      type: "boolean",
      description:
        "Use Anthropic prompt cache for any attachments or fragments",
      default: null,
    },
    fast: {
      type: "boolean",
      description:
        "Use fast mode for lower latency responses: " +
        "https://platform.claude.com/docs/en/build-with-claude/fast-mode",
      default: null,
    },
    web_search: {
      type: "boolean",
      description: "Enable web search capabilities",
      default: null,
    },
    web_search_max_uses: {
      type: "integer",
      description: "Maximum number of web searches to perform per request",
      default: null,
    },
    web_search_allowed_domains: {
      type: "array",
      description: "List of domains to restrict web searches to",
      default: null,
      items: { type: "string" },
    },
    web_search_blocked_domains: {
      type: "array",
      description: "List of domains to exclude from web searches",
      default: null,
      items: { type: "string" },
    },
    web_search_location: {
      type: "object",
      description:
        "User location for localizing search results (dict with city, region, " +
        "country, timezone)",
      default: null,
    },
  };

  static override validators: Record<string, Validator> = {
    stop_sequences: validateStopSequences,
    temperature: validateTemperature,
    top_p: validateTopP,
    top_k: validateTopK,
    web_search_max_uses: validateWebSearchMaxUses,
    web_search_allowed_domains: validateWebSearchDomains,
    web_search_blocked_domains: validateWebSearchDomains,
    web_search_location: validateWebSearchLocation,
  };

  static override modelValidators: ModelValidator[] = [
    validateTemperatureTopP,
    validateWebSearchDomainsConflict,
  ];
}

export class ClaudeOptionsWithThinking extends ClaudeOptions {
  static override fields: Record<string, FieldDef> = {
    thinking: {
      type: "boolean",
      description: "Enable thinking mode",
      default: null,
    },
    thinking_budget: {
      type: "integer",
      description: "Number of tokens to budget for thinking",
      default: null,
    },
    thinking_display: {
      type: "boolean",
      description:
        "Request summarized thinking output (available in --json logs)",
      default: null,
    },
    thinking_adaptive: {
      type: "boolean",
      description:
        'Force adaptive thinking mode (sends thinking={"type": "adaptive"})',
      default: null,
    },
  };
}

export class ClaudeOptionsWithThinkingEffort extends ClaudeOptionsWithThinking {
  static override fields: Record<string, FieldDef> = {
    thinking_effort: {
      type: "string",
      description:
        "Level of thinking effort to apply: low, medium, or high",
      default: null,
      enum: [...THINKING_EFFORTS],
    },
  };
}

// -------------------------------------------------------- attachments

interface PreparedAttachment extends Attachment {
  _base64?: string;
}

export function sourceForAttachment(attachment: Attachment): Json {
  if (attachment.url) {
    return { type: "url", url: attachment.url };
  }
  const prepared = attachment as PreparedAttachment;
  return {
    data:
      prepared._base64 ??
      Buffer.from(attachment.content ?? new Uint8Array()).toString("base64"),
    media_type: attachment.type ?? attachment.resolveTypeSync(),
    type: "base64",
  };
}

/**
 * Resolve attachment types and base64 payloads up front so that
 * build_messages() — which the Python plugin (and its tests) call
 * synchronously — does not have to await anything.
 */
async function prepareAttachments(prompt: Prompt): Promise<void> {
  for (const message of prompt.messages) {
    for (const part of message.parts) {
      if (!(part instanceof AttachmentPart) || !part.attachment) continue;
      const attachment = part.attachment as PreparedAttachment;
      if (!attachment.type) {
        attachment.type = await attachment.resolveType();
      }
      if (!attachment.url && attachment._base64 === undefined) {
        attachment._base64 = await attachment.base64Content();
      }
    }
  }
}

// ------------------------------------------------------------- shared

export interface ClaudeInit {
  claude_model_id?: string | null;
  supports_images?: boolean;
  supports_pdf?: boolean;
  supports_thinking?: boolean;
  supports_thinking_effort?: boolean;
  supports_adaptive_thinking?: boolean;
  supports_web_search?: boolean;
  use_structured_outputs?: boolean;
  default_max_tokens?: number | null;
  base_url?: string | null;
}

/** The state and behaviour shared by ClaudeMessages and AsyncClaudeMessages. */
interface ClaudeShared {
  model_id: string;
  claude_model_id: string;
  base_url: string | null;
  use_structured_outputs: boolean;
  supports_thinking: boolean;
  supports_thinking_effort: boolean;
  supports_adaptive_thinking: boolean;
  supports_web_search: boolean;
  default_max_tokens: number;
  attachment_types: Set<string>;
  Options: typeof OptionsBase;
  get_key(explicitKey?: string | null): string | null;
}

function initShared(self: any, modelId: string, init: ClaudeInit): void {
  const {
    claude_model_id = null,
    supports_images = true,
    supports_pdf = false,
    supports_thinking = false,
    supports_thinking_effort = false,
    supports_adaptive_thinking = false,
    supports_web_search = false,
    use_structured_outputs = false,
    default_max_tokens = null,
    base_url = null,
  } = init;

  self.model_id = "anthropic/" + modelId;
  self.claude_model_id = claude_model_id || modelId;
  self.base_url = base_url;
  self.use_structured_outputs = use_structured_outputs;
  self.attachment_types = new Set<string>();
  if (supports_images) {
    for (const type of [
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]) {
      self.attachment_types.add(type);
    }
  }
  if (supports_pdf) {
    self.attachment_types.add("application/pdf");
  }
  if (supports_thinking) {
    self.supports_thinking = true;
    self.Options = ClaudeOptionsWithThinking;
  }
  if (supports_thinking_effort) {
    self.supports_thinking_effort = true;
    self.Options = ClaudeOptionsWithThinkingEffort;
  }
  if (supports_adaptive_thinking) {
    self.supports_adaptive_thinking = true;
  }
  if (default_max_tokens !== null) {
    self.default_max_tokens = default_max_tokens;
  }
  self.supports_web_search = supports_web_search;
}

function prefillText(prompt: Prompt): string {
  const options = prompt.options as Json;
  if (options.prefill && !options.hide_prefill) {
    return options.prefill as string;
  }
  return "";
}

// --- messages= support ---------------------------------------------------
//
// This plugin consumes prompt.messages (the canonical Message[] that llm
// synthesizes from legacy inputs when messages= wasn't explicitly passed).
// Each Message + its Parts is translated into Anthropic content blocks;
// adjacent user-side messages (role="user" or role="tool") are merged
// because Anthropic requires alternating user/assistant turns.

/** Translate one llm Part into an Anthropic content block. */
function partToBlock(part: Part): Json | null {
  const pm = part.provider_metadata ?? {};
  const anthropicPm =
    (pm && typeof pm === "object" ? (pm as Json).anthropic : null) ?? {};
  if (part instanceof TextPart) {
    return { type: "text", text: part.text };
  }
  if (part instanceof ReasoningPart) {
    const block: Json = { type: "thinking", thinking: part.text };
    // Anthropic signed-thinking requires the signature echoed back.
    const sig =
      anthropicPm && typeof anthropicPm === "object"
        ? (anthropicPm as Json).signature
        : null;
    if (sig) {
      block.signature = sig;
    }
    return block;
  }
  if (part instanceof ToolCallPart) {
    return {
      type: "tool_use",
      id: part.tool_call_id,
      name: part.name,
      input: part.arguments,
    };
  }
  if (part instanceof ToolResultPart) {
    return {
      type: "tool_result",
      tool_use_id: part.tool_call_id,
      content: part.output,
    };
  }
  if (part instanceof AttachmentPart && part.attachment !== null) {
    const attachment = part.attachment;
    const attachmentType =
      (attachment.type ?? attachment.resolveTypeSync()) === "application/pdf"
        ? "document"
        : "image";
    return {
      type: attachmentType,
      source: sourceForAttachment(attachment),
    };
  }
  return null;
}

function messageToBlocks(message: Message): Json[] {
  let blocks: Json[] = [];
  for (const part of message.parts) {
    const block = partToBlock(part);
    if (block !== null) {
      blocks.push(block);
    }
  }
  if (message.role === "assistant") {
    const filteredBlocks: Json[] = [];
    let seenToolUse = false;
    for (const block of blocks) {
      const blockType = block.type;
      if (seenToolUse && blockType === "text" && block.text === " ") {
        // The sync streaming path yields a display-only space after tool
        // calls so chained text does not run together. Anthropic rejects
        // assistant history that places text after tool_use instead of
        // immediately before tool_result.
        continue;
      }
      filteredBlocks.push(block);
      if (blockType === "tool_use") {
        seenToolUse = true;
      }
    }
    blocks = filteredBlocks;
  }
  return blocks;
}

/**
 * Append an Anthropic-shaped message, merging with the previous one if both
 * would be user-side turns (tool_result + text in the same user message is
 * the required shape for tool follow-ups).
 */
function appendMessage(out: Json[], message: Message): void {
  if (message.role === "system") {
    return; // system lives on the top-level kwargs["system"] field
  }
  const blocks = messageToBlocks(message);
  if (!blocks.length) {
    return;
  }
  // Anthropic: tool messages from llm become user messages with
  // tool_result blocks; assistant stays assistant.
  const anthropicRole = message.role === "assistant" ? "assistant" : "user";
  const last = out[out.length - 1];
  if (last && last.role === anthropicRole && anthropicRole === "user") {
    (last.content as Json[]).push(...blocks);
  } else {
    out.push({ role: anthropicRole, content: blocks });
  }
}

function buildMessages(self: ClaudeShared, prompt: Prompt): Json[] {
  const messages: Json[] = [];
  const options = prompt.options as Json;

  // Current turn — iterate prompt.messages (auto-synthesized from legacy
  // inputs if messages= was not explicitly passed). In llm 0.32+ conversation
  // and chain paths pre-bake the full input chain here, so also walking
  // conversation.responses would duplicate prior turns and break tool-result
  // ordering.
  for (const message of prompt.messages) {
    appendMessage(messages, message);
  }

  // Cache control: apply to the last content block of the final user-side
  // turn, matching the pre-upgrade behavior.
  if (options.cache && messages.length) {
    const lastMessage = messages[messages.length - 1];
    if (Array.isArray(lastMessage.content) && lastMessage.content.length) {
      lastMessage.content[lastMessage.content.length - 1].cache_control = {
        type: "ephemeral",
      };
    }
  }

  // Prefill — append an assistant turn the model will continue from.
  if (options.prefill) {
    if (self.supports_adaptive_thinking) {
      throw new Error(
        `Prefilling assistant messages is not supported by ${self.claude_model_id}. ` +
          "Use structured outputs or system prompt instructions instead.",
      );
    }
    messages.push({
      role: "assistant",
      content: [{ type: "text", text: options.prefill }],
    });
  }

  return messages;
}

/**
 * Pull the system prompt from prompt.messages or prompt.system.
 *
 * `prompt.system` already composes `_system` + `system_fragments`; if
 * messages= was passed explicitly and it contains a system-role message,
 * fall back to reading that.
 */
function extractSystem(prompt: Prompt): string | null {
  if (prompt.system) {
    return prompt.system;
  }
  for (const message of prompt.messages) {
    if (message.role === "system") {
      const texts = message.parts
        .filter((p): p is TextPart => p instanceof TextPart)
        .map((p) => p.text);
      if (texts.length) {
        return texts.join("\n\n");
      }
    }
  }
  return null;
}

function buildKwargs(self: ClaudeShared, prompt: Prompt): Json {
  const options = prompt.options as Json;

  if (prompt.schema && prompt.tools.length) {
    throw new Error(
      "llm-anthropic does not yet support using both schema and tools in the same prompt",
    );
  }

  // Validate web search support
  if (options.web_search && !self.supports_web_search) {
    throw new Error(
      `Web search is not supported by model ${self.model_id}. ` +
        "Supported models include: claude-3.5-sonnet-latest, claude-3.5-haiku-latest, " +
        "claude-3.7-sonnet-latest, claude-4-opus, claude-4-sonnet, claude-opus-4.1, " +
        "claude-opus-4.6, claude-sonnet-4.6",
    );
  }

  // `max` effort demands the extra headroom only the Opus models have.
  if (
    options.thinking_effort === "max" &&
    !self.claude_model_id.includes("opus")
  ) {
    throw new Error(
      `thinking_effort='max' is only supported by the Claude Opus models, ` +
        `not ${self.claude_model_id}`,
    );
  }

  const kwargs: Json = {
    model: self.claude_model_id,
    messages: buildMessages(self, prompt),
  };
  if (options.user_id) {
    kwargs.metadata = { user_id: options.user_id };
  }

  if (options.top_p) {
    kwargs.top_p = options.top_p;
  } else {
    kwargs.temperature =
      options.temperature !== null && options.temperature !== undefined
        ? options.temperature
        : DEFAULT_TEMPERATURE;
  }

  if (options.top_k) {
    kwargs.top_k = options.top_k;
  }

  const system = extractSystem(prompt);
  if (system) {
    kwargs.system = system;
  }

  if (options.stop_sequences) {
    kwargs.stop_sequences = options.stop_sequences;
  }

  const thinkingEffortEnabled = Boolean(
    self.supports_thinking_effort && options.thinking_effort,
  );

  // Determine if thinking should be activated
  let thinkingRequested = false;
  if (self.supports_thinking) {
    thinkingRequested = Boolean(
      options.thinking ||
        options.thinking_budget ||
        options.thinking_display ||
        options.thinking_adaptive ||
        thinkingEffortEnabled,
    );
  }

  if (self.supports_thinking && thinkingRequested) {
    options.thinking = true;
    if (options.thinking_adaptive || thinkingEffortEnabled) {
      kwargs.thinking = { type: "adaptive" };
    } else if (options.thinking_budget) {
      // Explicit budget = manual mode (deprecated on 4.6 but still works)
      kwargs.thinking = {
        type: "enabled",
        budget_tokens: options.thinking_budget,
      };
    } else if (self.supports_adaptive_thinking) {
      // 4.6 models default to adaptive thinking
      kwargs.thinking = { type: "adaptive" };
    } else {
      // Pre-4.6 models: enabled with default budget
      kwargs.thinking = {
        type: "enabled",
        budget_tokens: DEFAULT_THINKING_TOKENS,
      };
    }

    if (options.thinking_display) {
      kwargs.thinking.display = "summarized";
    }
  }

  // Handle effort in output_config
  if (thinkingEffortEnabled) {
    (kwargs.output_config ??= {}).effort = options.thinking_effort;
  }

  let maxTokens = self.default_max_tokens;
  if (options.max_tokens !== null && options.max_tokens !== undefined) {
    maxTokens = options.max_tokens;
  }
  if (
    self.supports_thinking &&
    options.thinking_budget !== null &&
    options.thinking_budget !== undefined &&
    options.thinking_budget > maxTokens
  ) {
    maxTokens = options.thinking_budget + 1;
  }
  kwargs.max_tokens = maxTokens;

  // Determine which beta headers to use
  const betas: string[] = [];

  // Effort beta: only for pre-GA models (e.g., Opus 4.5)
  if (
    kwargs.output_config &&
    "effort" in kwargs.output_config &&
    !self.supports_adaptive_thinking
  ) {
    betas.push("effort-2025-11-24");
  }

  // 128K output beta: not needed for 4.6 models
  if (maxTokens > 64000 && !self.supports_adaptive_thinking) {
    betas.push("output-128k-2025-02-19");
    if ("thinking" in kwargs) {
      const thinking = kwargs.thinking;
      delete kwargs.thinking;
      kwargs.extra_body = { thinking };
    }
  }

  // Check if we should use new structured outputs
  const useStructuredOutputs = Boolean(
    prompt.schema && self.use_structured_outputs,
  );

  if (useStructuredOutputs) {
    (kwargs.output_config ??= {}).format = {
      type: "json_schema",
      schema: transformSchema(prompt.schema),
    };
  }

  // Fast mode for lower latency responses
  if (options.fast) {
    kwargs.speed = "fast";
    betas.push("fast-mode-2026-02-01");
  }

  if (betas.length) {
    kwargs.betas = betas;
  }

  const tools: Json[] = [];

  // Add web search tool if enabled
  if (options.web_search) {
    const webSearchTool: Json = {
      type: "web_search_20250305",
      name: "web_search",
    };

    // Add optional web search parameters
    if (options.web_search_max_uses) {
      webSearchTool.max_uses = options.web_search_max_uses;
    }
    if (options.web_search_allowed_domains) {
      webSearchTool.allowed_domains = options.web_search_allowed_domains;
    }
    if (options.web_search_blocked_domains) {
      webSearchTool.blocked_domains = options.web_search_blocked_domains;
    }
    if (options.web_search_location) {
      webSearchTool.user_location = {
        ...options.web_search_location,
        type: "approximate", // Required by API
      };
    }

    tools.push(webSearchTool);
  }

  if (prompt.schema && !useStructuredOutputs) {
    // Fall back to tools workaround for models that don't support
    // structured outputs
    tools.push({
      name: "output_structured_data",
      input_schema: prompt.schema,
    });
    kwargs.tool_choice = { type: "tool", name: "output_structured_data" };
  }

  if (prompt.tools.length) {
    tools.push(
      ...prompt.tools.map((tool) => ({
        name: tool.name,
        description: tool.description || "",
        input_schema: tool.input_schema,
      })),
    );
  }

  if (tools.length) {
    kwargs.tools = tools;
  }

  return kwargs;
}

function setUsage(response: Response | AsyncResponse): void {
  const responseJson = response.response_json as Json;
  const usage = { ...(responseJson.usage as Json) };
  delete responseJson.usage;
  const inputTokens = usage.input_tokens;
  delete usage.input_tokens;
  const outputTokens = usage.output_tokens;
  delete usage.output_tokens;
  // Only include usage details if prompt caching was on or web search was used
  let details: Json | null = null;
  if ((response.prompt.options as Json).cache || usage.server_tool_use) {
    details = usage;
  }
  response.set_usage({
    input: inputTokens,
    output: outputTokens,
    details,
  });
}

function addToolUsage(
  response: Response | AsyncResponse,
  lastMessage: Json,
): boolean {
  const toolUses = (lastMessage.content as Json[]).filter(
    (item) => item.type === "tool_use",
  );
  for (const toolUse of toolUses) {
    response.add_tool_call(
      new ToolCall({
        tool_call_id: toolUse.id,
        name: toolUse.name,
        arguments: toolUse.input,
      }),
    );
  }
  return toolUses.length > 0;
}

function getClient(self: ClaudeShared, key: string | null): AnthropicClient {
  return new AnthropicClient({
    apiKey: self.get_key(key) ?? "",
    baseUrl: self.base_url,
  });
}

/** Non-streaming content-block walk, shared by both model classes. */
function* nonStreamingEvents(
  completion: Json,
  initialPrefill: string,
): Generator<StreamEvent> {
  let prefill = initialPrefill;
  for (const item of completion.content ?? []) {
    const itemType = item.type;
    if (itemType === "thinking") {
      const signature = item.signature ?? null;
      yield new StreamEvent({
        type: "reasoning",
        chunk: item.thinking,
        provider_metadata: signature ? { anthropic: { signature } } : null,
      });
    } else if (itemType === "text") {
      const text = prefill ? prefill + item.text : item.text;
      prefill = ""; // Only prepend once
      yield new StreamEvent({ type: "text", chunk: text });
    } else if (itemType === "tool_use" || itemType === "server_tool_use") {
      yield new StreamEvent({
        type: "tool_call_name",
        chunk: item.name,
        tool_call_id: item.id,
        server_executed: itemType === "server_tool_use",
      });
      yield new StreamEvent({
        type: "tool_call_args",
        chunk: JSON.stringify(item.input),
        tool_call_id: item.id,
        server_executed: itemType === "server_tool_use",
      });
    } else if (itemType === "web_search_tool_result") {
      const resultContent = item.content ?? [];
      yield new StreamEvent({
        type: "tool_result",
        chunk: resultContent.length ? JSON.stringify(resultContent) : "",
        tool_call_id: item.tool_use_id ?? null,
        server_executed: true,
        tool_name: "web_search",
      });
    }
  }
}

/**
 * The streaming loop, shared by both model classes. `emitTrailingSpace`
 * mirrors the sync plugin's extra " " chunk after tool calls.
 */
async function* streamingEvents(
  self: ClaudeShared,
  client: AnthropicClient,
  kwargs: Json,
  response: Response | AsyncResponse,
  prefill: string,
  emitTrailingSpace: boolean,
): AsyncGenerator<StreamEvent> {
  void self;
  const streamObj = client.messages.stream(kwargs);
  let currentBlockId: string | null = null;
  let currentBlockName: string | null = null;
  let isServerTool = false;

  if (prefill) {
    yield new StreamEvent({ type: "text", chunk: prefill });
  }

  for await (const chunk of streamObj) {
    if (chunk.type === "content_block_start") {
      const block = chunk.content_block ?? {};
      const blockType = block.type ?? null;
      currentBlockId = block.id ?? null;
      currentBlockName = block.name ?? null;
      isServerTool =
        blockType === "server_tool_use" ||
        blockType === "web_search_tool_result";

      if (blockType === "tool_use" || blockType === "server_tool_use") {
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: currentBlockName || "",
          tool_call_id: currentBlockId,
          server_executed: blockType === "server_tool_use",
        });
      } else if (blockType === "web_search_tool_result") {
        // Content is available inline on content_block_start
        const resultContent = block.content ?? [];
        yield new StreamEvent({
          type: "tool_result",
          chunk: resultContent.length ? JSON.stringify(resultContent) : "",
          tool_call_id: block.tool_use_id ?? null,
          server_executed: true,
          tool_name: "web_search",
        });
      }
    } else if (chunk.type === "content_block_delta") {
      const delta = chunk.delta ?? {};
      const deltaType = delta.type ?? null;

      if (deltaType === "thinking_delta") {
        yield new StreamEvent({ type: "reasoning", chunk: delta.thinking });
      } else if (deltaType === "signature_delta") {
        yield new StreamEvent({
          type: "reasoning",
          chunk: "",
          provider_metadata: { anthropic: { signature: delta.signature } },
        });
      } else if (deltaType === "text_delta") {
        yield new StreamEvent({ type: "text", chunk: delta.text });
      } else if (deltaType === "input_json_delta") {
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: delta.partial_json,
          tool_call_id: currentBlockId,
          server_executed: isServerTool,
        });
      }
    }
  }

  // This records usage and other data:
  const lastMessage = streamObj.getFinalMessage();
  response.response_json = lastMessage;

  if (addToolUsage(response, lastMessage) && emitTrailingSpace) {
    // Avoid "can have dragons.Now that I " bug
    yield new StreamEvent({ type: "text", chunk: " " });
  }
}

async function* execute(
  self: ClaudeShared,
  prompt: Prompt,
  stream: boolean,
  response: Response | AsyncResponse,
  key: string | null,
  emitTrailingSpace: boolean,
): AsyncGenerator<StreamEvent> {
  const client = getClient(self, key);
  await prepareAttachments(prompt);
  const kwargs = buildKwargs(self, prompt);
  const prefill = prefillText(prompt);

  if (stream) {
    yield* streamingEvents(
      self,
      client,
      kwargs,
      response,
      prefill,
      emitTrailingSpace,
    );
  } else {
    const completion = await client.messages.create(kwargs);
    yield* nonStreamingEvents(completion, prefill);
    response.response_json = completion;
    addToolUsage(response, completion);
  }
  setUsage(response);
}

// -------------------------------------------------------------- models

export class ClaudeMessages extends KeyModel implements ClaudeShared {
  override needs_key: string | null = "anthropic";
  override key_env_var: string | null = "ANTHROPIC_API_KEY";
  override can_stream = true;
  base_url: string | null = null;

  claude_model_id!: string;
  use_structured_outputs = false;
  supports_thinking = false;
  supports_thinking_effort = false;
  supports_adaptive_thinking = false;
  override supports_schema = true;
  override supports_tools = true;
  supports_web_search = false;
  default_max_tokens = 4096;

  static override Options = ClaudeOptions;

  constructor(modelId: string, init: ClaudeInit = {}) {
    super();
    initShared(this, modelId, init);
  }

  build_messages(prompt: Prompt, conversation: Conversation | null): Json[] {
    void conversation;
    return buildMessages(this, prompt);
  }

  build_kwargs(prompt: Prompt, conversation: Conversation | null): Json {
    void conversation;
    return buildKwargs(this, prompt);
  }

  _extract_system(prompt: Prompt): string | null {
    return extractSystem(prompt);
  }

  execute(
    prompt: Prompt,
    stream: boolean,
    response: Response,
    conversation: Conversation | null,
    key: string | null,
  ): AsyncGenerator<StreamEvent> {
    void conversation;
    return execute(this, prompt, stream, response, key, true);
  }

  override toString(): string {
    return `Anthropic Messages: ${this.model_id}`;
  }
}

export class AsyncClaudeMessages
  extends AsyncKeyModel
  implements ClaudeShared
{
  override needs_key: string | null = "anthropic";
  override key_env_var: string | null = "ANTHROPIC_API_KEY";
  override can_stream = true;
  base_url: string | null = null;

  claude_model_id!: string;
  use_structured_outputs = false;
  supports_thinking = false;
  supports_thinking_effort = false;
  supports_adaptive_thinking = false;
  override supports_schema = true;
  override supports_tools = true;
  supports_web_search = false;
  default_max_tokens = 4096;

  static override Options = ClaudeOptions;

  constructor(modelId: string, init: ClaudeInit = {}) {
    super();
    initShared(this, modelId, init);
  }

  build_messages(
    prompt: Prompt,
    conversation: AsyncConversation | null,
  ): Json[] {
    void conversation;
    return buildMessages(this, prompt);
  }

  build_kwargs(prompt: Prompt, conversation: AsyncConversation | null): Json {
    void conversation;
    return buildKwargs(this, prompt);
  }

  _extract_system(prompt: Prompt): string | null {
    return extractSystem(prompt);
  }

  execute(
    prompt: Prompt,
    stream: boolean,
    response: AsyncResponse,
    conversation: AsyncConversation | null,
    key: string | null,
  ): AsyncGenerator<StreamEvent> {
    void conversation;
    // The async path does not emit the display-only trailing space.
    return execute(this, prompt, stream, response, key, false);
  }

  override toString(): string {
    return `Anthropic Messages: ${this.model_id}`;
  }
}

// ---------------------------------------------------------- registration

interface ModelSpec {
  id: string;
  init?: ClaudeInit;
  aliases?: string[];
}

/** https://docs.anthropic.com/claude/docs/models-overview */
const MODEL_SPECS: ModelSpec[] = [
  { id: "claude-3-opus-20240229" },
  { id: "claude-3-opus-latest", aliases: ["claude-3-opus"] },
  { id: "claude-3-sonnet-20240229", aliases: ["claude-3-sonnet"] },
  { id: "claude-3-haiku-20240307", aliases: ["claude-3-haiku"] },
  // 3.5 models
  {
    id: "claude-3-5-sonnet-20240620",
    init: { supports_pdf: true, default_max_tokens: 8192 },
  },
  {
    id: "claude-3-5-sonnet-20241022",
    init: {
      supports_pdf: true,
      supports_web_search: true,
      default_max_tokens: 8192,
    },
  },
  {
    id: "claude-3-5-sonnet-latest",
    init: {
      supports_pdf: true,
      supports_web_search: true,
      default_max_tokens: 8192,
    },
    aliases: ["claude-3.5-sonnet", "claude-3.5-sonnet-latest"],
  },
  {
    id: "claude-3-5-haiku-latest",
    init: { supports_web_search: true, default_max_tokens: 8192 },
    aliases: ["claude-3.5-haiku"],
  },
  // 3.7
  {
    id: "claude-3-7-sonnet-20250219",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_web_search: true,
      default_max_tokens: 8192,
    },
  },
  {
    id: "claude-3-7-sonnet-latest",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_web_search: true,
      default_max_tokens: 8192,
    },
    aliases: ["claude-3.7-sonnet", "claude-3.7-sonnet-latest"],
  },
  {
    id: "claude-opus-4-0",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_web_search: true,
      default_max_tokens: 32000,
    },
    aliases: ["claude-4-opus"],
  },
  {
    id: "claude-sonnet-4-0",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_web_search: true,
      default_max_tokens: 64000,
    },
    aliases: ["claude-4-sonnet"],
  },
  {
    id: "claude-opus-4-1-20250805",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_web_search: true,
      use_structured_outputs: true,
      default_max_tokens: 32000,
    },
    aliases: ["claude-opus-4.1"],
  },
  {
    id: "claude-sonnet-4-5",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      use_structured_outputs: true,
      default_max_tokens: 64000,
    },
    aliases: ["claude-sonnet-4.5"],
  },
  {
    id: "claude-haiku-4-5-20251001",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      default_max_tokens: 64000,
    },
    aliases: ["claude-haiku-4.5"],
  },
  {
    id: "claude-opus-4-5-20251101",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_thinking_effort: true,
      supports_web_search: true,
      default_max_tokens: 64000,
    },
    aliases: ["claude-opus-4.5"],
  },
  {
    id: "claude-opus-4-6",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_thinking_effort: true,
      supports_adaptive_thinking: true,
      supports_web_search: true,
      use_structured_outputs: true,
      default_max_tokens: 128000,
    },
    aliases: ["claude-opus-4.6"],
  },
  {
    id: "claude-sonnet-4-6",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_thinking_effort: true,
      supports_adaptive_thinking: true,
      supports_web_search: true,
      use_structured_outputs: true,
      default_max_tokens: 128000,
    },
    aliases: ["claude-sonnet-4.6"],
  },
  {
    id: "claude-opus-4-7",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_thinking_effort: true,
      supports_adaptive_thinking: true,
      supports_web_search: true,
      use_structured_outputs: true,
      default_max_tokens: 128000,
    },
    aliases: ["claude-opus-4.7"],
  },
  {
    id: "claude-opus-4-8",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_thinking_effort: true,
      supports_adaptive_thinking: true,
      supports_web_search: true,
      use_structured_outputs: true,
      default_max_tokens: 128000,
    },
    aliases: ["claude-opus-4.8"],
  },
  {
    id: "claude-fable-5",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      supports_thinking_effort: true,
      supports_adaptive_thinking: true,
      supports_web_search: true,
      use_structured_outputs: true,
      default_max_tokens: 128000,
    },
    aliases: ["claude-fable-5"],
  },
  {
    id: "claude-sonnet-5",
    init: {
      supports_pdf: true,
      supports_thinking: true,
      use_structured_outputs: true,
      default_max_tokens: 64000,
    },
    aliases: ["claude-sonnet-5"],
  },
];

export const register_models = hookimpl(function register_models(
  register: (
    model: Model,
    asyncModel?: AsyncModel | null,
    aliases?: string[] | null,
  ) => void,
) {
  for (const spec of MODEL_SPECS) {
    register(
      new ClaudeMessages(spec.id, spec.init ?? {}) as unknown as Model,
      new AsyncClaudeMessages(spec.id, spec.init ?? {}) as unknown as AsyncModel,
      spec.aliases ?? null,
    );
  }
});

export type { BaseModel };
