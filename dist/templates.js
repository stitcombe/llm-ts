/**
 * Port of llm/templates.py. Uses the mini-pydantic BaseModel so unknown
 * template keys are rejected (extra="forbid"), matching Python.
 */
import { BaseModel } from "./pydantic.js";
export class AttachmentType extends BaseModel {
    static fields = {
        type: { type: "string" },
        value: { type: "string" },
    };
}
export class TemplateMissingVariables extends Error {
    constructor(message) {
        super(message);
        this.name = "MissingVariables";
    }
}
/** Python string.Template pattern: $name, ${name}, $$ escape. */
const TEMPLATE_PATTERN = /\$(?:(\$)|([_a-zA-Z][_a-zA-Z0-9]*)|\{([_a-zA-Z][_a-zA-Z0-9]*)\})/g;
export class Template extends BaseModel {
    // """A reusable prompt template."""
    static fields = {
        name: { type: "string" },
        prompt: { type: "string", default: null },
        system: { type: "string", default: null },
        attachments: { type: "array", default: null },
        attachment_types: { type: "array", default: null },
        model: { type: "string", default: null },
        defaults: { type: "object", default: null },
        options: { type: "object", default: null },
        extract: { type: "boolean", default: null }, // For extracting fenced code blocks
        extract_last: { type: "boolean", default: null },
        schema_object: { type: "object", default: null },
        fragments: { type: "array", default: null },
        system_fragments: { type: "array", default: null },
        tools: { type: "array", default: null },
        functions: { type: "string", default: null },
    };
    static MissingVariables = TemplateMissingVariables;
    /** Controls if inline functions code is trusted (not a model field so
     * YAML cannot set it). */
    _functions_is_trusted = false;
    constructor(data = {}) {
        super(data);
        this._functions_is_trusted = false;
    }
    /** Evaluate the template, returning [prompt, system]. */
    evaluate(input, params = null) {
        const merged = { ...(params ?? {}) };
        merged.input = input;
        if (this.defaults) {
            for (const [k, v] of Object.entries(this.defaults)) {
                if (!(k in merged)) {
                    merged[k] = v;
                }
            }
        }
        let prompt = null;
        let system = null;
        if (!this.prompt) {
            system = Template.interpolate(this.system, merged);
            prompt = input;
        }
        else {
            prompt = Template.interpolate(this.prompt, merged);
            system = Template.interpolate(this.system, merged);
        }
        return [prompt, system];
    }
    /** The set of variable names used in the prompt and system templates. */
    vars() {
        const allVars = new Set();
        for (const text of [this.prompt, this.system]) {
            if (!text)
                continue;
            for (const v of Template.extractVars(text)) {
                allVars.add(v);
            }
        }
        return allVars;
    }
    /** Substitute template variables, raising MissingVariables if absent. */
    static interpolate(text, params) {
        if (!text)
            return text;
        const vars = Template.extractVars(text);
        const missing = vars.filter((p) => !(p in params));
        if (missing.length) {
            throw new TemplateMissingVariables(`Missing variables: ${missing.join(", ")}`);
        }
        return text.replace(TEMPLATE_PATTERN, (match, escaped, named, braced) => {
            if (escaped)
                return "$";
            const name = named ?? braced;
            return String(params[name]);
        });
    }
    /** Extract named variable identifiers from a template string. */
    static extractVars(text) {
        const out = [];
        for (const match of text.matchAll(TEMPLATE_PATTERN)) {
            const name = match[2] ?? match[3];
            if (name)
                out.push(name);
        }
        return out;
    }
}
