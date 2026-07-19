import { ULID } from "./ulid.js";
export declare class Fragment extends String {
    source: string;
    constructor(content: string, source?: string);
    id(): string;
}
export declare function mimetypeFromString(content: Uint8Array | string): string | null;
export declare function mimetypeFromPath(path: string): string | null;
export declare function dictsToTableString(headings: string[], dicts: Array<Record<string, unknown>>): string[];
export declare function removeDictNoneValues(d: unknown): unknown;
export declare function simplifyUsageDict(d: unknown): unknown;
export declare function tokenUsageString(inputTokens: number | null | undefined, outputTokens: number | null | undefined, tokenDetails?: Record<string, unknown> | null): string;
export declare function extractFencedCodeBlock(text: string, last?: boolean): string | null;
export declare function makeSchemaId(schema: Record<string, unknown>): [string, string];
export declare function outputRowsAsJson(rows: Array<Record<string, unknown>>, { nl, compact, jsonCols, }?: {
    nl?: boolean;
    compact?: boolean;
    jsonCols?: string[];
}): Generator<string>;
export declare function schemaSummary(schema: unknown): string;
export declare function schemaDsl(schemaDsl: string, multi?: boolean): Record<string, unknown>;
export declare function multiSchema(schema: Record<string, unknown>): Record<string, unknown>;
export declare function findUnusedKey(item: Record<string, unknown>, key: string): string;
export declare function truncateString(text: string, maxLength?: number, normalizeWhitespace?: boolean, keepEnd?: boolean): string;
export declare function maybeFencedCode(content: string): string;
export declare function hasPluginPrefix(value: string): boolean;
export declare function parseKwargs(argStr: string): Record<string, unknown>;
/**
 * Instantiate a class from a specification string.
 *
 * Deviation from Python: Python's ClassName({"key": "value"}) unpacks the
 * object as **kwargs; in TypeScript the kwargs object is passed as the
 * constructor's single argument. ClassName("x") passes the value
 * positionally, same as Python.
 */
export declare function instantiateFromSpec(classMap: Record<string, new (...args: any[]) => any>, spec: string): any;
/**
 * Return a ULID that is strictly larger than every other ULID returned by
 * this function inside the same process (monotonic within a millisecond).
 */
export declare function monotonicUlid(): ULID;
