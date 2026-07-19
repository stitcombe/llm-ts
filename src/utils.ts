import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { dumps } from "./pyjson.js";
import { ULID } from "./ulid.js";

const MIME_TYPE_FIXES: Record<string, string> = {
  "audio/wave": "audio/wav",
};

export class Fragment extends String {
  source: string;

  constructor(content: string, source = "") {
    super(content);
    this.source = source;
  }

  id(): string {
    return createHash("sha256").update(this.toString(), "utf8").digest("hex");
  }
}

/**
 * Stand-in for puremagic: sniff a mime type from leading magic bytes.
 * Covers the formats the llm test-suite and attachment handling exercise.
 */
function sniffMimetype(buf: Uint8Array): string | null {
  const startsWith = (bytes: number[], offset = 0) =>
    bytes.every((b, i) => buf[offset + i] === b);
  const ascii = (s: string, offset = 0) =>
    startsWith([...s].map((c) => c.charCodeAt(0)), offset);

  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii("GIF87a") || ascii("GIF89a")) return "image/gif";
  if (ascii("RIFF") && ascii("WEBP", 8)) return "image/webp";
  if (ascii("RIFF") && ascii("WAVE", 8)) return "audio/wave";
  if (ascii("RIFF") && ascii("AVI ", 8)) return "video/x-msvideo";
  if (ascii("%PDF-")) return "application/pdf";
  if (ascii("ID3") || startsWith([0xff, 0xfb]) || startsWith([0xff, 0xf3]))
    return "audio/mpeg";
  if (ascii("OggS")) return "audio/ogg";
  if (ascii("fLaC")) return "audio/flac";
  if (ascii("BM")) return "image/bmp";
  if (startsWith([0x49, 0x49, 0x2a, 0x00]) || startsWith([0x4d, 0x4d, 0x00, 0x2a]))
    return "image/tiff";
  if (ascii("ftypM4A", 4)) return "audio/mp4";
  if (ascii("ftyp", 4)) return "video/mp4";
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  return null;
}

export function mimetypeFromString(
  content: Uint8Array | string,
): string | null {
  const buf =
    typeof content === "string" ? Buffer.from(content, "latin1") : content;
  const type = sniffMimetype(buf);
  if (type === null) return null;
  return MIME_TYPE_FIXES[type] ?? type;
}

/** puremagic falls back to the filename extension when magic-byte
 * detection fails; cover the extensions the suite exercises. */
const EXTENSION_MIMETYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
};

export function mimetypeFromPath(path: string): string | null {
  let buf: Buffer;
  try {
    const fd = fs.openSync(path, "r");
    try {
      buf = Buffer.alloc(64);
      fs.readSync(fd, buf, 0, 64, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  const sniffed = mimetypeFromString(buf);
  if (sniffed !== null) {
    return sniffed;
  }
  const dot = path.lastIndexOf(".");
  if (dot !== -1) {
    const ext = path.slice(dot).toLowerCase();
    return EXTENSION_MIMETYPES[ext] ?? null;
  }
  return null;
}

export function dictsToTableString(
  headings: string[],
  dicts: Array<Record<string, unknown>>,
): string[] {
  const maxLengths = headings.map((h) => h.length);

  for (const d of dicts) {
    headings.forEach((h, i) => {
      if (h in d && String(d[h]).length > maxLengths[i]) {
        maxLengths[i] = String(d[h]).length;
      }
    });
  }

  const res: string[] = [];
  res.push(headings.map((h, i) => h.padEnd(maxLengths[i])).join("    "));
  for (const d of dicts) {
    res.push(
      headings
        .map((h, i) => String(d[h] ?? "").padEnd(maxLengths[i]))
        .join("    "),
    );
  }
  return res;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof String)
  );
}

export function removeDictNoneValues(d: unknown): unknown {
  // Recursively remove keys with value of null/undefined
  if (!isPlainObject(d)) return d;
  const newDict: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(d)) {
    if (value !== null && value !== undefined) {
      if (isPlainObject(value)) {
        const nested = removeDictNoneValues(value) as Record<string, unknown>;
        if (Object.keys(nested).length) {
          newDict[key] = nested;
        }
      } else if (Array.isArray(value)) {
        newDict[key] = value.map((v) => removeDictNoneValues(v));
      } else {
        newDict[key] = value;
      }
    }
  }
  return newDict;
}

