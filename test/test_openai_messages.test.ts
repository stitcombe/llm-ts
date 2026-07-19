/** Port of tests/test_openai_messages.py */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as llm from "../src/index.js";
import { Chat } from "../src/default_plugins/openai_models.js";
import { Prompt, Attachment, type Response } from "../src/models.js";
import {
  Message,
  ReasoningPart,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  assistant,
  system,
  tool_message,
  user,
} from "../src/parts.js";
import { dumps } from "../src/pyjson.js";
import { FetchMock } from "./fetchMock.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

const API_KEY = "badkey";

let env: TestEnv;
let fetchMock: FetchMock;

beforeEach(() => {
  env = setupTestEnvironment();
  fetchMock = new FetchMock();
  fetchMock.install();
});

afterEach(() => {
  fetchMock.uninstall();
  env.cleanup();
});

function sse(
  delta: Record<string, unknown>,
  {
    finishReason = null,
    usage = null,
    toolCalls = null,
  }: {
    finishReason?: string | null;
    usage?: Record<string, unknown> | null;
    toolCalls?: Array<Record<string, unknown>> | null;
  } = {},
): string {
  const chunk: Record<string, unknown> = {
    id: "c1",
    object: "chat.completion.chunk",
    created: 1700000000,
    model: "gpt-4o-mini",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (toolCalls !== null) {
    (
      (chunk.choices as Array<Record<string, unknown>>)[0]
        .delta as Record<string, unknown>
    ).tool_calls = toolCalls;
  }
  if (usage !== null) {
    chunk.usage = usage;
  }
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

function textStream(): string[] {
  return [
    sse({ role: "assistant", content: "" }),
    sse({ content: "Hel" }),
    sse({ content: "lo" }),
    sse({}, { finishReason: "stop" }),
    "data: [DONE]\n\n",
  ];
}

/** Mimic an OpenAI stream with a tool call (no preceding text). */
function toolCallStream(): string[] {
  return [
    sse({ role: "assistant", content: null }),
    sse(
      {},
      {
        toolCalls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: "" },
          },
        ],
      },
    ),
    sse(
      {},
      { toolCalls: [{ index: 0, function: { arguments: '{"city":' } }] },
    ),
    sse(
      {},
      { toolCalls: [{ index: 0, function: { arguments: '"Paris"}' } }] },
    ),
    sse({}, { finishReason: "tool_calls" }),
    "data: [DONE]\n\n",
  ];
}

/**
 * Text arrives first, then a tool call — the tool call must get
 * a part_index past the text so assembly doesn't mix families.
 */
function textThenToolCallStream(): string[] {
  return [
    sse({ role: "assistant", content: "" }),
    sse({ content: "Looking up" }),
    sse(
      {},
      {
        toolCalls: [
          {
            index: 0,
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"c":1}' },
          },
        ],
      },
    ),
    sse({}, { finishReason: "tool_calls" }),
    "data: [DONE]\n\n",
  ];
}

function addStreamResponse(chunks: string[]): void {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    streamChunks: chunks,
  });
}

/**
 * A plain Chat instance with vision and tools enabled — enough
 * capabilities for the Part subtypes we translate.
 */
function chatModel(): Chat {
  return new Chat("gpt-4o-mini", { vision: true, supports_tools: true });
}

