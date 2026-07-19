/**
 * Port of llm-anthropic/tests/test_anthropic.py.
 *
 * The @pytest.mark.vcr tests replay the recorded Python cassettes
 * (copied to test/cassettes/test_anthropic/) via test/cassettes.ts.
 *
 * Differences from Python noted in PORTING_NOTES.md:
 *  - the plugin is registered explicitly here (in Python it is a separately
 *    installed package discovered via entry points)
 *  - `str(response)` / `response.text()` become `await response.textAsync()`
 *    because fetch-backed models execute asynchronously
 *  - `list(response.stream_events())` becomes a `for await` over
 *    `response.streamEventsAsync()`
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as llm from "../src/index.js";
import { loadConversation } from "../src/cli.js";
import { migrate } from "../src/migrations.js";
import { Database } from "../src/sqliteUtils.js";
import {
  ReasoningPart,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../src/parts.js";
import { pm } from "../src/plugins.js";
import * as anthropic from "../src/plugins/anthropic.js";
import type { ClaudeMessages } from "../src/plugins/anthropic.js";
import type { Conversation, Response } from "../src/models.js";
import { FetchMock } from "./fetchMock.js";
import { loadCassette } from "./cassettes.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

const ANTHROPIC_API_KEY = process.env.PYTEST_ANTHROPIC_API_KEY || "sk-...";
const FIXED_TEST_VERSION = "0.32a0";

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000a60000011a0203000000e699c45e" +
    "00000009504c5445ffffff00ff00fe01001274014a000000474944415478daedd8" +
    "3111003008c0c02e5deaaf2651890456e03ef32bc8915af4a208455114455114455" +
    "1144551d44291244933bbbf0845511445511445511445d1a5d41791c69505150f9f" +
    "c5099fa40000000049454e44ae426082",
  "hex",
);

function fixedVersionTool(): llm.Tool {
  return llm.Tool.function(() => FIXED_TEST_VERSION, {
    name: "fixed_version",
    description: "Return a fixed test version string",
  });
}

/** The Dog schema used by the structured-output tests. */
const Dog = {
  type: "object",
  properties: {
    name: { type: "string", title: "Name" },
    age: { type: "integer", title: "Age" },
    bio: { type: "string", title: "Bio" },
  },
  required: ["name", "age", "bio"],
  title: "Dog",
};

let env: TestEnv;
let fetchMock: FetchMock;

beforeEach(() => {
  env = setupTestEnvironment();
  fetchMock = new FetchMock();
  fetchMock.install();
  pm.register(anthropic, "llm_anthropic");
});

afterEach(() => {
  try {
    pm.unregister(undefined, "llm_anthropic");
  } catch {
    // already unregistered
  }
  fetchMock.uninstall();
  env.cleanup();
});

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

test("test_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_prompt");
  const model = llm.getModel("claude-sonnet-4.5");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Two names for a pet pelican, be brief");
  expect(await response.textAsync()).toBe("- Captain\n- Scoop");
  const responseDict = { ...(response.response_json as Record<string, unknown>) };
  delete responseDict.id; // differs between requests
  expect(responseDict).toEqual({
    container: null,
    content: [
      {
        citations: null,
        parsed_output: null,
        text: "- Captain\n- Scoop",
        type: "text",
      },
    ],
    model: "claude-sonnet-4-5-20250929",
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
  });
  expect(response.input_tokens).toBe(17);
  expect(response.output_tokens).toBe(10);
  expect(response.token_details).toBeNull();
});

