/**
 * Port of simonw/condense-json — deduplicates known strings inside a
 * JSON structure. Any string value exactly equal to a replacement value
 * becomes {"$": key}; a string containing replacement values becomes
 * {"$r": ["prefix", {"$": key}, "suffix", ...]}. llm uses this to avoid
 * storing fragment/response text twice inside prompt_json/response_json.
 */
export declare function condenseJson<T>(obj: T, replacements: Record<string, string>): T;
/** Inverse of condenseJson — expands {"$": key} and {"$r": [...]} nodes. */
export declare function uncondenseJson<T>(obj: T, replacements: Record<string, string>): T;
