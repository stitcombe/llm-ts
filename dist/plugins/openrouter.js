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
import * as fs from "node:fs";
import * as path from "node:path";
import { hookimpl } from "../hookspecs.js";
import { getKey, userDir } from "../config.js";
import { AsyncChat, Chat } from "../default_plugins/openai_models.js";
import { Option, echo } from "../click/index.js";
const MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TIMEOUT_SECONDS = 3600;
export class DownloadError extends Error {
}
function modelsCachePath() {
    return path.join(userDir(), "openrouter_models.json");
}
/**
 * Async half of Python's fetch_cached_json: refresh the on-disk cache when
 * it is missing or stale, falling back to a stale cache when the download
 * fails. Must be awaited before the model registry is consulted.
 */
export async function fetchCachedJson(url, cachePath, cacheTimeout) {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    if (fs.existsSync(cachePath)) {
        const modTime = fs.statSync(cachePath).mtimeMs / 1000;
        if (Date.now() / 1000 - modTime < cacheTimeout) {
            return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        }
    }
    try {
        const response = await fetch(url, { redirect: "follow" });
        if (!response.ok) {
            throw new Error(`HTTP error ${response.status} fetching ${url}`);
        }
        const data = (await response.json());
        fs.writeFileSync(cachePath, JSON.stringify(data));
        return data;
    }
    catch (e) {
        if (fs.existsSync(cachePath)) {
            return JSON.parse(fs.readFileSync(cachePath, "utf-8"));
        }
        throw new DownloadError(`Failed to download data and no cache is available at ${cachePath}: ${e.message}`);
    }
}
/** Refresh the model list cache. Safe to call when no key is configured. */
export async function ensureModelsCached(skipCache = false) {
    if (!getKey({ explicitKey: "", keyAlias: "openrouter", envVar: "OPENROUTER_KEY" })) {
        return;
    }
    await fetchCachedJson(MODELS_URL, modelsCachePath(), skipCache ? 0 : CACHE_TIMEOUT_SECONDS);
}
/** Sync half: read whatever ensureModelsCached() last wrote. */
export function getOpenrouterModels() {
    const cachePath = modelsCachePath();
    if (!fs.existsSync(cachePath)) {
        return [];
    }
    return (JSON.parse(fs.readFileSync(cachePath, "utf-8")).data ?? []);
}
export function getModelIds() {
    return getOpenrouterModels().map((model) => model.id);
}
export function getSupportsImages(modelDefinition) {
    const modalities = modelDefinition?.architecture?.input_modalities;
    return Array.isArray(modalities) && modalities.includes("image");
}
export function hasParameter(modelDefinition, parameter) {
    const supported = modelDefinition?.supported_parameters;
    return Array.isArray(supported) && supported.includes(parameter);
}
// ------------------------------------------------------------- options
const validateProvider = (provider) => {
    if (provider === null) {
        return null;
    }
    if (typeof provider === "string") {
        try {
            return JSON.parse(provider);
        }
        catch {
            throw new Error("Invalid JSON in provider string");
        }
    }
    return provider;
};
const MIXIN_FIELDS = {
    online: {
        type: "boolean",
        description: "Use relevant search results from Exa",
        default: null,
    },
    provider: {
        type: ["object", "string"],
        description: "JSON object to control provider routing",
        default: null,
    },
    reasoning_effort: {
        type: "string",
        description: 'One of "high", "medium", or "low" to control reasoning effort',
        default: null,
        enum: ["low", "medium", "high"],
    },
    reasoning_max_tokens: {
        type: "integer",
        description: "Specific token limit to control reasoning effort",
        default: null,
    },
    reasoning_enabled: {
        type: "boolean",
        description: "Set to true to enable reasoning with default parameters",
        default: null,
    },
};
const MIXIN_VALIDATORS = {
    provider: validateProvider,
};
/**
 * The _mixin.build_kwargs override: strip the OpenRouter-only options out
 * of the OpenAI kwargs and re-express them as OpenRouter extras.
 */