export function simplifyUsageDict(d: unknown): unknown {
  // Recursively remove keys with value 0 and empty dictionaries
  function removeEmptyAndZero(obj: unknown): unknown {
    if (isPlainObject(obj)) {
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        if (v === 0 || (isPlainObject(v) && Object.keys(v).length === 0)) {
          continue;
        }
        const value = removeEmptyAndZero(v);
        if (
          value === null ||
          value === undefined ||
          (isPlainObject(value) && Object.keys(value).length === 0)
        ) {
          continue;
        }
        cleaned[k] = value;
      }
      return cleaned;
    }
    return obj;
  }
  const result = removeEmptyAndZero(d);
  if (isPlainObject(result) && Object.keys(result).length === 0) return {};
  return result ?? {};
}

function formatThousands(n: number): string {
  // Python's format(n, ",")
  return n.toLocaleString("en-US");
}

export function tokenUsageString(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
  tokenDetails?: Record<string, unknown> | null,
): string {
  const bits: string[] = [];
  if (inputTokens !== null && inputTokens !== undefined) {
    bits.push(`${formatThousands(inputTokens)} input`);
  }
  if (outputTokens !== null && outputTokens !== undefined) {
    bits.push(`${formatThousands(outputTokens)} output`);
  }
  if (tokenDetails && Object.keys(tokenDetails).length) {
    bits.push(dumps(tokenDetails));
  }
  return bits.join(", ");
}

