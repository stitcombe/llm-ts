/**
 * Part, Message, and StreamEvent value types. Port of llm/parts.py.
 *
 * Parts represent the structured content of model interactions: text,
 * reasoning, tool calls, tool results, and attachments. A Message wraps a
 * list of Parts with a role. StreamEvent wraps a streaming chunk with type
 * information.
 */

import { Attachment } from "./models.js";
import type {
  AttachmentDict,
  AttachmentPartDict,
  MessageDict,
  PartDict,
  ReasoningPartDict,
  TextPartDict,
  ToolCallPartDict,
  ToolResultPartDict,
} from "./serialization.js";

function attachmentToDict(att: Attachment): AttachmentDict {
  const d: AttachmentDict = {};
  if (att.type) d.type = att.type;
  if (att.url) d.url = att.url;
  if (att.path) d.path = att.path;
  if (att.content) d.content = Buffer.from(att.content).toString("base64");
  return d;
}

function attachmentFromDict(d: AttachmentDict): Attachment {
  let contentBytes: Uint8Array | null = null;
  if (typeof d.content === "string") {
    contentBytes = Buffer.from(d.content, "base64");
  }
  return new Attachment({
    type: d.type ?? null,
    path: d.path ?? null,
    url: d.url ?? null,
    content: contentBytes,
  });
}

/** Python's dataclasses raise TypeError on unexpected kwargs; mirror
 * that for Part constructors so removed fields (e.g. token_count) fail
 * loudly instead of being silently dropped. */
function assertKnownKeys(
  init: Record<string, unknown>,
  allowed: string[],
  className: string,
): void {
  for (const key of Object.keys(init)) {
    if (!allowed.includes(key)) {
      throw new TypeError(
        `${className} got an unexpected keyword argument '${key}'`,
      );
    }
  }
}

export abstract class Part {
  provider_metadata: Record<string, unknown> | null = null;

  abstract toDict(): PartDict;

  static fromDict(d: PartDict): Part {
    switch (d.type) {
      case "text":
        return new TextPart({
          text: d.text,
          provider_metadata: d.provider_metadata ?? null,
        });
      case "reasoning":
        return new ReasoningPart({
          text: d.text,
          redacted: d.redacted ?? false,
          provider_metadata: d.provider_metadata ?? null,
        });
      case "tool_call":
        return new ToolCallPart({
          name: d.name,
          arguments: d.arguments,
          tool_call_id: d.tool_call_id ?? null,
          server_executed: d.server_executed ?? false,
          provider_metadata: d.provider_metadata ?? null,
        });
      case "tool_result":
        return new ToolResultPart({
          name: d.name,
          output: d.output,
          tool_call_id: d.tool_call_id ?? null,
          server_executed: d.server_executed ?? false,
          exception: d.exception ?? null,
          attachments: (d.attachments ?? []).map(attachmentFromDict),
          provider_metadata: d.provider_metadata ?? null,
        });
      case "attachment": {
        const attDict = (d as AttachmentPartDict).attachment;
        return new AttachmentPart({
          attachment: attDict ? attachmentFromDict(attDict) : null,
          provider_metadata: d.provider_metadata ?? null,
        });
      }
      default:
        throw new Error(
          `Unknown part type: '${(d as { type: string }).type}'`,
        );
    }
  }
}

export class TextPart extends Part {
  text: string;

  constructor(
    init: {
      text?: string;
      provider_metadata?: Record<string, unknown> | null;
    } = {},
  ) {
    super();
    assertKnownKeys(init, ["text", "provider_metadata"], "TextPart");
    this.text = init.text ?? "";
    this.provider_metadata = init.provider_metadata ?? null;
  }

  toDict(): TextPartDict {
    const d: TextPartDict = { type: "text", text: this.text };
    if (this.provider_metadata && Object.keys(this.provider_metadata).length) {
      d.provider_metadata = this.provider_metadata;
    }
    return d;
  }
}

export class ReasoningPart extends Part {
  text: string;
  redacted: boolean;

  constructor(
    init: {
      text?: string;
      redacted?: boolean;
      provider_metadata?: Record<string, unknown> | null;
    } = {},
  ) {
    super();
    assertKnownKeys(
      init,
      ["text", "redacted", "provider_metadata"],
      "ReasoningPart",
    );
    this.text = init.text ?? "";
    this.redacted = init.redacted ?? false;
    this.provider_metadata = init.provider_metadata ?? null;
  }