test("test_async_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_async_prompt");
  const model = llm.getAsyncModel("claude-sonnet-4.5");
  model.key = model.key || ANTHROPIC_API_KEY; // don't override existing key
  const conversation = model.conversation();
  const response = conversation.prompt("Two names for a pet pelican, be brief");
  expect(await response.text()).toBe("- Captain\n- Scoop");
  const responseDict = { ...(response.response_json as Record<string, unknown>) };
  delete responseDict.id; // differs between requests
  expect(responseDict).toEqual({
    container: null,
    content: [
      {
        citations: null,
        parsed_output: null,
        text: "- Captain\n- Scoop",
        type: "text",
      },
    ],
    model: "claude-sonnet-4-5-20250929",
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
  });
  expect(response.input_tokens).toBe(17);
  expect(response.output_tokens).toBe(10);
  expect(response.token_details).toBeNull();
  const response2 = conversation.prompt("in french");
  expect(await response2.text()).toBe("- Capitaine\n- Bec (beak)");
});

test("test_image_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_image_prompt");
  const model = llm.getModel("claude-sonnet-4.5");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Describe image in three words", {
    attachments: [new llm.Attachment({ content: TINY_PNG })],
  });
  expect(await response.textAsync()).toBe("Red square, green square.");
  const responseDict = { ...(response.response_json as Record<string, unknown>) };
  delete responseDict.id; // differs between requests
  expect(responseDict).toEqual({
    container: null,
    content: [
      {
        citations: null,
        parsed_output: null,
        text: "Red square, green square.",
        type: "text",
      },
    ],
    model: "claude-sonnet-4-5-20250929",
    role: "assistant",
    stop_details: null,
    stop_reason: "end_turn",
    stop_sequence: null,
    type: "message",
  });
  expect(response.input_tokens).toBe(83);
  expect(response.output_tokens).toBe(9);
  expect(response.token_details).toBeNull();
});

test("test_image_with_no_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_image_with_no_prompt");
  const model = llm.getModel("claude-sonnet-4.5");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt(null, {
    attachments: [new llm.Attachment({ content: TINY_PNG })],
  });
  expect(await response.textAsync()).toBe(
    "I need to describe what I see in this image.\n\n" +
      "The image shows two solid colored rectangles arranged vertically on a white background:\n\n" +
      "1. **Top rectangle**: A bright red rectangle positioned in the upper portion of the image\n" +
      "2. **Bottom rectangle**: A bright green (lime green) rectangle positioned in the lower portion of the image\n\n" +
      "Both rectangles appear to be roughly the same size and shape (horizontal rectangles/landscape orientation), " +
      "and they are separated by white space between them.",
  );
});

test("test_url_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_url_prompt");
  const model = llm.getModel("claude-sonnet-4.5");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("describe image", {
    attachments: [
      new llm.Attachment({
        url: "https://static.simonwillison.net/static/2024/pelican.jpg",
      }),
    ],
  });
  expect(await response.textAsync()).toBe(
    "This image shows a **brown pelican** perched on rocky terrain at what appears " +
      "to be a marina or harbor. The pelican is captured in profile, displaying its " +
      "distinctive features:\n\n" +
      "- **Long, prominent bill** with the characteristic pelican pouch\n" +
      "- **White head and neck** with darker gray-brown plumage on its body and wings\n" +
      "- **Sturdy build** with detailed feather texture visible in the wings\n\n" +
      "The background shows several **boats docked in a marina**, slightly out of " +
      "focus, creating a typical coastal or waterfront setting. The lighting suggests " +
      "this photo was taken during daytime, with bright natural light that creates " +
      "a slight halo effect around the bird's head.\n\n" +
      "The pelican appears calm and at rest, which is common behavior for these " +
      "seabirds in harbor areas where they often wait for fishing opportunities or " +
      "scraps from nearby boats. The rocky perch and marina setting are typical " +
      "habitats where pelicans congregate along coastlines.",
  );
});

test("test_schema_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_schema_prompt");
  const model = llm.getModel("claude-sonnet-4.5");
  const response = model.prompt("Invent a good dog", {
    schema: Dog,
    key: ANTHROPIC_API_KEY,
  });
  const dog = JSON.parse(await response.textAsync());
  expect(dog).toEqual({
    name: "Biscuit",
    age: 4,
    bio:
      "Biscuit is a golden retriever with a gentle soul and boundless " +
      "enthusiasm. He greets every person with a wagging tail and has an uncanny " +
      "ability to sense when someone needs comfort. His favorite activities " +
      "include playing fetch at the beach, napping in sunny spots, and stealing " +
      "socks to add to his secret collection under the bed.",
  });
});

