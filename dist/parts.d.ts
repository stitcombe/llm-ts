/**
 * Part, Message, and StreamEvent value types. Port of llm/parts.py.
 *
 * Parts represent the structured content of model interactions: text,
 * reasoning, tool calls, tool results, and attachments. A Message wraps a
 * list of Parts with a role. StreamEvent wraps a streaming chunk with type
 * information.
 */
import { Attachment } from "./models.js";
import type { AttachmentPartDict, MessageDict, PartDict, ReasoningPartDict, TextPartDict, ToolCallPartDict, ToolResultPartDict } from "./serialization.js";
export declare abstract class Part {
    provider_metadata: Record<string, unknown> | null;
    abstract toDict(): PartDict;
    static fromDict(d: PartDict): Part;
}
export declare class TextPart extends Part {
    text: string;
    constructor(init?: {
        text?: string;
        provider_metadata?: Record<string, unknown> | null;
    });
    toDict(): TextPartDict;
}
export declare class ReasoningPart extends Part {
    text: string;
    redacted: boolean;
    constructor(init?: {
        text?: string;
        redacted?: boolean;
        provider_metadata?: Record<string, unknown> | null;
    });
    toDict(): ReasoningPartDict;
}
export declare class ToolCallPart extends Part {
    name: string;
    arguments: Record<string, unknown>;
    tool_call_id: string | null;
    server_executed: boolean;
    constructor(init?: {
        name?: string;
        arguments?: Record<string, unknown>;
        tool_call_id?: string | null;
        server_executed?: boolean;
        provider_metadata?: Record<string, unknown> | null;
    });
    toDict(): ToolCallPartDict;
}
export declare class ToolResultPart extends Part {
    name: string;
    output: string;
    tool_call_id: string | null;
    server_executed: boolean;
    attachments: Attachment[];
    exception: string | null;
    constructor(init?: {
        name?: string;
        output?: string;
        tool_call_id?: string | null;
        server_executed?: boolean;
        attachments?: Attachment[];
        exception?: string | null;
        provider_metadata?: Record<string, unknown> | null;
    });
    toDict(): ToolResultPartDict;
}
export declare class AttachmentPart extends Part {
    attachment: Attachment | null;
    constructor(init?: {
        attachment?: Attachment | null;
        provider_metadata?: Record<string, unknown> | null;
    });
    toDict(): AttachmentPartDict;
}
export declare class Message {
    role: string;
    parts: Part[];
    provider_metadata: Record<string, unknown> | null;
    constructor({ role, parts, provider_metadata, }: {
        role: string;
        parts?: Part[];
        provider_metadata?: Record<string, unknown> | null;
    });
    toDict(): MessageDict;
    static fromDict(d: MessageDict): Message;
}
export type PartInput = Part | string | Attachment | PartInput[];
export declare function normalizeParts(items: PartInput[]): Part[];
interface HelperOptions {
    provider_metadata?: Record<string, unknown> | null;
}
export declare function system(...items: Array<PartInput | HelperOptions>): Message;
export declare function user(...items: Array<PartInput | HelperOptions>): Message;
export declare function assistant(...items: Array<PartInput | HelperOptions>): Message;
export declare function tool_message(...items: Array<PartInput | HelperOptions>): Message;
export type StreamEventType = "text" | "reasoning" | "tool_call_name" | "tool_call_args" | "tool_result";
export declare class StreamEvent {
    type: StreamEventType;
    chunk: string;
    part_index: number | null;
    tool_call_id: string | null;
    server_executed: boolean;
    tool_name: string | null;
    redacted: boolean;
    provider_metadata: Record<string, unknown> | null;
    message_index: number;
    constructor({ type, chunk, part_index, tool_call_id, server_executed, tool_name, redacted, provider_metadata, message_index, }: {
        type: StreamEventType;
        chunk: string;
        part_index?: number | null;
        tool_call_id?: string | null;
        server_executed?: boolean;
        tool_name?: string | null;
        redacted?: boolean;
        provider_metadata?: Record<string, unknown> | null;
        message_index?: number;
    });
}
export {};
