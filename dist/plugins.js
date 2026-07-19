import { PluginManager } from "pluggy-ts";
import { hookspecs } from "./hookspecs.js";
import * as openaiModels from "./default_plugins/openai_models.js";
import * as defaultTools from "./default_plugins/default_tools.js";
const DEFAULT_PLUGINS = [
    ["llm.default_plugins.openai_models", openaiModels],
    ["llm.default_plugins.default_tools", defaultTools],
];
export const pm = new PluginManager("llm");
pm.add_hookspecs(hookspecs);
const LLM_LOAD_PLUGINS = process.env.LLM_LOAD_PLUGINS ?? null;
let _loaded = false;
/**
 * Python checks `sys._called_from_test` (set by conftest) to skip loading
 * externally-installed plugins during tests; this flag plays that role.
 */
export const testState = { calledFromTest: false };
export function loadPlugins() {
    if (_loaded)
        return;
    _loaded = true;
    if (!testState.calledFromTest && LLM_LOAD_PLUGINS === null) {
        // Python loads setuptools entrypoints here. The TS equivalent —
        // scanning installed npm packages for an "llm" entry point — happens in
        // loadEntrypointPlugins(), which the CLI entry point awaits before
        // dispatching. Library consumers register plugins explicitly.
    }
    for (const [name, mod] of DEFAULT_PLUGINS) {
        pm.register(mod, name);
    }
}
/**
 * Load plugins named in LLM_LOAD_PLUGINS (comma-separated npm package
 * names). Async because ESM imports are async; the CLI awaits this.
 */
export async function loadEntrypointPlugins() {
    if (LLM_LOAD_PLUGINS === null)
        return;
    for (const packageName of LLM_LOAD_PLUGINS.split(",")
        .map((n) => n.trim())
        .filter(Boolean)) {
        try {
            const mod = await import(packageName);
            pm.register(mod.default ?? mod, packageName);
        }
        catch {
            process.stderr.write(`Plugin ${packageName} could not be found\n`);
        }
    }
}
/** Test helper: reset the loaded flag (used by ported conftest fixtures). */
export function resetLoadedForTests() {
    _loaded = false;
}