test("test_schema_prompt_async", async () => {
  loadCassette(fetchMock, "test_anthropic/test_schema_prompt_async");
  const model = llm.getAsyncModel("claude-sonnet-4.5");
  const response = model.prompt("Invent a terrific dog", {
    schema: Dog,
    key: ANTHROPIC_API_KEY,
  });
  const dog = JSON.parse(await response.text());
  expect(dog).toEqual({
    name: "Luna",
    age: 4,
    bio:
      "Luna is a brilliant Golden Retriever with a heart of gold who serves as " +
      "a certified therapy dog at children's hospitals. She has an uncanny " +
      "ability to sense when someone needs comfort and gently rests her head on " +
      "their lap. Luna loves swimming in lakes, playing fetch with her favorite " +
      "tennis ball, and has learned over 50 commands including helping her owner " +
      "retrieve items from around the house.",
  });
});

test("test_prompt_with_prefill_and_stop_sequences", async () => {
  loadCassette(
    fetchMock,
    "test_anthropic/test_prompt_with_prefill_and_stop_sequences",
  );
  const model = llm.getModel("claude-haiku-4.5");
  const response = model.prompt("Very short function describing a pelican", {
    prefill: "```python",
    stop_sequences: ["```"],
    hide_prefill: true,
    key: ANTHROPIC_API_KEY,
  });
  expect(await response.textAsync()).toBe(
    "\ndef pelican():\n" +
      '    return "A large waterbird with a long bill and a throat pouch for catching fish."\n',
  );
});

test("test_thinking_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_thinking_prompt");
  const model = llm.getModel("claude-sonnet-4.5");
  const conversation = model.conversation();
  const response = conversation.prompt("Two names for a pet pelican, be brief", {
    thinking: true,
    key: ANTHROPIC_API_KEY,
  });
  expect(await response.textAsync()).toBe("- Captain\n- Scoop");
  const responseDict = { ...(response.response_json as Record<string, unknown>) };
  delete responseDict.id; // differs between requests
  // Check structure without exact thinking signature
  expect(responseDict.model).toBe("claude-sonnet-4-5-20250929");
  expect(responseDict.stop_reason).toBe("end_turn");
  const contentTypes = (
    responseDict.content as Array<Record<string, unknown>>
  ).map((block) => block.type);
  expect(contentTypes).toContain("thinking");
  expect(contentTypes).toContain("text");
  expect(response.input_tokens).toBe(46);
  expect(response.output_tokens).toBe(84);
  expect(response.token_details).toBeNull();
});

test("test_tools", async () => {
  loadCassette(fetchMock, "test_anthropic/test_tools");
  const model = llm.getModel("claude-haiku-4.5");
  const names = ["Charles", "Sammy"];
  const chainResponse = model.chain("Two names for a pet pelican", {
    tools: [
      llm.Tool.function(() => names.shift(), {
        name: "pelican_name_generator",
      }),
    ],
    key: ANTHROPIC_API_KEY,
  });
  const text = await chainResponse.text();
  expect(text).toBe(
    " Here are two great names for your pet pelican:\n\n" +
      "1. **Charles** - A sophisticated and dignified name, perfect for a pelican with personality!\n" +
      "2. **Sammy** - A friendly and playful name that gives off warm, approachable vibes.\n\n" +
      "Either of these would make an excellent name for your feathered friend! \u{1f985}",
  );
  const toolCalls = (chainResponse._responses[0] as Response).tool_calls();
  expect(toolCalls).toHaveLength(2);
  expect(toolCalls.every((c) => c.name === "pelican_name_generator")).toBe(true);
  expect(
    chainResponse._responses[1].prompt.tool_results.map((r) => r.output),
  ).toEqual(["Charles", "Sammy"]);
});

