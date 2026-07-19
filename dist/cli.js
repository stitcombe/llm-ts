/**
 * Port of llm/cli.py — the llm command-line interface, built on the
 * mini-click layer in src/click/index.ts.
 *
 * Deviations from Python are documented in PORTING_NOTES.md; notably
 * --functions accepts JavaScript source (not Python), and
 * install/uninstall are not supported (npm handles plugins).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import * as yaml from "js-yaml";
import * as click from "./click/index.js";
import { ClickException, Choice as ClickChoice, CliRunner, Command, Group, Path as ClickPath, UsageError, argument, echo, flag, option, style, } from "./click/index.js";
import { Attachment, AsyncKeyModel, AsyncResponse, CancelToolCall, Conversation, AsyncConversation, KeyModel, Response, Tool, _BaseChainResponse, } from "./models.js";
import { UnknownModelError, encode, getAsyncModel, getEmbeddingModel, getEmbeddingModelAliases, getEmbeddingModelsWithAliases, getFragmentLoaders, getModel, getModelAliases, getModelsWithAliases, getPlugins, getTemplateLoaders, getTools, removeAlias, setAlias, userDir, } from "./index.js";
import { getDefaultEmbeddingModel, getDefaultModel, setDefaultEmbeddingModel, setDefaultModel, } from "./config.js";
import { Collection, CollectionDoesNotExist } from "./embeddings.js";
import { Template } from "./templates.js";
import { migrate } from "./migrations.js";
import { pm, loadPlugins } from "./plugins.js";
import { Database, NotFoundError } from "./sqliteUtils.js";
import { ensureFragment } from "./dbutils.js";
import { Fragment, extractFencedCodeBlock, findUnusedKey, hasPluginPrefix, instantiateFromSpec, makeSchemaId, maybeFencedCode, mimetypeFromPath, mimetypeFromString, multiSchema, outputRowsAsJson, schemaDsl, schemaSummary, tokenUsageString, truncateString, } from "./utils.js";
import { dumps } from "./pyjson.js";
import { ValidationError } from "./pydantic.js";
import { parseParams } from "./introspect.js";
const DEFAULT_TEMPLATE = "prompt: ";
const require_ = createRequire(import.meta.url);
const VERSION = require_("../package.json").version;
export class FragmentNotFound extends Error {
}
export class LoadTemplateError extends Error {
}
class AttachmentError extends Error {
}
// ------------------------------------------------------------- helpers
export async function displayStreamEvents(events, { showReasoning = true } = {}) {
    let wasReasoning = false;
    for await (const event of events) {
        if (event.type === "text") {
            if (wasReasoning && showReasoning) {
                echo("", { err: true });
                wasReasoning = false;
            }
            echo(event.chunk, { nl: false });
        }
        else if (event.type === "reasoning" && showReasoning) {
            wasReasoning = true;
            echo(style(event.chunk, { dim: true }), { nl: false, err: true });
        }
    }
}
function validateFragmentAlias(_ctx, _param, value) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(value))) {
        throw new click.BadParameter("Fragment alias must be alphanumeric");
    }
    return value;
}
export async function resolveFragments(db, fragments, allowAttachments = false) {
    function loadByAlias(fragment) {
        const rows = db.query(`
                select content, source from fragments
                left join fragment_aliases on fragments.id = fragment_aliases.fragment_id
                where alias = :alias or hash = :alias limit 1
                `, { alias: fragment });
        if (rows.length) {
            return [rows[0].content, rows[0].source];
        }
        return [null, null];
    }
    const resolved = [];
    for (const fragment of fragments) {
        if (fragment.startsWith("http://") || fragment.startsWith("https://")) {
            const response = await fetch(fragment, {
                redirect: "follow",
                headers: {
                    "User-Agent": `llm/${VERSION} (https://llm.datasette.io/)`,
                },
            });
            if (!response.ok) {
                throw new FragmentNotFound(`Could not load fragment ${fragment}: HTTP ${response.status}`);
            }
            resolved.push(new Fragment(await response.text(), fragment));
        }
        else if (fragment === "-") {
            resolved.push(new Fragment(click.getStreams().readStdin(), "-"));
        }
        else if (hasPluginPrefix(fragment)) {
            const colonIndex = fragment.indexOf(":");
            const prefix = fragment.slice(0, colonIndex);
            const rest = fragment.slice(colonIndex + 1);
            const loaders = getFragmentLoaders();
            if (!(prefix in loaders)) {
                throw new FragmentNotFound(`Unknown fragment prefix: ${prefix}`);
            }
            const loader = loaders[prefix];
            try {
                let result = await loader(rest);
                if (!Array.isArray(result)) {
                    result = [result];
                }
                if (!allowAttachments &&
                    result.some((r) => r instanceof Attachment)) {
                    throw new FragmentNotFound(`Fragment loader ${prefix} returned a disallowed attachment`);
                }
                resolved.push(...result);
            }
            catch (ex) {
                throw new FragmentNotFound(`Could not load fragment ${fragment}: ${ex.message}`);
            }
        }
        else {
            // Try from the DB
            const [content, source] = loadByAlias(fragment);
            if (content !== null) {
                resolved.push(new Fragment(content, source ?? ""));
            }
            else {
                // Now try path
                if (fs.existsSync(fragment)) {
                    resolved.push(new Fragment(fs.readFileSync(fragment, "utf-8"), path.resolve(fragment)));
                }
                else {
                    throw new FragmentNotFound(`Fragment '${fragment}' not found`);
                }
            }
        }
    }
    return resolved;
}
async function processFragmentsInChat(db, prompt) {
    const promptLines = [];
    const fragments = [];
    const attachments = [];
    for (const line of prompt.split("\n")) {
        if (line.startsWith("!fragment ")) {
            try {
                const fragmentStrs = line
                    .trim()
                    .replace(/^!fragment /, "")
                    .split(/\s+/);
                const fragmentsAndAttachments = await resolveFragments(db, fragmentStrs, true);
                fragments.push(...fragmentsAndAttachments.filter((f) => f instanceof Fragment));
                attachments.push(...fragmentsAndAttachments.filter((a) => a instanceof Attachment));
            }
            catch (ex) {
                if (ex instanceof FragmentNotFound) {
                    throw new ClickException(ex.message);
                }
                throw ex;
            }
        }
        else {
            promptLines.push(line);
        }
    }
    return [promptLines.join("\n"), fragments, attachments];
}
export async function resolveAttachment(value) {
    if (value === "-") {
        const content = click.getStreams().readStdinBuffer();
        const mimetype = mimetypeFromString(content);
        if (mimetype === null) {
            throw new AttachmentError("Could not determine mimetype of stdin");
        }
        return new Attachment({ type: mimetype, path: null, url: null, content });
    }
    if (value.includes("://")) {
        let mimetype;
        try {
            const response = await fetch(value, { method: "HEAD" });
            if (!response.ok) {
                throw new Error(`Client error '${response.status}' for url '${value}'`);
            }
            mimetype = response.headers.get("content-type");
        }
        catch (ex) {
            throw new AttachmentError(ex.message);
        }
        return new Attachment({
            type: mimetype,
            path: null,
            url: value,
            content: null,
        });
    }
    if (!fs.existsSync(value)) {
        throw new AttachmentError(`File ${value} does not exist`);
    }
    const resolvedPath = path.resolve(value);
    const mimetype = mimetypeFromPath(resolvedPath);
    if (mimetype === null) {
        throw new AttachmentError(`Could not determine mimetype of ${value}`);
    }
    return new Attachment({
        type: mimetype,
        path: resolvedPath,
        url: null,
        content: null,
    });
}
function resolveAttachmentWithType(value, mimetype) {
    if (value.includes("://")) {
        return new Attachment({ type: mimetype, url: value });
    }
    if (value === "-") {
        const content = click.getStreams().readStdinBuffer();
        return new Attachment({ type: mimetype, content });
    }
    if (!fs.existsSync(value)) {
        throw new click.BadParameter(`File ${value} does not exist`);
    }
    return new Attachment({ type: mimetype, path: path.resolve(value) });
}
function jsonValidator(objectName) {
    return (_ctx, _param, value) => {
        if (value === null || value === undefined)
            return value;
        try {
            const obj = JSON.parse(String(value));
            if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
                throw new click.BadParameter(`${objectName} must be a JSON object`);
            }
            return obj;
        }
        catch (e) {
            if (e instanceof click.BadParameter)
                throw e;
            throw new click.BadParameter(`${objectName} must be valid JSON`);
        }
    };
}
export function templateDir() {
    const dir = path.join(userDir(), "templates");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
export function logsDbPath() {
    return path.join(userDir(), "logs.db");
}
function renderErrors(errors) {
    const output = [];
    for (const error of errors) {
        output.push(error.loc.join(", "));
        output.push("  " + error.msg);
    }
    return output.join("\n");
}
function humanReadableSize(sizeBytes) {
    if (sizeBytes === 0)
        return "0B";
    const sizeNames = ["B", "KB", "MB", "GB", "TB", "PB", "EB", "ZB", "YB"];
    let i = 0;
    let size = sizeBytes;
    while (size >= 1024 && i < sizeNames.length - 1) {
        size /= 1024.0;
        i++;
    }
    return `${size.toFixed(2)}${sizeNames[i]}`;
}
export function logsOn() {
    return !fs.existsSync(path.join(userDir(), "logs-off"));
}
export function getAllModelOptions() {
    const p = path.join(userDir(), "model_options.json");
    if (!fs.existsSync(p))
        return {};
    try {
        return JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    catch {
        return {};
    }
}
export function getModelOptions(modelId) {
    return getAllModelOptions()[modelId] ?? {};
}
export function setModelOption(modelId, key, value) {
    const p = path.join(userDir(), "model_options.json");
    let options = {};
    if (fs.existsSync(p)) {
        try {
            options = JSON.parse(fs.readFileSync(p, "utf-8"));
        }
        catch {
            options = {};
        }
    }
    (options[modelId] ??= {})[key] = value;
    fs.writeFileSync(p, JSON.stringify(options, null, 2));
}
export function clearModelOption(modelId, key) {
    const p = path.join(userDir(), "model_options.json");
    if (!fs.existsSync(p))
        return;
    let options;
    try {
        options = JSON.parse(fs.readFileSync(p, "utf-8"));
    }
    catch {
        return;
    }
    if (!(modelId in options))
        return;
    if (key in options[modelId]) {
        delete options[modelId][key];
        if (!Object.keys(options[modelId]).length) {
            delete options[modelId];
        }
    }
    fs.writeFileSync(p, JSON.stringify(options, null, 2));
}
/**
 * js-yaml appends a trailing newline to a clip-chomped block scalar
 * even when the document has no final line break; PyYAML (per spec)
 * does not. Strip that extra newline from the value the document ends
 * with so template prompts round-trip like Python.
 */
function fixClipChomping(loaded, content) {
    if (content.endsWith("\n"))
        return;
    const lastLine = (content.split("\n").pop() ?? "").trimStart();
    if (!lastLine)
        return;
    for (const [key, value] of Object.entries(loaded)) {
        if (typeof value === "string" && value.endsWith(lastLine + "\n")) {
            loaded[key] = value.slice(0, -1);
        }
    }
}
function parseYamlTemplate(name, content) {
    let loaded;
    try {
        loaded = yaml.load(content);
    }
    catch (ex) {
        throw new LoadTemplateError(`Invalid YAML: ${ex.message}`);
    }
    if (typeof loaded === "string") {
        return new Template({ name, prompt: loaded });
    }
    if (loaded && typeof loaded === "object" && !Array.isArray(loaded)) {
        fixClipChomping(loaded, content);
    }
    const data = { ...loaded, name };
    try {
        return new Template(data);
    }
    catch (ex) {
        if (ex instanceof ValidationError) {
            let msg = "A validation error occurred:\n";
            msg += renderErrors(ex.errors());
            throw new LoadTemplateError(msg);
        }
        throw ex;
    }
}
export async function loadTemplate(name) {
    if (name.startsWith("https://") || name.startsWith("http://")) {
        const response = await fetch(name);
        if (!response.ok) {
            throw new LoadTemplateError(`Could not load template ${name}: HTTP ${response.status}`);
        }
        return parseYamlTemplate(name, await response.text());
    }
    if (hasPluginPrefix(name) && !fs.existsSync(name)) {
        const colonIndex = name.indexOf(":");
        const prefix = name.slice(0, colonIndex);
        const rest = name.slice(colonIndex + 1);
        const loaders = getTemplateLoaders();
        if (!(prefix in loaders)) {
            throw new LoadTemplateError(`Unknown template prefix: ${prefix}`);
        }
        const loader = loaders[prefix];
        try {
            return await loader(rest);
        }
        catch (ex) {
            throw new LoadTemplateError(`Could not load template ${name}: ${ex.message}`);
        }
    }
    let templatePath;
    if (fs.existsSync(name)) {
        templatePath = name;
    }
    else {
        templatePath = path.join(templateDir(), `${name}.yaml`);
    }
    if (!fs.existsSync(templatePath)) {
        throw new LoadTemplateError(`Invalid template: ${name}`);
    }
    const content = fs.readFileSync(templatePath, "utf-8");
    const templateObj = parseYamlTemplate(name, content);
    // We trust functions here because they came from the filesystem
    templateObj._functions_is_trusted = true;
    return templateObj;
}
/**
 * Treat all functions defined in the code as tools. The Python version
 * executes Python source; this port evaluates JavaScript source.
 */
