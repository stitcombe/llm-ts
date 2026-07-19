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
import { AsyncConversation, AsyncKeyModel, AsyncModel, AsyncResponse, Attachment, Conversation, KeyModel, Model, Options as OptionsBase, Prompt, Response } from "../models.js";
import type { BaseModel, FieldDef, ModelValidator, Validator } from "../pydantic.js";
import { StreamEvent } from "../parts.js";
type Json = Record<string, any>;
/**
 * Stand-in for anthropic.transform_schema: JSON schemas sent as
 * output_config.format must close every object with
 * additionalProperties: false.
 */
export declare function transformSchema(schema: unknown): unknown;
export declare class ClaudeOptions extends OptionsBase {
    static fields: Record<string, FieldDef>;
    static validators: Record<string, Validator>;
    static modelValidators: ModelValidator[];
}
export declare class ClaudeOptionsWithThinking extends ClaudeOptions {
    static fields: Record<string, FieldDef>;
}
export declare class ClaudeOptionsWithThinkingEffort extends ClaudeOptionsWithThinking {
    static fields: Record<string, FieldDef>;
}
export declare function sourceForAttachment(attachment: Attachment): Json;
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
export declare class ClaudeMessages extends KeyModel implements ClaudeShared {
    needs_key: string | null;
    key_env_var: string | null;
    can_stream: boolean;
    base_url: string | null;
    claude_model_id: string;
    use_structured_outputs: boolean;
    supports_thinking: boolean;
    supports_thinking_effort: boolean;
    supports_adaptive_thinking: boolean;
    supports_schema: boolean;
    supports_tools: boolean;
    supports_web_search: boolean;
    default_max_tokens: number;
    static Options: typeof ClaudeOptions;
    constructor(modelId: string, init?: ClaudeInit);
    build_messages(prompt: Prompt, conversation: Conversation | null): Json[];
    build_kwargs(prompt: Prompt, conversation: Conversation | null): Json;
    _extract_system(prompt: Prompt): string | null;
    execute(prompt: Prompt, stream: boolean, response: Response, conversation: Conversation | null, key: string | null): AsyncGenerator<StreamEvent>;
    toString(): string;
}
export declare class AsyncClaudeMessages extends AsyncKeyModel implements ClaudeShared {
    needs_key: string | null;
    key_env_var: string | null;
    can_stream: boolean;
    base_url: string | null;
    claude_model_id: string;
    use_structured_outputs: boolean;
    supports_thinking: boolean;
    supports_thinking_effort: boolean;
    supports_adaptive_thinking: boolean;
    supports_schema: boolean;
    supports_tools: boolean;
    supports_web_search: boolean;
    default_max_tokens: number;
    static Options: typeof ClaudeOptions;
    constructor(modelId: string, init?: ClaudeInit);
    build_messages(prompt: Prompt, conversation: AsyncConversation | null): Json[];
    build_kwargs(prompt: Prompt, conversation: AsyncConversation | null): Json;
    _extract_system(prompt: Prompt): string | null;
    execute(prompt: Prompt, stream: boolean, response: AsyncResponse, conversation: AsyncConversation | null, key: string | null): AsyncGenerator<StreamEvent>;
    toString(): string;
}
export declare const register_models: (register: (model: Model, asyncModel?: AsyncModel | null, aliases?: string[] | null) => void) => void;
export type { BaseModel };