test("test_fixed_version_tool_chain_regression", async () => {
  loadCassette(
    fetchMock,
    "test_anthropic/test_fixed_version_tool_chain_regression",
  );
  const model = llm.getModel("claude-haiku-4.5") as unknown as ClaudeMessages;
  const fixedVersion = fixedVersionTool();

  const chainResponse = (model as unknown as llm.Model).chain(
    "Use the fixed_version tool. Then tell me the version and make one short joke about it.",
    { tools: [fixedVersion], key: ANTHROPIC_API_KEY },
  );
  const text = await chainResponse.text();
  expect(text).toContain(FIXED_TEST_VERSION);
  expect(chainResponse._responses).toHaveLength(2);
  const secondResponse = chainResponse._responses[1];
  expect(secondResponse.prompt.tool_results[0].output).toBe(FIXED_TEST_VERSION);
  const secondRequestMessages = model.build_messages(
    secondResponse.prompt,
    secondResponse.conversation as Conversation | null,
  );
  expect(secondRequestMessages.map((m) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  const assistantContent = secondRequestMessages[1]
    .content as Array<Record<string, unknown>>;
  expect(assistantContent[assistantContent.length - 1].type).toBe("tool_use");
  expect(
    (secondRequestMessages[2].content as Array<Record<string, unknown>>).map(
      (b) => b.type,
    ),
  ).toEqual(["tool_result"]);
});

test("test_fixed_version_tool_chain_with_thinking_display_regression", async () => {
  loadCassette(
    fetchMock,
    "test_anthropic/test_fixed_version_tool_chain_with_thinking_display_regression",
  );
  const model = llm.getModel("claude-haiku-4.5") as unknown as ClaudeMessages;
  const fixedVersion = fixedVersionTool();

  const chainResponse = (model as unknown as llm.Model).chain(
    "Use the fixed_version tool. Then tell me the version and make one short joke about it. Think about it first.",
    {
      tools: [fixedVersion],
      key: ANTHROPIC_API_KEY,
      options: { thinking_display: true },
    },
  );
  const text = await chainResponse.text();
  expect(text).toContain(FIXED_TEST_VERSION);
  expect(chainResponse._responses).toHaveLength(2);

  const firstResponse = chainResponse._responses[0] as Response;
  const messages = await firstResponse.messagesAsync();
  const reasoningParts = messages
    .flatMap((m) => m.parts)
    .filter((p): p is ReasoningPart => p instanceof ReasoningPart);
  expect(
    (
      reasoningParts[0].provider_metadata as {
        anthropic: { signature: string };
      }
    ).anthropic.signature,
  ).toBeTruthy();

  const secondResponse = chainResponse._responses[1];
  const secondRequestMessages = model.build_messages(
    secondResponse.prompt,
    secondResponse.conversation as Conversation | null,
  );
  const assistantContent = secondRequestMessages[1]
    .content as Array<Record<string, unknown>>;
  expect(assistantContent[0].type).toBe("thinking");
  expect(assistantContent[0].signature).toBeTruthy();
  expect(assistantContent[assistantContent.length - 1].type).toBe("tool_use");
  expect(
    (secondRequestMessages[2].content as Array<Record<string, unknown>>).map(
      (b) => b.type,
    ),
  ).toEqual(["tool_result"]);
});

test("test_web_search", async () => {
  loadCassette(fetchMock, "test_anthropic/test_web_search");
  const model = llm.getModel("claude-opus-4.1");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("What is the current weather in San Francisco?", {
    web_search: true,
  });
  const responseText = await response.textAsync();
  expect(responseText.length).toBeGreaterThan(0);
  expect(
    ["weather", "temperature", "san francisco", "degree", "forecast"].some(
      (word) => responseText.toLowerCase().includes(word),
    ),
  ).toBe(true);
  const responseDict = response.response_json as Record<string, unknown>;
  expect(responseDict).toHaveProperty("content");
  expect((responseDict.content as unknown[]).length).toBeGreaterThan(0);
});

test("test_fast_mode_kwargs", () => {
  const model = llm.getModel("claude-opus-4.8") as unknown as ClaudeMessages;
  const prompt = new llm.Prompt("Hi", model as unknown as llm.Model, {
    options: new model.Options({ fast: true }),
  });
  const kwargs = model.build_kwargs(prompt, null);
  expect(kwargs.speed).toBe("fast");
  expect(kwargs.betas).toContain("fast-mode-2026-02-01");
});

test("test_fast_mode_off_by_default", () => {
  const model = llm.getModel("claude-opus-4.8") as unknown as ClaudeMessages;
  const prompt = new llm.Prompt("Hi", model as unknown as llm.Model, {
    options: new model.Options({}),
  });
  const kwargs = model.build_kwargs(prompt, null);
  expect(kwargs).not.toHaveProperty("speed");
  expect(kwargs).not.toHaveProperty("betas");
});

test("test_opus_46_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_opus_46_prompt");
  const model = llm.getModel("claude-opus-4.6");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Two names for a pet pelican, be brief");
  const text = await response.textAsync();
  expect(text.length).toBeGreaterThan(0);
  const responseDict = response.response_json as Record<string, unknown>;
  expect(responseDict.model).toBe("claude-opus-4-6");
  expect(response.input_tokens).toBeGreaterThan(0);
  expect(response.output_tokens).toBeGreaterThan(0);
});

