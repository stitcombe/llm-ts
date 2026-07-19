import { hookimpl } from "../hookspecs.js";
import { llm_time, llm_version } from "../tools.js";

export const register_tools = hookimpl(function register_tools(
  register: (tool: unknown, name?: string) => void,
) {
  register(llm_version);
  register(llm_time);
});