export function extractFencedCodeBlock(
  text: string,
  last = false,
): string | null {
  const pattern =
    /^(?<fence>`{3,})(?<lang>\w+)?\n(?<code>[\s\S]*?)^\k<fence>[ ]*(?=\n|$)/gm;
  const matches = [...text.matchAll(pattern)];
  if (matches.length) {
    const match = last ? matches[matches.length - 1] : matches[0];
    return match.groups!.code;
  }
  return null;
}

export function makeSchemaId(schema: Record<string, unknown>): [string, string] {
  const schemaJson = dumps(schema, { compact: true });
  const schemaId = bytesToHex(
    blake2b(new TextEncoder().encode(schemaJson), { dkLen: 16 }),
  );
  return [schemaId, schemaJson];
}

function indentText(text: string, prefix: string): string {
  // textwrap.indent: adds prefix to lines that contain non-whitespace
  return text
    .split("\n")
    .map((line) => (line.trim() ? prefix + line : line))
    .join("\n");
}

export function* outputRowsAsJson(
  rows: Array<Record<string, unknown>>,
  {
    nl = false,
    compact = false,
    jsonCols = [] as string[],
  }: { nl?: boolean; compact?: boolean; jsonCols?: string[] } = {},
): Generator<string> {
  let first = true;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const isLast = i === rows.length - 1;
    for (const col of jsonCols) {
      row[col] = JSON.parse(String(row[col]));
    }
    if (nl) {
      yield dumps(row);
    } else if (compact) {
      yield (
        (first ? "[" : " ") +
        dumps(row) +
        (isLast ? "" : ",") +
        (isLast ? "]" : "")
      );
    } else {
      yield (
        (first ? "[\n" : "") +
        indentText(dumps(row, { indent: 2 }), "  ") +
        (isLast ? "" : ",") +
        (isLast ? "\n]" : "")
      );
    }
    first = false;
  }
  if (first && !nl) {
    yield "[]";
  }
}

export function schemaSummary(schema: unknown): string {
  if (!schema || !isPlainObject(schema)) return "";
  const schemaType = schema.type ?? "";

  if (schemaType === "object") {
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    const propSummaries: string[] = [];
    for (const [name, propSchemaRaw] of Object.entries(props)) {
      const propSchema = isPlainObject(propSchemaRaw) ? propSchemaRaw : {};
      const propType = propSchema.type ?? "";
      if (propType === "array") {
        const items = propSchema.items ?? {};
        propSummaries.push(`${name}: [${schemaSummary(items)}]`);
      } else if (propType === "object") {
        propSummaries.push(`${name}: ${schemaSummary(propSchema)}`);
      } else {
        propSummaries.push(name);
      }
    }
    return "{" + propSummaries.join(", ") + "}";
  } else if (schemaType === "array") {
    return schemaSummary(schema.items ?? {});
  }
  return "";
}

export function schemaDsl(
  schemaDsl: string,
  multi = false,
): Record<string, unknown> {
  const typeMapping: Record<string, string> = {
    int: "integer",
    float: "number",
    bool: "boolean",
    str: "string",
  };

  const properties: Record<string, Record<string, unknown>> = {};
  const required: string[] = [];
  const jsonSchema: Record<string, unknown> = {
    type: "object",
    properties,
    required,
  };

  let fields: string[];
  if (schemaDsl.includes("\n")) {
    fields = schemaDsl.split("\n").map((f) => f.trim()).filter(Boolean);
  } else {
    fields = schemaDsl.split(",").map((f) => f.trim()).filter(Boolean);
  }

  for (const field of fields) {
    let fieldInfo: string;
    let description = "";
    const colonIndex = field.indexOf(":");
    if (colonIndex !== -1) {
      fieldInfo = field.slice(0, colonIndex);
      description = field.slice(colonIndex + 1).trim();
    } else {
      fieldInfo = field;
    }

    const fieldParts = fieldInfo.trim().split(/\s+/);
    const fieldName = fieldParts[0].trim();

    let fieldType = "string";
    if (fieldParts.length > 1) {
      const typeIndicator = fieldParts[1].trim();
      if (typeIndicator in typeMapping) {
        fieldType = typeMapping[typeIndicator];
      }
    }

    properties[fieldName] = { type: fieldType };
    if (description) {
      properties[fieldName].description = description;
    }
    required.push(fieldName);
  }

  if (multi) {
    return multiSchema(jsonSchema);
  }
  return jsonSchema;
}

export function multiSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  // "Wrap JSON schema in an 'items': [] array"
  return {
    type: "object",
    properties: { items: { type: "array", items: schema } },
    required: ["items"],
  };
}

export function findUnusedKey(item: Record<string, unknown>, key: string): string {
  // 'Return unused key, e.g. for {"id": "1"} and key "id" returns "id_"'
  while (key in item) {
    key += "_";
  }
  return key;
}

export function truncateString(
  text: string,
  maxLength = 100,
  normalizeWhitespace = false,
  keepEnd = false,
): string {
  if (!text) return text;

  if (normalizeWhitespace) {
    text = text.replace(/\s+/g, " ");
  }

  if (text.length <= maxLength) return text;

  // Minimum sensible length for keep_end is 9 characters: "a... z"
  const minKeepEndLength = 9;

  if (keepEnd && maxLength >= minKeepEndLength) {
    // Subtract 5 for the "... " separator
    const cutoff = Math.floor((maxLength - 5) / 2);
    return text.slice(0, cutoff) + "... " + text.slice(text.length - cutoff);
  }
  return text.slice(0, maxLength - 3) + "...";
}

export function maybeFencedCode(content: string): string {
  // "Return the content as a fenced code block if it looks like code"
  let isCode = false;
  if ((content.match(/</g) ?? []).length > 10) {
    isCode = true;
  }
  if (!isCode) {
    // Are 90% of the lines under 120 chars?
    const lines = content.split(/\r?\n|\r/);
    if (lines.length > 3) {
      const numShort = lines.filter((line) => line.length < 120).length;
      if (numShort / lines.length > 0.9) {
        isCode = true;
      }
    }
  }
  if (isCode) {
    let numBackticks = 3;
    while (content.includes("`".repeat(numBackticks))) {
      numBackticks += 1;
    }
    content =
      "\n" +
      "`".repeat(numBackticks) +
      "\n" +
      content.trim() +
      "\n" +
      "`".repeat(numBackticks);
  }
  return content;
}

const pluginPrefixRe = /^[a-zA-Z0-9_-]+:/;

export function hasPluginPrefix(value: string): boolean {
  // "Check if value starts with alphanumeric prefix followed by a colon"
  return pluginPrefixRe.test(value);
}

