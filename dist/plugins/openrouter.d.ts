/**
 * Port of llm-openrouter's llm_openrouter.py.
 *
 * Two deliberate differences from Python, both forced by the runtime:
 *
 *  - `fetch_cached_json` used a blocking httpx.get inside register_models.
 *    JS has no synchronous HTTP, so the download is split out into the
 *    async `ensureModelsCached()`; register_models reads the on-disk cache
 *    synchronously. The CLI awaits ensureModelsCached() during startup.
 *  - the Python SDK's `extra_body` kwarg is merged into the request body
 *    directly, since the TS OpenAI client spreads kwargs onto the body.
 */
import type { AsyncModel, Model, Prompt } from "../models.js";
import { AsyncChat, Chat } from "../default_plugins/openai_models.js";
import { Group } from "../click/index.js";
type Json = Record<string, any>;
export declare class DownloadError extends Error {
}
/**
 * Async half of Python's fetch_cached_json: refresh the on-disk cache when
 * it is missing or stale, falling back to a stale cache when the download
 * fails. Must be awaited before the model registry is consulted.
 */
export declare function fetchCachedJson(url: string, cachePath: string, cacheTimeout: number): Promise<Json>;
/** Refresh the model list cache. Safe to call when no key is configured. */
export declare function ensureModelsCached(skipCache?: boolean): Promise<void>;
/** Sync half: read whatever ensureModelsCached() last wrote. */
export declare function getOpenrouterModels(): Json[];
export declare function getModelIds(): string[];
export declare function getSupportsImages(modelDefinition: Json): boolean;
export declare function hasParameter(modelDefinition: Json, parameter: string): boolean;
export declare class OpenRouterChat extends Chat {
    needs_key: string | null;
    key_env_var: string | null;
    static Options: any;
    build_kwargs(prompt: Prompt, stream: boolean): Json;
    toString(): string;
}
export declare class OpenRouterAsyncChat extends AsyncChat {
    needs_key: string | null;
    key_env_var: string | null;
    static Options: any;
    build_kwargs(prompt: Prompt, stream: boolean): Json;
    toString(): string;
}
export declare const register_models: (register: (model: Model, asyncModel?: AsyncModel | null, aliases?: string[] | null) => void) => void;
export declare function formatPrice(key: string, priceStr: string): string | null;
export declare function formatPricing(pricingDict: Json): string;
export declare const register_commands: (cli: Group) => void;
export {};