test("test_sonnet_46_prompt", async () => {
  loadCassette(fetchMock, "test_anthropic/test_sonnet_46_prompt");
  const model = llm.getModel("claude-sonnet-4.6");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Two names for a pet pelican, be brief");
  const text = await response.textAsync();
  expect(text.length).toBeGreaterThan(0);
  const responseDict = response.response_json as Record<string, unknown>;
  expect(responseDict.model).toBe("claude-sonnet-4-6");
  expect(response.input_tokens).toBeGreaterThan(0);
  expect(response.output_tokens).toBeGreaterThan(0);
});

test("test_opus_46_adaptive_thinking", async () => {
  loadCassette(fetchMock, "test_anthropic/test_opus_46_adaptive_thinking");
  const model = llm.getModel("claude-opus-4.6");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Two names for a pet pelican, be brief", {
    thinking: true,
  });
  const text = await response.textAsync();
  expect(text.length).toBeGreaterThan(0);
  const responseDict = response.response_json as Record<string, unknown>;
  // Should have thinking content in the response
  const contentTypes = (
    responseDict.content as Array<Record<string, unknown>>
  ).map((block) => block.type);
  expect(contentTypes).toContain("thinking");
  expect(contentTypes).toContain("text");
});

test("test_sonnet_46_effort_without_thinking", async () => {
  loadCassette(fetchMock, "test_anthropic/test_sonnet_46_effort_without_thinking");
  const model = llm.getModel("claude-sonnet-4.6");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Two names for a pet pelican, be brief", {
    thinking_effort: "low",
  });
  const text = await response.textAsync();
  expect(text.length).toBeGreaterThan(0);
});

test("test_46_prefill_rejected", async () => {
  const model = llm.getModel("claude-opus-4.6");
  model.key = "test-key";
  await expect(
    model.prompt("Hello", { prefill: "{" }).textAsync(),
  ).rejects.toThrow(/Prefilling assistant messages is not supported/);
});

test("test_46_max_effort_opus_only", async () => {
  const model = llm.getModel("claude-sonnet-4.6");
  model.key = "test-key";
  await expect(
    model.prompt("Hello", { thinking_effort: "max" }).textAsync(),
  ).rejects.toThrow(/thinking_effort='max' is only supported/);
});

test("test_opus_46_schema", async () => {
  loadCassette(fetchMock, "test_anthropic/test_opus_46_schema");
  const model = llm.getModel("claude-opus-4.6");
  const response = model.prompt("Invent a good dog", {
    schema: Dog,
    key: ANTHROPIC_API_KEY,
  });
  const dog = JSON.parse(await response.textAsync());
  expect(dog).toHaveProperty("name");
  expect(dog).toHaveProperty("age");
  expect(dog).toHaveProperty("bio");
});

