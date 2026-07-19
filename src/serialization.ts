/**
 * Type definitions for the JSON-safe wire form of Part, Message, and
 * Response — the exact shapes returned by toDict() methods and accepted
 * by the matching fromDict() functions. Port of llm/serialization.py
 * (Python TypedDicts become TS interfaces; NotRequired becomes `?`).
 */

export interface AttachmentDict {
  type?: string;
  url?: string;
  path?: string;
  /** base64-encoded bytes when constructed with raw content. */
  content?: string;
}

export interface TextPartDict {
  type: "text";
  text: string;
  provider_metadata?: Record<string, unknown>;
}

export interface ReasoningPartDict {
  type: "reasoning";
  text: string;
  redacted?: boolean;
  provider_metadata?: Record<string, unknown>;
}

export interface ToolCallPartDict {
  type: "tool_call";
  name: string;
  arguments: Record<string, unknown>;
  tool_call_id?: string;
  server_executed?: boolean;
  provider_metadata?: Record<string, unknown>;
}

export interface ToolResultPartDict {
  type: "tool_result";
  name: string;
  output: string;
  tool_call_id?: string;
  server_executed?: boolean;
  exception?: string;
  attachments?: AttachmentDict[];
  provider_metadata?: Record<string, unknown>;
}

export interface AttachmentPartDict {
  type: "attachment";
  attachment?: AttachmentDict;
  provider_metadata?: Record<string, unknown>;
}

export type PartDict =
  | TextPartDict
  | ReasoningPartDict
  | ToolCallPartDict
  | ToolResultPartDict
  | AttachmentPartDict;

export interface MessageDict {
  role: string;
  parts: PartDict[];
  provider_metadata?: Record<string, unknown>;
}

export interface PromptDict {
  messages: MessageDict[];
  options?: Record<string, unknown>;
  system?: string;
}

export interface UsageDict {
  input?: number;
  output?: number;
  details?: Record<string, unknown>;
}

export interface ResponseDict {
  model: string;
  prompt: PromptDict;
  messages: MessageDict[];
  id?: string;
  usage?: UsageDict;
  datetime_utc?: string;
}

// ---- Runtime specs -----------------------------------------------------
//
// TS interfaces are erased at compile time, but Python exposes TypedDict
// key sets at runtime (__required_keys__ / __optional_keys__) and the
// test suite validates toDict() output against them via pydantic's
// TypeAdapter. These spec objects and validators are the runtime
// counterpart: one spec per Dict interface above, kept in sync by hand.

export interface DictSpec {
  /** Keys that must be present (TypedDict __required_keys__). */
  requiredKeys: Set<string>;
  /** Keys that may be absent (TypedDict __optional_keys__). */
  optionalKeys: Set<string>;
  /** The Literal["..."] discriminator value, for Part dicts. */
  typeLiteral?: string;
}

export const AttachmentDictSpec: DictSpec = {
  requiredKeys: new Set(),
  optionalKeys: new Set(["type", "url", "path", "content"]),
};

export const TextPartDictSpec: DictSpec = {
  requiredKeys: new Set(["type", "text"]),
  optionalKeys: new Set(["provider_metadata"]),
  typeLiteral: "text",
};

export const ReasoningPartDictSpec: DictSpec = {
  requiredKeys: new Set(["type", "text"]),
  optionalKeys: new Set(["redacted", "provider_metadata"]),
  typeLiteral: "reasoning",
};

export const ToolCallPartDictSpec: DictSpec = {
  requiredKeys: new Set(["type", "name", "arguments"]),
  optionalKeys: new Set([
    "tool_call_id",
    "server_executed",
    "provider_metadata",
  ]),
  typeLiteral: "tool_call",
};

export const ToolResultPartDictSpec: DictSpec = {
  requiredKeys: new Set(["type", "name", "output"]),
  optionalKeys: new Set([
    "tool_call_id",
    "server_executed",
    "exception",
    "attachments",
    "provider_metadata",
  ]),
  typeLiteral: "tool_result",
};

export const AttachmentPartDictSpec: DictSpec = {
  requiredKeys: new Set(["type"]),
  optionalKeys: new Set(["attachment", "provider_metadata"]),
  typeLiteral: "attachment",
};

export const PartDictSpecs: Record<string, DictSpec> = {
  text: TextPartDictSpec,
  reasoning: ReasoningPartDictSpec,
  tool_call: ToolCallPartDictSpec,
  tool_result: ToolResultPartDictSpec,
  attachment: AttachmentPartDictSpec,
};

export const MessageDictSpec: DictSpec = {
  requiredKeys: new Set(["role", "parts"]),
  optionalKeys: new Set(["provider_metadata"]),
};

export const PromptDictSpec: DictSpec = {
  requiredKeys: new Set(["messages"]),
  optionalKeys: new Set(["options", "system"]),
};