function toolsFromCode(codeOrPath) {
    let code = codeOrPath;
    if (!codeOrPath.includes("\n") &&
        (codeOrPath.endsWith(".js") || codeOrPath.endsWith(".py"))) {
        try {
            code = fs.readFileSync(codeOrPath, "utf-8");
        }
        catch {
            throw new ClickException(`File not found: ${codeOrPath}`);
        }
    }
    // Collect top-level function names declared in the code
    const names = new Set();
    for (const match of code.matchAll(/(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
        names.add(match[1]);
    }
    for (const match of code.matchAll(/(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\(|function)/g)) {
        names.add(match[1]);
    }
    const tools = [];
    let namespace;
    try {
        const factory = new Function(`${code}\nreturn { ${[...names].join(", ")} };`);
        namespace = factory();
    }
    catch (ex) {
        throw new ClickException(`Error in --functions definition: ${ex.message}`);
    }
    for (const [name, value] of Object.entries(namespace)) {
        if (typeof value === "function" && !name.startsWith("_")) {
            tools.push(Tool.function(value));
        }
    }
    return tools;
}
function debugToolCall(_tool, toolCall, toolResult) {
    echo(style(`\nTool call: ${toolCall.name}(${dumps(toolCall.arguments)})`, {
        fg: "yellow",
        bold: true,
    }), { err: true });
    let output = "";
    let attachments = "";
    if (toolResult.attachments.length) {
        attachments += "\nAttachments:\n";
        for (const attachment of toolResult.attachments) {
            attachments += `  ${attachment.toString()}\n`;
        }
    }
    try {
        output = dumps(JSON.parse(toolResult.output), { indent: 2 });
    }
    catch {
        output = toolResult.output;
    }
    output += attachments;
    echo(style(output
        .split("\n")
        .map((l) => (l.trim() ? "  " + l : l))
        .join("\n") + (toolResult.exception ? "" : "\n"), { fg: "green", bold: true }), { err: true });
    if (toolResult.exception) {
        echo(style(`  Exception: ${toolResult.exception.message}`, {
            fg: "red",
            bold: true,
        }), { err: true });
    }
}
function approveToolCall(_tool, toolCall) {
    echo(style(`Tool call: ${toolCall.name}(${dumps(toolCall.arguments)})`, {
        fg: "yellow",
        bold: true,
    }), { err: true });
    if (!click.confirm("Approve tool call?")) {
        throw new CancelToolCall("User cancelled tool call");
    }
}
function gatherTools(toolSpecs, pythonTools) {
    const tools = [];
    if (pythonTools.length) {
        for (const codeOrPath of pythonTools) {
            tools.push(...toolsFromCode(codeOrPath));
        }
    }
    const registeredTools = getTools();
    const registeredClasses = {};
    for (const [key, value] of Object.entries(registeredTools)) {
        if (typeof value === "function") {
            registeredClasses[key] = value;
        }
    }
    const badTools = toolSpecs.filter((tool) => !(tool.split("(")[0] in registeredTools));
    if (badTools.length) {
        throw new ClickException(`Tool(s) ${badTools.join(", ")} not found. Available tools: ${Object.keys(registeredTools).join(", ")}`);
    }
    for (const toolSpec of toolSpecs) {
        if (toolSpec[0] !== toolSpec[0].toUpperCase()) {
            // It's a function
            tools.push(registeredTools[toolSpec]);
        }
        else {
            // It's a class
            tools.push(instantiateFromSpec(registeredClasses, toolSpec));
        }
    }
    return tools;
}
function getConversationTools(conversation, tools) {
    if (conversation && !tools.length && conversation.responses.length) {
        const initialTools = conversation.responses[0].prompt.tools;
        if (initialTools.length) {
            return initialTools.filter((t) => t.plugin).map((t) => t.name);
        }
    }
    return null;
}
export async function loadConversation(conversationId, async_ = false, database = null) {
    const logPath = database ?? logsDbPath();
    const db = new Database(logPath);
    migrate(db);
    let cid = conversationId;
    if (cid === null) {
        const matches = db
            .table("conversations")
            .rowsWhere(undefined, undefined, { order_by: "id desc", limit: 1 });
        if (matches.length) {
            cid = matches[0].id;
        }
        else {
            return null;
        }
    }
    let row;
    try {
        row = db.table("conversations").get(cid);
    }
    catch (e) {
        if (e instanceof NotFoundError) {
            throw new ClickException(`No conversation found with id=${cid}`);
        }
        throw e;
    }
    const conversation = async_
        ? await AsyncConversation.fromRow(row)
        : await Conversation.fromRow(row);
    for (const responseRow of db
        .table("responses")
        .rowsWhere("conversation_id = ?", [cid], { order_by: "id" })) {
        const responseObj = async_
            ? await AsyncResponse.fromRow(db, responseRow)
            : await Response.fromRow(db, responseRow);
        if (conversation.responses.length) {
            const previousResponse = conversation.responses[conversation.responses.length - 1];
            // Rebuild the full chain so follow-up prompts satisfy the
            // Prompt.messages invariant.
            responseObj.prompt._explicit_messages = [
                ...previousResponse.prompt.messages,
                ...previousResponse.messagesNow(),
                ...responseObj.prompt.messages,
            ];
        }
        conversation.responses.push(responseObj);
    }
    return conversation;
}
function resolveSchemaInput(db, schemaInput, loadTemplateFn) {
    // schema_input might be JSON or a filepath or an ID or t:name
    if (!schemaInput) {
        return null;
    }
    if (schemaInput.trim().startsWith("t:")) {
        const name = schemaInput.trim().slice(2);
        return (async () => {
            let template;
            try {
                template = await loadTemplateFn(name);
            }
            catch {
                throw new ClickException(`Invalid template: ${name}`);
            }
            if (!template.schema_object) {
                throw new ClickException(`Template '${name}' has no schema`);
            }
            return template.schema_object;
        })();
    }
    if (schemaInput.trim().startsWith("{")) {
        try {
            return JSON.parse(schemaInput);
        }
        catch {
            // fall through
        }
    }
    if (schemaInput.trim().includes(" ") || schemaInput.includes(",")) {
        // Treat it as schema DSL
        return schemaDsl(schemaInput);
    }
    // Is it a file on disk?
    if (fs.existsSync(schemaInput)) {
        try {
            return JSON.parse(fs.readFileSync(schemaInput, "utf-8"));
        }
        catch {
            throw new ClickException("Schema file contained invalid JSON");
        }
    }
    // Last attempt: is it an ID in the DB?
    try {
        const row = db.table("schemas").get(schemaInput);
        return JSON.parse(row.content);
    }
    catch {
        throw new click.BadParameter("Invalid schema");
    }
}
const TYPE_LOOKUP = {
    number: "float",
    integer: "int",
    string: "str",
    object: "dict",
};
function modelMatchesIdOrAlias(modelWithAliases, modelIds) {
    const idsAndAliases = new Set([
        ...(modelWithAliases.model ? [modelWithAliases.model.model_id] : []),
        ...modelWithAliases.aliases,
    ]);
    return [...modelIds].some((id) => idsAndAliases.has(id));
}
function wrapText(text, width) {
    const words = text.split(/\s+/).filter(Boolean);
    const lines = [];
    let line = "";
    for (const word of words) {
        if (line && (line + " " + word).length > width) {
            lines.push(line);
            line = word;
        }
        else {
            line = line ? line + " " + word : word;
        }
    }
    if (line)
        lines.push(line);
    return lines;
}
function renderModelWithAliases(modelWithAliases, { options = false, async_ = false, modelsThatHaveShownOptions = null, } = {}) {
    const extraInfo = [];
    if (modelWithAliases.aliases.length) {
        extraInfo.push(`aliases: ${modelWithAliases.aliases.join(", ")}`);
    }
    const model = !async_ ? modelWithAliases.model : modelWithAliases.async_model;
    let output = String(model);
    if (extraInfo.length) {
        output += ` (${extraInfo.join(", ")})`;
    }
    const optionsSchema = model.Options.modelJsonSchema();
    const properties = optionsSchema.properties;
    if (options && Object.keys(properties).length) {
        output += "\n  Options:";
        for (const [name, field] of Object.entries(properties)) {
            let anyOf = field.anyOf;
            if (anyOf === undefined) {
                anyOf = [{ type: field.type ?? "str" }];
            }
            const types = anyOf
                .filter((item) => item.type !== "null")
                .map((item) => TYPE_LOOKUP[item.type] ?? item.type ?? "str")
                .join(", ");
            const bits = ["\n    ", name, ": ", types];
            const description = field.description ?? "";
            if (description &&
                modelsThatHaveShownOptions !== null &&
                !modelsThatHaveShownOptions.has(model.constructor)) {
                const wrapped = wrapText(description, 70);
                bits.push("\n      ");
                bits.push(wrapped.join("\n      "));
            }
            output += bits.join("");
        }
        if (modelsThatHaveShownOptions !== null) {
            modelsThatHaveShownOptions.add(model.constructor);
        }
    }
    if (options && model.attachment_types && model.attachment_types.size) {
        const attachmentTypes = [...model.attachment_types].sort().join(", ");
        const wrapped = wrapText(attachmentTypes, 66)
            .map((l) => "    " + l)
            .join("\n");
        output += `\n  Attachment types:\n${wrapped}`;
    }
    const features = [
        ...(model.can_stream ? ["streaming"] : []),
        ...(model.supports_schema ? ["schemas"] : []),
        ...(model.supports_tools ? ["tools"] : []),
        ...(modelWithAliases.async_model ? ["async"] : []),
    ];
    if (options && features.length) {
        output += `\n  Features:\n${features
            .map((feature) => `  - ${feature}`)
            .join("\n")}`;
    }
    if (options && model.needs_key) {
        output += "\n  Keys:";
        output += `\n    key: ${model.needs_key}`;
        if (model.key_env_var) {
            output += `\n    env_var: ${model.key_env_var}`;
        }
    }
    return output;
}
function renderModelWithOptions(modelId, { async_ = false } = {}) {
    for (const modelWithAliases of getModelsWithAliases()) {
        if (modelMatchesIdOrAlias(modelWithAliases, [modelId])) {
            return renderModelWithAliases(modelWithAliases, {
                options: true,
                async_,
                modelsThatHaveShownOptions: new Set(),
            });
        }
    }
    throw new ClickException(`'${modelId}' is not a known model`);
}
function displayTruncated(text) {
    const consoleWidth = process.stdout.columns || 80;
    if (text.length > consoleWidth) {
        return text.slice(0, consoleWidth - 3) + "...";
    }
    return text;
}
function optionsFromValidated(model, options) {
    const validated = {};
    try {
        const optionsModel = new model.Options(Object.fromEntries(options));
        for (const [key, value] of optionsModel) {
            if (value !== null && value !== undefined) {
                validated[key] = value;
            }
        }
    }
    catch (ex) {
        if (ex instanceof ValidationError) {
            throw new ClickException(renderErrors(ex.errors()));
        }
        throw ex;
    }
    return validated;
}
function pyYamlDump(data, opts = {}) {
    // js-yaml dump with settings closest to PyYAML's defaults
    return yaml.dump(data, {
        noRefs: true,
        lineWidth: opts.width ?? 80,
        sortKeys: opts.sortKeys ?? true,
        quotingType: "'",
        forceQuotes: false,
        // PyYAML does not indent block sequences under a mapping key
        noArrayIndent: true,
        ...opts,
    });
}
// -------------------------------------------------------------- build CLI
export const cli = new Group({
    name: "cli",
    version: VERSION,
    versionName: "cli",
    defaultCommand: "prompt",
    defaultIfNoArgs: true,
    help: `Access Large Language Models from the command-line

    Documentation: https://llm.datasette.io/

    LLM can run models from many different providers. Consult the
    plugin directory for a list of available models:

    https://llm.datasette.io/en/stable/plugins/directory.html

    To get started with OpenAI, obtain an API key from them and:

        $ llm keys set openai
        Enter key: ...

    Then execute a prompt like this:

        llm 'Five outrageous names for a pet pelican'

    For a full list of prompting options run:

        llm prompt --help`,
});
// ------------------------------------------------------------ prompt cmd
const promptOptions = [
    option(["-s", "--system"], { help: "System prompt to use" }),
    option(["-m", "--model"], {
        name: "model_id",
        help: "Model to use",
        envvar: "LLM_MODEL",
    }),
    option(["-d", "--database"], {
        type: new ClickPath({ dirOkay: false }),
        help: "Path to log database",
    }),
    option(["-q", "--query"], {
        name: "queries",
        multiple: true,
        help: "Use first model matching these strings",
    }),
    option(["-a", "--attachment"], {
        name: "attachments",
        multiple: true,
        help: "Attachment path or URL or -",
    }),
    option(["--at", "--attachment-type"], {
        name: "attachment_types",
        nargs: 2,
        multiple: true,
        help: "Attachment with explicit mimetype,\n--at image.jpg image/jpeg",
    }),
    option(["-T", "--tool"], {
        name: "tools",
        multiple: true,
        help: "Name of a tool to make available to the model",
    }),
    option(["--functions"], {
        name: "python_tools",
        multiple: true,
        help: "Python code block or file path defining functions to register as tools",
    }),
    flag(["--td", "--tools-debug"], {
        name: "tools_debug",
        help: "Show full details of tool executions",
        envvar: "LLM_TOOLS_DEBUG",
    }),
    flag(["--ta", "--tools-approve"], {
        name: "tools_approve",
        help: "Manually approve every tool execution",
    }),
    option(["--cl", "--chain-limit"], {
        name: "chain_limit",
        type: "int",
        default: 5,
        help: "How many chained tool responses to allow, default 5, set 0 for unlimited",
    }),
    option(["-o", "--option"], {
        name: "options",
        nargs: 2,
        multiple: true,
        help: "key/value options for the model",
    }),
    flag(["--options"], {
        name: "show_model_options",
        help: "Show options for the selected model",
    }),
    option(["--schema"], {
        name: "schema_input",
        help: "JSON schema, filepath or ID",
    }),
    option(["--schema-multi"], {
        help: "JSON schema to use for multiple results",
    }),
    option(["-f", "--fragment"], {
        name: "fragments",
        multiple: true,
        help: "Fragment (alias, URL, hash or file path) to add to the prompt",
    }),
    option(["--sf", "--system-fragment"], {
        name: "system_fragments",
        multiple: true,
        help: "Fragment to add to system prompt",
    }),
    option(["-t", "--template"], { help: "Template to use" }),
    option(["-p", "--param"], {
        multiple: true,
        nargs: 2,
        help: "Parameters for template",
    }),
    flag(["--no-stream"], { help: "Do not stream output" }),
    flag(["-n", "--no-log"], { help: "Don't log to database" }),
    flag(["--log"], { help: "Log prompt and response to the database" }),
    flag(["-R", "--hide-reasoning"], { help: "Hide reasoning output" }),
    flag(["-c", "--continue"], {
        name: "_continue",
        help: "Continue the most recent conversation.",
    }),
    option(["--cid", "--conversation"], {
        name: "conversation_id",
        help: "Continue the conversation with the given ID.",
    }),
    option(["--key"], { help: "API key to use" }),
    option(["--save"], { help: "Save prompt with this template name" }),
    flag(["--async"], { name: "async_", help: "Run prompt asynchronously" }),
    flag(["-u", "--usage"], { help: "Show token usage" }),
    flag(["-x", "--extract"], { help: "Extract first fenced code block" }),
    flag(["--xl", "--extract-last"], {
        name: "extract_last",
        help: "Extract last fenced code block",
    }),
];
cli.addCommand(new Command({
    name: "prompt",
    help: `Execute a prompt

    Documentation: https://llm.datasette.io/en/stable/usage.html

    Examples:

        llm 'Capital of France?'
        llm 'Capital of France?' -m gpt-4o
        llm 'Capital of France?' -s 'answer in Spanish'

    Multi-modal models can be called with attachments like this:

        llm 'Extract text from this image' -a image.jpg
        llm 'Describe' -a https://static.simonwillison.net/static/2024/pelicans.jpg
        cat image | llm 'describe image' -a -
        # With an explicit mimetype:
        cat image | llm 'describe image' --at - image/jpeg

    The -x/--extract option returns just the content of the first \`\`\` fenced code
    block, if one is present. If none are present it returns the full response.

        llm 'JavaScript function for reversing a string' -x`,
    arguments: [argument("prompt", { required: false })],
    options: promptOptions,
    handler: async (params) => {
        let { prompt, system, model_id, database, queries, attachments: attachmentValues, attachment_types: attachmentTypePairs, tools, python_tools, tools_debug, tools_approve, chain_limit, options, show_model_options, schema_input, schema_multi, fragments, system_fragments, template, param, no_stream, no_log, log, hide_reasoning, _continue, conversation_id, key, save, async_, usage, extract, extract_last, } = params;
        if (log && no_log) {
            throw new ClickException("--log and --no-log are mutually exclusive");
        }
        // Resolve attachments eagerly (Python did this via click types)
        let attachments = [];
        for (const value of attachmentValues) {
            try {
                attachments.push(await resolveAttachment(value));
            }
            catch (ex) {
                if (ex instanceof AttachmentError) {
                    throw new click.BadParameter(ex.message, "'-a' / '--attachment'");
                }
                throw ex;
            }
        }
        let attachment_types = attachmentTypePairs.map(([value, mimetype]) => resolveAttachmentWithType(value, mimetype));
        if (queries.length && !model_id) {
            // Use -q options to find model with shortest model_id
            const matches = [];
            for (const modelWithAliases of getModelsWithAliases()) {
                if (queries.every((q) => modelWithAliases.matches(q))) {
                    matches.push(modelWithAliases.model.model_id);
                }
            }
            if (!matches.length) {
                throw new ClickException(`No model found matching queries ${queries.join(", ")}`);
            }
            matches.sort((a, b) => a.length - b.length);
            model_id = matches[0];
        }
        if (show_model_options && !(conversation_id || _continue || template)) {
            model_id = model_id || getDefaultModel();
            try {
                if (async_) {
                    getAsyncModel(model_id);
                }
                else {
                    getModel(model_id);
                }
            }
            catch (ex) {
                if (ex instanceof UnknownModelError) {
                    throw new ClickException(ex.message);
                }
                throw ex;
            }
            echo(renderModelWithOptions(model_id, { async_ }));
            return;
        }
        const logPath = database ? String(database) : logsDbPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const db = new Database(logPath);
        migrate(db);
        if (schema_multi) {
            schema_input = schema_multi;
        }
        let schema = await resolveSchemaInput(db, schema_input, loadTemplate);
        if (schema_multi) {
            schema = multiSchema(schema);
        }
        const readPrompt = () => {
            // Is there extra prompt available on stdin?
            let stdinPrompt = null;
            if (!click.getStreams().stdinIsTty()) {
                stdinPrompt = click.getStreams().readStdin();
            }
            if (stdinPrompt) {
                const bits = [stdinPrompt];
                if (prompt) {
                    bits.push(prompt);
                }
                prompt = bits.join(" ");
            }
            if ((prompt === null || prompt === undefined) &&
                !save &&
                click.getStreams().stdinIsTty() &&
                !attachments.length &&
                !attachment_types.length &&
                !schema &&
                !fragments.length) {
                prompt = click.getStreams().readStdin();
            }
            return prompt;
        };
        if (save) {
            const disallowedOptions = [];
            for (const [optionName, v] of [
                ["--template", template],
                ["--continue", _continue],
                ["--cid", conversation_id],
            ]) {
                if (v) {
                    disallowedOptions.push(optionName);
                }
            }
            if (disallowedOptions.length) {
                throw new ClickException(`--save cannot be used with ${disallowedOptions.join(", ")}`);
            }
            const savePath = path.join(templateDir(), `${save}.yaml`);
            const toSave = {};
            if (model_id) {
                const modelAliases = getModelAliases();
                if (!(model_id in modelAliases)) {
                    throw new ClickException(`'${model_id}' is not a known model`);
                }
                toSave.model = modelAliases[model_id].model_id;
            }
            prompt = readPrompt();
            if (prompt)
                toSave.prompt = prompt;
            if (system)
                toSave.system = system;
            if (param.length) {
                toSave.defaults = Object.fromEntries(param);
            }
            if (extract)
                toSave.extract = true;
            if (extract_last)
                toSave.extract_last = true;
            if (schema)
                toSave.schema_object = schema;
            if (fragments.length)
                toSave.fragments = [...fragments];
            if (system_fragments.length) {
                toSave.system_fragments = [...system_fragments];
            }
            if (python_tools.length) {
                toSave.functions = python_tools.join("\n\n");
            }
            if (tools.length)
                toSave.tools = [...tools];
            if (attachments.length) {
                toSave.attachments = attachments
                    .filter((a) => a.path || a.url)
                    .map((a) => a.path || a.url);
            }
            if (attachment_types.length) {
                toSave.attachment_types = attachment_types
                    .filter((a) => a.path || a.url)
                    .map((a) => ({ type: a.type, value: a.path || a.url }));
            }
            if (options.length) {
                const model = getModel(model_id || getDefaultModel());
                try {
                    const optionsModel = new model.Options(Object.fromEntries(options));
                    const dumped = {};
                    for (const [k, v] of Object.entries(optionsModel.modelDump())) {
                        if (v !== null && v !== undefined)
                            dumped[k] = v;
                    }
                    toSave.options = dumped;
                }
                catch (ex) {
                    if (ex instanceof ValidationError) {
                        throw new ClickException(renderErrors(ex.errors()));
                    }
                    throw ex;
                }
            }
            fs.writeFileSync(savePath, pyYamlDump(toSave, { sortKeys: false, indent: 4 }));
            return;
        }
        let templateObj = null;
        if (template) {
            const params_ = Object.fromEntries(param);
            try {
                templateObj = await loadTemplate(template);
            }
            catch (ex) {
                if (ex instanceof LoadTemplateError) {
                    throw new ClickException(ex.message);
                }
                throw ex;
            }
            if (!(extract || extract_last)) {
                extract = templateObj.extract;
                extract_last = templateObj.extract_last;
            }
            if (templateObj.fragments) {
                fragments = [...templateObj.fragments, ...fragments];
            }
            if (templateObj.system_fragments) {
                system_fragments = [
                    ...templateObj.system_fragments,
                    ...system_fragments,
                ];
            }
            if (templateObj.schema_object) {
                schema = templateObj.schema_object;
            }
            if (templateObj.tools) {
                tools = [...templateObj.tools, ...tools];
            }
            if (templateObj.functions && templateObj._functions_is_trusted) {
                python_tools = [templateObj.functions, ...python_tools];
            }
            let input_ = "";
            if (templateObj.options) {
                options = [...options];
                const specifiedOptions = Object.fromEntries(options);
                for (const [optionName, optionValue] of Object.entries(templateObj.options)) {
                    if (!(optionName in specifiedOptions)) {
                        options.push([
                            optionName,
                            optionValue,
                        ]);
                    }
                }
            }
            const usesInput = templateObj.vars().has("input");
            if (usesInput) {
                input_ = readPrompt() ?? "";
            }
            try {
                const [templatePrompt, templateSystem] = templateObj.evaluate(input_, params_);
                if (templatePrompt) {
                    if (prompt && !usesInput) {
                        prompt = templatePrompt + "\n" + prompt;
                    }
                    else {
                        prompt = templatePrompt;
                    }
                }
                if (templateSystem && !system) {
                    system = templateSystem;
                }
            }
            catch (ex) {
                if (ex instanceof Template.MissingVariables) {
                    throw new ClickException(ex.message);
                }
                throw ex;
            }
            if (!model_id && templateObj.model) {
                model_id = templateObj.model;
            }
            if (templateObj.attachments) {
                const resolved = [];
                for (const a of templateObj.attachments) {
                    try {
                        resolved.push(await resolveAttachment(a));
                    }
                    catch (ex) {
                        if (ex instanceof AttachmentError) {
                            throw new ClickException(ex.message);
                        }
                        throw ex;
                    }
                }
                attachments = [...resolved, ...attachments];
            }
            if (templateObj.attachment_types) {
                attachment_types = [
                    ...templateObj.attachment_types.map((at) => resolveAttachmentWithType(at.value, at.type)),
                    ...attachment_types,
                ];
            }
        }
        if (extract || extract_last) {
            no_stream = true;
        }
        let conversation = null;
        if (conversation_id || _continue) {
            try {
                conversation = await loadConversation(conversation_id ?? null, async_, database);
            }
            catch (ex) {
                if (ex instanceof UnknownModelError) {
                    throw new ClickException(ex.message);
                }
                throw ex;
            }
        }
        const conversationTools = getConversationTools(conversation, tools);
        if (conversationTools) {
            tools = conversationTools;
        }
        // Figure out which model we are using
        if (!model_id) {
            if (conversation) {
                model_id = conversation.model.model_id;
            }
            else {
                model_id = getDefaultModel();
            }
        }
        // Now resolve the model
        let model;
        try {
            model = async_ ? getAsyncModel(model_id) : getModel(model_id);
        }
        catch (ex) {
            if (ex instanceof UnknownModelError) {
                throw new ClickException(ex.message);
            }
            throw ex;
        }
        if (show_model_options) {
            echo(renderModelWithOptions(model_id, { async_ }));
            return;
        }
        if (conversation === null &&
            (tools.length || python_tools.length)) {
            conversation = model.conversation();
        }
        if (conversation) {
            // To ensure it can see the key
            conversation.model = model;
        }
        // Validate options
        let validatedOptions = {};
        if (options.length) {
            validatedOptions = optionsFromValidated(model, options);
        }
        // Add on any default model options
        const defaultOptions = getModelOptions(model.model_id);
        for (const [key_, value] of Object.entries(defaultOptions)) {
            if (!(key_ in validatedOptions)) {
                validatedOptions[key_] = value;
            }
        }
        const kwargs = {};
        let resolvedAttachments = [...attachments, ...attachment_types];
        const shouldStream = model.can_stream && !no_stream;
        if (!shouldStream) {
            kwargs.stream = false;
        }
        if (model instanceof KeyModel || model instanceof AsyncKeyModel) {
            kwargs.key = key;
        }
        prompt = readPrompt();
        let resolvedFragments;
        let resolvedSystemFragments;
        try {
            const fragmentsAndAttachments = await resolveFragments(db, fragments, true);
            resolvedFragments = fragmentsAndAttachments.filter((f) => f instanceof Fragment);
            resolvedAttachments = [
                ...resolvedAttachments,
                ...fragmentsAndAttachments.filter((a) => a instanceof Attachment),
            ];
            resolvedSystemFragments = await resolveFragments(db, system_fragments);
        }
        catch (ex) {
            if (ex instanceof FragmentNotFound) {
                throw new ClickException(ex.message);
            }
            throw ex;
        }
        let promptTarget = model;
        let promptMethodName = "prompt";
        if (conversation) {
            promptTarget = conversation;
        }
        const toolImplementations = gatherTools(tools, python_tools);
        if (toolImplementations.length) {
            promptTarget = conversation;
            promptMethodName = "chain";
            kwargs.options = validatedOptions;
            kwargs.chain_limit = chain_limit;
            if (tools_debug) {
                kwargs.after_call = debugToolCall;
            }
            if (tools_approve) {
                kwargs.before_call = approveToolCall;
            }
            kwargs.tools = toolImplementations;
        }
        else {
            Object.assign(kwargs, validatedOptions);
        }
        if (hide_reasoning) {
            kwargs.hide_reasoning = true;
        }
        let response = null;
        try {
            response = promptTarget[promptMethodName](prompt, {
                fragments: resolvedFragments,
                attachments: resolvedAttachments,
                system,
                schema,
                system_fragments: resolvedSystemFragments,
                ...kwargs,
            });
            if (shouldStream) {
                const events = typeof response.astream_events === "function"
                    ? response.astream_events()
                    : typeof response.streamEventsAsync === "function"
                        ? response.streamEventsAsync()
                        : response.stream_events();
                await displayStreamEvents(events, {
                    showReasoning: !hide_reasoning,
                });
                echo("");
            }
            else {
                let text = typeof response.textAsync === "function"
                    ? await response.textAsync()
                    : await response.text();
                if (extract || extract_last) {
                    text = extractFencedCodeBlock(text, Boolean(extract_last)) ?? text;
                }
                echo(text);
            }
        }
        catch (ex) {
            // ValueError / NotImplementedError analog: our model layer throws
            // plain Errors for those cases.
            if (ex instanceof ClickException ||
                ex instanceof click.Exit ||
                ex instanceof click.Abort) {
                throw ex;
            }
            const { testState } = await import("./plugins.js");
            if (testState.calledFromTest || process.env.LLM_RAISE_ERRORS) {
                // In pytest mode only ValueError/NotImplementedError are
                // converted; our error classes don't distinguish, so convert
                // "expected" model errors and re-raise everything else.
                if (ex instanceof Error &&
                    (ex.name === "Error" ||
                        ex.name === "ModelError" ||
                        ex.name === "NeedsKeyException" ||
                        ex.name === "APIError")) {
                    throw new ClickException(ex.message);
                }
                throw ex;
            }
            throw new ClickException(ex.message);
        }
        if (usage) {
            const responses = response instanceof _BaseChainResponse
                ? response._responses
                : [response];
            for (const responseObject of responses) {
                echo(style(`Token usage: ${responseObject.token_usage()}`, {
                    fg: "yellow",
                    bold: true,
                }), { err: true });
            }
        }
        // Log responses to the database
        if ((logsOn() || log) && !no_log) {
            let toLog = response;
            if (toLog instanceof AsyncResponse) {
                toLog = await toLog.toSyncResponse();
            }
            await toLog.logToDb(db);
        }
    },
}));
// -------------------------------------------------------------- chat cmd
cli.addCommand(new Command({
    name: "chat",
    help: "Hold an ongoing chat with a model.",
    options: [
        option(["-s", "--system"], { help: "System prompt to use" }),
        option(["-m", "--model"], {
            name: "model_id",
            help: "Model to use",
            envvar: "LLM_MODEL",
        }),
        flag(["-c", "--continue"], {
            name: "_continue",
            help: "Continue the most recent conversation.",
        }),
        option(["--cid", "--conversation"], {
            name: "conversation_id",
            help: "Continue the conversation with the given ID.",
        }),
        option(["-f", "--fragment"], {
            name: "fragments",
            multiple: true,
            help: "Fragment (alias, URL, hash or file path) to add to the prompt",
        }),
        option(["--sf", "--system-fragment"], {
            name: "system_fragments",
            multiple: true,
            help: "Fragment to add to system prompt",
        }),
        option(["-t", "--template"], { help: "Template to use" }),
        option(["-p", "--param"], {
            multiple: true,
            nargs: 2,
            help: "Parameters for template",
        }),
        option(["-o", "--option"], {
            name: "options",
            nargs: 2,
            multiple: true,
            help: "key/value options for the model",
        }),
        option(["-d", "--database"], {
            type: new ClickPath({ dirOkay: false }),
            help: "Path to log database",
        }),
        flag(["--no-stream"], { help: "Do not stream output" }),
        flag(["-R", "--hide-reasoning"], { help: "Hide reasoning output" }),
        option(["--key"], { help: "API key to use" }),
        option(["-T", "--tool"], {
            name: "tools",
            multiple: true,
            help: "Name of a tool to make available to the model",
        }),
        option(["--functions"], {
            name: "python_tools",
            multiple: true,
            help: "Python code block or file path defining functions to register as tools",
        }),
        flag(["--td", "--tools-debug"], {
            name: "tools_debug",
            help: "Show full details of tool executions",
            envvar: "LLM_TOOLS_DEBUG",
        }),
        flag(["--ta", "--tools-approve"], {
            name: "tools_approve",
            help: "Manually approve every tool execution",
        }),
        option(["--cl", "--chain-limit"], {
            name: "chain_limit",
            type: "int",
            default: 5,
            help: "How many chained tool responses to allow, default 5, set 0 for unlimited",
        }),
    ],
    handler: async (params) => {
        let { system, model_id, _continue, conversation_id, fragments, system_fragments, template, param, options, no_stream, hide_reasoning, key, database, tools, python_tools, tools_debug, tools_approve, chain_limit, } = params;
        const logPath = database ? String(database) : logsDbPath();
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        const db = new Database(logPath);
        migrate(db);
        let conversation = null;
        if (conversation_id || _continue) {
            conversation = (await loadConversation(conversation_id ?? null, false, database));
        }
        const conversationTools = getConversationTools(conversation, tools);
        if (conversationTools) {
            tools = conversationTools;
        }
        let templateObj = null;
        let params_ = {};
        if (template) {
            params_ = Object.fromEntries(param);
            try {
                templateObj = await loadTemplate(template);
            }
            catch (ex) {
                if (ex instanceof LoadTemplateError) {
                    throw new ClickException(ex.message);
                }
                throw ex;
            }
            if (!model_id && templateObj.model) {
                model_id = templateObj.model;
            }
            if (templateObj.tools) {
                tools = [...templateObj.tools, ...tools];
            }
            if (templateObj.functions && templateObj._functions_is_trusted) {
                python_tools = [templateObj.functions, ...python_tools];
            }
        }
        if (!model_id) {
            if (conversation) {
                model_id = conversation.model.model_id;
            }
            else {
                model_id = getDefaultModel();
            }
        }
        let model;
        try {
            model = getModel(model_id);
        }
        catch (ex) {
            throw new ClickException(`'${model_id}' is not a known model`);
        }
        if (conversation === null) {
            conversation = new Conversation({ model });
        }
        else {
            conversation.model = model;
        }
        if (tools_debug) {
            conversation.after_call = debugToolCall;
        }
        if (tools_approve) {
            conversation.before_call = approveToolCall;
        }
        // Validate options
        let validatedOptions = getModelOptions(model.model_id);
        if (options.length) {
            validatedOptions = optionsFromValidated(model, options);
        }
        const kwargs = {};
        if (Object.keys(validatedOptions).length) {
            kwargs.options = validatedOptions;
        }
        const toolFunctions = gatherTools(tools, python_tools);
        if (toolFunctions.length) {
            kwargs.chain_limit = chain_limit;
            kwargs.tools = toolFunctions;
        }
        const shouldStream = model.can_stream && !no_stream;
        if (!shouldStream) {
            kwargs.stream = false;
        }
        if (key && model instanceof KeyModel) {
            kwargs.key = key;
        }
        if (hide_reasoning) {
            kwargs.hide_reasoning = true;
        }
        let argumentFragments;
        let argumentAttachments;
        let argumentSystemFragments;
        try {
            const fragmentsAndAttachments = await resolveFragments(db, fragments, true);
            argumentFragments = fragmentsAndAttachments.filter((f) => f instanceof Fragment);
            argumentAttachments = fragmentsAndAttachments.filter((a) => a instanceof Attachment);
            argumentSystemFragments = await resolveFragments(db, system_fragments);
        }
        catch (ex) {
            if (ex instanceof FragmentNotFound) {
                throw new ClickException(ex.message);
            }
            throw ex;
        }
        echo(`Chatting with ${model.model_id}`);
        echo("Type 'exit' or 'quit' to exit");
        echo("Type '!multi' to enter multiple lines, then '!end' to finish");
        echo("Type '!edit' to open your default editor and modify the prompt");
        echo("Type '!fragment <my_fragment> [<another_fragment> ...]' to insert one or more fragments");
        let inMulti = false;
        let accumulated = [];
        let accumulatedFragments = [];
        let accumulatedAttachments = [];
        let endToken = "!end";
        while (true) {
            // click.prompt("", prompt_suffix="> ") — the prompt text goes to
            // stdout, and in test mode the typed input is echoed too.
            const promptSuffix = !inMulti ? "> " : "";
            click.getStreams().writeOut(promptSuffix);
            const line = click.getStreams().readLine();
            if (line === null) {
                throw new click.Abort();
            }
            click.getStreams().writeOut(line + "\n");
            let prompt = line;
            let fragments_ = [];
            let attachments = [];
            if (argumentFragments.length) {
                fragments_ = [...fragments_, ...argumentFragments];
                // fragments from --fragments only get added to the first message
                argumentFragments = [];
            }
            if (argumentAttachments.length) {
                attachments = argumentAttachments;
                argumentAttachments = [];
            }
            if (prompt.trim().startsWith("!multi")) {
                inMulti = true;
                const bits = prompt.trim().split(/\s+/);
                if (bits.length > 1) {
                    endToken = `!end ${bits.slice(1).join(" ")}`;
                }
                continue;
            }
            if (prompt.trim() === "!edit") {
                const editedPrompt = click.edit();
                if (editedPrompt === null) {
                    echo("Editor closed without saving.", { err: true });
                    continue;
                }
                prompt = editedPrompt.trim();
            }
            if (prompt.trim().startsWith("!fragment ")) {
                const [newPrompt, newFragments, newAttachments] = await processFragmentsInChat(db, prompt);
                prompt = newPrompt;
                fragments_ = newFragments;
                attachments = newAttachments;
            }
            if (inMulti) {
                if (prompt.trim() === endToken) {
                    prompt = accumulated.join("\n");
                    fragments_ = accumulatedFragments;
                    attachments = accumulatedAttachments;
                    inMulti = false;
                    accumulated = [];
                    accumulatedFragments = [];
                    accumulatedAttachments = [];
                }
                else {
                    if (prompt) {
                        accumulated.push(prompt);
                    }
                    accumulatedFragments = [...accumulatedFragments, ...fragments_];
                    accumulatedAttachments = [
                        ...accumulatedAttachments,
                        ...attachments,
                    ];
                    continue;
                }
            }
            if (templateObj) {
                let templatePrompt;
                let templateSystem;
                const usesInput = templateObj.vars().has("input");
                try {
                    const input_ = usesInput ? prompt : "";
                    [templatePrompt, templateSystem] = templateObj.evaluate(input_, params_);
                }
                catch (ex) {
                    if (ex instanceof Template.MissingVariables) {
                        throw new ClickException(ex.message);
                    }
                    throw ex;
                }
                if (templateSystem && !system) {
                    system = templateSystem;
                }
                if (templatePrompt) {
                    if (prompt && !usesInput) {
                        prompt = `${templatePrompt}\n${prompt}`;
                    }
                    else {
                        prompt = templatePrompt;
                    }
                }
            }
            if (["exit", "quit"].includes(prompt.trim())) {
                break;
            }
            const response = conversation.chain(prompt, {
                fragments: fragments_,
                system_fragments: argumentSystemFragments.filter((f) => f instanceof Fragment),
                attachments,
                system,
                ...kwargs,
            });
            // System prompt and system fragments only sent for the first message
            system = null;
            argumentSystemFragments = [];
            await displayStreamEvents(response.stream_events(), {
                showReasoning: !hide_reasoning,
            });
            await response.logToDb(db);
            echo("");
        }
    },
}));
// -------------------------------------------------------------- keys cmds
const keysGroup = new Group({
    name: "keys",
    help: "Manage stored API keys for different models",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(keysGroup);
keysGroup.command({
    name: "list",
    help: "List names of all stored keys",
    handler: async () => {
        const p = path.join(userDir(), "keys.json");
        if (!fs.existsSync(p)) {
            echo("No keys found");
            return;
        }
        const keys = JSON.parse(fs.readFileSync(p, "utf-8"));
        for (const key of Object.keys(keys).sort()) {
            if (key !== "// Note") {
                echo(key);
            }
        }
    },
});
keysGroup.command({
    name: "path",
    help: "Output the path to the keys.json file",
    handler: async () => {
        echo(path.join(userDir(), "keys.json"));
    },
});
keysGroup.command({
    name: "get",
    help: `Return the value of a stored key

    Example usage:

        export OPENAI_API_KEY=$(llm keys get openai)`,
    arguments: [argument("name")],
    handler: async (params) => {
        const p = path.join(userDir(), "keys.json");
        if (!fs.existsSync(p)) {
            throw new ClickException("No keys found");
        }
        const keys = JSON.parse(fs.readFileSync(p, "utf-8"));
        if (!(params.name in keys)) {
            throw new ClickException(`No key found with name '${params.name}'`);
        }
        echo(keys[params.name]);
    },
});
keysGroup.command({
    name: "set",
    help: `Save a key in the keys.json file

    Example usage:

        $ llm keys set openai
        Enter key: ...`,
    arguments: [argument("name")],
    options: [option(["--value"], { help: "Value to set" })],
    handler: async (params) => {
        let value = params.value;
        if (!value) {
            // click's prompt="Enter key" with hide_input=True
            click.getStreams().writeOut("Enter key: ");
            const line = click.getStreams().readLine();
            if (line === null) {
                throw new click.Abort();
            }
            click.getStreams().writeOut("\n");
            value = line;
        }
        const defaultContent = {
            "// Note": "This file stores secret API credentials. Do not share!",
        };
        const p = path.join(userDir(), "keys.json");
        fs.mkdirSync(path.dirname(p), { recursive: true });
        if (!fs.existsSync(p)) {
            fs.writeFileSync(p, JSON.stringify(defaultContent));
            fs.chmodSync(p, 0o600);
        }
        let current;
        try {
            current = JSON.parse(fs.readFileSync(p, "utf-8"));
        }
        catch {
            current = { ...defaultContent };
        }
        current[params.name] = value;
        fs.writeFileSync(p, JSON.stringify(current, null, 2) + "\n");
    },
});
// -------------------------------------------------------------- logs cmds
const logsGroup = new Group({
    name: "logs",
    help: "Tools for exploring logged prompts and responses",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(logsGroup);
logsGroup.command({
    name: "path",
    help: "Output the path to the logs.db file",
    handler: async () => {
        echo(logsDbPath());
    },
});
logsGroup.command({
    name: "status",
    help: "Show current status of database logging",
    handler: async () => {
        const p = logsDbPath();
        if (!fs.existsSync(p)) {
            echo(`No log database found at ${p}`);
            return;
        }
        if (logsOn()) {
            echo("Logging is ON for all prompts");
        }
        else {
            echo("Logging is OFF");
        }
        const db = new Database(p);
        migrate(db);
        echo(`Found log database at ${p}`);
        echo(`Number of conversations logged:\t${db.table("conversations").count}`);
        echo(`Number of responses logged:\t${db.table("responses").count}`);
        echo(`Database file size: \t\t${humanReadableSize(fs.statSync(p).size)}`);
    },
});
logsGroup.command({
    name: "backup",
    help: "Backup your logs database to this file",
    arguments: [argument("path")],
    handler: async (params) => {
        const logsPath = logsDbPath();
        const targetPath = params.path;
        const db = new Database(logsPath);
        try {
            db.execute("vacuum into ?", [targetPath]);
        }
        catch (ex) {
            throw new ClickException(ex.message);
        }
        echo(`Backed up ${humanReadableSize(fs.statSync(targetPath).size)} to ${targetPath}`);
    },
});
logsGroup.command({
    name: "on",
    help: "Turn on logging for all prompts",
    handler: async () => {
        const p = path.join(userDir(), "logs-off");
        if (fs.existsSync(p)) {
            fs.unlinkSync(p);
        }
    },
});
logsGroup.command({
    name: "off",
    help: "Turn off logging for all prompts",
    handler: async () => {
        fs.writeFileSync(path.join(userDir(), "logs-off"), "");
    },
});
const LOGS_COLUMNS = `    responses.id,
    responses.model,
    responses.resolved_model,
    responses.prompt,
    responses.system,
    responses.prompt_json,
    responses.options_json,
    responses.response,
    responses.reasoning,
    responses.response_json,
    responses.conversation_id,
    responses.duration_ms,
    responses.datetime_utc,
    responses.input_tokens,
    responses.output_tokens,
    responses.token_details,
    conversations.name as conversation_name,
    conversations.model as conversation_model,
    schemas.content as schema_json`;
const LOGS_SQL = `
select
{columns}
from
    responses
left join schemas on responses.schema_id = schemas.id
left join conversations on responses.conversation_id = conversations.id{extra_where}
order by {order_by}{limit}
`;
const LOGS_SQL_SEARCH = `
select
{columns}
from
    responses
left join schemas on responses.schema_id = schemas.id
left join conversations on responses.conversation_id = conversations.id
join responses_fts on responses_fts.rowid = responses.rowid
where responses_fts match :query{extra_where}
order by {order_by}{limit}
`;
const ATTACHMENTS_SQL = `
select
    response_id,
    attachments.id,
    attachments.type,
    attachments.path,
    attachments.url,
    length(attachments.content) as content_length
from attachments
join prompt_attachments
    on attachments.id = prompt_attachments.attachment_id
where prompt_attachments.response_id in ({})
order by prompt_attachments."order"
`;
logsGroup.addCommand(new Command({
    name: "list",
    help: "Show logged prompts and their responses",
    options: [
        option(["-n", "--count"], {
            type: "int",
            default: null,
            help: "Number of entries to show - defaults to 3, use 0 for all",
        }),
        option(["-p", "--path"], {
            type: new ClickPath({ exists: true, dirOkay: false }),
            help: "Path to log database",
            hidden: true,
        }),
        option(["-d", "--database"], {
            type: new ClickPath({ exists: true, dirOkay: false }),
            help: "Path to log database",
        }),
        option(["-m", "--model"], { help: "Filter by model or model alias" }),
        option(["-q", "--query"], {
            help: "Search for logs matching this string",
        }),
        option(["--fragment", "-f"], {
            name: "fragments",
            help: "Filter for prompts using these fragments",
            multiple: true,
        }),
        option(["-T", "--tool"], {
            name: "tools",
            multiple: true,
            help: "Filter for prompts with results from these tools",
        }),
        flag(["--tools"], {
            name: "any_tools",
            help: "Filter for prompts with results from any tools",
        }),
        option(["--schema"], {
            name: "schema_input",
            help: "JSON schema, filepath or ID",
        }),
        option(["--schema-multi"], {
            help: "JSON schema used for multiple results",
        }),
        flag(["-l", "--latest"], {
            help: "Return latest results matching search query",
        }),
        flag(["--data"], {
            help: "Output newline-delimited JSON data for schema",
        }),
        flag(["--data-array"], { help: "Output JSON array of data for schema" }),
        option(["--data-key"], {
            help: "Return JSON objects from array in this key",
        }),
        flag(["--data-ids"], {
            help: "Attach corresponding IDs to JSON objects",
        }),
        flag(["-t", "--truncate"], {
            help: "Truncate long strings in output",
        }),
        flag(["-s", "--short"], {
            help: "Shorter YAML output with truncated prompts",
        }),
        flag(["-u", "--usage"], { help: "Include token usage" }),
        flag(["-r", "--response"], { help: "Just output the last response" }),
        flag(["-x", "--extract"], { help: "Extract first fenced code block" }),
        flag(["--xl", "--extract-last"], {
            name: "extract_last",
            help: "Extract last fenced code block",
        }),
        flag(["-c", "--current"], {
            name: "current_conversation",
            help: "Show logs from the current conversation",
        }),
        option(["--cid", "--conversation"], {
            name: "conversation_id",
            help: "Show logs for this conversation ID",
        }),
        option(["--id-gt"], { help: "Return responses with ID > this" }),
        option(["--id-gte"], { help: "Return responses with ID >= this" }),
        flag(["--json"], { name: "json_output", help: "Output logs as JSON" }),
        flag(["--expand", "-e"], {
            help: "Expand fragments to show their content",
        }),
    ],
    handler: logsListHandler,
}));
async function logsListHandler(params) {
    let { count, path: pathOption, database, model, query, fragments, tools, any_tools, schema_input, schema_multi, latest, data, data_array, data_key, data_ids, truncate, short, usage, response, extract, extract_last, current_conversation, conversation_id, id_gt, id_gte, json_output, expand, } = params;
    if (database && !pathOption) {
        pathOption = database;
    }
    const dbPath = pathOption || logsDbPath();
    if (!fs.existsSync(dbPath)) {
        throw new ClickException(`No log database found at ${dbPath}`);
    }
    const db = new Database(dbPath);
    migrate(db);
    if (schema_multi) {
        schema_input = schema_multi;
    }
    let schema = await resolveSchemaInput(db, schema_input, loadTemplate);
    if (schema_multi) {
        schema = multiSchema(schema);
    }
    if (short && (json_output || response)) {
        const invalid = [
            ["--json", json_output],
            ["--response", response],
        ]
            .filter(([, v]) => v)
            .map(([f]) => f)
            .join(" or ");
        throw new ClickException(`Cannot use --short and ${invalid} together`);
    }
    if (response && !current_conversation && !conversation_id) {
        current_conversation = true;
    }
    if (current_conversation) {
        const rows = db.query("select conversation_id from responses order by id desc limit 1");
        if (!rows.length) {
            throw new ClickException("No conversations found");
        }
        conversation_id = rows[0].conversation_id;
    }
    // For --conversation set limit 0, if not explicitly set
    if (count === null || count === undefined) {
        count = conversation_id ? 0 : 3;
    }
    let modelId = null;
    if (model) {
        try {
            modelId = getModel(model).model_id;
        }
        catch (e) {
            if (e instanceof UnknownModelError) {
                modelId = model;
            }
            else {
                throw e;
            }
        }
    }
    let sql = LOGS_SQL;
    let orderBy = "responses.id desc";
    if (query) {
        sql = LOGS_SQL_SEARCH;
        if (!latest) {
            orderBy = "responses_fts.rank desc";
        }
    }
    let limit = "";
    if (count !== null && count > 0) {
        limit = ` limit ${count}`;
    }
    const sqlFormat = {
        limit,
        columns: LOGS_COLUMNS,
        extra_where: "",
        order_by: orderBy,
    };
    const whereBits = [];
    const sqlParams = {
        model: modelId,
        query,
        conversation_id,
        id_gt,
        id_gte,
    };
    if (modelId) {
        whereBits.push("responses.model = :model");
    }
    if (conversation_id) {
        whereBits.push("responses.conversation_id = :conversation_id");
    }
    if (id_gt) {
        whereBits.push("responses.id > :id_gt");
    }
    if (id_gte) {
        whereBits.push("responses.id >= :id_gte");
    }
    if (fragments.length) {
        const fragmentHashes = (await resolveFragments(db, fragments)).map((f) => f.id());
        const existsClauses = [];
        fragmentHashes.forEach((fragmentHash, i) => {
            existsClauses.push(`
            exists (
                select 1 from prompt_fragments
                where prompt_fragments.response_id = responses.id
                and prompt_fragments.fragment_id in (
                    select fragments.id from fragments
                    where hash = :f${i}
                )
                union
                select 1 from system_fragments
                where system_fragments.response_id = responses.id
                and system_fragments.fragment_id in (
                    select fragments.id from fragments
                    where hash = :f${i}
                )
            )
            `);
            sqlParams[`f${i}`] = fragmentHash;
        });
        whereBits.push(existsClauses.join(" and "));
    }
    if (any_tools) {
        whereBits.push(`
            exists (
              select 1
                from tool_results
              where
                tool_results.response_id = responses.id
            )
        `);
    }
    if (tools.length) {
        const toolsByName = getTools();
        const toolClauses = [];
        tools.forEach((toolName, i) => {
            if (!(toolName in toolsByName)) {
                throw new ClickException(`Unknown tool: ${toolName}`);
            }
            const pluginName = toolsByName[toolName].plugin;
            toolClauses.push(`
            exists (
              select 1
                from tool_results
                join tools on tools.id = tool_results.tool_id
               where tool_results.response_id = responses.id
                 and tools.name = :tool${i}
                 and tools.plugin = :plugin${i}
            )
            `);
            sqlParams[`tool${i}`] = toolName;
            sqlParams[`plugin${i}`] = pluginName;
        });
        whereBits.push(toolClauses.join(" and "));
    }
    if (schema) {
        const schemaId = makeSchemaId(schema)[0];
        whereBits.push("responses.schema_id = :schema_id");
        sqlParams.schema_id = schemaId;
    }
    if (whereBits.length) {
        const where_ = query ? " and " : " where ";
        sqlFormat.extra_where = where_ + whereBits.join(" and ");
    }
    let finalSql = sql
        .replace("{columns}", sqlFormat.columns)
        .replace("{extra_where}", sqlFormat.extra_where)
        .replace("{order_by}", sqlFormat.order_by)
        .replace("{limit}", sqlFormat.limit);
    // Named params: better-sqlite3 rejects unused named params, so filter
    const usedParams = {};
    for (const [k, v] of Object.entries(sqlParams)) {
        if (finalSql.includes(`:${k}`)) {
            usedParams[k] = v;
        }
    }
    const rows = db.query(finalSql, usedParams);
    // Reverse for chronological order, except searches / data output
    if (!query && !data) {
        rows.reverse();
    }
    // Fetch any attachments
    const ids = rows.map((row) => row.id);
    const attachmentsRows = ids.length
        ? db.query(ATTACHMENTS_SQL.replace("{}", ids.map(() => "?").join(",")), ids)
        : [];
    const attachmentsById = {};
    for (const attachment of attachmentsRows) {
        (attachmentsById[attachment.response_id] ??= []).push(attachment);
    }
    const FRAGMENTS_SQL = (table, placeholders) => `
    select
        ${table}.response_id,
        fragments.hash,
        fragments.id as fragment_id,
        fragments.content,
        (
            select json_group_array(fragment_aliases.alias)
            from fragment_aliases
            where fragment_aliases.fragment_id = fragments.id
        ) as aliases
    from ${table}
    join fragments on ${table}.fragment_id = fragments.id
    where ${table}.response_id in (${placeholders})
    order by ${table}."order"
    `;
    const promptFragmentsById = {};
    const systemFragmentsById = {};
    for (const [table, dictionary] of [
        ["prompt_fragments", promptFragmentsById],
        ["system_fragments", systemFragmentsById],
    ]) {
        if (!ids.length)
            continue;
        for (const fragment of db.query(FRAGMENTS_SQL(table, ids.map(() => "?").join(",")), ids)) {
            (dictionary[fragment.response_id] ??= []).push(fragment);
        }
    }
    if (data || data_array || data_key || data_ids) {
        const toOutput = [];
        for (const row of rows) {
            const responseText = row.response || "";
            try {
                const decoded = JSON.parse(responseText);
                let newItems = [];
                if (decoded &&
                    typeof decoded === "object" &&
                    !Array.isArray(decoded) &&
                    data_key &&
                    data_key in decoded &&
                    Array.isArray(decoded[data_key]) &&
                    decoded[data_key].every((item) => item && typeof item === "object" && !Array.isArray(item))) {
                    newItems = decoded[data_key];
                }
                else {
                    newItems = [decoded];
                }
                if (data_ids) {
                    for (const item of newItems) {
                        item[findUnusedKey(item, "response_id")] = row.id;
                        item[findUnusedKey(item, "conversation_id")] = row.id;
                    }
                }
                toOutput.push(...newItems);
            }
            catch {
                // skip invalid JSON
            }
        }
        for (const line of outputRowsAsJson(toOutput, {
            nl: !data_array,
            compact: true,
        })) {
            echo(line);
        }
        return;
    }
    // Tool usage information
    const TOOLS_SQL = (placeholders) => `
    SELECT responses.id,
    COALESCE(
        (SELECT json_group_array(json_object(
            'id', t.id,
            'hash', t.hash,
            'name', t.name,
            'description', t.description,
            'input_schema', json(t.input_schema)
        ))
        FROM tools t
        JOIN tool_responses tr ON t.id = tr.tool_id
        WHERE tr.response_id = responses.id
        ),
        '[]'
    ) AS tools,
    COALESCE(
        (SELECT json_group_array(json_object(
            'id', tc.id,
            'tool_id', tc.tool_id,
            'name', tc.name,
            'arguments', json(tc.arguments),
            'tool_call_id', tc.tool_call_id
        ))
        FROM tool_calls tc
        WHERE tc.response_id = responses.id
        ),
        '[]'
    ) AS tool_calls,
    COALESCE(
        (SELECT json_group_array(json_object(
            'id', tr.id,
            'tool_id', tr.tool_id,
            'name', tr.name,
            'output', tr.output,
            'tool_call_id', tr.tool_call_id,
            'exception', tr.exception,
            'attachments', COALESCE(
                (SELECT json_group_array(json_object(
                    'id', a.id,
                    'type', a.type,
                    'path', a.path,
                    'url', a.url,
                    'content', a.content
                ))
                FROM tool_results_attachments tra
                JOIN attachments a ON tra.attachment_id = a.id
                WHERE tra.tool_result_id = tr.id
                ),
                '[]'
            )
        ))
        FROM tool_results tr
        WHERE tr.response_id = responses.id
        ),
        '[]'
    ) AS tool_results
    FROM responses
    where id in (${placeholders})
    `;
    const toolInfoById = {};
    if (ids.length) {
        for (const row of db.query(TOOLS_SQL(ids.map(() => "?").join(",")), ids)) {
            toolInfoById[row.id] = {
                tools: JSON.parse(row.tools),
                tool_calls: JSON.parse(row.tool_calls),
                tool_results: JSON.parse(row.tool_results),
            };
        }
    }
    for (const row of rows) {
        if (truncate) {
            row.prompt = truncateString(row.prompt || "");
            row.response = truncateString(row.response || "");
        }
        for (const key of ["prompt_fragments", "system_fragments"]) {
            const source = key === "prompt_fragments"
                ? (promptFragmentsById[row.id] ?? [])
                : (systemFragmentsById[row.id] ?? []);
            row[key] = source.map((fragment) => ({
                hash: fragment.hash,
                content: expand
                    ? fragment.content
                    : truncateString(fragment.content),
                aliases: JSON.parse(fragment.aliases),
            }));
        }
        // Either decode or remove all JSON keys
        for (const key of Object.keys(row)) {
            if (key.endsWith("_json") && row[key] !== null) {
                if (truncate) {
                    delete row[key];
                }
                else {
                    row[key] = JSON.parse(row[key]);
                }
            }
        }
        Object.assign(row, toolInfoById[row.id] ?? {
            tools: [],
            tool_calls: [],
            tool_results: [],
        });
    }
    let output = null;
    if (json_output) {
        for (const row of rows) {
            row.attachments = (attachmentsById[row.id] ?? []).map((attachment) => Object.fromEntries(Object.entries(attachment).filter(([k]) => k !== "response_id")));
        }
        output = dumps(rows, { indent: 2 });
    }
    else if (extract || extract_last) {
        for (const row of rows) {
            output = extractFencedCodeBlock(row.response, Boolean(extract_last));
            if (output !== null) {
                break;
            }
        }
    }
    else if (response) {
        if (rows.length) {
            output = rows[rows.length - 1].response;
        }
    }
    if (output !== null) {
        echo(output);
    }
    else {
        renderLogsHumanReadable(rows, {
            short,
            usage,
            expand,
            conversation_id,
            attachmentsById,
        });
    }
}
function fencedBlock(value) {
    let numBackticks = 3;
    while (value.includes("`".repeat(numBackticks))) {
        numBackticks += 1;
    }
    const fence = "`".repeat(numBackticks);
    return `${fence}\n${value}\n${fence}`
        .split("\n")
        .map((l) => (l.trim() ? "    " + l : l))
        .join("\n");
}
function inlineCode(value) {
    let numBackticks = 1;
    while (value.includes("`".repeat(numBackticks))) {
        numBackticks += 1;
    }
    const delimiter = "`".repeat(numBackticks);
    if (value.startsWith("`") || value.endsWith("`")) {
        return `${delimiter} ${value} ${delimiter}`;
    }
    return `${delimiter}${value}${delimiter}`;
}
function formatToolCallArguments(args) {
    if (!args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        !Object.keys(args).length) {
        return `    Arguments: ${inlineCode(dumps(args))}`;
    }
    const lines = [];
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === "string") {
            lines.push(`    ${key}:`);
            lines.push(fencedBlock(value));
        }
        else {
            lines.push(`    ${key}: ${inlineCode(dumps(value))}`);
        }
    }
    return lines.join("\n");
}
function tokenUsageMarkdown(inputTokens, outputTokens, tokenDetails) {
    const usage = tokenUsageString(inputTokens, outputTokens, null);
    if (tokenDetails) {
        const details = inlineCode(dumps(tokenDetails));
        if (usage) {
            return `${usage}, ${details}`;
        }
        return details;
    }
    return usage;
}
function renderLogsHumanReadable(rows, { short, usage, expand, conversation_id, attachmentsById, }) {
    function displayFragments(fragments, title) {
        if (!fragments.length) {
            return;
        }
        let content;
        if (!expand) {
            content = fragments.map((f) => `- ${f.hash}`).join("\n");
        }
        else {
            content = fragments
                .map((f) => `<details><summary>${f.hash}</summary>\n${maybeFencedCode(f.content)}\n</details>`)
                .join("\n");
        }
        echo(`\n### ${title}\n\n${content}`);
    }
    let currentSystem = null;
    let shouldShowConversation = true;
    const seenToolHashes = new Set();
    for (const row of rows) {
        if (short) {
            const system = truncateString(row.system || "", 120, true);
            const prompt = truncateString(row.prompt || "", 120, true, true);
            const cid = row.conversation_id;
            const attachments = attachmentsById[row.id];
            const obj = {
                model: row.model,
                datetime: row.datetime_utc.split(".")[0],
                conversation: cid,
            };
            if (row.tool_calls.length) {
                obj.tool_calls = row.tool_calls.map((toolCall) => `${toolCall.name}(${dumps(toolCall.arguments)})`);
            }
            if (row.tool_results.length) {
                obj.tool_results = row.tool_results.map((toolResult) => `${toolResult.name}: ${truncateString(toolResult.output)}`);
            }
            if (system)
                obj.system = system;
            if (prompt)
                obj.prompt = prompt;
            if (attachments) {
                obj.attachments = attachments.map((attachment) => {
                    const details = { type: attachment.type };
                    if (attachment.path)
                        details.path = attachment.path;
                    if (attachment.url)
                        details.url = attachment.url;
                    return details;
                });
            }
            for (const key of ["prompt_fragments", "system_fragments"]) {
                obj[key] = row[key].map((f) => f.hash);
            }
            if (usage && (row.input_tokens || row.output_tokens)) {
                const usageDetails = {
                    input: row.input_tokens,
                    output: row.output_tokens,
                };
                if (row.token_details) {
                    usageDetails.details = JSON.parse(row.token_details);
                }
                obj.usage = usageDetails;
            }
            echo(pyYamlDump([obj], { sortKeys: false }).trim());
            continue;
        }
        // Not short, output Markdown
        echo(`# ${row.datetime_utc.split(".")[0]}${shouldShowConversation
            ? `    conversation: ${row.conversation_id} id: ${row.id}`
            : ""}\n${shouldShowConversation
            ? `\nModel: **${row.model}**${row.resolved_model
                ? ` (resolved: **${row.resolved_model}**)`
                : ""}\n`
            : ""}`);
        if (conversation_id) {
            shouldShowConversation = false;
        }
        echo(`## Prompt\n\n${row.prompt || "-- none --"}`);
        displayFragments(row.prompt_fragments, "Prompt fragments");
        if (row.options_json) {
            let options = row.options_json;
            if (typeof options === "string") {
                options = JSON.parse(options);
            }
            if (options && Object.keys(options).length) {
                const optionsText = Object.entries(options)
                    .map(([key, value]) => `- ${key}: ${value}`)
                    .join("\n");
                echo(`\n## Options\n\n${optionsText}`);
            }
        }
        if (row.system !== currentSystem) {
            if (row.system !== null && row.system !== undefined) {
                echo(`\n## System\n\n${row.system}`);
            }
            currentSystem = row.system;
        }
        displayFragments(row.system_fragments, "System fragments");
        if (row.schema_json) {
            echo(`\n## Schema\n\n\`\`\`json\n${dumps(row.schema_json, { indent: 2 })}\n\`\`\``);
        }
        if (row.tools.length) {
            echo("\n### Tools\n");
            for (const tool of row.tools) {
                if (seenToolHashes.has(tool.hash)) {
                    echo(`- **${tool.name}**: \`${tool.hash.slice(0, 7)}\``);
                }
                else {
                    seenToolHashes.add(tool.hash);
                    const description = (tool.description || "").replace(/\s+$/, "");
                    const indented = description
                        .split("\n")
                        .map((l) => (l.trim() ? "    " + l : l))
                        .join("\n");
                    echo(`- **${tool.name}**: \`${tool.hash}\`<br>\n${indented}<br>\n    Arguments: \`${dumps(tool.input_schema.properties)}\``);
                }
            }
        }
        if (row.tool_results.length) {
            echo("\n### Tool results\n");
            for (const toolResult of row.tool_results) {
                let attachmentsDesc = "";
                for (const attachment of toolResult.attachments) {
                    let desc = "";
                    if (attachment.type)
                        desc += attachment.type + ": ";
                    if (attachment.path)
                        desc += attachment.path;
                    else if (attachment.url)
                        desc += attachment.url;
                    else if (attachment.content) {
                        desc += `<${Number(attachment.content_length).toLocaleString("en-US")} bytes>`;
                    }
                    attachmentsDesc += `\n    - ${desc}`;
                }
                echo(`- **${toolResult.name}**: \`${toolResult.tool_call_id}\`<br>\n${fencedBlock(toolResult.output)}${toolResult.exception
                    ? `<br>\n    **Error**: ${toolResult.exception}\n`
                    : ""}${attachmentsDesc}`);
            }
        }
        const attachments = attachmentsById[row.id];
        if (attachments) {
            echo("\n### Attachments\n");
            attachments.forEach((attachment, index) => {
                const i = index + 1;
                if (attachment.path) {
                    echo(`${i}. **${attachment.type}**: \`${attachment.path}\``);
                }
                else if (attachment.url) {
                    echo(`${i}. **${attachment.type}**: ${attachment.url}`);
                }
                else if (attachment.content_length) {
                    echo(`${i}. **${attachment.type}**: \`<${Number(attachment.content_length).toLocaleString("en-US")} bytes>\``);
                }
            });
        }
        let responseText = row.response;
        if (row.schema_json) {
            try {
                const parsed = JSON.parse(responseText);
                responseText = `\`\`\`json\n${dumps(parsed, { indent: 2 })}\n\`\`\``;
            }
            catch {
                // leave as-is
            }
        }
        if (row.reasoning) {
            echo(`\n## Reasoning\n\n${row.reasoning.replace(/\s+$/, "")}`);
        }
        echo("\n## Response\n");
        if (row.tool_calls.length) {
            echo("### Tool calls\n");
            for (const toolCall of row.tool_calls) {
                echo(`- **${toolCall.name}**: \`${toolCall.tool_call_id}\`<br>\n${formatToolCallArguments(toolCall.arguments)}`);
            }
            echo("");
        }
        if (responseText) {
            echo(`${responseText}\n`);
        }
        if (usage) {
            const tokenUsage = tokenUsageMarkdown(row.input_tokens, row.output_tokens, row.token_details ? JSON.parse(row.token_details) : null);
            if (tokenUsage) {
                echo(`## Token usage\n\n${tokenUsage}\n`);
            }
        }
    }
}
// ------------------------------------------------------------- models cmds
const modelsGroup = new Group({
    name: "models",
    help: "Manage available models",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(modelsGroup);
modelsGroup.command({
    name: "list",
    help: "List available models",
    options: [
        flag(["--options"], {
            help: "Show options for each model, if available",
        }),
        flag(["--async"], { name: "async_", help: "List async models" }),
        flag(["--schemas"], { help: "List models that support schemas" }),
        flag(["--tools"], { help: "List models that support tools" }),
        option(["-q", "--query"], {
            multiple: true,
            help: "Search for models matching these strings",
        }),
        option(["-m", "--model"], {
            name: "model_ids",
            help: "Specific model IDs",
            multiple: true,
        }),
    ],
    handler: async (params) => {
        const { options, async_, schemas, tools, query, model_ids } = params;
        const modelsThatHaveShownOptions = new Set();
        for (const modelWithAliases of getModelsWithAliases()) {
            if (async_ && !modelWithAliases.async_model)
                continue;
            if (query.length) {
                if (!query.every((q) => modelWithAliases.matches(q))) {
                    continue;
                }
            }
            if (model_ids.length) {
                if (!modelMatchesIdOrAlias(modelWithAliases, model_ids)) {
                    continue;
                }
            }
            if (schemas && !modelWithAliases.model.supports_schema)
                continue;
            if (tools && !modelWithAliases.model.supports_tools)
                continue;
            echo(renderModelWithAliases(modelWithAliases, {
                options,
                async_,
                modelsThatHaveShownOptions,
            }));
        }
        if (!query.length &&
            !options &&
            !schemas &&
            !model_ids.length) {
            echo(`Default: ${getDefaultModel()}`);
        }
    },
});
modelsGroup.command({
    name: "default",
    help: "Show or set the default model",
    arguments: [argument("model", { required: false })],
    handler: async (params) => {
        if (!params.model) {
            echo(getDefaultModel());
            return;
        }
        try {
            const model = getModel(params.model);
            setDefaultModel(model.model_id);
        }
        catch (e) {
            if (e instanceof UnknownModelError) {
                throw new ClickException(`Unknown model: ${params.model}`);
            }
            throw e;
        }
    },
});
// ---------------------------------------------------------- templates cmds
const templatesGroup = new Group({
    name: "templates",
    help: "Manage stored prompt templates",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(templatesGroup);
templatesGroup.command({
    name: "list",
    help: "List available prompt templates",
    handler: async () => {
        const dir = templateDir();
        const pairs = [];
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".yaml"))) {
            const name = file.slice(0, -5);
            let template;
            try {
                template = await loadTemplate(name);
            }
            catch {
                continue;
            }
            const text = [];
            if (template.system) {
                text.push(`system: ${template.system}`);
                if (template.prompt) {
                    text.push(` prompt: ${template.prompt}`);
                }
            }
            else {
                text.push(template.prompt ? template.prompt : "");
            }
            pairs.push([name, text.join("").replace(/\n/g, " ")]);
        }
        if (!pairs.length) {
            return;
        }
        const maxNameLen = Math.max(...pairs.map(([n]) => n.length));
        pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [name, prompt] of pairs) {
            echo(displayTruncated(`${name.padEnd(maxNameLen)} : ${prompt}`));
        }
    },
});
templatesGroup.command({
    name: "show",
    help: "Show the specified prompt template",
    arguments: [argument("name")],
    handler: async (params) => {
        let template;
        try {
            template = await loadTemplate(params.name);
        }
        catch (e) {
            if (e instanceof LoadTemplateError) {
                throw new ClickException(`Template '${params.name}' not found or invalid`);
            }
            throw e;
        }
        const data = Object.fromEntries(Object.entries(template.modelDump()).filter(([, v]) => v !== null && v !== undefined));
        echo(pyYamlDump(data, { indent: 4, sortKeys: true }));
    },
});
templatesGroup.command({
    name: "edit",
    help: "Edit the specified prompt template using the default $EDITOR",
    arguments: [argument("name")],
    handler: async (params) => {
        const p = path.join(templateDir(), `${params.name}.yaml`);
        if (!fs.existsSync(p)) {
            fs.writeFileSync(p, DEFAULT_TEMPLATE);
        }
        click.edit();
        await loadTemplate(params.name);
    },
});
templatesGroup.command({
    name: "path",
    help: "Output the path to the templates directory",
    handler: async () => {
        echo(templateDir());
    },
});
templatesGroup.command({
    name: "loaders",
    help: "Show template loaders registered by plugins",
    handler: async () => {
        let found = false;
        for (const [prefix, loader] of Object.entries(getTemplateLoaders())) {
            found = true;
            let docs = "Undocumented";
            const loaderDocs = loader.description;
            if (loaderDocs) {
                docs = loaderDocs.trim();
            }
            echo(`${prefix}:`);
            echo(docs
                .split("\n")
                .map((l) => "  " + l)
                .join("\n"));
        }
        if (!found) {
            echo("No template loaders found");
        }
    },
});
// ------------------------------------------------------------ schemas cmds
const schemasGroup = new Group({
    name: "schemas",
    help: "Manage stored schemas",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(schemasGroup);
schemasGroup.command({
    name: "list",
    help: "List stored schemas",
    options: [
        option(["-p", "--path"], {
            type: new ClickPath({ exists: true, dirOkay: false }),
            help: "Path to log database",
            hidden: true,
        }),
        option(["-d", "--database"], {
            type: new ClickPath({ exists: true, dirOkay: false }),
            help: "Path to log database",
        }),
        option(["-q", "--query"], {
            name: "queries",
            multiple: true,
            help: "Search for schemas matching this string",
        }),
        flag(["--full"], { help: "Output full schema contents" }),
        flag(["--json"], { name: "json_", help: "Output as JSON" }),
        flag(["--nl"], { name: "nl", help: "Output as newline-delimited JSON" }),
    ],
    handler: async (params) => {
        let { path: pathOption, database, queries, full, json_, nl } = params;
        if (database && !pathOption) {
            pathOption = database;
        }
        const dbPath = pathOption || logsDbPath();
        if (!fs.existsSync(dbPath)) {
            throw new ClickException(`No log database found at ${dbPath}`);
        }
        const db = new Database(dbPath);
        migrate(db);
        const sqlParams = [];
        let whereSql = "";
        if (queries.length) {
            const whereBits = queries.map(() => "schemas.content like ?");
            whereSql += ` where ${whereBits.join(" and ")}`;
            sqlParams.push(...queries.map((q) => `%${q}%`));
        }
        const sql = `
    select
      schemas.id,
      schemas.content,
      max(responses.datetime_utc) as recently_used,
      count(*) as times_used
    from schemas
    join responses
      on responses.schema_id = schemas.id
    ${whereSql} group by responses.schema_id
    order by recently_used
    `;
        const rows = db.query(sql, sqlParams);
        if (json_ || nl) {
            for (const line of outputRowsAsJson(rows, {
                jsonCols: ["content"],
                nl,
            })) {
                echo(line);
            }
            return;
        }
        for (const row of rows) {
            echo(`- id: ${row.id}`);
            if (full) {
                const indented = dumps(JSON.parse(row.content), {
                    indent: 2,
                })
                    .split("\n")
                    .map((l) => (l.trim() ? "    " + l : l))
                    .join("\n");
                echo(`  schema: |\n${indented}`);
            }
            else {
                echo(`  summary: |\n    ${schemaSummary(JSON.parse(row.content))}`);
            }
            echo(`  usage: |\n    ${row.times_used} time${row.times_used !== 1 ? "s" : ""}, most recently ${row.recently_used}`);
        }
    },
});
schemasGroup.command({
    name: "show",
    help: "Show a stored schema",
    arguments: [argument("schema_id")],
    options: [
        option(["-p", "--path"], {
            type: new ClickPath({ exists: true, dirOkay: false }),
            help: "Path to log database",
            hidden: true,
        }),
        option(["-d", "--database"], {
            type: new ClickPath({ exists: true, dirOkay: false }),
            help: "Path to log database",
        }),
    ],
    handler: async (params) => {
        let { schema_id, path: pathOption, database } = params;
        if (database && !pathOption) {
            pathOption = database;
        }
        const dbPath = pathOption || logsDbPath();
        if (!fs.existsSync(dbPath)) {
            throw new ClickException(`No log database found at ${dbPath}`);
        }
        const db = new Database(dbPath);
        migrate(db);
        let row;
        try {
            row = db.table("schemas").get(schema_id);
        }
        catch (e) {
            if (e instanceof NotFoundError) {
                throw new ClickException("Invalid schema ID");
            }
            throw e;
        }
        echo(dumps(JSON.parse(row.content), { indent: 2 }));
    },
});
schemasGroup.command({
    name: "dsl",
    help: `Convert LLM's schema DSL to a JSON schema

        llm schema dsl 'name, age int, bio: their bio'`,
    arguments: [argument("input")],
    options: [flag(["--multi"], { help: "Wrap in an array" })],
    handler: async (params) => {
        const schema = schemaDsl(params.input, Boolean(params.multi));
        echo(dumps(schema, { indent: 2 }));
    },
});
// -------------------------------------------------------------- tools cmds
const toolsGroup = new Group({
    name: "tools",
    help: "Manage tools that can be made available to LLMs",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(toolsGroup);
function functionSignature(implementation) {
    if (!implementation)
        return "()";
    const params = parseParams(implementation);
    return `(${params
        .map((p) => p.hasDefault
        ? `${p.name}=${p.default === null ? "None" : JSON.stringify(p.default)}`
        : p.name)
        .join(", ")})`;
}
toolsGroup.command({
    name: "list",
    help: "List available tools that have been provided by plugins",
    arguments: [argument("tool_defs", { nargs: -1 })],
    options: [
        flag(["--json"], { name: "json_", help: "Output as JSON" }),
        option(["--functions"], {
            name: "python_tools",
            help: "Python code block or file path defining functions to register as tools",
            multiple: true,
        }),
    ],
    handler: async (params) => {
        const { tool_defs, json_, python_tools } = params;
        function introspectTools(toolboxClass) {
            return toolboxClass.method_tools().map((tool) => ({
                name: tool.name,
                description: tool.description,
                arguments: tool.input_schema,
                implementation: tool.implementation,
            }));
        }
        let tools;
        if (tool_defs.length) {
            tools = {};
            for (const tool of gatherTools(tool_defs, python_tools)) {
                if (tool instanceof Tool) {
                    tools[tool.name] = tool;
                }
                else {
                    tools[tool.constructor.name] = tool;
                }
            }
        }
        else {
            tools = getTools();
            if (python_tools.length) {
                for (const codeOrPath of python_tools) {
                    for (const tool of toolsFromCode(codeOrPath)) {
                        tools[tool.name] = tool;
                    }
                }
            }
        }
        const outputTools = [];
        const outputToolboxes = [];
        const toolObjects = [];
        const toolboxObjects = [];
        for (const [name, tool] of Object.entries(tools).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
            if (tool instanceof Tool) {
                toolObjects.push(tool);
                outputTools.push({
                    name,
                    description: tool.description,
                    arguments: tool.input_schema,
                    plugin: tool.plugin,
                });
            }
            else {
                toolboxObjects.push(tool);
                const cls = typeof tool === "function"
                    ? tool
                    : tool.constructor;
                outputToolboxes.push({
                    name,
                    tools: introspectTools(cls).map((t) => ({
                        name: t.name,
                        description: t.description,
                        arguments: t.arguments,
                    })),
                });
            }
        }
        if (json_) {
            echo(dumps({ tools: outputTools, toolboxes: outputToolboxes }, { indent: 2 }));
        }
        else {
            for (const tool of toolObjects) {
                const sig = functionSignature(tool.implementation);
                echo(`${tool.name}${sig}${tool.plugin ? ` (plugin: ${tool.plugin})` : ""}\n`);
                if (tool.description) {
                    echo(tool.description
                        .trim()
                        .split("\n")
                        .map((l) => "  " + l)
                        .join("\n") + "\n");
                }
            }
            for (const toolbox of toolboxObjects) {
                const cls = typeof toolbox === "function"
                    ? toolbox
                    : toolbox.constructor;
                echo(cls.name + ":\n");
                for (const tool of cls.method_tools()) {
                    const sig = functionSignature(tool.implementation)
                        .replace("(self, ", "(")
                        .replace("(self)", "()");
                    echo(`  ${tool.name}${sig}\n`);
                    if (tool.description) {
                        echo(tool.description
                            .trim()
                            .split("\n")
                            .map((l) => "    " + l)
                            .join("\n") + "\n");
                    }
                }
            }
        }
    },
});
// ------------------------------------------------------------ aliases cmds
const aliasesGroup = new Group({
    name: "aliases",
    help: "Manage model aliases",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(aliasesGroup);
aliasesGroup.command({
    name: "list",
    help: "List current aliases",
    options: [flag(["--json"], { name: "json_", help: "Output as JSON" })],
    handler: async (params) => {
        const toOutput = [];
        for (const [alias, model] of Object.entries(getModelAliases())) {
            if (alias !== model.model_id) {
                toOutput.push([alias, model.model_id, ""]);
            }
        }
        for (const [alias, embeddingModel] of Object.entries(getEmbeddingModelAliases())) {
            if (alias !== embeddingModel.model_id) {
                toOutput.push([alias, embeddingModel.model_id, "embedding"]);
            }
        }
        if (params.json_) {
            echo(dumps(Object.fromEntries(toOutput.map(([k, v]) => [k, v])), {
                indent: 4,
            }));
            return;
        }
        const maxAliasLength = Math.max(...toOutput.map(([a]) => a.length));
        for (const [alias, modelId, type_] of toOutput) {
            echo(`${alias.padEnd(maxAliasLength)} : ${modelId}${type_ ? ` (${type_})` : ""}`);
        }
    },
});
aliasesGroup.command({
    name: "set",
    help: `Set an alias for a model

    Example usage:

        llm aliases set mini gpt-4o-mini

    Alternatively you can omit the model ID and specify one or more -q options.
    The first model matching all of those query strings will be used.

        llm aliases set mini -q 4o -q mini`,
    arguments: [argument("alias"), argument("model_id", { required: false })],
    options: [
        option(["-q", "--query"], {
            multiple: true,
            help: "Set alias for model matching these strings",
        }),
    ],
    handler: async (params) => {
        const { alias, model_id, query } = params;
        if (!model_id) {
            if (!query.length) {
                throw new ClickException("You must provide a model_id or at least one -q option");
            }
            let found = null;
            for (const modelWithAliases of getModelsWithAliases()) {
                if (query.every((q) => modelWithAliases.matches(q))) {
                    found = modelWithAliases;
                    break;
                }
            }
            if (!found) {
                throw new ClickException("No model found matching query: " + query.join(", "));
            }
            const foundModelId = found.model.model_id;
            setAlias(alias, foundModelId);
            echo(`Alias '${alias}' set to model '${foundModelId}'`, { err: true });
        }
        else {
            setAlias(alias, model_id);
        }
    },
});
aliasesGroup.command({
    name: "remove",
    help: `Remove an alias

    Example usage:

        $ llm aliases remove turbo`,
    arguments: [argument("alias")],
    handler: async (params) => {
        try {
            removeAlias(params.alias);
        }
        catch (ex) {
            throw new ClickException(ex.message);
        }
    },
});
aliasesGroup.command({
    name: "path",
    help: "Output the path to the aliases.json file",
    handler: async () => {
        echo(path.join(userDir(), "aliases.json"));
    },
});
// ---------------------------------------------------------- fragments cmds
const fragmentsGroup = new Group({
    name: "fragments",
    help: `Manage fragments that are stored in the database

    Fragments are reusable snippets of text that are shared across multiple prompts.`,
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(fragmentsGroup);
fragmentsGroup.command({
    name: "list",
    help: "List current fragments",
    options: [
        option(["-q", "--query"], {
            name: "queries",
            multiple: true,
            help: "Search for fragments matching these strings",
        }),
        flag(["--aliases"], { help: "Show only fragments with aliases" }),
        flag(["--json"], { name: "json_", help: "Output as JSON" }),
    ],
    handler: async (params) => {
        const { queries, aliases, json_ } = params;
        const db = new Database(logsDbPath());
        migrate(db);
        const sqlParams = {};
        let paramCount = 0;
        const whereBits = [];
        if (aliases) {
            whereBits.push("fragment_aliases.alias is not null");
        }
        for (const q of queries) {
            paramCount += 1;
            const p = `p${paramCount}`;
            sqlParams[p] = q;
            whereBits.push(`
            (fragments.hash = :${p} or fragment_aliases.alias = :${p}
            or fragments.source like '%' || :${p} || '%'
            or fragments.content like '%' || :${p} || '%')
        `);
        }
        let where = whereBits.join("\n      and\n  ");
        if (where) {
            where = " where " + where;
        }
        const sql = `
    select
        fragments.hash,
        json_group_array(fragment_aliases.alias) filter (
            where
            fragment_aliases.alias is not null
        ) as aliases,
        fragments.datetime_utc,
        fragments.source,
        fragments.content
    from
        fragments
    left join
        fragment_aliases on fragment_aliases.fragment_id = fragments.id
    ${where}
    group by
        fragments.id, fragments.hash, fragments.content, fragments.datetime_utc, fragments.source
    order by fragments.datetime_utc
    `;
        const results = db.query(sql, sqlParams);
        for (const result of results) {
            result.aliases = JSON.parse(result.aliases);
        }
        if (json_) {
            echo(dumps(results, { indent: 4 }));
        }
        else {
            for (const result of results) {
                result.content = truncateString(result.content);
                echo(pyYamlDump([result], {
                    sortKeys: false,
                    width: Number.MAX_SAFE_INTEGER,
                }).trim());
            }
        }
    },
});
fragmentsGroup.command({
    name: "set",
    help: `Set an alias for a fragment

    Accepts an alias and a file path, URL, hash or '-' for stdin

    Example usage:

        llm fragments set mydocs ./docs.md`,
    arguments: [
        argument("alias", { callback: validateFragmentAlias }),
        argument("fragment"),
    ],
    handler: async (params) => {
        const db = new Database(logsDbPath());
        migrate(db);
        let resolved;
        try {
            resolved = (await resolveFragments(db, [params.fragment]))[0];
        }
        catch (ex) {
            if (ex instanceof FragmentNotFound) {
                throw new ClickException(ex.message);
            }
            throw ex;
        }
        migrate(db);
        const aliasSql = `
    insert into fragment_aliases (alias, fragment_id)
    values (:alias, :fragment_id)
    on conflict(alias) do update set
        fragment_id = excluded.fragment_id;
    `;
        const fragmentId = ensureFragment(db, resolved);
        db.execute(aliasSql, { alias: params.alias, fragment_id: fragmentId });
    },
});
fragmentsGroup.command({
    name: "show",
    help: `Display the fragment stored under an alias or hash

        llm fragments show mydocs`,
    arguments: [argument("alias_or_hash")],
    handler: async (params) => {
        const db = new Database(logsDbPath());
        migrate(db);
        let resolved;
        try {
            resolved = (await resolveFragments(db, [params.alias_or_hash]))[0];
        }
        catch (ex) {
            if (ex instanceof FragmentNotFound) {
                throw new ClickException(ex.message);
            }
            throw ex;
        }
        echo(String(resolved));
    },
});
fragmentsGroup.command({
    name: "remove",
    help: `Remove a fragment alias

    Example usage:

        llm fragments remove docs`,
    arguments: [argument("alias", { callback: validateFragmentAlias })],
    handler: async (params) => {
        const db = new Database(logsDbPath());
        migrate(db);
        db.execute("delete from fragment_aliases where alias = :alias", {
            alias: params.alias,
        });
    },
});
fragmentsGroup.command({
    name: "loaders",
    help: "Show fragment loaders registered by plugins",
    handler: async () => {
        let found = false;
        for (const [prefix, loader] of Object.entries(getFragmentLoaders())) {
            if (found) {
                echo("");
            }
            found = true;
            let docs = "Undocumented";
            const loaderDocs = loader.description;
            if (loaderDocs) {
                docs = loaderDocs.trim();
            }
            echo(`${prefix}:`);
            echo(docs
                .split("\n")
                .map((l) => "  " + l)
                .join("\n"));
        }
        if (!found) {
            echo("No fragment loaders found");
        }
    },
});
// ------------------------------------------------------------ plugins cmd
cli.addCommand(new Command({
    name: "plugins",
    help: "List installed plugins",
    options: [
        flag(["--all"], { help: "Include built-in default plugins" }),
        option(["--hook"], {
            name: "hooks",
            help: "Filter for plugins that implement this hook",
            multiple: true,
        }),
    ],
    handler: async (params) => {
        let plugins = getPlugins(Boolean(params.all));
        const hooks = new Set(params.hooks);
        if (hooks.size) {
            plugins = plugins.filter((plugin) => plugin.hooks.some((h) => hooks.has(h)));
        }
        echo(dumps(plugins, { indent: 2 }));
    },
}));
// ---------------------------------------------------- install / uninstall
cli.addCommand(new Command({
    name: "install",
    help: "Install packages from PyPI into the same environment as LLM",
    arguments: [argument("packages", { nargs: -1 })],
    options: [
        flag(["-U", "--upgrade"], {
            help: "Upgrade packages to latest version",
        }),
        option(["-e", "--editable"], {
            help: "Install a project in editable mode from this path",
        }),
        flag(["--force-reinstall"], {
            help: "Reinstall all packages even if they are already up-to-date",
        }),
        flag(["--no-cache-dir"], { help: "Disable the cache" }),
        flag(["--pre"], {
            help: "Include pre-release and development versions",
        }),
    ],
    handler: async () => {
        throw new ClickException("llm-ts does not manage plugin installs; use npm install instead");
    },
}));
cli.addCommand(new Command({
    name: "uninstall",
    help: "Uninstall Python packages from the LLM environment",
    arguments: [argument("packages", { nargs: -1, required: true })],
    options: [flag(["-y", "--yes"], { help: "Don't ask for confirmation" })],
    handler: async () => {
        throw new ClickException("llm-ts does not manage plugin installs; use npm uninstall instead");
    },
}));
// -------------------------------------------------------------- embed cmd
cli.addCommand(new Command({
    name: "embed",
    help: "Embed text and store or return the result",
    arguments: [
        argument("collection", { required: false }),
        argument("id", { required: false }),
    ],
    options: [
        option(["-i", "--input"], {
            type: new ClickPath({ exists: true, allowDash: true }),
            help: "File to embed",
        }),
        option(["-m", "--model"], {
            help: "Embedding model to use",
            envvar: "LLM_EMBEDDING_MODEL",
        }),
        flag(["--store"], { help: "Store the text itself in the database" }),
        option(["-d", "--database"], {
            type: new ClickPath({ dirOkay: false }),
            envvar: "LLM_EMBEDDINGS_DB",
        }),
        option(["-c", "--content"], { help: "Content to embed" }),
        flag(["--binary"], { help: "Treat input as binary data" }),
        option(["--metadata"], {
            help: "JSON object metadata to store",
            callback: jsonValidator("metadata"),
        }),
        option(["-f", "--format"], {
            name: "format_",
            type: new ClickChoice(["json", "blob", "base64", "hex"]),
            help: "Output format",
        }),
    ],
    handler: async (params) => {
        const { collection, id, input, model, store, database, binary, metadata, format_, } = params;
        let content = params.content ?? null;
        if (collection && !id) {
            throw new ClickException("Must provide both collection and id");
        }
        if (store && !collection) {
            throw new ClickException("Must provide collection when using --store");
        }
        const getDb = () => new Database(database ? String(database) : path.join(userDir(), "embeddings.db"));
        let collectionObj = null;
        let modelObj = null;
        let modelId = model ?? null;
        if (collection) {
            const db = getDb();
            if (Collection.exists(db, collection)) {
                collectionObj = new Collection(collection, db);
                modelObj = collectionObj.model();
            }
            else {
                if (!modelId) {
                    modelId = getDefaultEmbeddingModel();
                    if (modelId === null) {
                        throw new ClickException("You need to specify an embedding model (no default model is set)");
                    }
                }
                collectionObj = new Collection(collection, db, { model_id: modelId });
                modelObj = collectionObj.model();
            }
        }
        if (modelObj === null) {
            if (modelId === null) {
                modelId = getDefaultEmbeddingModel();
            }
            try {
                modelObj = getEmbeddingModel(modelId);
            }
            catch (e) {
                if (e instanceof UnknownModelError) {
                    throw new ClickException("You need to specify an embedding model (no default model is set)");
                }
                throw e;
            }
        }
        let showOutput = true;
        if (collection && (format_ === null || format_ === undefined)) {
            showOutput = false;
        }
        // Resolve input text
        if (!content) {
            if (!input || input === "-") {
                content = binary
                    ? click.getStreams().readStdinBuffer()
                    : click.getStreams().readStdin();
            }
            else {
                content = binary
                    ? fs.readFileSync(input)
                    : fs.readFileSync(input, "utf-8");
            }
        }
        if (!content || !content.length) {
            throw new ClickException("No content provided");
        }
        let embedding;
        if (collectionObj) {
            await collectionObj.embed(String(id), content, { metadata, store });
            // Python's embed() returns None when storing via collection.embed;
            // output shows only when a format is given, where embed returns
            // the vector. Match by embedding again through the model.
            embedding = showOutput ? await modelObj.embed(content) : [];
        }
        else {
            embedding = await modelObj.embed(content);
        }
        if (showOutput) {
            if (format_ === "json" || format_ === null || format_ === undefined) {
                echo(dumps(embedding));
            }
            else if (format_ === "blob") {
                echo(encode(embedding).toString("utf-8"));
            }
            else if (format_ === "base64") {
                echo(encode(embedding).toString("base64"));
            }
            else if (format_ === "hex") {
                echo(encode(embedding).toString("hex"));
            }
        }
    },
}));
// -------------------------------------------------------- embed-multi cmd
function rowsFromFile(content, format) {
    const text = content.toString("utf-8");
    let detected = format;
    if (!detected) {
        const trimmed = text.trim();
        if (trimmed.startsWith("["))
            detected = "json";
        else if (trimmed.startsWith("{"))
            detected = "nl";
        else if (text.includes("\t"))
            detected = "tsv";
        else
            detected = "csv";
    }
    if (detected === "json") {
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            throw new Error("JSON input must be an array of objects");
        }
        return parsed;
    }
    if (detected === "nl") {
        return text
            .split("\n")
            .filter((l) => l.trim())
            .map((l) => JSON.parse(l));
    }
    // csv / tsv
    const delimiter = detected === "tsv" ? "\t" : ",";
    const lines = text.split(/\r?\n/).filter((l) => l.length);
    if (!lines.length)
        return [];
    const parseLine = (line) => {
        const cells = [];
        let cell = "";
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (line[i + 1] === '"') {
                        cell += '"';
                        i++;
                    }
                    else {
                        inQuotes = false;
                    }
                }
                else {
                    cell += ch;
                }
            }
            else if (ch === '"') {
                inQuotes = true;
            }
            else if (ch === delimiter) {
                cells.push(cell);
                cell = "";
            }
            else {
                cell += ch;
            }
        }
        cells.push(cell);
        return cells;
    };
    const headers = parseLine(lines[0]);
    return lines.slice(1).map((line) => {
        const cells = parseLine(line);
        const row = {};
        headers.forEach((h, i) => {
            row[h] = cells[i];
        });
        return row;
    });
}
cli.addCommand(new Command({
    name: "embed-multi",
    help: `Store embeddings for multiple strings at once in the specified collection.

    Input data can come from one of three sources:

    1. A CSV, TSV, JSON or JSONL file:
       - CSV/TSV: First column is ID, remaining columns concatenated as content
       - JSON: Array of objects with "id" field and content fields
       - JSONL: Newline-delimited JSON objects

       Examples:
         llm embed-multi docs input.csv
         cat data.json | llm embed-multi docs -
         llm embed-multi docs input.json --format json

    2. A SQL query against a SQLite database:
       - First column returned is used as ID
       - Other columns concatenated to form content

       Examples:
         llm embed-multi docs --sql "SELECT id, title, body FROM posts"
         llm embed-multi docs --attach blog blog.db --sql "SELECT id, content FROM blog.posts"

    3. Files in directories matching glob patterns:
       - Each file becomes one embedding
       - Relative file paths become IDs

       Examples:
         llm embed-multi docs --files docs '**/*.md'
         llm embed-multi images --files photos '*.jpg' --binary
         llm embed-multi texts --files texts '*.txt' --encoding utf-8 --encoding latin-1`,
    arguments: [
        argument("collection"),
        argument("input_path", {
            required: false,
            type: new ClickPath({ exists: true, dirOkay: false, allowDash: true }),
        }),
    ],
    options: [
        option(["--format"], {
            type: new ClickChoice(["json", "csv", "tsv", "nl"]),
            help: "Format of input file - defaults to auto-detect",
        }),
        option(["--files"], {
            nargs: 2,
            multiple: true,
            help: "Embed files in this directory - specify directory and glob pattern",
        }),
        option(["--encoding"], {
            name: "encodings",
            help: "Encodings to try when reading --files",
            multiple: true,
        }),
        flag(["--binary"], { help: "Treat --files as binary data" }),
        option(["--sql"], { help: "Read input using this SQL query" }),
        option(["--attach"], {
            nargs: 2,
            multiple: true,
            help: "Additional databases to attach - specify alias and file path",
        }),
        option(["--batch-size"], {
            type: "int",
            help: "Batch size to use when running embeddings",
        }),
        option(["--prefix"], { help: "Prefix to add to the IDs", default: "" }),
        option(["-m", "--model"], {
            help: "Embedding model to use",
            envvar: "LLM_EMBEDDING_MODEL",
        }),
        option(["--prepend"], {
            help: "Prepend this string to all content before embedding",
        }),
        flag(["--store"], { help: "Store the text itself in the database" }),
        option(["-d", "--database"], {
            type: new ClickPath({ dirOkay: false }),
            envvar: "LLM_EMBEDDINGS_DB",
        }),
    ],
    handler: async (params) => {
        const { collection, input_path, format, files, encodings, binary, sql, attach, batch_size, prefix, model, prepend, store, database, } = params;
        if (binary && !files.length) {
            throw new UsageError("--binary must be used with --files");
        }
        if (binary && encodings.length) {
            throw new UsageError("--binary cannot be used with --encoding");
        }
        if (!input_path && !sql && !files.length) {
            throw new UsageError("Either --sql or input path or --files is required");
        }
        if (files.length) {
            if (input_path || sql || format) {
                throw new UsageError("Cannot use --files with --sql, input path or --format");
            }
        }
        const db = new Database(database ? String(database) : path.join(userDir(), "embeddings.db"));
        for (const [alias, attachPath] of attach) {
            db.attach(alias, attachPath);
        }
        let collectionObj;
        try {
            collectionObj = new Collection(collection, db, {
                model_id: model || getDefaultEmbeddingModel(),
            });
        }
        catch (ex) {
            if (ex instanceof Error &&
                ex.message.includes("model= or model_id=")) {
                throw new ClickException("You need to specify an embedding model (no default model is set)");
            }
            throw ex;
        }
        let rows;
        if (files.length) {
            const encodingList = encodings.length
                ? encodings
                : ["utf-8", "latin-1"];
            rows = [];
            for (const [directory, pattern] of files) {
                if (!fs.existsSync(directory) ||
                    !fs.statSync(directory).isDirectory()) {
                    throw new UsageError(`Invalid directory: ${directory}`);
                }
                const matches = globFallback(directory, pattern);
                for (const rel of matches) {
                    const filePath = path.join(directory, rel);
                    if (fs.statSync(filePath).isDirectory())
                        continue;
                    let content = null;
                    if (binary) {
                        content = fs.readFileSync(filePath);
                    }
                    else {
                        const raw = fs.readFileSync(filePath);
                        for (const encoding of encodingList) {
                            try {
                                content = decodeStrict(raw, encoding);
                                break;
                            }
                            catch {
                                continue;
                            }
                        }
                    }
                    if (content === null) {
                        echo(`Could not decode text in file ${filePath}`, { err: true });
                    }
                    else {
                        rows.push({ id: rel, content });
                    }
                }
            }
        }
        else if (sql) {
            rows = db.query(sql);
        }
        else {
            let content;
            if (input_path !== "-") {
                content = fs.readFileSync(input_path);
            }
            else {
                content = click.getStreams().readStdinBuffer();
            }
            try {
                rows = rowsFromFile(content, format ?? null);
            }
            catch (ex) {
                throw new ClickException(ex.message);
            }
        }
        const tuples = [];
        for (const row of rows) {
            const values = Object.values(row);
            const id = String(prefix ?? "") + String(values[0]);
            let content;
            if (binary) {
                content = values[1];
            }
            else {
                content = values
                    .slice(1)
                    .map((v) => (v === null || v === undefined ? "" : String(v)))
                    .join(" ");
            }
            if (prepend && typeof content === "string") {
                content = String(prepend) + content;
            }
            tuples.push([id, content || ""]);
        }
        const embedKwargs = {
            store: Boolean(store),
        };
        if (batch_size) {
            embedKwargs.batch_size = batch_size;
        }
        await collectionObj.embedMulti(tuples, embedKwargs);
    },
}));
/**
 * Decode a buffer like Python's bytes.decode(encoding): raise on bytes
 * that are invalid for the encoding rather than substituting U+FFFD.
 */
function decodeStrict(raw, encoding) {
    const normalized = encoding.toLowerCase().replace(/[-_]/g, "");
    if (normalized === "latin1" || normalized === "iso88591") {
        // Node's latin1 maps every byte to U+00xx, like Python's latin-1
        return raw.toString("latin1");
    }
    if (normalized === "utf8") {
        return new TextDecoder("utf-8", { fatal: true }).decode(raw);
    }
    return new TextDecoder(encoding, { fatal: true }).decode(raw);
}
function globFallback(directory, pattern) {
    // Basic glob: supports *, **, ? within path segments. Wildcards are
    // swapped for placeholder tokens first so replacement text containing
    // regex metacharacters is not itself rewritten by later steps.
    const regex = new RegExp("^" +
        pattern
            .replace(/[.+^${}()|[\]\\]/g, "\\$&")
            .replace(/\*\*\//g, "")
            .replace(/\*\*/g, "")
            .replace(/\*/g, "[^/]*")
            .replace(/\?/g, "[^/]")
            .replace(//g, "(?:.+/)?")
            .replace(//g, ".*") +
        "$");
    const results = [];
    const walk = (dir, base) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const rel = base ? `${base}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                walk(path.join(dir, entry.name), rel);
            }
            if (regex.test(rel)) {
                results.push(rel);
            }
        }
    };
    walk(directory, "");
    return results;
}
// ------------------------------------------------------------ similar cmd
cli.addCommand(new Command({
    name: "similar",
    help: `Return top N similar IDs from a collection using cosine similarity.

    Example usage:

        llm similar my-collection -c "I like cats"

    Or to find content similar to a specific stored ID:

        llm similar my-collection 1234`,
    arguments: [argument("collection"), argument("id", { required: false })],
    options: [
        option(["-i", "--input"], {
            type: new ClickPath({ exists: true, allowDash: true }),
            help: "File to embed for comparison",
        }),
        option(["-c", "--content"], { help: "Content to embed for comparison" }),
        flag(["--binary"], { help: "Treat input as binary data" }),
        option(["-n", "--number"], {
            type: "int",
            default: 10,
            help: "Number of results to return",
        }),
        flag(["-p", "--plain"], { help: "Output in plain text format" }),
        option(["-d", "--database"], {
            type: new ClickPath({ dirOkay: false }),
            envvar: "LLM_EMBEDDINGS_DB",
        }),
        option(["--prefix"], { help: "Just IDs with this prefix", default: "" }),
    ],
    handler: async (params) => {
        const { collection, id, input, binary, number, plain, database, prefix } = params;
        let content = params.content ?? null;
        if (!id && !content && !input) {
            throw new ClickException("Must provide content or an ID for the comparison");
        }
        const db = new Database(database ? String(database) : path.join(userDir(), "embeddings.db"));
        if (!db.table("embeddings").exists()) {
            throw new ClickException("No embeddings table found in database");
        }
        let collectionObj;
        try {
            collectionObj = new Collection(collection, db, { create: false });
        }
        catch (e) {
            if (e instanceof CollectionDoesNotExist) {
                throw new ClickException("Collection does not exist");
            }
            throw e;
        }
        let results;
        if (id) {
            try {
                results = collectionObj.similarById(id, number, { prefix });
            }
            catch (e) {
                if (e instanceof CollectionDoesNotExist) {
                    throw new ClickException("ID not found in collection");
                }
                throw e;
            }
        }
        else {
            if (!content) {
                if (!input || input === "-") {
                    content = binary
                        ? click.getStreams().readStdinBuffer()
                        : click.getStreams().readStdin();
                }
                else {
                    content = binary
                        ? fs.readFileSync(input)
                        : fs.readFileSync(input, "utf-8");
                }
            }
            if (!content || !content.length) {
                throw new ClickException("No content provided");
            }
            results = await collectionObj.similar(content, number, { prefix });
        }
        for (const result of results) {
            if (plain) {
                echo(`${result.id} (${result.score})\n`);
                if (result.content) {
                    echo(result.content
                        .split("\n")
                        .map((l) => (l.trim() ? "  " + l : l))
                        .join("\n"));
                }
                if (result.metadata) {
                    echo("  " + dumps(result.metadata));
                }
                echo("");
            }
            else {
                echo(dumps({
                    id: result.id,
                    score: result.score,
                    content: result.content,
                    metadata: result.metadata,
                }));
            }
        }
    },
}));
// ------------------------------------------------------- embed-models cmds
const embedModelsGroup = new Group({
    name: "embed-models",
    help: "Manage available embedding models",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(embedModelsGroup);
embedModelsGroup.command({
    name: "list",
    help: "List available embedding models",
    options: [
        option(["-q", "--query"], {
            multiple: true,
            help: "Search for embedding models matching these strings",
        }),
    ],
    handler: async (params) => {
        const output = [];
        for (const modelWithAliases of getEmbeddingModelsWithAliases()) {
            if (params.query.length) {
                if (!params.query.every((q) => modelWithAliases.matches(q))) {
                    continue;
                }
            }
            let s = String(modelWithAliases.model);
            if (modelWithAliases.aliases.length) {
                s += ` (aliases: ${modelWithAliases.aliases.join(", ")})`;
            }
            output.push(s);
        }
        echo(output.join("\n"));
    },
});
embedModelsGroup.command({
    name: "default",
    help: "Show or set the default embedding model",
    arguments: [argument("model", { required: false })],
    options: [
        flag(["--remove-default"], {
            help: "Reset to specifying no default model",
        }),
    ],
    handler: async (params) => {
        const { model, remove_default } = params;
        if (!model && !remove_default) {
            const defaultModel = getDefaultEmbeddingModel();
            if (defaultModel === null) {
                echo("<No default embedding model set>", { err: true });
            }
            else {
                echo(defaultModel);
            }
            return;
        }
        try {
            if (remove_default) {
                setDefaultEmbeddingModel(null);
            }
            else {
                const modelObj = getEmbeddingModel(model);
                setDefaultEmbeddingModel(modelObj.model_id);
            }
        }
        catch (e) {
            if (e instanceof UnknownModelError) {
                throw new ClickException(`Unknown embedding model: ${model}`);
            }
            throw e;
        }
    },
});
// -------------------------------------------------------- collections cmds
const collectionsGroup = new Group({
    name: "collections",
    help: "View and manage collections of embeddings",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
cli.addCommand(collectionsGroup);
collectionsGroup.command({
    name: "path",
    help: "Output the path to the embeddings database",
    handler: async () => {
        echo(path.join(userDir(), "embeddings.db"));
    },
});
collectionsGroup.command({
    name: "list",
    help: "View a list of collections",
    options: [
        option(["-d", "--database"], {
            type: new ClickPath({ dirOkay: false }),
            envvar: "LLM_EMBEDDINGS_DB",
            help: "Path to embeddings database",
        }),
        flag(["--json"], { name: "json_", help: "Output as JSON" }),
    ],
    handler: async (params) => {
        const database = params.database || path.join(userDir(), "embeddings.db");
        const db = new Database(String(database));
        if (!db.table("collections").exists()) {
            throw new ClickException(`No collections table found in ${database}`);
        }
        const rows = db.query(`
    select
        collections.name,
        collections.model,
        count(embeddings.id) as num_embeddings
    from
        collections left join embeddings
        on collections.id = embeddings.collection_id
    group by
        collections.name, collections.model
    `);
        if (params.json_) {
            echo(dumps(rows, { indent: 4 }));
        }
        else {
            for (const row of rows) {
                echo(`${row.name}: ${row.model}`);
                echo(`  ${row.num_embeddings} embedding${row.num_embeddings !== 1 ? "s" : ""}`);
            }
        }
    },
});
collectionsGroup.command({
    name: "delete",
    help: `Delete the specified collection

    Example usage:

        llm collections delete my-collection`,
    arguments: [argument("collection")],
    options: [
        option(["-d", "--database"], {
            type: new ClickPath({ dirOkay: false }),
            envvar: "LLM_EMBEDDINGS_DB",
            help: "Path to embeddings database",
        }),
    ],
    handler: async (params) => {
        const database = params.database || path.join(userDir(), "embeddings.db");
        const db = new Database(String(database));
        let collectionObj;
        try {
            collectionObj = new Collection(params.collection, db, {
                create: false,
            });
        }
        catch (e) {
            if (e instanceof CollectionDoesNotExist) {
                throw new ClickException("Collection does not exist");
            }
            throw e;
        }
        collectionObj.delete();
    },
});
// -------------------------------------------------- models options subgroup
const optionsGroup = new Group({
    name: "options",
    help: "Manage default options for models",
    defaultCommand: "list",
    defaultIfNoArgs: true,
});
modelsGroup.addCommand(optionsGroup);
optionsGroup.command({
    name: "list",
    help: `List default options for all models

    Example usage:

        llm models options list`,
    handler: async () => {
        const options = getAllModelOptions();
        if (!Object.keys(options).length) {
            echo("No default options set for any models.", { err: true });
            return;
        }
        for (const [modelId, modelOptions] of Object.entries(options)) {
            echo(`${modelId}:`);
            for (const [key, value] of Object.entries(modelOptions)) {
                echo(`  ${key}: ${value}`);
            }
        }
    },
});
optionsGroup.command({
    name: "show",
    help: `List default options set for a specific model

    Example usage:

        llm models options show gpt-4o`,
    arguments: [argument("model")],
    handler: async (params) => {
        let modelId;
        try {
            modelId = getModel(params.model).model_id;
        }
        catch (e) {
            if (e instanceof UnknownModelError) {
                modelId = params.model;
            }
            else {
                throw e;
            }
        }
        const options = getModelOptions(modelId);
        if (!Object.keys(options).length) {
            echo(`No default options set for model '${modelId}'.`, { err: true });
            return;
        }
        for (const [key, value] of Object.entries(options)) {
            echo(`${key}: ${value}`);
        }
    },
});
optionsGroup.command({
    name: "set",
    help: `Set a default option for a model

    Example usage:

        llm models options set gpt-4o temperature 0.5`,
    arguments: [argument("model"), argument("key"), argument("value")],
    handler: async (params) => {
        let modelId;
        try {
            const modelObj = getModel(params.model);
            modelId = modelObj.model_id;
            try {
                new modelObj.Options({ [params.key]: params.value });
            }
            catch (ex) {
                if (ex instanceof ValidationError) {
                    throw new ClickException(renderErrors(ex.errors()));
                }
                throw ex;
            }
        }
        catch (e) {
            if (e instanceof UnknownModelError) {
                modelId = params.model;
            }
            else {
                throw e;
            }
        }
        setModelOption(modelId, params.key, params.value);
        echo(`Set default option ${params.key}=${params.value} for model ${modelId}`, { err: true });
    },
});
optionsGroup.command({
    name: "clear",
    help: `Clear default option(s) for a model

    Example usage:

        llm models options clear gpt-4o
        # Or for a single option
        llm models options clear gpt-4o temperature`,
    arguments: [argument("model"), argument("key", { required: false })],
    handler: async (params) => {
        let modelId;
        try {
            modelId = getModel(params.model).model_id;
        }
        catch (e) {
            if (e instanceof UnknownModelError) {
                modelId = params.model;
            }
            else {
                throw e;
            }
        }
        const clearedKeys = [];
        if (!params.key) {
            clearedKeys.push(...Object.keys(getModelOptions(modelId)));
            for (const key_ of clearedKeys) {
                clearModelOption(modelId, key_);
            }
        }
        else {
            clearedKeys.push(params.key);
            clearModelOption(modelId, params.key);
        }
        if (clearedKeys.length) {
            if (clearedKeys.length === 1) {
                echo(`Cleared option '${clearedKeys[0]}' for model ${modelId}`);
            }
            else {
                echo(`Cleared ${clearedKeys.join(", ")} options for model ${modelId}`);
            }
        }
    },
});
// ------------------------------------------------- plugin-provided commands
loadPlugins();
pm.hook.register_commands({ cli });
export { CliRunner };