// Phase 3: StreamEvent tests

test("test_stream_events_text", async () => {
  loadCassette(fetchMock, "test_anthropic/test_stream_events_text");
  const model = llm.getModel("claude-haiku-4.5");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Say just hello");
  const events = await collect(response.streamEventsAsync());
  const textEvents = events.filter((e) => e.type === "text");
  expect(textEvents.length).toBeGreaterThan(0);
  const text = textEvents.map((e) => e.chunk).join("");
  expect(text.toLowerCase().includes("hello") || text.includes("Hello")).toBe(
    true,
  );
});

test("test_stream_events_thinking", async () => {
  loadCassette(fetchMock, "test_anthropic/test_stream_events_thinking");
  const model = llm.getModel("claude-haiku-4.5");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Two names for a pet pelican, be brief", {
    thinking: true,
  });
  const events = await collect(response.streamEventsAsync());
  const reasoningEvents = events.filter((e) => e.type === "reasoning");
  const textEvents = events.filter((e) => e.type === "text");
  expect(reasoningEvents.length, "Should have reasoning events").toBeGreaterThan(
    0,
  );
  expect(textEvents.length, "Should have text events").toBeGreaterThan(0);
  // Reasoning should be in earlier part_index than text
  expect(reasoningEvents[0].part_index!).toBeLessThan(
    textEvents[0].part_index!,
  );
});

test("test_parts_thinking", async () => {
  loadCassette(fetchMock, "test_anthropic/test_parts_thinking");
  const model = llm.getModel("claude-haiku-4.5");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("Two names for a pet pelican, be brief", {
    thinking: true,
  });
  await response.textAsync();
  const messages = await response.messagesAsync();
  const parts = messages.flatMap((m) => m.parts);
  const reasoningParts = parts.filter(
    (p): p is ReasoningPart => p instanceof ReasoningPart,
  );
  const textParts = parts.filter((p): p is TextPart => p instanceof TextPart);
  expect(reasoningParts.length, "Should have reasoning part").toBeGreaterThanOrEqual(1);
  expect(textParts.length, "Should have text part").toBeGreaterThanOrEqual(1);
  expect(
    (
      reasoningParts[0].provider_metadata as {
        anthropic: { signature: string };
      }
    ).anthropic.signature,
  ).toBeTruthy();
  expect(reasoningParts[0].text, "Reasoning text should not be empty").toBeTruthy();
  expect(textParts[0].text, "Text should not be empty").toBeTruthy();
});

test("test_stream_events_tool_calls", async () => {
  loadCassette(fetchMock, "test_anthropic/test_stream_events_tool_calls");
  const model = llm.getModel("claude-haiku-4.5");
  model.key = model.key || ANTHROPIC_API_KEY;
  const names = ["Charles"];
  const response = model.prompt("Generate one name for a pet pelican", {
    tools: [
      llm.Tool.function(() => names.shift(), {
        name: "pelican_name_generator",
      }),
    ],
    key: ANTHROPIC_API_KEY,
  });
  const events = await collect(response.streamEventsAsync());
  const nameEvents = events.filter((e) => e.type === "tool_call_name");
  expect(nameEvents.length, "Should have tool_call_name event").toBeGreaterThanOrEqual(1);
  expect(nameEvents[0].chunk).toBe("pelican_name_generator");
  expect(nameEvents[0].tool_call_id).not.toBeNull();
});