export const UsageDictSpec: DictSpec = {
  requiredKeys: new Set(),
  optionalKeys: new Set(["input", "output", "details"]),
};

export const ResponseDictSpec: DictSpec = {
  requiredKeys: new Set(["model", "prompt", "messages"]),
  optionalKeys: new Set(["id", "usage", "datetime_utc"]),
};

class SerializationValidationError extends Error {}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function checkRequired(
  d: Record<string, unknown>,
  spec: DictSpec,
  label: string,
): void {
  for (const key of spec.requiredKeys) {
    if (!(key in d)) {
      throw new SerializationValidationError(
        `${label}: missing required key ${JSON.stringify(key)}`,
      );
    }
  }
}

/** Runtime analog of TypeAdapter(<SpecificPartDict>).validate_python. */
export function validatePartDictAs(d: unknown, spec: DictSpec): void {
  if (!isPlainObject(d)) {
    throw new SerializationValidationError("Part dict must be an object");
  }
  checkRequired(d, spec, `PartDict(${spec.typeLiteral ?? "?"})`);
  if (spec.typeLiteral !== undefined && d.type !== spec.typeLiteral) {
    throw new SerializationValidationError(
      `Expected type=${JSON.stringify(spec.typeLiteral)}, got ${JSON.stringify(
        d.type,
      )}`,
    );
  }
  if (spec.requiredKeys.has("text") && typeof d.text !== "string") {
    throw new SerializationValidationError("text must be a string");
  }
  if (spec.requiredKeys.has("name") && typeof d.name !== "string") {
    throw new SerializationValidationError("name must be a string");
  }
  if (spec.requiredKeys.has("output") && typeof d.output !== "string") {
    throw new SerializationValidationError("output must be a string");
  }
  if (spec.requiredKeys.has("arguments") && !isPlainObject(d.arguments)) {
    throw new SerializationValidationError("arguments must be an object");
  }
  if ("provider_metadata" in d && !isPlainObject(d.provider_metadata)) {
    throw new SerializationValidationError(
      "provider_metadata must be an object",
    );
  }
  if ("attachment" in d && d.attachment !== undefined) {
    if (!isPlainObject(d.attachment)) {
      throw new SerializationValidationError("attachment must be an object");
    }
  }
  if ("attachments" in d && d.attachments !== undefined) {
    if (!Array.isArray(d.attachments)) {
      throw new SerializationValidationError("attachments must be a list");
    }
  }
}

/** Runtime analog of TypeAdapter(PartDict).validate_python — the
 * discriminated union: dispatch on `type`, reject unknown values. */
export function validatePartDict(d: unknown): void {
  if (!isPlainObject(d) || typeof d.type !== "string") {
    throw new SerializationValidationError(
      "Part dict must be an object with a string `type`",
    );
  }
  const spec = PartDictSpecs[d.type];
  if (!spec) {
    throw new SerializationValidationError(
      `Unknown part type: ${JSON.stringify(d.type)}`,
    );
  }
  validatePartDictAs(d, spec);
}

export function validateMessageDict(d: unknown): void {
  if (!isPlainObject(d)) {
    throw new SerializationValidationError("Message dict must be an object");
  }
  checkRequired(d, MessageDictSpec, "MessageDict");
  if (typeof d.role !== "string") {
    throw new SerializationValidationError("role must be a string");
  }
  if (!Array.isArray(d.parts)) {
    throw new SerializationValidationError("parts must be a list");
  }
  for (const part of d.parts) {
    validatePartDict(part);
  }
}

export function validatePromptDict(d: unknown): void {
  if (!isPlainObject(d)) {
    throw new SerializationValidationError("Prompt dict must be an object");
  }
  checkRequired(d, PromptDictSpec, "PromptDict");
  if (!Array.isArray(d.messages)) {
    throw new SerializationValidationError("messages must be a list");
  }
  for (const message of d.messages) {
    validateMessageDict(message);
  }
  if ("options" in d && d.options !== undefined && !isPlainObject(d.options)) {
    throw new SerializationValidationError("options must be an object");
  }
}

export function validateResponseDict(d: unknown): void {
  if (!isPlainObject(d)) {
    throw new SerializationValidationError("Response dict must be an object");
  }
  checkRequired(d, ResponseDictSpec, "ResponseDict");
  if (typeof d.model !== "string") {
    throw new SerializationValidationError("model must be a string");
  }
  validatePromptDict(d.prompt);
  if (!Array.isArray(d.messages)) {
    throw new SerializationValidationError("messages must be a list");
  }
  for (const message of d.messages) {
    validateMessageDict(message);
  }
  if ("usage" in d && d.usage !== undefined && !isPlainObject(d.usage)) {
    throw new SerializationValidationError("usage must be an object");
  }
  if ("datetime_utc" in d && typeof d.datetime_utc !== "string") {
    throw new SerializationValidationError("datetime_utc must be a string");
  }
}