describe("TestBuildMessagesFromExplicitMessages", () => {
  test("test_single_user_message", async () => {
    const model = chatModel();
    const prompt = new Prompt(null, model, { messages: [user("hi")] });
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  test("test_system_plus_user", async () => {
    const model = chatModel();
    const prompt = new Prompt(null, model, {
      messages: [system("be brief"), user("hi")],
    });
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  test("test_user_with_attachment", async () => {
    const model = chatModel();
    const att = new Attachment({
      type: "image/jpeg",
      url: "http://example.com/cat.jpg",
    });
    const prompt = new Prompt(null, model, {
      messages: [user("describe", att)],
    });
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "describe" },
          {
            type: "image_url",
            image_url: { url: "http://example.com/cat.jpg" },
          },
        ],
      },
    ]);
  });

  test("test_assistant_with_tool_call", async () => {
    const model = chatModel();
    const toolCall = new ToolCallPart({
      name: "search",
      arguments: { q: "weather" },
      tool_call_id: "c1",
    });
    const prompt = new Prompt(null, model, {
      messages: [user("search weather"), assistant("on it", toolCall)],
    });
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([
      { role: "user", content: "search weather" },
      {
        role: "assistant",
        content: "on it",
        tool_calls: [
          {
            type: "function",
            id: "c1",
            function: {
              name: "search",
              arguments: dumps({ q: "weather" }),
            },
          },
        ],
      },
    ]);
  });

  test("test_assistant_tool_call_only_no_text", async () => {
    // When an assistant message has tool_calls but no text, OpenAI
    // expects content=null.
    const model = chatModel();
    const toolCall = new ToolCallPart({
      name: "search",
      arguments: { q: "x" },
      tool_call_id: "c1",
    });
    const prompt = new Prompt(null, model, {
      messages: [user("q"), assistant(toolCall)],
    });
    const result = await model.build_messages(prompt, null);
    expect(result[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          type: "function",
          id: "c1",
          function: {
            name: "search",
            arguments: dumps({ q: "x" }),
          },
        },
      ],
    });
  });

  test("test_tool_role_message_with_tool_result", async () => {
    const model = chatModel();
    const tr = new ToolResultPart({
      name: "search",
      output: "sunny",
      tool_call_id: "c1",
    });
    const prompt = new Prompt(null, model, {
      messages: [user("q"), tool_message(tr)],
    });
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([
      { role: "user", content: "q" },
      { role: "tool", tool_call_id: "c1", content: "sunny" },
    ]);
  });

  test("test_multiple_tool_results_emit_multiple_messages", async () => {
    // Parallel tool results: one OpenAI 'tool' message per result.
    const model = chatModel();
    const a = new ToolResultPart({
      name: "t",
      output: "A",
      tool_call_id: "c1",
    });
    const b = new ToolResultPart({
      name: "t",
      output: "B",
      tool_call_id: "c2",
    });
    const prompt = new Prompt(null, model, {
      messages: [user("q"), tool_message(a, b)],
    });
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([
      { role: "user", content: "q" },
      { role: "tool", tool_call_id: "c1", content: "A" },
      { role: "tool", tool_call_id: "c2", content: "B" },
    ]);
  });
});

describe("TestBuildMessagesLegacyFieldsStillWork", () => {
  // prompt=, system=, attachments= keep working — they synthesize
  // messages via Prompt.messages before build_messages sees them.

  test("test_prompt_only", async () => {
    const model = chatModel();
    const prompt = new Prompt("hi", model);
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([{ role: "user", content: "hi" }]);
  });

  test("test_system_and_prompt", async () => {
    const model = chatModel();
    const prompt = new Prompt("hi", model, { system: "be brief" });
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  test("test_attachments", async () => {
    const model = chatModel();
    const att = new Attachment({
      type: "image/jpeg",
      url: "http://example.com/a.jpg",
    });
    const prompt = new Prompt("look", model, { attachments: [att] });
    const result = await model.build_messages(prompt, null);
    expect(result).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          {
            type: "image_url",
            image_url: { url: "http://example.com/a.jpg" },
          },
        ],
      },
    ]);
  });
});

describe("TestBuildMessagesSystemDedup", () => {
  // Explicit messages with repeated system messages dedupe
  // repeated unchanged systems; OpenAI accepts one.

  test("test_same_system_not_repeated", async () => {
    const model = chatModel();
    const prompt = new Prompt(null, model, {
      messages: [
        system("be brief"),
        user("q1"),
        assistant("a1"),
        system("be brief"),
        user("q2"),
      ],
    });
    const result = await model.build_messages(prompt, null);
    const systemMsgs = result.filter((m) => m.role === "system");
    expect(systemMsgs.length).toBe(1);
    expect(systemMsgs[0].content).toBe("be brief");
  });

  test("test_system_change_emitted", async () => {
    const model = chatModel();
    const prompt = new Prompt(null, model, {
      messages: [
        system("be brief"),
        user("q1"),
        assistant("a1"),
        system("be expansive"),
        user("q2"),
      ],
    });
    const result = await model.build_messages(prompt, null);
    const systemMsgs = result.filter((m) => m.role === "system");
    expect(systemMsgs.map((m) => m.content)).toEqual([
      "be brief",
      "be expansive",
    ]);
  });
});

