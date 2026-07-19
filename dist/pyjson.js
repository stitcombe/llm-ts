/**
 * Python-compatible json.dumps.
 *
 * The CLI's output is compared byte-for-byte against the Python
 * implementation's in the ported test suite, so this mirrors Python's
 * json.dumps formatting rules:
 *
 * - default item/key separators are ", " and ": " (JSON.stringify uses
 *   "," and ":")
 * - with indent, the item separator becomes ",\n" + indentation
 * - ensure_ascii defaults to true (non-ASCII characters are \uXXXX escaped)
 * - floats that are whole numbers cannot be distinguished from ints in JS,
 *   so 1.0 serializes as "1" (deviation, unavoidable)
 */
const ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
};
function encodeString(s, ensureAscii) {
    let out = '"';
    for (const ch of s) {
        const code = ch.codePointAt(0);
        if (ESCAPES[ch] !== undefined) {
            out += ESCAPES[ch];
        }
        else if (code < 0x20) {
            out += "\\u" + code.toString(16).padStart(4, "0");
        }
        else if (code < 0x7f || !ensureAscii) {
            out += ch;
        }
        else if (code > 0xffff) {
            // encode as surrogate pair, like Python's ensure_ascii
            const c = code - 0x10000;
            const hi = 0xd800 + (c >> 10);
            const lo = 0xdc00 + (c & 0x3ff);
            out +=
                "\\u" +
                    hi.toString(16).padStart(4, "0") +
                    "\\u" +
                    lo.toString(16).padStart(4, "0");
        }
        else {
            out += "\\u" + code.toString(16).padStart(4, "0");
        }
    }
    return out + '"';
}
function encodeNumber(n) {
    if (Number.isNaN(n))
        return "NaN";
    if (n === Infinity)
        return "Infinity";
    if (n === -Infinity)
        return "-Infinity";
    return String(n);
}
export function dumps(value, options = {}) {
    const { indent, sortKeys = false, ensureAscii = true, compact = false, fallback, } = options;
    const itemSep = compact ? "," : ", ";
    const keySep = compact ? ":" : ": ";
    function encode(value, depth) {
        if (value === null || value === undefined)
            return "null";
        if (typeof value === "boolean")
            return value ? "true" : "false";
        if (typeof value === "number")
            return encodeNumber(value);
        if (typeof value === "string" || value instanceof String) {
            return encodeString(String(value), ensureAscii);
        }
        if (Array.isArray(value)) {
            if (value.length === 0)
                return "[]";
            const items = value.map((v) => encode(v, depth + 1));
            return wrap("[", items, "]", depth);
        }
        if (typeof value === "object") {
            const obj = value;
            // Objects with a toJSON method (e.g. Date) serialize via it
            if (typeof obj.toJSON === "function") {
                return encode(obj.toJSON(), depth);
            }
            let keys = obj instanceof Map ? [...obj.keys()] : Object.keys(obj);
            if (sortKeys)
                keys = keys.sort();
            if (keys.length === 0)
                return "{}";
            const items = keys.map((k) => {
                const v = obj instanceof Map ? obj.get(k) : obj[k];
                return (encodeString(String(k), ensureAscii) +
                    keySep +
                    encode(v === undefined ? null : v, depth + 1));
            });
            return wrap("{", items, "}", depth);
        }
        if (fallback) {
            return encodeString(fallback(value), ensureAscii);
        }
        throw new TypeError(`Object of type ${typeof value} is not JSON serializable`);
    }
    function wrap(open, items, close, depth) {
        if (indent === undefined) {
            return open + items.join(itemSep) + close;
        }
        const pad = " ".repeat(indent * (depth + 1));
        const closePad = " ".repeat(indent * depth);
        return (open + "\n" + pad + items.join(",\n" + pad) + "\n" + closePad + close);
    }
    return encode(value, 0);
}
/** Python json.loads equivalent (plain JSON.parse). */
export function loads(text) {
    return JSON.parse(text);
}