  toDict(): ReasoningPartDict {
    const d: ReasoningPartDict = { type: "reasoning", text: this.text };
    if (this.redacted) d.redacted = true;
    if (this.provider_metadata && Object.keys(this.provider_metadata).length) {
      d.provider_metadata = this.provider_metadata;
    }
    return d;
  }
}

export class ToolCallPart extends Part {
  name: string;
  arguments: Record<string, unknown>;
  tool_call_id: string | null;
  server_executed: boolean;

  constructor(
    init: {
      name?: string;
      arguments?: Record<string, unknown>;
      tool_call_id?: string | null;
      server_executed?: boolean;
      provider_metadata?: Record<string, unknown> | null;
    } = {},
  ) {
    super();
    assertKnownKeys(
      init,
      [
        "name",
        "arguments",
        "tool_call_id",
        "server_executed",
        "provider_metadata",
      ],
      "ToolCallPart",
    );
    this.name = init.name ?? "";
    this.arguments = init.arguments ?? {};
    this.tool_call_id = init.tool_call_id ?? null;
    this.server_executed = init.server_executed ?? false;
    this.provider_metadata = init.provider_metadata ?? null;
  }

  toDict(): ToolCallPartDict {
    const d: ToolCallPartDict = {
      type: "tool_call",
      name: this.name,
      arguments: this.arguments,
    };
    if (this.tool_call_id !== null) d.tool_call_id = this.tool_call_id;
    if (this.server_executed) d.server_executed = true;
    if (this.provider_metadata && Object.keys(this.provider_metadata).length) {
      d.provider_metadata = this.provider_metadata;
    }
    return d;
  }
}

export class ToolResultPart extends Part {
  name: string;
  output: string;
  tool_call_id: string | null;
  server_executed: boolean;
  attachments: Attachment[];
  exception: string | null;

  constructor(
    init: {
      name?: string;
      output?: string;
      tool_call_id?: string | null;
      server_executed?: boolean;
      attachments?: Attachment[];
      exception?: string | null;
      provider_metadata?: Record<string, unknown> | null;
    } = {},
  ) {
    super();
    assertKnownKeys(
      init,
      [
        "name",
        "output",
        "tool_call_id",
        "server_executed",
        "attachments",
        "exception",
        "provider_metadata",
      ],
      "ToolResultPart",
    );
    this.name = init.name ?? "";
    this.output = init.output ?? "";
    this.tool_call_id = init.tool_call_id ?? null;
    this.server_executed = init.server_executed ?? false;
    this.attachments = init.attachments ?? [];
    this.exception = init.exception ?? null;
    this.provider_metadata = init.provider_metadata ?? null;
  }

  toDict(): ToolResultPartDict {
    const d: ToolResultPartDict = {
      type: "tool_result",
      name: this.name,
      output: this.output,
    };
    if (this.tool_call_id !== null) d.tool_call_id = this.tool_call_id;
    if (this.server_executed) d.server_executed = true;
    if (this.exception !== null) d.exception = this.exception;
    if (this.attachments.length) {
      d.attachments = this.attachments.map(attachmentToDict);
    }
    if (this.provider_metadata && Object.keys(this.provider_metadata).length) {
      d.provider_metadata = this.provider_metadata;
    }
    return d;
  }
}

export class AttachmentPart extends Part {
  attachment: Attachment | null;

  constructor(
    init: {
      attachment?: Attachment | null;
      provider_metadata?: Record<string, unknown> | null;
    } = {},
  ) {
    super();
    assertKnownKeys(init, ["attachment", "provider_metadata"], "AttachmentPart");
    this.attachment = init.attachment ?? null;
    this.provider_metadata = init.provider_metadata ?? null;
  }

  toDict(): AttachmentPartDict {
    const d: AttachmentPartDict = { type: "attachment" };
    if (this.attachment) d.attachment = attachmentToDict(this.attachment);
    if (this.provider_metadata && Object.keys(this.provider_metadata).length) {
      d.provider_metadata = this.provider_metadata;
    }
    return d;
  }
}

export class Message {
  role: string;
  parts: Part[];
  provider_metadata: Record<string, unknown> | null;

