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

function unwrap(fn: Function): Function {
  let f = fn;
  const seen = new Set<Function>();
  while (
    (f as { __wrapped__?: Function }).__wrapped__ instanceof Function &&
    !seen.has(f)
  ) {
    seen.add(f);
    f = (f as { __wrapped__?: Function }).__wrapped__ as Function;
  }
  return f;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Extract the parameter list source text of a function. */
function paramListSource(fn: Function): string {
  const src = stripComments(unwrap(fn).toString()).trim();

  // Arrow function with a single unparenthesized param: `x => ...`
  const arrowSingle = /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>/.exec(src);
  if (arrowSingle) return arrowSingle[1];

  // Find the first top-level '(' and its matching ')'
  const start = src.indexOf("(");
  if (start === -1) return "";
  let depth = 0;
  let inString: string | null = null;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return src.slice(start + 1, i);
    }
  }
  return "";
}

function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let buf = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      buf += ch;
      if (ch === "\\") {
        buf += text[i + 1] ?? "";
        i++;
      } else if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      buf += ch;
    } else if ("([{".includes(ch)) {
      depth++;
      buf += ch;
    } else if (")]}".includes(ch)) {
      depth--;
      buf += ch;
    } else if (ch === sep && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) out.push(buf);
  return out;
}

function parseLiteral(text: string): { ok: boolean; value?: unknown } {
  const t = text.trim();
  if (t === "null") return { ok: true, value: null };
  if (t === "undefined") return { ok: true, value: undefined };
  if (t === "true") return { ok: true, value: true };
  if (t === "false") return { ok: true, value: false };
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t)) {
    return { ok: true, value: Number(t) };
  }
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return { ok: true, value: t.slice(1, -1) };
  }
  if (t === "[]") return { ok: true, value: [] };
  if (t === "{}") return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(t) };
  } catch {
    return { ok: false };
  }
}

export function parseParams(fn: Function): ParamInfo[] {
  const paramSrc = paramListSource(fn);
  if (!paramSrc.trim()) return [];
  const params: ParamInfo[] = [];
  for (const piece of splitTopLevel(paramSrc, ",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    // Skip rest params and destructuring, like pluggy-ts varnames
    if (trimmed.startsWith("...")) continue;
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) continue;
    const eq = splitTopLevel(trimmed, "=");
    const name = eq[0].trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    if (eq.length > 1) {
      const lit = parseLiteral(eq.slice(1).join("="));
      params.push({
        name,
        hasDefault: true,
        default: lit.ok ? lit.value : undefined,
      });
    } else {
      params.push({ name, hasDefault: false });
    }
  }
  return params;
}

/** Call fn with arguments drawn by name from kwargs (Python **kwargs style). */
export function callWithKwargs(
  fn: Function,
  kwargs: Record<string, unknown>,
  thisArg?: unknown,
): unknown {
  const params = parseParams(fn);
  const args = params.map((p) =>
    p.name in kwargs ? kwargs[p.name] : p.default,
  );
  return fn.apply(thisArg, args);
}

/** Does the function signature include a parameter with this name? */
export function acceptsParam(fn: Function, name: string): boolean {
  try {
    return parseParams(fn).some((p) => p.name === name);
  } catch {
    return false;
  }
}
