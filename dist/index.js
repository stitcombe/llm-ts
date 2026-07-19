/**
 * Port of llm/__init__.py — the public API and model/plugin registry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hookimpl } from "./hookspecs.js";
import { ModelError, NeedsKeyException } from "./errors.js";
import { AsyncConversation, AsyncKeyModel, AsyncModel, AsyncResponse, Attachment, CancelToolCall, PauseChain, Conversation, EmbeddingModel, EmbeddingModelWithAliases, KeyModel, Model, ModelWithAliases, Options, Prompt, Response, Tool, Toolbox, ToolCall, ToolOutput, ToolResult, Usage, } from "./models.js";
import { Message, assistant, system, tool_message, user, } from "./parts.js";
import { schemaDsl, Fragment } from "./utils.js";
import { Collection, registerIndex } from "./embeddings.js";
import { Template } from "./templates.js";
import { pm, loadPlugins } from "./plugins.js";
import { DEFAULT_MODEL, getDefaultEmbeddingModel, getDefaultModel, getKey, loadKeys, setDefaultEmbeddingModel, setDefaultModel, userDir, } from "./config.js";
import { callWithKwargs } from "./introspect.js";
export { AsyncConversation, AsyncKeyModel, AsyncModel, AsyncResponse, assistant, Attachment, CancelToolCall, Collection, Conversation, Fragment, hookimpl, KeyModel, Message, Model, ModelError, ModelWithAliases, EmbeddingModel, EmbeddingModelWithAliases, NeedsKeyException, Options, PauseChain, Prompt, Response, schemaDsl, system, Template, Tool, Toolbox, ToolCall, tool_message, ToolOutput, ToolResult, Usage, user, userDir, getKey, loadKeys, DEFAULT_MODEL, getDefaultModel, setDefaultModel, getDefaultEmbeddingModel, setDefaultEmbeddingModel, pm, loadPlugins, };
export function getPlugins(all = false) {
    const plugins = [];
    const pluginToDistinfo = new Map(pm.list_plugin_distinfo());
    for (const plugin of pm.get_plugins()) {
        // Python uses plugin.__name__ (falling back to the registration
        // name only when the plugin object doesn't define one).
        const name = (plugin.__name__ ??
            pm.get_name(plugin)) ||
            "";
        if (!all && name && name.startsWith("llm.default_plugins.")) {
            continue;
        }
        const pluginInfo = {
            name,
            hooks: pm.get_hookcallers(plugin)?.map((h) => h.name) ?? [],
        };
        const distinfo = pluginToDistinfo.get(plugin);
        if (distinfo) {
            pluginInfo.version = distinfo.version;
            pluginInfo.name =
                distinfo.name ||
                    distinfo.project_name ||
                    pluginInfo.name;
        }
        plugins.push(pluginInfo);
    }
    return plugins;
}
function readExtraAliases() {
    const aliasesPath = path.join(userDir(), "aliases.json");
    const extraModelAliases = {};
    if (fs.existsSync(aliasesPath)) {
        const configuredAliases = JSON.parse(fs.readFileSync(aliasesPath, "utf-8"));
        for (const [alias, modelId] of Object.entries(configuredAliases)) {
            (extraModelAliases[modelId] ??= []).push(alias);
        }
    }
    return extraModelAliases;
}
export function getModelsWithAliases() {
    const modelAliases = [];
    const extraModelAliases = readExtraAliases();
    function register(model, asyncModel = null, aliases = null) {
        const aliasList = [...(aliases ?? [])];
        if (model && model.model_id in extraModelAliases) {
            aliasList.push(...extraModelAliases[model.model_id]);
        }
        modelAliases.push(new ModelWithAliases(model, asyncModel, aliasList));
    }
    loadPlugins();
    pm.hook.register_models({ register, model_aliases: modelAliases });
    return modelAliases;
}
function getLoaders(hookMethod) {
    loadPlugins();
    const loaders = {};
    function register(prefix, loader) {
        let suffix = 0;
        let prefixToTry = prefix;
        while (prefixToTry in loaders) {
            suffix += 1;
            prefixToTry = `${prefix}_${suffix}`;
        }
        loaders[prefixToTry] = loader;
    }
    hookMethod({ register });
    return loaders;
}
/** Get template loaders registered by plugins. */
export function getTemplateLoaders() {
    return getLoaders((kwargs) => pm.hook.register_template_loaders(kwargs));
}
/** Get fragment loaders registered by plugins. */
export function getFragmentLoaders() {
    return getLoaders((kwargs) => pm.hook.register_fragment_loaders(kwargs));
}
/** Return all tools (llm.Tool and llm.Toolbox classes) registered by plugins. */
export function getTools() {
    loadPlugins();
    const tools = {};
    let currentPluginName = null;
    function register(toolOrFunction, name = null) {
        let tool = null;
        if (typeof toolOrFunction === "function" &&
            toolOrFunction.prototype instanceof Toolbox) {
            // It's a Toolbox class: set the plugin field on it
            const cls = toolOrFunction;
            tool = cls;
            if (currentPluginName) {
                cls.plugin = currentPluginName;
            }
            if (name) {
                Object.defineProperty(cls, "name", { value: name });
            }
        }
        else if (toolOrFunction instanceof Tool) {
            tool = toolOrFunction;
            if (name) {
                tool.name = name;
            }
            if (currentPluginName) {
                tool.plugin = currentPluginName;
            }
        }
        else if (typeof toolOrFunction === "function") {
            // Python's inspect.isclass: an ES `class` that is not a Toolbox
            // subclass is an error, not a bare function to wrap.
            if (/^class[\s{]/.test(Function.prototype.toString.call(toolOrFunction))) {
                throw new TypeError(`Toolbox classes must inherit from llm.Toolbox, ${toolOrFunction.name} does not.`);
            }
            tool = Tool.function(toolOrFunction, { name });
            if (currentPluginName) {
                tool.plugin = currentPluginName;
            }
        }
        else {
            throw new TypeError(`Toolbox classes must inherit from llm.Toolbox, ${String(toolOrFunction)} does not.`);
        }
        if (tool) {
            let prefix;
            if (typeof tool === "function") {
                prefix = name || tool.name || "";
            }
            else {
                prefix = name || tool.name || "";
            }
            let suffix = 0;
            let candidate = prefix;
            while (candidate in tools) {
                suffix += 1;
                candidate = `${prefix}_${suffix}`;
            }
            tools[candidate] = tool;
        }
    }
    // Call each plugin's register_tools hook individually to track
    // currentPluginName
    for (const plugin of pm.get_plugins()) {
        currentPluginName = pm.get_name(plugin);
        const hookCaller = pm.hook.register_tools;
        const pluginImpls = hookCaller
            .get_hookimpls()
            .filter((impl) => impl.plugin === plugin);
        for (const impl of pluginImpls) {
            callWithKwargs(impl.function, { register });
        }
    }
    return tools;
}
export function getEmbeddingModelsWithAliases() {
    const modelAliases = [];
    const extraModelAliases = readExtraAliases();
    function register(model, aliases = null) {
        const aliasList = [...(aliases ?? [])];
        if (model.model_id in extraModelAliases) {
            aliasList.push(...extraModelAliases[model.model_id]);
        }
        modelAliases.push(new EmbeddingModelWithAliases(model, aliasList));
    }
    loadPlugins();
    pm.hook.register_embedding_models({ register });
    return modelAliases;
}
export function getEmbeddingModels() {
    const models = [];
    function register(model, _aliases) {
        models.push(model);
    }
    loadPlugins();
    pm.hook.register_embedding_models({ register });
    return models;
}
export class UnknownModelError extends Error {
    constructor(message) {
        super(message);
        this.name = "UnknownModelError";
    }
}
export function getEmbeddingModel(name) {
    const aliases = getEmbeddingModelAliases();
    const model = aliases[name ?? ""];
    if (!model) {
        throw new UnknownModelError("Unknown model: " + String(name));
    }
    return model;
}
export function getEmbeddingModelAliases() {
    const modelAliases = {};
    for (const modelWithAliases of getEmbeddingModelsWithAliases()) {
        for (const alias of modelWithAliases.aliases) {
            modelAliases[alias] = modelWithAliases.model;
        }
        modelAliases[modelWithAliases.model.model_id] = modelWithAliases.model;
    }
    return modelAliases;
}
export function getAsyncModelAliases() {
    const asyncModelAliases = {};
    for (const modelWithAliases of getModelsWithAliases()) {
        if (modelWithAliases.async_model) {
            for (const alias of modelWithAliases.aliases) {
                asyncModelAliases[alias] = modelWithAliases.async_model;
            }
            asyncModelAliases[modelWithAliases.model.model_id] =
                modelWithAliases.async_model;
        }
    }
    return asyncModelAliases;
}
export function getModelAliases() {
    const modelAliases = {};
    for (const modelWithAliases of getModelsWithAliases()) {
        if (modelWithAliases.model) {
            for (const alias of modelWithAliases.aliases) {
                modelAliases[alias] = modelWithAliases.model;
            }
            modelAliases[modelWithAliases.model.model_id] = modelWithAliases.model;
        }
    }
    return modelAliases;
}
/** Get all registered models. */
export function getModels() {
    return getModelsWithAliases()
        .filter((mwa) => mwa.model)
        .map((mwa) => mwa.model);
}
/** Get all registered async models. */
export function getAsyncModels() {
    return getModelsWithAliases()
        .filter((mwa) => mwa.async_model)
        .map((mwa) => mwa.async_model);
}
/** Get an async model by name or alias. */
export function getAsyncModel(name = null) {
    const aliases = getAsyncModelAliases();
    const resolved = name || getDefaultModel();
    const model = aliases[resolved ?? ""];
    if (model) {
        return model;
    }
    // Does a sync model exist?
    let syncModel = null;
    try {
        syncModel = getModel(resolved, true);
    }
    catch (e) {
        if (!(e instanceof UnknownModelError))
            throw e;
    }
    if (syncModel) {
        throw new UnknownModelError("Unknown async model (sync model exists): " + resolved);
    }
    throw new UnknownModelError("Unknown model: " + resolved);
}
/** Get a model by name or alias. */
export function getModel(name = null, _skipAsync = false) {
    const aliases = getModelAliases();
    const resolved = name || getDefaultModel();
    const model = aliases[resolved ?? ""];
    if (model) {
        return model;
    }
    if (_skipAsync) {
        throw new UnknownModelError("Unknown model: " + resolved);
    }
    let asyncModel = null;
    try {
        asyncModel = getAsyncModel(resolved);
    }
    catch (e) {
        if (!(e instanceof UnknownModelError))
            throw e;
    }
    if (asyncModel) {
        throw new UnknownModelError("Unknown model (async model exists): " + resolved);
    }
    throw new UnknownModelError("Unknown model: " + resolved);
}
/** Set an alias to point to the specified model. */
export function setAlias(alias, modelIdOrAlias) {
    const p = path.join(userDir(), "aliases.json");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (!fs.existsSync(p)) {
        fs.writeFileSync(p, "{}\n");
    }
    let current;
    try {
        current = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    catch {
        // We're going to write a valid JSON file in a moment:
        current = {};
    }
    // Resolve modelIdOrAlias to a model_id
    let modelId;
    try {
        modelId = getModel(modelIdOrAlias).model_id;
    }
    catch (e) {
        if (!(e instanceof UnknownModelError))
            throw e;
        try {
            modelId = getEmbeddingModel(modelIdOrAlias).model_id;
        }
        catch (e2) {
            if (!(e2 instanceof UnknownModelError))
                throw e2;
            // Set the alias to the exact string they provided instead
            modelId = modelIdOrAlias;
        }
    }
    current[alias] = modelId;
    fs.writeFileSync(p, JSON.stringify(current, null, 4) + "\n");
}
/** Remove an alias. */
export function removeAlias(alias) {
    const p = path.join(userDir(), "aliases.json");
    if (!fs.existsSync(p)) {
        throw new Error("No aliases.json file exists");
    }
    let current;
    try {
        current = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    catch {
        throw new Error("aliases.json file is not valid JSON");
    }
    if (!(alias in current)) {
        throw new Error(`No such alias: ${alias}`);
    }
    delete current[alias];
    fs.writeFileSync(p, JSON.stringify(current, null, 4) + "\n");
}
/** struct.pack("<" + "f" * len(values), *values) */
export function encode(values) {
    const buf = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => buf.writeFloatLE(v, i * 4));
    return buf;
}
/** struct.unpack("<" + "f" * (len(binary) // 4), binary) */
export function decode(binary) {
    const buf = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
    const out = [];
    for (let i = 0; i + 4 <= buf.length; i += 4) {
        out.push(buf.readFloatLE(i));
    }
    return out;
}
export function cosineSimilarity(a, b) {
    let dotProduct = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        dotProduct += a[i] * b[i];
    }
    const magnitudeA = Math.sqrt(a.reduce((acc, x) => acc + x * x, 0));
    const magnitudeB = Math.sqrt(b.reduce((acc, x) => acc + x * x, 0));
    return dotProduct / (magnitudeA * magnitudeB);
}
// Wire the embeddings module's lazy index accessor.
registerIndex({
    getEmbeddingModel,
    encode,
    decode,
    cosineSimilarity,
});
