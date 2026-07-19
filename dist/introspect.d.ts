/**
 * Function-signature introspection: the TS stand-in for Python's
 * inspect.signature + typing.get_type_hints, in the same spirit as
 * pluggy-ts's varnames(). Parses Function.prototype.toString().
 *
 * Type annotations are erased at runtime in TypeScript, so parameter
 * types default to "string" unless the function carries an explicit
 * `annotations` property: `fn.annotations = {count: "integer"}`.
 */
export interface ParamInfo {
    name: string;
    hasDefault: boolean;
    default?: unknown;
}
export declare function parseParams(fn: Function): ParamInfo[];
/** Call fn with arguments drawn by name from kwargs (Python **kwargs style). */
export declare function callWithKwargs(fn: Function, kwargs: Record<string, unknown>, thisArg?: unknown): unknown;
/** Does the function signature include a parameter with this name? */
export declare function acceptsParam(fn: Function, name: string): boolean;
