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

export type FieldType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "any";

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

export class ValidationError extends Error {
  errors_list: ValidationErrorItem[];
  title: string;

  constructor(title: string, errors: ValidationErrorItem[]) {
    const lines = [
      `${errors.length} validation error${errors.length === 1 ? "" : "s"} for ${title}`,
    ];
    for (const e of errors) {
      lines.push(String(e.loc.join(".")));
      lines.push(`  ${e.msg}`);
    }
    super(lines.join("\n"));
    this.name = "ValidationError";
    this.title = title;
    this.errors_list = errors;
  }

  errors(): ValidationErrorItem[] {
    return this.errors_list;
  }
}

function typeMatches(type: FieldType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string" || value instanceof String;
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return (
        typeof value === "object" && value !== null && !Array.isArray(value)
      );
    case "array":
      return Array.isArray(value);
    case "any":
      return true;
  }
}

function coerce(type: FieldType, value: unknown): unknown {
  // Lax coercion, pydantic-v2 style: strings can become numbers/bools,
  // numbers can become strings is NOT allowed in v2 (strict there), but
  // int-from-float only when integral.
  if (typeMatches(type, value)) return value;
  if (type === "number") {
    if (typeof value === "string" && value.trim() !== "") {
      const n = Number(value);
      if (!Number.isNaN(n)) return n;
    }
    if (typeof value === "boolean") return undefined;
  }
  if (type === "integer") {
    if (typeof value === "number" && Number.isInteger(value)) return value;
    if (typeof value === "string" && /^[+-]?\d+$/.test(value.trim())) {
      return parseInt(value, 10);
    }
  }
  if (type === "boolean") {
    if (typeof value === "string") {
      const lower = value.toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return true;
      if (["false", "0", "no", "off"].includes(lower)) return false;
    }
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (type === "string") {
    if (value instanceof String) return String(value);
  }
  return undefined; // no coercion possible
}

const TYPE_ERROR_MSG: Record<FieldType, string> = {
  string: "Input should be a valid string",
  integer:
    "Input should be a valid integer, unable to parse string as an integer",
  number: "Input should be a valid number, unable to parse string as a number",
  boolean: "Input should be a valid boolean, unable to parse string as a boolean",
  object: "Input should be a valid dictionary",
  array: "Input should be a valid list",
  any: "Invalid input",
};

export type Validator = (value: unknown) => unknown;

/** The @model_validator(mode="after") equivalent: throw to reject. */
export type ModelValidator = (self: BaseModel) => void;

export class BaseModel {
  static fields: Record<string, FieldDef> = {};
  /** field name -> validator; runs after type coercion. Throw to reject. */
  static validators: Record<string, Validator> = {};
  /** Whole-model checks, run once every field has been populated. */
  static modelValidators: ModelValidator[] = [];

  [key: string]: unknown;

  constructor(data: Record<string, unknown> = {}) {
    const cls = this.constructor as typeof BaseModel;
    const fields = cls.allFields();
    const validators = cls.allValidators();
    const errors: ValidationErrorItem[] = [];

    for (const key of Object.keys(data)) {
      if (!(key in fields)) {
        errors.push({
          loc: [key],
          msg: "Extra inputs are not permitted",
          type: "extra_forbidden",
        });
      }
    }

    for (const [name, def] of Object.entries(fields)) {
      let value: unknown;
      if (name in data && data[name] !== undefined) {
        value = data[name];
        const types = Array.isArray(def.type) ? def.type : [def.type];
        let coerced: unknown = undefined;
        let ok = false;
        // Pass 1: exact type match wins (so Union[dict, str] keeps a dict)
        for (const t of types) {
          if (typeMatches(t, value)) {
            coerced = value;
            ok = true;
            break;
          }
        }
        // Pass 2: try coercion
        if (!ok) {
          for (const t of types) {
            const c = coerce(t, value);
            if (c !== undefined) {
              coerced = c;
              ok = true;
              break;
            }
          }
        }
        if (!ok && value === null) {
          // Optional[...] fields accept None
          if (def.default === null) {
            coerced = null;
            ok = true;
          }
        }
        if (!ok) {
          errors.push({
            loc: [name],
            msg: TYPE_ERROR_MSG[
              (Array.isArray(def.type) ? def.type[0] : def.type) as FieldType
            ],
            type: "type_error",
          });
          continue;
        }
        value = coerced;

        // Numeric constraints
        if (typeof value === "number") {
          if (def.ge !== undefined && value < def.ge) {
            errors.push({
              loc: [name],
              msg: `Input should be greater than or equal to ${def.ge}`,
              type: "greater_than_equal",
            });
            continue;
          }
          if (def.le !== undefined && value > def.le) {
            errors.push({
              loc: [name],
              msg: `Input should be less than or equal to ${def.le}`,
              type: "less_than_equal",
            });
            continue;
          }
          if (def.gt !== undefined && value <= def.gt) {
            errors.push({
              loc: [name],
              msg: `Input should be greater than ${def.gt}`,
              type: "greater_than",
            });
            continue;
          }
          if (def.lt !== undefined && value >= def.lt) {
            errors.push({
              loc: [name],
              msg: `Input should be less than ${def.lt}`,
              type: "less_than",
            });
            continue;
          }
        }

        if (def.enum && value !== null && !def.enum.includes(value as string)) {
          // pydantic v2 wording: "'a', 'b' or 'c'"
          const quoted = def.enum.map((v) =>
            JSON.stringify(v).replace(/"/g, "'"),
          );
          const choices =
            quoted.length > 1
              ? `${quoted.slice(0, -1).join(", ")} or ${quoted[quoted.length - 1]}`
              : quoted[0];
          errors.push({
            loc: [name],
            msg: `Input should be ${choices}`,
            type: "enum",
          });
          continue;
        }

        if (validators[name]) {
          try {
            value = validators[name](value);
          } catch (e) {
            errors.push({
              loc: [name],
              msg: `Value error, ${(e as Error).message}`,
              type: "value_error",
            });
            continue;
          }
        }
        this[name] = value;
      } else {
        if (def.default === undefined) {
          errors.push({
            loc: [name],
            msg: "Field required",
            type: "missing",
          });
        } else {
          this[name] = def.default;
        }
      }
    }

    if (errors.length) {
      throw new ValidationError(cls.name, errors);
    }

    for (const modelValidator of cls.allModelValidators()) {
      try {
        modelValidator(this);
      } catch (e) {
        errors.push({
          loc: [],
          msg: `Value error, ${(e as Error).message}`,
          type: "value_error",
        });
      }
    }

    if (errors.length) {
      throw new ValidationError(cls.name, errors);
    }
  }

  /** All fields including inherited ones (subclass fields override). */
  static allFields(): Record<string, FieldDef> {
    const chain: Array<typeof BaseModel> = [];
    let cls = this as typeof BaseModel;
    while (cls && cls !== BaseModel) {
      chain.unshift(cls);
      cls = Object.getPrototypeOf(cls);
    }
    const out: Record<string, FieldDef> = {};
    for (const c of chain) {
      if (Object.prototype.hasOwnProperty.call(c, "fields")) {
        Object.assign(out, c.fields);
      }
    }
    return out;
  }

  static allValidators(): Record<string, Validator> {
    const chain: Array<typeof BaseModel> = [];
    let cls = this as typeof BaseModel;
    while (cls && cls !== BaseModel) {
      chain.unshift(cls);
      cls = Object.getPrototypeOf(cls);
    }
    const out: Record<string, Validator> = {};
    for (const c of chain) {
      if (Object.prototype.hasOwnProperty.call(c, "validators")) {
        Object.assign(out, c.validators);
      }
    }
    return out;
  }

  /** All model validators, base classes first. */
  static allModelValidators(): ModelValidator[] {
    const chain: Array<typeof BaseModel> = [];
    let cls = this as typeof BaseModel;
    while (cls && cls !== BaseModel) {
      chain.unshift(cls);
      cls = Object.getPrototypeOf(cls);
    }
    const out: ModelValidator[] = [];
    for (const c of chain) {
      if (Object.prototype.hasOwnProperty.call(c, "modelValidators")) {
        out.push(...c.modelValidators);
      }
    }
    return out;
  }

  /** dict(model) equivalent: plain object of field values. */
  modelDump(): Record<string, unknown> {
    const cls = this.constructor as typeof BaseModel;
    const out: Record<string, unknown> = {};
    for (const name of Object.keys(cls.allFields())) {
      out[name] = this[name];
    }
    return out;
  }

  /** Iterate [key, value] pairs like pydantic's BaseModel.__iter__. */
  *[Symbol.iterator](): Iterator<[string, unknown]> {
    for (const [k, v] of Object.entries(this.modelDump())) {
      yield [k, v];
    }
  }

  static modelJsonSchema(): Record<string, unknown> {
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    const fields = this.allFields();
    for (const [name, def] of Object.entries(fields)) {
      const prop: Record<string, unknown> = {};
      const types = Array.isArray(def.type) ? def.type : [def.type];
      const jsonTypes = types.filter((t) => t !== "any");
      const isOptional = def.default === null;

      const typeSchemas: Array<Record<string, unknown>> = jsonTypes.map(
        (t) => {
          const s: Record<string, unknown> = { type: t };
          if (t === "array" && def.items) s.items = def.items;
          return s;
        },
      );
      if (isOptional) typeSchemas.push({ type: "null" });

      if (typeSchemas.length === 1) {
        Object.assign(prop, typeSchemas[0]);
      } else if (typeSchemas.length > 1) {
        prop.anyOf = typeSchemas;
      }
      if (def.enum) prop.enum = def.enum;
      // pydantic auto-generates a title from the field name
      prop.title = name
        .split("_")
        .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
        .join(" ");
      if (def.description) prop.description = def.description;
      if (def.ge !== undefined) prop.minimum = def.ge;
      if (def.le !== undefined) prop.maximum = def.le;
      if (def.default !== undefined) prop.default = def.default;
      if (!("default" in def)) required.push(name);
      properties[name] = prop;
    }
    const schema: Record<string, unknown> = {
      properties,
      title: this.name,
      type: "object",
    };
    if (required.length) schema.required = required;
    return schema;
  }
}

/** create_model equivalent. */
export function createModel(
  name: string,
  fields: Record<string, FieldDef>,
  base: typeof BaseModel = BaseModel,
): typeof BaseModel {
  const cls = class extends base {};
  Object.defineProperty(cls, "name", { value: name });
  cls.fields = fields;
  return cls;
}
