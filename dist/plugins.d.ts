import { PluginManager } from "pluggy-ts";
export declare const pm: PluginManager;
/**
 * Python checks `sys._called_from_test` (set by conftest) to skip loading
 * externally-installed plugins during tests; this flag plays that role.
 */
export declare const testState: {
    calledFromTest: boolean;
};
export declare function loadPlugins(): void;
/**
 * Load plugins named in LLM_LOAD_PLUGINS (comma-separated npm package
 * names). Async because ESM imports are async; the CLI awaits this.
 */
export declare function loadEntrypointPlugins(): Promise<void>;
/** Test helper: reset the loaded flag (used by ported conftest fixtures). */
export declare function resetLoadedForTests(): void;
