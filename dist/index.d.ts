/**
 * Port of llm/__init__.py — the public API and model/plugin registry.
 */
import { hookimpl } from "./hookspecs.js";
import { ModelError, NeedsKeyException } from "./errors.js";
import { AsyncConversation, AsyncKeyModel, AsyncModel, AsyncResponse, Attachment, CancelToolCall, PauseChain, Conversation, EmbeddingModel, EmbeddingModelWithAliases, KeyModel, Model, ModelWithAliases, Options, Prompt, Response, Tool, Toolbox, ToolCall, ToolOutput, ToolResult, Usage } from "./models.js";
import { Message, assistant, system, tool_message, user } from "./parts.js";
import { schemaDsl, Fragment } from "./utils.js";
import { Collection } from "./embeddings.js";
import { Template } from "./templates.js";
import { pm, loadPlugins } from "./plugins.js";
import { DEFAULT_MODEL, getDefaultEmbeddingModel, getDefaultModel, getKey, loadKeys, setDefaultEmbeddingModel, setDefaultModel, userDir } from "./config.js";
export { AsyncConversation, AsyncKeyModel, AsyncModel, AsyncResponse, assistant, Attachment, CancelToolCall, Collection, Conversation, Fragment, hookimpl, KeyModel, Message, Model, ModelError, ModelWithAliases, EmbeddingModel, EmbeddingModelWithAliases, NeedsKeyException, Options, PauseChain, Prompt, Response, schemaDsl, system, Template, Tool, Toolbox, ToolCall, tool_message, ToolOutput, ToolResult, Usage, user, userDir, getKey, loadKeys, DEFAULT_MODEL, getDefaultModel, setDefaultModel, getDefaultEmbeddingModel, setDefaultEmbeddingModel, pm, loadPlugins, };
export interface PluginInfo {
    name: string;
    hooks: string[];
    version?: string;
}
export declare function getPlugins(all?: boolean): PluginInfo[];
export declare function getModelsWithAliases(): ModelWithAliases[];
export type TemplateLoader = (template: string) => Template | Promise<Template>;
export type FragmentLoader = (argument: string) => Fragment | Attachment | Array<Fragment | Attachment> | Promise<Fragment | Attachment | Array<Fragment | Attachment>>;
/** Get template loaders registered by plugins. */
export declare function getTemplateLoaders(): Record<string, TemplateLoader>;
/** Get fragment loaders registered by plugins. */
export declare function getFragmentLoaders(): Record<string, FragmentLoader>;
/** Return all tools (llm.Tool and llm.Toolbox classes) registered by plugins. */
export declare function getTools(): Record<string, Tool | typeof Toolbox>;
export declare function getEmbeddingModelsWithAliases(): EmbeddingModelWithAliases[];
export declare function getEmbeddingModels(): EmbeddingModel[];
export declare class UnknownModelError extends Error {
    constructor(message?: string);
}
export declare function getEmbeddingModel(name: string | null): EmbeddingModel;
export declare function getEmbeddingModelAliases(): Record<string, EmbeddingModel>;
export declare function getAsyncModelAliases(): Record<string, AsyncModel>;
export declare function getModelAliases(): Record<string, Model>;
/** Get all registered models. */
export declare function getModels(): Model[];
/** Get all registered async models. */
export declare function getAsyncModels(): AsyncModel[];
/** Get an async model by name or alias. */
export declare function getAsyncModel(name?: string | null): AsyncModel;
/** Get a model by name or alias. */
export declare function getModel(name?: string | null, _skipAsync?: boolean): Model;
/** Set an alias to point to the specified model. */
export declare function setAlias(alias: string, modelIdOrAlias: string): void;
/** Remove an alias. */
export declare function removeAlias(alias: string): void;
/** struct.pack("<" + "f" * len(values), *values) */
export declare function encode(values: number[]): Buffer;
/** struct.unpack("<" + "f" * (len(binary) // 4), binary) */
export declare function decode(binary: Uint8Array): number[];
export declare function cosineSimilarity(a: number[], b: number[]): number;