function openrouterBuildKwargs(base, prompt) {
    const kwargs = { ...base };
    const options = prompt.options;
    for (const key of [
        "provider",
        "online",
        "reasoning_effort",
        "reasoning_max_tokens",
        "reasoning_enabled",
    ]) {
        delete kwargs[key];
    }
    const extraBody = {};
    if (options.online) {
        extraBody.plugins = [{ id: "web" }];
    }
    if (options.provider) {
        extraBody.provider = options.provider;
    }
    const reasoning = {};
    if (options.reasoning_effort) {
        reasoning.effort = options.reasoning_effort;
    }
    if (options.reasoning_max_tokens) {
        reasoning.max_tokens = options.reasoning_max_tokens;
    }
    if (options.reasoning_enabled !== null && options.reasoning_enabled !== undefined) {
        reasoning.enabled = options.reasoning_enabled;
    }
    if (Object.keys(reasoning).length) {
        extraBody.reasoning = reasoning;
    }
    // The Python SDK forwards extra_body by merging it into the request
    // body; the TS client spreads kwargs, so merge here instead.
    return { ...kwargs, ...extraBody };
}
function optionsClassFor(base) {
    const cls = class extends base.Options {
        static fields = MIXIN_FIELDS;
        static validators = MIXIN_VALIDATORS;
    };
    return cls;
}
export class OpenRouterChat extends Chat {
    needs_key = "openrouter";
    key_env_var = "OPENROUTER_KEY";
    static Options = optionsClassFor(Chat);
    build_kwargs(prompt, stream) {
        return openrouterBuildKwargs(super.build_kwargs(prompt, stream), prompt);
    }
    toString() {
        return `OpenRouter: ${this.model_id}`;
    }
}
export class OpenRouterAsyncChat extends AsyncChat {
    needs_key = "openrouter";
    key_env_var = "OPENROUTER_KEY";
    static Options = optionsClassFor(AsyncChat);
    build_kwargs(prompt, stream) {
        return openrouterBuildKwargs(super.build_kwargs(prompt, stream), prompt);
    }
    toString() {
        return `OpenRouter: ${this.model_id}`;
    }
}
export const register_models = hookimpl(function register_models(register) {
    // Only do this if the openrouter key is set
    const key = getKey({
        explicitKey: "",
        keyAlias: "openrouter",
        envVar: "OPENROUTER_KEY",
    });
    if (!key) {
        return;
    }
    for (const modelDefinition of getOpenrouterModels()) {
        const init = {
            model_id: `openrouter/${modelDefinition.id}`,
            model_name: modelDefinition.id,
            vision: getSupportsImages(modelDefinition),
            supports_schema: hasParameter(modelDefinition, "structured_outputs"),
            supports_tools: hasParameter(modelDefinition, "tools"),
            api_base: "https://openrouter.ai/api/v1",
            headers: {
                "HTTP-Referer": "https://llm.datasette.io/",
                "X-Title": "LLM",
            },
        };
        register(new OpenRouterChat(init), new OpenRouterAsyncChat(init));
    }
});
// ------------------------------------------------------------ commands
export function formatPrice(key, priceStr) {
    // Format a price value with appropriate scaling and no trailing zeros.
    const price = parseFloat(priceStr);
    if (price === 0) {
        return null;
    }
    // Determine scale based on magnitude
    let scale;
    let suffix;
    if (price < 0.0001) {
        scale = 1000000;
        suffix = "/M";
    }
    else if (price < 0.001) {
        scale = 1000;
        suffix = "/K";
    }
    else if (price < 1) {
        scale = 1000;
        suffix = "/K";
    }
    else {
        scale = 1;
        suffix = "";
    }
    const scaledPrice = price * scale;
    // Format without trailing zeros
    const fixed = scaledPrice.toFixed(10);
    const formatted = fixed.includes(".")
        ? fixed.replace(/0+$/, "").replace(/\.$/, "")
        : fixed;
    return `${key} $${formatted}${suffix}`;
}
export function formatPricing(pricingDict) {
    const parts = [];
    for (const [key, value] of Object.entries(pricingDict)) {
        const formatted = formatPrice(key, value);
        if (formatted) {
            parts.push(formatted);
        }
    }
    return parts.join(", ");
}
export const register_commands = hookimpl(function register_commands(cli) {
    const openrouter = cli.group({
        name: "openrouter",
        help: "Commands relating to the llm-openrouter plugin",
    });
    openrouter.command({
        name: "models",
        help: "List of OpenRouter models",
        options: [
            new Option({ flags: ["--free"], isFlag: true, help: "List free models" }),
            new Option({
                flags: ["--json"],
                name: "json_",
                isFlag: true,
                help: "Output as JSON",
            }),
        ],
        handler: async (params) => {
            await ensureModelsCached();
            const free = params.free;
            const jsonOut = params.json_;
            const allModels = free
                ? getOpenrouterModels().filter((model) => model.id.endsWith(":free"))
                : getOpenrouterModels();
            if (jsonOut) {
                echo(JSON.stringify(allModels, null, 2));
                return;
            }
            // Custom format
            for (const model of allModels) {
                const bits = [];
                bits.push(`- id: ${model.id}`);
                bits.push(`  name: ${model.name}`);
                bits.push(`  context_length: ${Number(model.context_length).toLocaleString("en-US")}`);
                const architecture = model.architecture ?? null;
                if (architecture) {
                    bits.push("  architecture:");
                    for (const [key, value] of Object.entries(architecture)) {
                        bits.push("    " +
                            key +
                            ": " +
                            (typeof value === "string" ? value : JSON.stringify(value)));
                    }
                }
                bits.push(`  supports_schema: ${pyBool(hasParameter(model, "structured_outputs"))}`);
                bits.push(`  supports_tools: ${pyBool(hasParameter(model, "tools"))}`);
                const pricing = formatPricing(model.pricing ?? {});
                if (pricing) {
                    bits.push("  pricing: " + pricing);
                }
                echo(bits.join("\n") + "\n");
            }
        },
    });
    openrouter.command({
        name: "refresh",
        help: "Refresh the list of available OpenRouter models",
        handler: async () => {
            await ensureModelsCached();
            const before = new Set(getModelIds());
            await ensureModelsCached(true);
            const after = new Set(getModelIds());
            const added = [...after].filter((m) => !before.has(m));
            const removed = [...before].filter((m) => !after.has(m));
            if (added.length) {
                echo(`Added models: ${added.map((m) => "openrouter/" + m).join(", ")}`, { err: true });
            }
            if (removed.length) {
                echo(`Removed models: ${removed.map((m) => "openrouter/" + m).join(", ")}`, { err: true });
            }
            else {
                echo("No changes", { err: true });
            }
        },
    });
    openrouter.command({
        name: "key",
        help: "View information and rate limits for the current key",
        options: [new Option({ flags: ["--key"], help: "Key to inspect" })],
        handler: async (params) => {
            const key = getKey({
                explicitKey: params.key ?? null,
                keyAlias: "openrouter",
                envVar: "OPENROUTER_KEY",
            });
            const response = await fetch("https://openrouter.ai/api/v1/auth/key", {
                headers: { Authorization: `Bearer ${key}` },
            });
            if (!response.ok) {
                throw new Error(`HTTP error ${response.status}`);
            }
            const body = (await response.json());
            echo(JSON.stringify(body.data, null, 2));
        },
    });
});
/** Python renders booleans as True/False in the `openrouter models` output. */
function pyBool(value) {
    return value ? "True" : "False";
}