describe("TestBuildMessagesConversationHistory", () => {
  test("test_prior_turn_text_plus_current_user", async () => {
    const model = chatModel();
    const newPrompt = new Prompt(null, model, {
      messages: [
        user("what's 1+1?"),
        assistant("2"),
        user("what about 2+2?"),
      ],
    });
    const result = await model.build_messages(newPrompt, null);
    expect(result).toEqual([
      { role: "user", content: "what's 1+1?" },
      { role: "assistant", content: "2" },
      { role: "user", content: "what about 2+2?" },
    ]);
  });

  test("test_no_double_emission_from_conversation_prompt_flow", async () => {
    // Two staged responses so conv.prompt twice can complete.
    for (const content of ["A1", "A2"]) {
      fetchMock.addResponse({
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        json: {
          model: "gpt-4o-mini",
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1,
            total_tokens: 2,
          },
          choices: [
            {
              message: { role: "assistant", content },
              finish_reason: "stop",
            },
          ],
        },
      });
    }

    const model = llm.getModel("gpt-4o-mini");
    const conv = model.conversation();
    const r1 = conv.prompt("Q1", { key: API_KEY, stream: false });
    await r1.textAsync();
    const r2 = conv.prompt("Q2", { key: API_KEY, stream: false });
    await r2.textAsync();

    // Inspect what was sent on the SECOND turn.
    const requests = fetchMock.getRequests();
    const sentBody = JSON.parse(requests[requests.length - 1].content);
    const sentMessages = sentBody.messages;
    // Exactly three: user(Q1), assistant(A1), user(Q2).
    expect(sentMessages).toEqual([
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]);
  });
});

describe("TestStreamingExecuteYieldsStreamEvents", () => {
  test("test_text_stream_yields_text_events", async () => {
    addStreamResponse(textStream());
    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("hi", { key: API_KEY });
    const events: StreamEvent[] = [];
    for await (const event of response.streamEventsAsync()) {
      events.push(event);
    }
    // At least one StreamEvent, all text, all at part_index=0.
    expect(events.length, "expected stream events").toBeGreaterThan(0);
    for (const e of events) {
      expect(e).toBeInstanceOf(StreamEvent);
      expect(e.type).toBe("text");
      expect(e.part_index).toBe(0);
    }
    // Text chunks concatenate to the expected full text.
    expect(events.map((e) => e.chunk).join("")).toBe("Hello");
  });

  test("test_text_stream_plain_iteration_still_returns_strings", async () => {
    addStreamResponse(textStream());
    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("hi", { key: API_KEY });
    const chunks: string[] = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    for (const c of chunks) {
      expect(typeof c).toBe("string");
    }
    expect(chunks.join("")).toBe("Hello");
  });

  test("test_text_stream_messages_assembled", async () => {
    addStreamResponse(textStream());
    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("hi", { key: API_KEY });
    await response.textAsync();
    expect(await response.messagesAsync()).toEqual([
      new Message({
        role: "assistant",
        parts: [new TextPart({ text: "Hello" })],
      }),
    ]);
  });

  test("test_tool_call_stream_yields_name_and_args_events", async () => {
    addStreamResponse(toolCallStream());

    function get_weather(city: string): string {
      return "sunny";
    }
    get_weather.description = "Look up the weather.";

    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("weather?", {
      tools: [get_weather],
      key: API_KEY,
    });
    const events: StreamEvent[] = [];
    for await (const event of response.streamEventsAsync()) {
      events.push(event);
    }
    const types = events.map((e) => e.type);
    expect(types).toContain("tool_call_name");
    expect(types).toContain("tool_call_args");
    // Name event carries the tool_call_id and name.
    const nameEv = events.find((e) => e.type === "tool_call_name")!;
    expect(nameEv.tool_call_id).toBe("call_1");
    expect(nameEv.chunk).toBe("get_weather");
    // Args events share the same part_index and concatenate to
    // valid JSON.
    const argsEvents = events.filter((e) => e.type === "tool_call_args");
    for (const e of argsEvents) {
      expect(e.part_index).toBe(nameEv.part_index);
    }
    expect(JSON.parse(argsEvents.map((e) => e.chunk).join(""))).toEqual({
      city: "Paris",
    });
  });

  test("test_tool_call_registered_via_add_tool_call", async () => {
    // response.tool_calls() still works — chain/execute relies on it.
    addStreamResponse(toolCallStream());

    function get_weather(city: string): string {
      return "sunny";
    }
    get_weather.description = "Look up the weather.";

    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("weather?", {
      tools: [get_weather],
      key: API_KEY,
    });
    await response.textAsync();
    const tcs = response.tool_calls();
    expect(tcs.length).toBe(1);
    expect(tcs[0].name).toBe("get_weather");
    expect(tcs[0].arguments).toEqual({ city: "Paris" });
    expect(tcs[0].tool_call_id).toBe("call_1");
  });

  test("test_text_then_tool_call_part_index_advances", async () => {
    addStreamResponse(textThenToolCallStream());

    function get_weather(c: number): string {
      return "sunny";
    }
    get_weather.description = "Weather.";
    get_weather.annotations = { c: "integer" };

    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("q", {
      tools: [get_weather],
      key: API_KEY,
    });
    await response.textAsync();
    // After streaming, messages has both a TextPart and a ToolCallPart.
    const parts = (await response.messagesAsync())[0].parts;
    expect(parts.some((p) => p instanceof TextPart)).toBe(true);
    expect(parts.some((p) => p instanceof ToolCallPart)).toBe(true);
    const textPart = parts.find((p) => p instanceof TextPart) as TextPart;
    const tcPart = parts.find(
      (p) => p instanceof ToolCallPart,
    ) as ToolCallPart;
    expect(textPart.text).toBe("Looking up");
    expect(tcPart.name).toBe("get_weather");
    expect(tcPart.arguments).toEqual({ c: 1 });
  });
});

