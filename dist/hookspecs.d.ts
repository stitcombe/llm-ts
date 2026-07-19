import { HookimplMarker, HookspecMarker } from "pluggy-ts";
export declare const hookspec: HookspecMarker;
export declare const hookimpl: HookimplMarker;
export declare const hookspecs: {
    register_commands: (cli: unknown) => void;
    register_models: (register: unknown, model_aliases: unknown) => void;
    register_embedding_models: (register: unknown) => void;
    register_template_loaders: (register: unknown) => void;
    register_fragment_loaders: (register: unknown) => void;
    register_tools: (register: unknown) => void;
};