test("test_web_search_tool_result_ordering", async () => {
  loadCassette(fetchMock, "test_anthropic/test_web_search_tool_result_ordering");
  const model = llm.getModel("claude-opus-4.1");
  model.key = model.key || ANTHROPIC_API_KEY;
  const response = model.prompt("What is the current weather in San Francisco?", {
    web_search: true,
  });
  const events = await collect(response.streamEventsAsync());

  // Find indices of first tool_result and first text event
  const toolResultIndices = events
    .map((e, i) => (e.type === "tool_result" ? i : -1))
    .filter((i) => i !== -1);
  const textIndices = events
    .map((e, i) => (e.type === "text" && e.chunk.trim() ? i : -1))
    .filter((i) => i !== -1);
  expect(toolResultIndices.length, "Should have tool_result events").toBeGreaterThanOrEqual(1);
  expect(textIndices.length, "Should have text events").toBeGreaterThanOrEqual(1);

  // The tool_result should come before the main text content
  expect(toolResultIndices[0]).toBeLessThan(textIndices[0]);

  // Also verify via parts
  const messages = await response.messagesAsync();
  const partTypes = messages
    .flatMap((m) => m.parts)
    .map((p) => p.constructor.name);
  if (
    partTypes.includes("ToolResultPart") &&
    partTypes.includes("TextPart")
  ) {
    expect(partTypes.indexOf("ToolResultPart")).toBeLessThan(
      partTypes.indexOf("TextPart"),
    );
  }
});

// --- messages= parameter --------------------------------------------------
//
// Unit tests that exercise build_messages directly on messages= input.
// Pure structural — no API calls, so no cassettes.

function buildMessagesFor(
  promptKwargs: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const model = llm.getModel("claude-sonnet-4.5") as unknown as ClaudeMessages;
  const { options, ...rest } = promptKwargs;
  const p = new llm.Prompt(null, model as unknown as llm.Model, {
    options: (options as llm.Options) ?? new model.Options({}),
    ...rest,
  });
  return model.build_messages(p, null) as unknown as Array<
    Record<string, unknown>
  >;
}

test("test_build_messages_simple_user_text", () => {
  const msgs = buildMessagesFor({ messages: [llm.user("hi")] });
  expect(msgs).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
});

test("test_build_messages_skips_system_role", () => {
  const msgs = buildMessagesFor({
    messages: [llm.system("be nice"), llm.user("hi")],
  });
  // System does not appear in the messages list; it goes to kwargs["system"].
  expect(msgs).toEqual([
    { role: "user", content: [{ type: "text", text: "hi" }] },
  ]);
});

test("test_build_messages_merges_tool_then_user", () => {
  // A tool-role message followed by a user message must collapse into one
  // Anthropic user turn (tool_result + text in the same content array).
  const msgs = buildMessagesFor({
    messages: [
      llm.tool_message(
        new ToolResultPart({
          name: "search",
          output: "sunny",
          tool_call_id: "call_1",
        }),
      ),
      llm.user("thanks"),
    ],
  });
  expect(msgs).toEqual([
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_1", content: "sunny" },
        { type: "text", text: "thanks" },
      ],
    },
  ]);
});

