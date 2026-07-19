/**
 * Port of tests/test_openai_responses.py — tests for the /v1/responses
 * code path in the default OpenAI plugin. The @pytest.mark.vcr tests
 * replay the recorded cassettes via test/cassettes.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as llm from "../src/index.js";
import { Responses } from "../src/default_plugins/openai_models.js";
import type { ChainResponse, Response } from "../src/models.js";
import {
  Message,
  ReasoningPart,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../src/parts.js";
import { FetchMock } from "./fetchMock.js";
import { loadCassette } from "./cassettes.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

const API_KEY = process.env.PYTEST_OPENAI_API_KEY || "badkey";

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

function responsesSse(
  eventType: string,
  data: Record<string, unknown>,
): string {
  const payload = { type: eventType, ...data };
  return `event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function responsesReasoningSummaryStream(): string[] {
  return [
    responsesSse("response.reasoning_summary_text.delta", {
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: "Thinking",
      sequence_number: 1,
    }),
    responsesSse("response.reasoning_summary_text.delta", {
      item_id: "rs_1",
      output_index: 0,
      summary_index: 0,
      delta: " aloud",
      sequence_number: 2,
    }),
    responsesSse("response.output_item.done", {
      item: {
        id: "rs_1",
        type: "reasoning",
        summary: [{ type: "summary_text", text: "Thinking aloud" }],
        encrypted_content: "encrypted",
        status: "completed",
      },
      output_index: 0,
      sequence_number: 3,
    }),
    responsesSse("response.output_text.delta", {
      item_id: "msg_1",
      output_index: 1,
      content_index: 0,
      delta: "done",
      logprobs: [],
      sequence_number: 4,
    }),
  ];
}

test("test_responses_model_is_registered", () => {
  const model = llm.getModel("gpt-5.5");
  expect(model.constructor.name).toContain("Responses");
  // The chat_completions opt-out option must be exposed.
  const OptionsClass = (model as unknown as { Options: { fields: object } })
    .Options;
  expect(Object.keys(OptionsClass.fields)).toContain("chat_completions");
});

test("test_chat_completions_opt_out_dispatches_to_chat", async () => {
  // When chat_completions=1 is passed, the request must hit
  // /v1/chat/completions, not /v1/responses.
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    json: {
      id: "chatcmpl-x",
      object: "chat.completion",
      model: "gpt-5.5",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hi from chat" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
    },
  });
  const model = llm.getModel("gpt-5.5");
  const response = model.prompt("hello", {
    stream: false,
    chat_completions: true,
    key: "test",
  });
  expect(await response.textAsync()).toBe("hi from chat");
});

function simpleResponsesJson(
  text: string,
  {
    responseId = "resp_test_1",
    messageId = "msg_1",
    model = "gpt-5.5",
  }: { responseId?: string; messageId?: string; model?: string } = {},
): Record<string, unknown> {
  return {
    id: responseId,
    object: "response",
    created_at: 1,
    model,
    output: [
      {
        type: "message",
        id: messageId,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
    },
    status: "completed",
  };
}

test("test_default_routes_to_responses_endpoint", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    json: simpleResponsesJson("hi from responses"),
  });
  const model = llm.getModel("gpt-5.5");
  const response = model.prompt("hello", { stream: false, key: "test" });
  expect(await response.textAsync()).toBe("hi from responses");
  // Ensure we sent to the right endpoint
  const requests = fetchMock.getRequests();
  expect(requests.some((r) => r.url.includes("/v1/responses"))).toBe(true);
  const requestBody = JSON.parse(requests[requests.length - 1].content);
  expect(requestBody.include).toEqual(["reasoning.encrypted_content"]);
  expect(requestBody.reasoning).toEqual({ summary: "auto" });
});

test("test_hide_reasoning_omits_reasoning_summary_from_responses_request", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    json: simpleResponsesJson("hidden"),
  });
  const model = llm.getModel("gpt-5.5");
  const response = model.prompt("hello", {
    stream: false,
    key: "test",
    hide_reasoning: true,
  });
  expect(await response.textAsync()).toBe("hidden");
  const requests = fetchMock.getRequests();
  const requestBody = JSON.parse(requests[requests.length - 1].content);
  expect(requestBody.include).toEqual(["reasoning.encrypted_content"]);
  expect("reasoning" in requestBody).toBe(false);
});

test("test_non_reasoning_responses_model_omits_encrypted_reasoning_include", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    json: simpleResponsesJson("hi from gpt-4.1", { model: "gpt-4.1" }),
  });

  const model = new Responses("gpt-4.1", {
    vision: true,
    supports_schema: true,
    supports_tools: true,
  });
  const response = model.prompt("hello", { stream: false, key: "test" });

  expect(await response.textAsync()).toBe("hi from gpt-4.1");
  const requests = fetchMock.getRequests();
  const requestBody = JSON.parse(requests[requests.length - 1].content);
  expect(requestBody.model).toBe("gpt-4.1");
  expect("include" in requestBody).toBe(false);
  expect("reasoning" in requestBody).toBe(false);
});

test("test_responses_input_translation", async () => {
  // Unit-test the message-to-input translator without hitting the API.
  const model = llm.getModel("gpt-5.5") as unknown as Responses;

  const fakePrompt = {
    messages: [
      new Message({ role: "system", parts: [new TextPart({ text: "be brief" })] }),
      new Message({ role: "user", parts: [new TextPart({ text: "2 + 2?" })] }),
      new Message({
        role: "assistant",
        parts: [
          new ToolCallPart({
            name: "add",
            arguments: { a: 2, b: 2 },
            tool_call_id: "call_abc",
          }),
        ],
      }),
      new Message({
        role: "tool",
        parts: [
          new ToolResultPart({
            name: "add",
            output: "4",
            tool_call_id: "call_abc",
          }),
        ],
      }),
    ],
  };

  const [items, instructions] = await model._build_responses_input(fakePrompt);
  expect(instructions).toBe("be brief");
  // First user message is a plain string content
  expect(items[0]).toEqual({ role: "user", content: "2 + 2?" });
  // function_call from assistant
  expect(items[1].type).toBe("function_call");
  expect(items[1].call_id).toBe("call_abc");
  expect(items[1].name).toBe("add");
  expect(JSON.parse(items[1].arguments as string)).toEqual({ a: 2, b: 2 });
  // tool result
  expect(items[2]).toEqual({
    type: "function_call_output",
    call_id: "call_abc",
    output: "4",
  });
});

test("test_responses_input_translation_assistant_text_uses_easy_input_message", async () => {
  // Plain prior assistant text should match OpenAI's EasyInputMessage shape.
  const model = llm.getModel("gpt-5.5") as unknown as Responses;

  const fakePrompt = {
    messages: [
      new Message({ role: "user", parts: [new TextPart({ text: "hello" })] }),
      new Message({
        role: "assistant",
        parts: [new TextPart({ text: "first-ok" })],
      }),
      new Message({
        role: "user",
        parts: [new TextPart({ text: "what next?" })],
      }),
    ],
  };

  const [items, instructions] = await model._build_responses_input(fakePrompt);

  expect(instructions).toBe(null);
  expect(items).toEqual([
    { role: "user", content: "hello" },
    { role: "assistant", content: "first-ok" },
    { role: "user", content: "what next?" },
  ]);
});

test("test_responses_reply_sends_prior_assistant_text_as_string", async () => {
  // response.reply() should send the same simple history shape a direct
  // openai-python Responses call would use for a text-only assistant turn.
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    json: simpleResponsesJson("first-ok", {
      responseId: "resp_1",
      messageId: "msg_1",
    }),
  });
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    json: simpleResponsesJson("followup-ok", {
      responseId: "resp_2",
      messageId: "msg_2",
    }),
  });

  const model = llm.getModel("gpt-5.5");
  const first = model.prompt("Say exactly: first-ok", {
    stream: false,
    key: "test",
  });
  expect(await first.textAsync()).toBe("first-ok");
  const second = await first.reply("Say exactly: followup-ok", {
    stream: false,
    key: "test",
  });

  expect(await second.textAsync()).toBe("followup-ok");
  const requests = fetchMock.getRequests();
  const secondBody = JSON.parse(requests[requests.length - 1].content);
  expect(secondBody.input).toEqual([
    { role: "user", content: "Say exactly: first-ok" },
    { role: "assistant", content: "first-ok" },
    { role: "user", content: "Say exactly: followup-ok" },
  ]);
});

function responsesModel(): Responses {
  return llm.getModel("gpt-5.5") as unknown as Responses;
}

test("test_responses_kwargs_packs_reasoning_and_verbosity", () => {
  const model = responsesModel();
  const OptionsClass = (
    model as unknown as { Options: new (o?: object) => object }
  ).Options;
  const options = new OptionsClass({
    reasoning_effort: "low",
    verbosity: "low",
  });

  const p = { options, tools: [], schema: null } as never;
  const kwargs = model._build_responses_kwargs(p, false);
  expect(kwargs.reasoning).toEqual({ summary: "auto", effort: "low" });
  expect((kwargs.text as Record<string, unknown>).verbosity).toBe("low");
});

test("test_responses_kwargs_sets_reasoning_summary_without_effort", () => {
  const model = responsesModel();
  const OptionsClass = (
    model as unknown as { Options: new (o?: object) => object }
  ).Options;
  const options = new OptionsClass();

  const p = { options, tools: [], schema: null } as never;
  const kwargs = model._build_responses_kwargs(p, false);
  expect(kwargs.reasoning).toEqual({ summary: "auto" });
});

test("test_responses_kwargs_omits_reasoning_summary_when_hide_reasoning", () => {
  const model = responsesModel();
  const OptionsClass = (
    model as unknown as { Options: new (o?: object) => object }
  ).Options;
  const options = new OptionsClass({ reasoning_effort: "low" });

  const p = { options, tools: [], schema: null, hide_reasoning: true } as never;
  const kwargs = model._build_responses_kwargs(p, false);
  expect(kwargs.reasoning).toEqual({ effort: "low" });
});

test("test_responses_kwargs_omits_empty_reasoning_when_hide_reasoning", () => {
  const model = responsesModel();
  const OptionsClass = (
    model as unknown as { Options: new (o?: object) => object }
  ).Options;
  const options = new OptionsClass();

  const p = { options, tools: [], schema: null, hide_reasoning: true } as never;
  const kwargs = model._build_responses_kwargs(p, false);
  expect("reasoning" in kwargs).toBe(false);
});

test("test_responses_streams_reasoning_summary_text", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    streamChunks: responsesReasoningSummaryStream(),
  });

  const model = llm.getModel("gpt-5.5");
  const response = model.prompt("hello", { key: "test" });
  const events = [];
  for await (const event of response.streamEventsAsync()) {
    events.push(event);
  }

  expect(events.map((e) => [e.type, e.chunk])).toEqual([
    ["reasoning", "Thinking"],
    ["reasoning", " aloud"],
    ["reasoning", ""],
    ["text", "done"],
  ]);
  const messages = await response.messagesAsync();
  const reasoningParts = messages
    .flatMap((m) => m.parts)
    .filter((p) => p instanceof ReasoningPart);
  expect(reasoningParts).toEqual([
    new ReasoningPart({
      text: "Thinking aloud",
      provider_metadata: {
        openai: {
          id: "rs_1",
          encrypted_content: "encrypted",
          summary: [{ type: "summary_text", text: "Thinking aloud" }],
        },
      },
    }),
  ]);
  expect(await response.textAsync()).toBe("done");
});

// ------------------------------------------------- @pytest.mark.vcr tests

describe("vcr", () => {
  test("test_responses_basic_non_streaming", async () => {
    loadCassette(
      fetchMock,
      "test_openai_responses/test_responses_basic_non_streaming",
    );
    const model = llm.getModel("gpt-5.5");
    const response = model.prompt("Reply with exactly: pong", {
      stream: false,
      reasoning_effort: "low",
      key: API_KEY,
    });
    const text = await response.textAsync();
    expect(text.toLowerCase()).toContain("pong");
    // response_json should reflect the Responses API shape
    expect(
      (response.response_json as Record<string, unknown>).object,
    ).toBe("response");
  });

  test("test_responses_basic_streaming", async () => {
    loadCassette(
      fetchMock,
      "test_openai_responses/test_responses_basic_streaming",
    );
    const model = llm.getModel("gpt-5.5");
    const response = model.prompt("Reply with exactly: pong", {
      reasoning_effort: "low",
      key: API_KEY,
    });
    const chunks: string[] = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    const text = chunks.join("");
    expect(text.toLowerCase()).toContain("pong");
  });

  test("test_responses_tool_use", async () => {
    loadCassette(fetchMock, "test_openai_responses/test_responses_tool_use");
    const model = llm.getModel("gpt-5.5");

    function multiply(a: number, b: number): number {
      return a * b;
    }
    multiply.description = "Multiply two numbers.";
    multiply.annotations = { a: "integer", b: "integer" };

    const chain = model.chain("What is 1231 * 2331? Use the multiply tool.", {
      tools: [multiply],
      stream: false,
      options: { reasoning_effort: "low" },
      key: API_KEY,
    });
    const output = await chain.text();
    expect(output.replace(/,/g, "")).toContain("2869461");
    const [first, second] = chain._responses as Response[];
    expect(first.tool_calls()[0].name).toBe("multiply");
    expect(first.tool_calls()[0].arguments).toEqual({ a: 1231, b: 2331 });
    expect(second.prompt.tool_results[0].output).toBe("2869461");
  });

  test("test_responses_tool_use_streaming", async () => {
    loadCassette(
      fetchMock,
      "test_openai_responses/test_responses_tool_use_streaming",
    );
    const model = llm.getModel("gpt-5.5");

    function multiply(a: number, b: number): number {
      return a * b;
    }
    multiply.description = "Multiply two numbers.";
    multiply.annotations = { a: "integer", b: "integer" };

    const chain = model.chain("What is 1231 * 2331? Use the multiply tool.", {
      tools: [multiply],
      options: { reasoning_effort: "low" },
      key: API_KEY,
    });
    const chunks: string[] = [];
    for await (const chunk of chain) {
      chunks.push(chunk);
    }
    const output = chunks.join("");
    expect(output.replace(/,/g, "")).toContain("2869461");
    const [first] = chain._responses as Response[];
    expect(first.tool_calls()[0].arguments).toEqual({ a: 1231, b: 2331 });
  });

  test("test_responses_round_trips_encrypted_reasoning", async () => {
    // Reasoning items returned by the API in the first turn must be
    // echoed back verbatim on the second turn so the model can pick up
    // its hidden chain of thought after the tool result arrives.
    loadCassette(
      fetchMock,
      "test_openai_responses/test_responses_round_trips_encrypted_reasoning",
    );
    const model = llm.getModel("gpt-5.5");

    function lookup_population(country: string): number {
      return 123124;
    }
    lookup_population.description =
      "Returns the current population of the specified fictional country.";

    function can_have_dragons(population: number): boolean {
      return population > 10000;
    }
    can_have_dragons.description =
      "Returns True if the specified population can have dragons.";
    can_have_dragons.annotations = { population: "integer" };

    const chain = model.chain(
      "Pick a clever country name, look up its population, then check " +
        "whether it can have dragons. Be brief.",
      {
        tools: [lookup_population, can_have_dragons],
        stream: false,
        options: { reasoning_effort: "high" },
        key: API_KEY,
      },
    );
    await chain.text(); // drain the chain

    const first = chain._responses[0] as Response;

    // The first response must produce at least one ReasoningPart carrying
    // the opaque encrypted_content + id.
    const reasoningParts = first
      .messages()
      .flatMap((m) => m.parts)
      .filter((p): p is ReasoningPart => p instanceof ReasoningPart);
    expect(
      reasoningParts.length,
      "first turn should expose at least one ReasoningPart",
    ).toBeGreaterThan(0);
    const pm = (reasoningParts[0].provider_metadata ?? {}) as {
      openai?: Record<string, unknown>;
    };
    expect("openai" in pm).toBe(true);
    expect(
      pm.openai!.encrypted_content,
      "encrypted_content must be captured",
    ).toBeTruthy();
    expect(pm.openai!.id, "reasoning id must be captured").toBeTruthy();

    // The second turn's outgoing input must echo back that reasoning
    // item, otherwise the model loses its chain of thought.
    const second = chain._responses[1] as Response;
    const secondInput =
      ((second._prompt_json as Record<string, unknown>) ?? {}).input ?? [];
    const reasoningInputs = (
      secondInput as Array<Record<string, unknown>>
    ).filter((it) => it.type === "reasoning");
    expect(
      reasoningInputs.length,
      "second turn must echo a reasoning input item",
    ).toBeGreaterThan(0);
    expect(reasoningInputs[0].encrypted_content).toBe(
      pm.openai!.encrypted_content,
    );
    expect(reasoningInputs[0].id).toBe(pm.openai!.id);
  });

  test("test_responses_interleaved_reasoning_between_tool_calls", async () => {
    // Tool calls during reasoning: each turn produces fresh reasoning AND
    // every prior reasoning block is round-tripped on every subsequent turn
    // so the model's hidden chain of thought accumulates across the whole
    // chain. This is the GPT-5-class capability that the Chat Completions
    // API can't deliver because it discards reasoning between turns.
    loadCassette(
      fetchMock,
      "test_openai_responses/test_responses_interleaved_reasoning_between_tool_calls",
    );
    const model = llm.getModel("gpt-5.5");

    // Tool whose results force the model to re-plan between calls: each
    // lookup hands the model a NEW key to use next, so the model has to
    // think to figure out the next argument. Parallel tool calls would
    // short-circuit this, so we need the model to reason in series.
    function db_lookup(key: string): string {
      const table: Record<string, string> = {
        start: "Begin with the value 7.",
        step1_7: "Multiply by 13. Now lookup with key step2_<value>.",
        step2_91: "Subtract 11. Now lookup with key step3_<value>.",
        step3_80: "The answer is the value modulo 9. State only the integer.",
      };
      return table[key] ?? "unknown key";
    }
    db_lookup.description = "Look up a value by key in the puzzle database.";

    const conversation = model.conversation({ tools: [db_lookup] });
    conversation.chain_limit = 4;
    const chain = conversation.chain(
      "Solve this puzzle: call db_lookup('start'), then follow each " +
        "instruction step by step. Each lookup tells you the next key " +
        "to use. Compute each step in your head. State only the final " +
        "integer.",
      {
        stream: false,
        options: { reasoning_effort: "high" },
        key: API_KEY,
      },
    );
    // The chain may exceed the limit - we just want enough turns to
    // observe interleaved reasoning, then we stop.
    try {
      await chain.text();
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes("Chain limit")) {
        throw e;
      }
    }

    const responses = chain._responses as Response[];
    expect(
      responses.length,
      `expected at least 3 chained turns, got ${responses.length}`,
    ).toBeGreaterThanOrEqual(3);

    // 1) Fresh reasoning happens on more than just the first turn. This is
    //    the actual interleaved-reasoning capability, not just round-trip.
    const reasoningTokenCounts = responses.map((r) => {
      const u = r.usage();
      const details = (u ? u.details : null) ?? {};
      const outputDetails =
        ((details as Record<string, unknown>).output_tokens_details as
          | Record<string, unknown>
          | undefined) ?? {};
      return (outputDetails.reasoning_tokens as number) || 0;
    });
    const turnsWithFreshReasoning = reasoningTokenCounts.filter(
      (n) => n > 0,
    ).length;
    expect(
      turnsWithFreshReasoning,
      `expected >=2 turns to produce fresh reasoning, got ` +
        `${turnsWithFreshReasoning} (counts: ${reasoningTokenCounts})`,
    ).toBeGreaterThanOrEqual(2);

    // 2) Every reasoning block produced earlier in the chain is round-
    //    tripped on every subsequent turn. The Nth turn's outgoing input
    //    must contain at least N-1 reasoning items.
    for (let i = 1; i < responses.length; i++) {
      const outgoing =
        (((responses[i]._prompt_json as Record<string, unknown>) ?? {})
          .input as Array<Record<string, unknown>>) ?? [];
      const reasoningCount = outgoing.filter(
        (it) => it.type === "reasoning",
      ).length;
      // encrypted_content + id are non-empty on each one
      for (const it of outgoing) {
        if (it.type === "reasoning") {
          expect(it.encrypted_content, "encrypted_content lost").toBeTruthy();
          expect(it.id, "reasoning id lost").toBeTruthy();
        }
      }
      expect(
        reasoningCount,
        `turn ${i} must echo >= ${i} reasoning items, got ${reasoningCount}`,
      ).toBeGreaterThanOrEqual(i);
    }

    // 3) The captured ReasoningParts on the assistant messages carry the
    //    opaque metadata that was actually echoed back on the wire.
    for (let i = 0; i < responses.length - 1; i++) {
      const r = responses[i];
      const rparts = r
        .messages()
        .flatMap((m) => m.parts)
        .filter((p): p is ReasoningPart => p instanceof ReasoningPart);
      if (reasoningTokenCounts[i] > 0) {
        expect(
          rparts.length,
          `turn ${i} produced reasoning_tokens=${reasoningTokenCounts[i]} ` +
            "but no ReasoningPart was persisted",
        ).toBeGreaterThan(0);
        for (const rp of rparts) {
          const pm =
            (((rp.provider_metadata ?? {}) as Record<string, unknown>)
              .openai as Record<string, unknown>) ?? {};
          expect(
            pm.encrypted_content,
            "ReasoningPart missing encrypted_content",
          ).toBeTruthy();
        }
      }
    }
  });
});
