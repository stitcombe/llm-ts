import { HookimplMarker, HookspecMarker } from "pluggy-ts";
export const hookspec = new HookspecMarker("llm");
export const hookimpl = new HookimplMarker("llm");
/* eslint-disable @typescript-eslint/no-unused-vars */
export const hookspecs = {
    register_commands: hookspec(function register_commands(cli) {
        // "Register additional CLI commands, e.g. 'llm mycommand ...'"
    }),
    register_models: hookspec(function register_models(register, model_aliases) {
        // "Register additional model instances representing LLM models that can be called"
    }),
    register_embedding_models: hookspec(function register_embedding_models(register) {
        // "Register additional model instances that can be used for embedding"
    }),
    register_template_loaders: hookspec(function register_template_loaders(register) {
        // "Register additional template loaders with prefixes"
    }),
    register_fragment_loaders: hookspec(function register_fragment_loaders(register) {
        // "Register additional fragment loaders with prefixes"
    }),
    register_tools: hookspec(function register_tools(register) {
        // "Register functions that can be used as tools by the LLMs"
    }),
};
