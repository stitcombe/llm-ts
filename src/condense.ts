/**
 * Port of simonw/condense-json — deduplicates known strings inside a
 * JSON structure. Any string value exactly equal to a replacement value
 * becomes {"$": key}; a string containing replacement values becomes
 * {"$r": ["prefix", {"$": key}, "suffix", ...]}. llm uses this to avoid
 * storing fragment/response text twice inside prompt_json/response_json.
 */

type Json =
  | string
  | number
  | boolean
  | null
  | undefined
  | Json[]
  | { [key: string]: Json };

function condenseString(
  value: string,
  replacements: Array<[string, string]>,
): unknown {
  for (const [key, text] of replacements) {
    if (value === text) {
      return { $: key };
    }
  }
  // Substring pass: replace occurrences of any replacement value.
  const matching = replacements.filter(
    ([, text]) => text && value.includes(text),
  );
  if (!matching.length) {
    return value;
  }
  const segments: unknown[] = [];
  let rest = value;
  while (rest.length) {
    // Find the earliest (then longest) match in the remaining string.
    let bestIndex = -1;
    let bestKey = "";
    let bestText = "";
    for (const [key, text] of matching) {
      const idx = rest.indexOf(text);
      if (idx === -1) continue;
      if (
        bestIndex === -1 ||
        idx < bestIndex ||
        (idx === bestIndex && text.length > bestText.length)
      ) {
        bestIndex = idx;
        bestKey = key;
        bestText = text;
      }
    }
    if (bestIndex === -1) {
      segments.push(rest);
      break;
    }
    if (bestIndex > 0) {
      segments.push(rest.slice(0, bestIndex));
    }
    segments.push({ $: bestKey });
    rest = rest.slice(bestIndex + bestText.length);
  }
  return { $r: segments };
}

export function condenseJson<T>(
  obj: T,
  replacements: Record<string, string>,
): T {
  // Longest values first so overlapping replacements prefer the longest.
  const entries = Object.entries(replacements)
    .filter(([, text]) => typeof text === "string" && text.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  if (!entries.length) {
    return obj;
  }

  function walk(value: Json): unknown {
    if (typeof value === "string") {
      return condenseString(value, entries);
    }
    if (Array.isArray(value)) {
      return value.map((v) => walk(v));
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        out[k] = walk(v as Json);
      }
      return out;
    }
    return value;
  }

  return walk(obj as Json) as T;
}

/** Inverse of condenseJson — expands {"$": key} and {"$r": [...]} nodes. */
export function uncondenseJson<T>(
  obj: T,
  replacements: Record<string, string>,
): T {
  function walk(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((v) => walk(v));
    }
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record);
      if (
        keys.length === 1 &&
        keys[0] === "$" &&
        typeof record.$ === "string" &&
        (record.$ as string) in replacements
      ) {
        return replacements[record.$ as string];
      }
      if (keys.length === 1 && keys[0] === "$r" && Array.isArray(record.$r)) {
        return (record.$r as unknown[])
          .map((seg) => {
            if (typeof seg === "string") return seg;
            const expanded = walk(seg);
            return typeof expanded === "string" ? expanded : "";
          })
          .join("");
      }
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(record)) {
        out[k] = walk(v);
      }
      return out;
    }
    return value;
  }

  return walk(obj) as T;
}
