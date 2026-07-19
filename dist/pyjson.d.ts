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
export interface DumpsOptions {
    indent?: number;
    sortKeys?: boolean;
    ensureAscii?: boolean;
    /** Compact separators ("," and ":"), like Python separators=(",", ":") */
    compact?: boolean;
    /** Like Python's default= hook: called for unserializable values. */
    fallback?: (value: unknown) => string;
}
export declare function dumps(value: unknown, options?: DumpsOptions): string;
/** Python json.loads equivalent (plain JSON.parse). */
export declare function loads(text: string): unknown;
