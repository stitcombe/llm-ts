export declare const DEFAULT_MODEL = "gpt-4o-mini";
export declare function userDir(): string;
export declare function loadKeys(): Record<string, string>;
export interface GetKeyOptions {
    explicitKey?: string | null;
    keyAlias?: string | null;
    envVar?: string | null;
    alias?: string | null;
    env?: string | null;
    input?: string | null;
}
/**
 * Return an API key based on a hierarchy of potential sources.
 * Port of llm.get_key (positional style folded into the options object).
 */
export declare function getKey(options?: GetKeyOptions): string | null;
export declare function getDefaultModel(filename?: string, defaultValue?: string | null): string | null;
export declare function setDefaultModel(model: string | null, filename?: string): void;
export declare function getDefaultEmbeddingModel(): string | null;
export declare function setDefaultEmbeddingModel(model: string | null): void;
