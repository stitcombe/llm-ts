/**
 * Port of llm/templates.py. Uses the mini-pydantic BaseModel so unknown
 * template keys are rejected (extra="forbid"), matching Python.
 */
import { BaseModel, FieldDef } from "./pydantic.js";
export declare class AttachmentType extends BaseModel {
    static fields: Record<string, FieldDef>;
    type: string;
    value: string;
}
export declare class TemplateMissingVariables extends Error {
    constructor(message?: string);
}
export declare class Template extends BaseModel {
    static fields: Record<string, FieldDef>;
    name: string;
    prompt: string | null;
    system: string | null;
    attachments: string[] | null;
    attachment_types: AttachmentType[] | null;
    model: string | null;
    defaults: Record<string, unknown> | null;
    options: Record<string, unknown> | null;
    extract: boolean | null;
    extract_last: boolean | null;
    schema_object: Record<string, unknown> | null;
    fragments: string[] | null;
    system_fragments: string[] | null;
    tools: string[] | null;
    functions: string | null;
    static MissingVariables: typeof TemplateMissingVariables;
    /** Controls if inline functions code is trusted (not a model field so
     * YAML cannot set it). */
    _functions_is_trusted: boolean;
    constructor(data?: Record<string, unknown>);
    /** Evaluate the template, returning [prompt, system]. */
    evaluate(input: string, params?: Record<string, unknown> | null): [string | null, string | null];
    /** The set of variable names used in the prompt and system templates. */
    vars(): Set<string>;
    /** Substitute template variables, raising MissingVariables if absent. */
    static interpolate(text: string | null, params: Record<string, unknown>): string | null;
    /** Extract named variable identifiers from a template string. */
    static extractVars(text: string): string[];
}