describe("TestAsyncStreamingExecuteYieldsStreamEvents", () => {
  test("test_text_stream_yields_text_events", async () => {
    addStreamResponse(textStream());
    const model = llm.getAsyncModel("gpt-4o-mini");
    const response = model.prompt("hi", { key: API_KEY });
    const events: StreamEvent[] = [];
    for await (const event of response.astream_events()) {
      events.push(event);
    }
    for (const e of events) {
      expect(e).toBeInstanceOf(StreamEvent);
    }
    expect(events.map((e) => e.type)).toEqual(
      new Array(events.length).fill("text"),
    );
    expect(events.map((e) => e.chunk).join("")).toBe("Hello");
  });
});

/** Stream with usage in the final chunk reporting reasoning_tokens. */
function textStreamWithReasoningUsage(reasoningTokens: number): string[] {
  return [
    sse({ role: "assistant", content: "" }),
    sse({ content: "Hel" }),
    sse({ content: "lo" }),
    sse({}, { finishReason: "stop" }),
    // Final chunk with usage — OpenAI streams usage once at the end
    // when stream_options.include_usage=True.
    sse(
      {},
      {
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7,
          completion_tokens_details: { reasoning_tokens: reasoningTokens },
        },
      },
    ),
    "data: [DONE]\n\n",
  ];
}

describe("TestReasoningTokenCount", () => {
  test("test_redacted_reasoning_part_emitted_when_count_present", async () => {
    addStreamResponse(textStreamWithReasoningUsage(150));
    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("hi", { key: API_KEY });
    await response.textAsync();
    expect(await response.messagesAsync()).toEqual([
      new Message({
        role: "assistant",
        parts: [
          new ReasoningPart({ text: "", redacted: true }),
          new TextPart({ text: "Hello" }),
        ],
      }),
    ]);
  });

  test("test_no_reasoning_part_when_zero_or_absent", async () => {
    addStreamResponse(textStreamWithReasoningUsage(0));
    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("hi", { key: API_KEY });
    await response.textAsync();
    const parts = (await response.messagesAsync())[0].parts;
    expect(
      parts.some((p) => p instanceof ReasoningPart),
      "should not add a redacted reasoning part when count=0",
    ).toBe(false);
  });
});

describe("TestNonStreamingExecuteYieldsStreamEvents", () => {
  test("test_non_streaming_text_yields_single_event", async () => {
    fetchMock.addResponse({
      method: "POST",
      url: "https://api.openai.com/v1/chat/completions",
      json: {
        model: "gpt-4o-mini",
        usage: {
          prompt_tokens: 1,
          completion_tokens: 1,
          total_tokens: 2,
        },
        choices: [
          {
            message: { role: "assistant", content: "Hello" },
            finish_reason: "stop",
          },
        ],
      },
    });
    const model = llm.getModel("gpt-4o-mini");
    const response = model.prompt("hi", { key: API_KEY, stream: false });
    const events: StreamEvent[] = [];
    for await (const event of response.streamEventsAsync()) {
      events.push(event);
    }
    expect(events).toEqual([
      new StreamEvent({ type: "text", chunk: "Hello", part_index: 0 }),
    ]);
    expect(await response.messagesAsync()).toEqual([
      new Message({
        role: "assistant",
        parts: [new TextPart({ text: "Hello" })],
      }),
    ]);
  });
});