export function parseKwargs(argStr: string): Record<string, unknown> {
  // Parse key=value pairs where each value is valid JSON.
  const tokens: string[] = [];
  let buf: string[] = [];
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let escape = false;

  for (const ch of argStr) {
    if (inString) {
      buf.push(ch);
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === stringChar) {
        inString = false;
      }
    } else {
      if (ch === '"' || ch === "'") {
        inString = true;
        stringChar = ch;
        buf.push(ch);
      } else if ("{[(".includes(ch)) {
        depth += 1;
        buf.push(ch);
      } else if ("}])".includes(ch)) {
        depth -= 1;
        buf.push(ch);
      } else if (ch === "," && depth === 0) {
        tokens.push(buf.join("").trim());
        buf = [];
      } else {
        buf.push(ch);
      }
    }
  }
  if (buf.length) {
    tokens.push(buf.join("").trim());
  }

  const kwargs: Record<string, unknown> = {};
  for (const token of tokens) {
    if (!token) continue;
    if (!token.includes("=")) {
      throw new Error(`Invalid keyword spec segment: '${token}'`);
    }
    const eq = token.indexOf("=");
    const key = token.slice(0, eq).trim();
    const valueStr = token.slice(eq + 1).trim();
    let value: unknown;
    try {
      value = JSON.parse(valueStr);
    } catch (e) {
      throw new Error(`Value for '${key}' is not valid JSON: ${valueStr}`, {
        cause: e,
      });
    }
    kwargs[key] = value;
  }
  return kwargs;
}

/**
 * Instantiate a class from a specification string.
 *
 * Deviation from Python: Python's ClassName({"key": "value"}) unpacks the
 * object as **kwargs; in TypeScript the kwargs object is passed as the
 * constructor's single argument. ClassName("x") passes the value
 * positionally, same as Python.
 */
export function instantiateFromSpec(
  classMap: Record<string, new (...args: any[]) => any>,
  spec: string,
): any {
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(spec);
  if (!m) {
    throw new Error(`Invalid spec string: '${spec}'`);
  }
  const className = m[1];
  const argBody = (m[2] ?? "").trim();
  if (!(className in classMap)) {
    throw new Error(`Unknown class '${className}'`);
  }
  const cls = classMap[className];

  // No arguments at all
  if (argBody === "") {
    return new cls();
  }

  // Starts with { -> JSON object to kwargs
  if (argBody.startsWith("{")) {
    let kw: unknown;
    try {
      kw = JSON.parse(argBody);
    } catch (e) {
      throw new Error("Argument JSON object is not valid JSON", { cause: e });
    }
    if (!isPlainObject(kw)) {
      throw new Error("Top-level JSON must be an object when using {} form");
    }
    return new cls(kw);
  }

  // Starts with quote / number / [ / true false null for single positional JSON value
  if (/^\s*(["\[\d-]|true|false|null)/i.test(argBody)) {
    let positionalValue: unknown;
    try {
      positionalValue = JSON.parse(argBody);
    } catch (e) {
      throw new Error("Positional argument must be valid JSON", { cause: e });
    }
    return new cls(positionalValue);
  }

  // Otherwise treat as key=value pairs
  return new cls(parseKwargs(argBody));
}

const TIMESTAMP_LEN = 6;
const RANDOMNESS_LEN = 10;

let _last: Uint8Array | null = null; // 16-byte last produced ULID

/**
 * Return a ULID that is strictly larger than every other ULID returned by
 * this function inside the same process (monotonic within a millisecond).
 */
export function monotonicUlid(): ULID {
  const nowMs = Date.now();

  if (_last === null) {
    _last = fresh(nowMs);
    return new ULID(_last);
  }

  let lastMs = 0;
  for (let i = 0; i < TIMESTAMP_LEN; i++) {
    lastMs = lastMs * 256 + _last[i];
  }

  if (nowMs === lastMs) {
    // Same millisecond: increment the randomness by one
    const next = new Uint8Array(_last);
    let i = 15;
    while (i >= TIMESTAMP_LEN) {
      if (next[i] === 0xff) {
        next[i] = 0;
        i -= 1;
      } else {
        next[i] += 1;
        break;
      }
    }
    if (i < TIMESTAMP_LEN) {
      throw new Error(
        "Randomness overflow: > 2**80 ULIDs requested in one millisecond!",
      );
    }
    _last = next;
    return new ULID(_last);
  }

  _last = fresh(nowMs);
  return new ULID(_last);
}

function fresh(ms: number): Uint8Array {
  const bytes = new Uint8Array(16);
  let ts = BigInt(ms);
  for (let i = TIMESTAMP_LEN - 1; i >= 0; i--) {
    bytes[i] = Number(ts & 0xffn);
    ts >>= 8n;
  }
  bytes.set(randomBytes(RANDOMNESS_LEN), TIMESTAMP_LEN);
  return bytes;
}
