/**
 * Port of the llm-echo 0.3a3 test plugin (dev dependency of the Python
 * test suite).
 */

import {
  AsyncConversation,
  AsyncModel,
  AsyncResponse,
  Conversation,
  Model,
  Options,
  Prompt,
  Response,
  ToolCall,
} from "../src/models.js";
import type { FieldDef } from "../src/pydantic.js";
import { hookimpl } from "../src/hookspecs.js";
import { dumps } from "../src/pyjson.js";

class EchoOptions extends Options {
  static override fields: Record<string, FieldDef> = {
    example_bool: {
      type: "boolean",
      description: "Example boolean option",
      default: null,
    },
  };
}

function shared(
  prompt: Prompt,
  stream: boolean,
  response: Response | AsyncResponse,
  conversation: Conversation | AsyncConversation | null,
): Record<string, unknown> | string | null {
  let promptText = prompt.prompt;
  let raw: string | null = null;
  if (promptText.trim() && promptText.trim()[0] === "{") {
    try {
      const promptDict = JSON.parse(promptText);
      raw = promptDict.raw ?? null;
      promptText = promptDict.prompt ?? "";
      const toolCalls = promptDict.tool_calls ?? [];
      for (const toolCall of toolCalls) {
        response.add_tool_call(
          new ToolCall({
            name: toolCall.name,
            arguments: toolCall.arguments ?? {},
          }),
        );
      }
    } catch {
      // not JSON
    }
  }

  if (raw !== null) {
    return raw;
  }

  const info: Record<string, unknown> = {
    prompt: promptText,
    system: prompt.system,
    attachments: prompt.attachments.map((a) => ({
      type: a.type,
      path: a.path,
      url: a.url,
      id: a.id(),
    })),
    stream,
    previous: conversation
      ? conversation.responses.map((r) => ({ prompt: r.prompt.prompt }))
      : [],
  };
  const exampleBool = (prompt.options as EchoOptions).example_bool as
    | boolean
    | null
    | undefined;
  if (exampleBool !== null && exampleBool !== undefined) {
    info.options = { example_bool: exampleBool };
  }
  if (prompt.tool_results.length) {
    info.tool_results = prompt.tool_results.map((r) => ({
      name: r.name,
      output: r.output,
      tool_call_id: r.tool_call_id,
    }));
  }
  return info;
}

export class Echo extends Model {
  model_id = "echo";
  override can_stream = true;
  override supports_tools = true;
  override attachment_types = new Set(["image/png", "image/jpeg", "image/gif"]);
  static override Options = EchoOptions;

  *execute(
    prompt: Prompt,
    stream: boolean,
    response: Response,
    conversation: Conversation | null = null,
  ): Generator<string> {
    const data = shared(prompt, stream, response, conversation);
    if (data !== null && typeof data === "object") {
      yield dumps(data, { indent: 2 });
    } else {
      yield data as string;
    }
  }
}

export class EchoAsync extends AsyncModel {
  model_id = "echo";
  override can_stream = true;
  override supports_tools = true;
  override attachment_types = new Set(["image/png", "image/jpeg", "image/gif"]);
  static override Options = EchoOptions;

  async *execute(
    prompt: Prompt,
    stream: boolean,
    response: AsyncResponse,
    conversation: AsyncConversation | null = null,
  ): AsyncGenerator<string> {
    const data = shared(prompt, stream, response, conversation);
    if (data !== null && typeof data === "object") {
      yield dumps(data, { indent: 2 });
    } else {
      yield data as string;
    }
  }
}

export const register_models = hookimpl(function register_models(
  register: (model: Model, asyncModel?: AsyncModel) => void,
) {
  register(new Echo(), new EchoAsync());
});