  constructor({
    role,
    parts = [],
    provider_metadata = null,
  }: {
    role: string;
    parts?: Part[];
    provider_metadata?: Record<string, unknown> | null;
  }) {
    this.role = role;
    this.parts = parts;
    this.provider_metadata = provider_metadata;
  }

  toDict(): MessageDict {
    const d: MessageDict = {
      role: this.role,
      parts: this.parts.map((p) => p.toDict()),
    };
    if (this.provider_metadata && Object.keys(this.provider_metadata).length) {
      d.provider_metadata = this.provider_metadata;
    }
    return d;
  }

  static fromDict(d: MessageDict): Message {
    return new Message({
      role: d.role,
      parts: (d.parts ?? []).map((p) => Part.fromDict(p)),
      provider_metadata: d.provider_metadata ?? null,
    });
  }
}

export type PartInput = Part | string | Attachment | PartInput[];

export function normalizeParts(items: PartInput[]): Part[] {
  const out: Part[] = [];
  for (const item of items) {
    if (item instanceof Part) {
      out.push(item);
    } else if (typeof item === "string" || item instanceof String) {
      out.push(new TextPart({ text: String(item) }));
    } else if (item instanceof Attachment) {
      out.push(new AttachmentPart({ attachment: item }));
    } else if (Array.isArray(item)) {
      out.push(...normalizeParts(item));
    } else {
      throw new TypeError(`Cannot convert ${String(item)} to an llm Part`);
    }
  }
  return out;
}

interface HelperOptions {
  provider_metadata?: Record<string, unknown> | null;
}

/** Python's helpers take a keyword-only provider_metadata= argument; in
 * TS a trailing `{provider_metadata: ...}` object plays that role. */
function splitHelperOptions(
  items: Array<PartInput | HelperOptions>,
): [PartInput[], HelperOptions] {
  const last = items[items.length - 1];
  if (
    last !== null &&
    typeof last === "object" &&
    !(last instanceof Part) &&
    !(last instanceof Attachment) &&
    !(last instanceof String) &&
    !Array.isArray(last) &&
    "provider_metadata" in last
  ) {
    return [items.slice(0, -1) as PartInput[], last as HelperOptions];
  }
  return [items as PartInput[], {}];
}

function buildMessage(
  role: string,
  items: Array<PartInput | HelperOptions>,
): Message {
  const [parts, opts] = splitHelperOptions(items);
  return new Message({
    role,
    parts: normalizeParts(parts),
    provider_metadata: opts.provider_metadata ?? null,
  });
}

export function system(...items: Array<PartInput | HelperOptions>): Message {
  return buildMessage("system", items);
}

export function user(...items: Array<PartInput | HelperOptions>): Message {
  return buildMessage("user", items);
}

export function assistant(...items: Array<PartInput | HelperOptions>): Message {
  return buildMessage("assistant", items);
}

export function tool_message(
  ...items: Array<PartInput | HelperOptions>
): Message {
  return buildMessage("tool", items);
}

export type StreamEventType =
  | "text"
  | "reasoning"
  | "tool_call_name"
  | "tool_call_args"
  | "tool_result";

export class StreamEvent {
  type: StreamEventType;
  chunk: string;
  part_index: number | null;
  tool_call_id: string | null;
  server_executed: boolean;
  tool_name: string | null;
  redacted: boolean;
  provider_metadata: Record<string, unknown> | null;
  message_index: number;

  constructor({
    type,
    chunk,
    part_index = null,
    tool_call_id = null,
    server_executed = false,
    tool_name = null,
    redacted = false,
    provider_metadata = null,
    message_index = 0,
  }: {
    type: StreamEventType;
    chunk: string;
    part_index?: number | null;
    tool_call_id?: string | null;
    server_executed?: boolean;
    tool_name?: string | null;
    redacted?: boolean;
    provider_metadata?: Record<string, unknown> | null;
    message_index?: number;
  }) {
    this.type = type;
    this.chunk = chunk;
    this.part_index = part_index;
    this.tool_call_id = tool_call_id;
    this.server_executed = server_executed;
    this.tool_name = tool_name;
    this.redacted = redacted;
    this.provider_metadata = provider_metadata;
    this.message_index = message_index;
  }
}
