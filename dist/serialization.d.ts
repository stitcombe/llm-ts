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
export type PartDict = TextPartDict | ReasoningPartDict | ToolCallPartDict | ToolResultPartDict | AttachmentPartDict;
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
export interface DictSpec {
    /** Keys that must be present (TypedDict __required_keys__). */
    requiredKeys: Set<string>;
    /** Keys that may be absent (TypedDict __optional_keys__). */
    optionalKeys: Set<string>;
    /** The Literal["..."] discriminator value, for Part dicts. */
    typeLiteral?: string;
}
export declare const AttachmentDictSpec: DictSpec;
export declare const TextPartDictSpec: DictSpec;
export declare const ReasoningPartDictSpec: DictSpec;
export declare const ToolCallPartDictSpec: DictSpec;
export declare const ToolResultPartDictSpec: DictSpec;
export declare const AttachmentPartDictSpec: DictSpec;
export declare const PartDictSpecs: Record<string, DictSpec>;
export declare const MessageDictSpec: DictSpec;
export declare const PromptDictSpec: DictSpec;
export declare const UsageDictSpec: DictSpec;
export declare const ResponseDictSpec: DictSpec;
/** Runtime analog of TypeAdapter(<SpecificPartDict>).validate_python. */
export declare function validatePartDictAs(d: unknown, spec: DictSpec): void;
/** Runtime analog of TypeAdapter(PartDict).validate_python — the
 * discriminated union: dispatch on `type`, reject unknown values. */
export declare function validatePartDict(d: unknown): void;
export declare function validateMessageDict(d: unknown): void;
export declare function validatePromptDict(d: unknown): void;
export declare function validateResponseDict(d: unknown): void;