test("test_build_messages_assistant_tool_call_and_text", () => {
  const msgs = buildMessagesFor({
    messages: [
      llm.user("what time?"),
      llm.assistant(
        new TextPart({ text: "Let me check" }),
        new ToolCallPart({ name: "clock", arguments: {}, tool_call_id: "c1" }),
      ),
    ],
  });
  expect(msgs).toEqual([
    { role: "user", content: [{ type: "text", text: "what time?" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Let me check" },
        { type: "tool_use", id: "c1", name: "clock", input: {} },
      ],
    },
  ]);
});

test("test_build_messages_reasoning_round_trips_signature", () => {
  // Thinking blocks from a prior assistant message must preserve the
  // Anthropic signature via provider_metadata — otherwise continuation
  // requests involving signed thinking get rejected by the API.
  const msgs = buildMessagesFor({
    messages: [
      llm.user("q"),
      llm.assistant(
        new ReasoningPart({
          text: "thinking...",
          provider_metadata: { anthropic: { signature: "sig-abc" } },
        }),
        new TextPart({ text: "answer" }),
      ),
    ],
  });
  expect((msgs[1].content as unknown[])[0]).toEqual({
    type: "thinking",
    thinking: "thinking...",
    signature: "sig-abc",
  });
});

test("test_load_conversation_preserves_logged_tool_chain_for_anthropic", async () => {
  // Regression for `llm -c` after a logged tool call chain.
  //
  // LLM 0.32a0 rehydrates the final tool-result response as if its
  // prompt.messages started with only the current tool_result turn. That
  // makes Anthropic reject the next continuation because the request starts
  // with an orphan tool_result instead of the preceding assistant tool_use.
  const model = llm.getModel("claude-haiku-4.5") as unknown as ClaudeMessages;
  const syncModel = model as unknown as llm.Model;

  const tool = llm.Tool.function(() => "tock", { name: "tick" });
  const conversation = syncModel.conversation();

  function markDone(response: Response): void {
    response._done = true;
    response._start = 0.0;
    response._end = 0.0;
    response._start_utcnow = new Date().toISOString().replace("Z", "+00:00");
  }

  const first = new llm.Response(
    new llm.Prompt("q1", syncModel, {
      tools: [tool],
      options: new model.Options({}),
    }),
    syncModel,
    false,
    conversation,
  );
  first.add_tool_call(
    new llm.ToolCall({ name: "tick", arguments: {}, tool_call_id: "c1" }),
  );
  markDone(first);

  const toolResult = new llm.ToolResult({
    name: "tick",
    output: "tock",
    tool_call_id: "c1",
  });
  const secondChain = [
    llm.user("q1"),
    new llm.Message({
      role: "assistant",
      parts: [
        new ToolCallPart({ name: "tick", arguments: {}, tool_call_id: "c1" }),
      ],
    }),
    new llm.Message({
      role: "tool",
      parts: [
        new ToolResultPart({ name: "tick", output: "tock", tool_call_id: "c1" }),
      ],
    }),
  ];
  const second = new llm.Response(
    new llm.Prompt("", syncModel, {
      tools: [tool],
      tool_results: [toolResult],
      messages: secondChain,
      options: new model.Options({}),
    }),
    syncModel,
    false,
    conversation,
  );
  second._chunks = ["final answer"];
  second._stream_events = [
    new StreamEvent({ type: "text", chunk: "final answer" }),
  ];
  markDone(second);

  const dbPath = `${env.userPath}/tool-chain-logs.db`;
  const db = new Database(dbPath);
  migrate(db);
  await first.logToDb(db);
  conversation.responses.push(first);
  await second.logToDb(db);
  conversation.responses.push(second);

  const loaded = (await loadConversation(null, false, dbPath)) as Conversation;
  const followUp = loaded.prompt("q2");
  const anthropicMessages = model.build_messages(followUp.prompt, loaded);

  expect(anthropicMessages[0].content).toEqual([{ type: "text", text: "q1" }]);
  expect(anthropicMessages[1].content).toEqual([
    { type: "tool_use", id: "c1", name: "tick", input: {} },
  ]);
  expect(anthropicMessages[2].content).toEqual([
    { type: "tool_result", tool_use_id: "c1", content: "tock" },
  ]);
  expect(anthropicMessages[3].content).toEqual([
    { type: "text", text: "final answer" },
  ]);
  expect(anthropicMessages[4].content).toEqual([{ type: "text", text: "q2" }]);
});

test("test_extract_system_from_messages", () => {
  const model = llm.getModel("claude-sonnet-4.5") as unknown as ClaudeMessages;
  const p = new llm.Prompt(null, model as unknown as llm.Model, {
    messages: [llm.system("be helpful"), llm.user("hi")],
  });
  expect(model._extract_system(p)).toBe("be helpful");
});

test("test_extract_system_prefers_prompt_system_over_messages", () => {
  // When both paths are populated (synthesized case), prompt.system wins
  // since it already composes system= + system_fragments.
  const model = llm.getModel("claude-sonnet-4.5") as unknown as ClaudeMessages;
  const p = new llm.Prompt(null, model as unknown as llm.Model, {
    system: "legacy sys",
    messages: [llm.user("hi")],
  });
  expect(model._extract_system(p)).toBe("legacy sys");
});
