import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const DEFAULT_MODEL = "gpt-4o-mini";

/** click.get_app_dir("io.datasette.llm") equivalent. */
function getAppDir(appName: string): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", appName);
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming");
    return path.join(appData, appName);
  }
  const configHome =
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config");
  return path.join(configHome, appName);
}

export function userDir(): string {
  const llmUserPath = process.env.LLM_USER_PATH;
  const dir = llmUserPath || getAppDir("io.datasette.llm");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function loadKeys(): Record<string, string> {
  const keysPath = path.join(userDir(), "keys.json");
  if (fs.existsSync(keysPath)) {
    return JSON.parse(fs.readFileSync(keysPath, "utf-8"));
  }
  return {};
}

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
export function getKey(options: GetKeyOptions = {}): string | null {
  let { explicitKey = null, keyAlias = null, envVar = null } = options;
  const { alias = null, env = null, input = null } = options;
  if (alias) keyAlias = alias;
  if (env) envVar = env;
  if (input) explicitKey = input;
  const storedKeys = loadKeys();
  // If user specified an alias, use the key stored for that alias
  if (explicitKey && explicitKey in storedKeys) {
    return storedKeys[explicitKey];
  }
  if (explicitKey) {
    // User specified a key that's not an alias, use that
    return explicitKey;
  }
  // Stored key over-rides environment variables over-ride the default key
  if (keyAlias && keyAlias in storedKeys) {
    return storedKeys[keyAlias];
  }
  // Finally try environment variable
  if (envVar && process.env[envVar]) {
    return process.env[envVar]!;
  }
  return null;
}

export function getDefaultModel(
  filename = "default_model.txt",
  defaultValue: string | null = DEFAULT_MODEL,
): string | null {
  const p = path.join(userDir(), filename);
  if (fs.existsSync(p)) {
    return fs.readFileSync(p, "utf-8").trim();
  }
  return defaultValue;
}

export function setDefaultModel(
  model: string | null,
  filename = "default_model.txt",
): void {
  const p = path.join(userDir(), filename);
  if (model === null) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } else {
    fs.writeFileSync(p, model);
  }
}

export function getDefaultEmbeddingModel(): string | null {
  return getDefaultModel("default_embedding_model.txt", null);
}

export function setDefaultEmbeddingModel(model: string | null): void {
  setDefaultModel(model, "default_embedding_model.txt");
}
