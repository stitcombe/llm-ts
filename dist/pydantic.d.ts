/**
 * Minimal pydantic-v2 stand-in covering what llm uses:
 *
 * - BaseModel subclasses declare fields via a static `fields` map
 * - extra="forbid" semantics: unknown constructor keys raise ValidationError
 * - lax type coercion (string "0.5" -> 0.5 for number fields, etc.) since
 *   CLI -o options arrive as strings
 * - Field() metadata: default, description, ge/le/gt/lt, enum
 * - field validators (the @field_validator equivalent) via static `validators`
 * - model_json_schema() / model_dump()
 *
 * Python-visible API differences are documented in PORTING_NOTES.md.
 */
export type FieldType = "string" | "integer" | "number" | "boolean" | "object" | "array" | "any";
export interface FieldDef {
    /** One or more accepted types (union). */
    type: FieldType | FieldType[];
    /** undefined => required field. null is a valid default. */
    default?: unknown;
    description?: string;
    ge?: number;
    le?: number;
    gt?: number;
    lt?: number;
    enum?: Array<string | number>;
    /** Schema for array items, when type is "array". */
    items?: Record<string, unknown>;
}
export interface ValidationErrorItem {
    loc: Array<string | number>;
    msg: string;
    type: string;
}
export declare class ValidationError extends Error {
    errors_list: ValidationErrorItem[];
    title: string;
    constructor(title: string, errors: ValidationErrorItem[]);
    errors(): ValidationErrorItem[];
}
export type Validator = (value: unknown) => unknown;
/** The @model_validator(mode="after") equivalent: throw to reject. */
export type ModelValidator = (self: BaseModel) => void;
export declare class BaseModel {
    static fields: Record<string, FieldDef>;
    /** field name -> validator; runs after type coercion. Throw to reject. */
    static validators: Record<string, Validator>;
    /** Whole-model checks, run once every field has been populated. */
    static modelValidators: ModelValidator[];
    [key: string]: unknown;
    constructor(data?: Record<string, unknown>);
    /** All fields including inherited ones (subclass fields override). */
    static allFields(): Record<string, FieldDef>;
    static allValidators(): Record<string, Validator>;
    /** All model validators, base classes first. */
    static allModelValidators(): ModelValidator[];
    /** dict(model) equivalent: plain object of field values. */
    modelDump(): Record<string, unknown>;
    /** Iterate [key, value] pairs like pydantic's BaseModel.__iter__. */
    [Symbol.iterator](): Iterator<[string, unknown]>;
    static modelJsonSchema(): Record<string, unknown>;
}
/** create_model equivalent. */
export declare function createModel(name: string, fields: Record<string, FieldDef>, base?: typeof BaseModel): typeof BaseModel;
