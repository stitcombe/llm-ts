/**
 * Type definitions for the JSON-safe wire form of Part, Message, and
 * Response — the exact shapes returned by toDict() methods and accepted
 * by the matching fromDict() functions. Port of llm/serialization.py
 * (Python TypedDicts become TS interfaces; NotRequired becomes `?`).
 */
export const AttachmentDictSpec = {
    requiredKeys: new Set(),
    optionalKeys: new Set(["type", "url", "path", "content"]),
};
export const TextPartDictSpec = {
    requiredKeys: new Set(["type", "text"]),
    optionalKeys: new Set(["provider_metadata"]),
    typeLiteral: "text",
};
export const ReasoningPartDictSpec = {
    requiredKeys: new Set(["type", "text"]),
    optionalKeys: new Set(["redacted", "provider_metadata"]),
    typeLiteral: "reasoning",
};
export const ToolCallPartDictSpec = {
    requiredKeys: new Set(["type", "name", "arguments"]),
    optionalKeys: new Set([
        "tool_call_id",
        "server_executed",
        "provider_metadata",
    ]),
    typeLiteral: "tool_call",
};
export const ToolResultPartDictSpec = {
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
export const AttachmentPartDictSpec = {
    requiredKeys: new Set(["type"]),
    optionalKeys: new Set(["attachment", "provider_metadata"]),
    typeLiteral: "attachment",
};
export const PartDictSpecs = {
    text: TextPartDictSpec,
    reasoning: ReasoningPartDictSpec,
    tool_call: ToolCallPartDictSpec,
    tool_result: ToolResultPartDictSpec,
    attachment: AttachmentPartDictSpec,
};
export const MessageDictSpec = {
    requiredKeys: new Set(["role", "parts"]),
    optionalKeys: new Set(["provider_metadata"]),
};
export const PromptDictSpec = {
    requiredKeys: new Set(["messages"]),
    optionalKeys: new Set(["options", "system"]),
};
export const UsageDictSpec = {
    requiredKeys: new Set(),
    optionalKeys: new Set(["input", "output", "details"]),
};
export const ResponseDictSpec = {
    requiredKeys: new Set(["model", "prompt", "messages"]),
    optionalKeys: new Set(["id", "usage", "datetime_utc"]),
};
class SerializationValidationError extends Error {
}
function isPlainObject(v) {
    return typeof v === "object" && v !== null && !Array.isArray(v);
}
function checkRequired(d, spec, label) {
    for (const key of spec.requiredKeys) {
        if (!(key in d)) {
            throw new SerializationValidationError(`${label}: missing required key ${JSON.stringify(key)}`);
        }
    }
}
/** Runtime analog of TypeAdapter(<SpecificPartDict>).validate_python. */
export function validatePartDictAs(d, spec) {
    if (!isPlainObject(d)) {
        throw new SerializationValidationError("Part dict must be an object");
    }
    checkRequired(d, spec, `PartDict(${spec.typeLiteral ?? "?"})`);
    if (spec.typeLiteral !== undefined && d.type !== spec.typeLiteral) {
        throw new SerializationValidationError(`Expected type=${JSON.stringify(spec.typeLiteral)}, got ${JSON.stringify(d.type)}`);
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
        throw new SerializationValidationError("provider_metadata must be an object");
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
export function validatePartDict(d) {
    if (!isPlainObject(d) || typeof d.type !== "string") {
        throw new SerializationValidationError("Part dict must be an object with a string `type`");
    }
    const spec = PartDictSpecs[d.type];
    if (!spec) {
        throw new SerializationValidationError(`Unknown part type: ${JSON.stringify(d.type)}`);
    }
    validatePartDictAs(d, spec);
}
export function validateMessageDict(d) {
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
export function validatePromptDict(d) {
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
export function validateResponseDict(d) {
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
