/**
 * Minimal fetch-based Anthropic Messages API client, standing in for the
 * Python `anthropic` package used by llm-anthropic.
 *
 * Covers what the plugin needs:
 *  - messages.create(...) — non-streaming, returns the parsed JSON body
 *    normalized to the shape the SDK's `model_dump()` produces
 *  - messages.stream(...) — SSE streaming; the returned object is async
 *    iterable over raw events and exposes getFinalMessage(), which
 *    accumulates content blocks the way the SDK's stream helper does
 *
 * `betas` and `extra_body` entries in the params are handled the way the
 * Python SDK handles them: `betas` becomes the anthropic-beta header (and
 * selects the /v1/messages beta client), `extra_body` is merged into the
 * request body.
 */
export class AnthropicAPIError extends Error {
    status;
    body;
    constructor(message, status = null, body = null) {
        super(message);
        this.name = "AnthropicAPIError";
        this.status = status;
        this.body = body;
    }
}
export const ANTHROPIC_VERSION = "2023-06-01";
/**
 * Add the fields the SDK's pydantic models default to null but that the
 * wire format omits. Only the fields the plugin (and its tests) actually
 * observe are filled in.
 */
export function normalizeMessage(message) {
    const out = { ...message };
    if (!("container" in out))
        out.container = null;
    if (!("stop_details" in out))
        out.stop_details = null;
    out.content = (out.content ?? []).map((block) => {
        const b = { ...block };
        if (b.type === "text") {
            if (!("citations" in b))
                b.citations = null;
            if (!("parsed_output" in b))
                b.parsed_output = null;
        }
        return b;
    });
    return out;
}
/** Accumulates SSE events into the final Message, mirroring the SDK helper. */
class MessageAccumulator {
    message = {};
    blocks = new Map();
    jsonBuffers = new Map();
    add(event) {
        switch (event.type) {
            case "message_start":
                this.message = { ...(event.message ?? {}) };
                this.message.content = [];
                break;
            case "content_block_start": {
                const block = { ...(event.content_block ?? {}) };
                this.blocks.set(event.index, block);
                if (block.type === "tool_use" || block.type === "server_tool_use") {
                    this.jsonBuffers.set(event.index, "");
                }
                break;
            }
            case "content_block_delta": {
                const block = this.blocks.get(event.index);
                if (!block)
                    break;
                const delta = event.delta ?? {};
                if (delta.type === "text_delta") {
                    block.text = (block.text ?? "") + delta.text;
                }
                else if (delta.type === "thinking_delta") {
                    block.thinking = (block.thinking ?? "") + delta.thinking;
                }
                else if (delta.type === "signature_delta") {
                    block.signature = (block.signature ?? "") + delta.signature;
                }
                else if (delta.type === "input_json_delta") {
                    this.jsonBuffers.set(event.index, (this.jsonBuffers.get(event.index) ?? "") + delta.partial_json);
                }
                break;
            }
            case "content_block_stop": {
                const block = this.blocks.get(event.index);
                const buffered = this.jsonBuffers.get(event.index);
                if (block && buffered) {
                    try {
                        block.input = JSON.parse(buffered);
                    }
                    catch {
                        // Leave the input from content_block_start in place
                    }
                }
                break;
            }
            case "message_delta": {
                Object.assign(this.message, event.delta ?? {});
                if (event.usage) {
                    this.message.usage = {
                        ...(this.message.usage ?? {}),
                        ...event.usage,
                    };
                }
                break;
            }
            default:
                break;
        }
    }
    finalMessage() {
        const indexes = [...this.blocks.keys()].sort((a, b) => a - b);
        this.message.content = indexes.map((i) => this.blocks.get(i));
        return normalizeMessage(this.message);
    }
}
function errorMessage(body, status) {
    if (body && typeof body === "object") {
        return `Error code: ${status} - ${JSON.stringify(body)}`;
    }
    return `Error code: ${status}`;
}
export class AnthropicClient {
    apiKey;
    baseUrl;
    constructor({ apiKey, baseUrl = null }) {
        this.apiKey = apiKey;
        this.baseUrl = (baseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
    }
    /**
     * Split the plugin's kwargs into (body, betas), applying the Python SDK's
     * handling of the `betas` and `extra_body` pseudo-parameters.
     */
    prepare(params) {
        const { betas, extra_body: extraBody, ...rest } = params;
        const body = { ...rest, ...(extraBody ?? {}) };
        return { body, betas: betas ?? [] };
    }
    headers(betas) {
        const headers = {
            "x-api-key": this.apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
            accept: "application/json",
        };
        if (betas.length) {
            headers["anthropic-beta"] = betas.join(",");
        }
        return headers;
    }
    async request(params, stream) {
        const { body, betas } = this.prepare(params);
        const response = await fetch(`${this.baseUrl}/v1/messages`, {
            method: "POST",
            headers: this.headers(betas),
            body: JSON.stringify(stream ? { ...body, stream: true } : body),
        });
        if (!response.ok) {
            const text = await response.text();
            let parsed = text;
            try {
                parsed = text ? JSON.parse(text) : null;
            }
            catch {
                // keep the raw text
            }
            throw new AnthropicAPIError(errorMessage(parsed, response.status), response.status, parsed);
        }
        return response;
    }
    messages = {
        create: async (params) => {
            const response = await this.request(params, false);
            const text = await response.text();
            return normalizeMessage(text ? JSON.parse(text) : {});
        },
        stream: (params) => {
            const accumulator = new MessageAccumulator();
            const requestPromise = this.request(params, true);
            async function* iterate() {
                const response = await requestPromise;
                if (!response.body)
                    return;
                const reader = response.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";
                const emit = function* (rawEvent) {
                    for (const line of rawEvent.split("\n")) {
                        if (!line.startsWith("data:"))
                            continue;
                        const data = line.slice(5).trim();
                        if (!data)
                            continue;
                        yield JSON.parse(data);
                    }
                };
                try {
                    while (true) {
                        const { done, value } = await reader.read();
                        if (done)
                            break;
                        buffer += decoder.decode(value, { stream: true });
                        let end;
                        while ((end = buffer.indexOf("\n\n")) !== -1) {
                            const rawEvent = buffer.slice(0, end);
                            buffer = buffer.slice(end + 2);
                            for (const event of emit(rawEvent)) {
                                accumulator.add(event);
                                yield event;
                            }
                        }
                    }
                    if (buffer.trim()) {
                        for (const event of emit(buffer)) {
                            accumulator.add(event);
                            yield event;
                        }
                    }
                }
                finally {
                    reader.releaseLock();
                }
            }
            return {
                [Symbol.asyncIterator]: iterate,
                getFinalMessage: () => accumulator.finalMessage(),
            };
        },
    };
}
