/**
 * Port of llm-openrouter/tests/test_llm_openrouter.py.
 *
 * The @pytest.mark.vcr tests replay the recorded Python cassettes
 * (copied to test/cassettes/test_llm_openrouter/) via test/cassettes.ts.
 *
 * Differences from Python noted in PORTING_NOTES.md:
 *  - the plugin is registered explicitly here (in Python it is a separately
 *    installed package discovered via entry points)
 *  - the model list is fetched by `await ensureModelsCached()` before the
 *    registry is consulted, because register_models cannot block on HTTP
 *    in JS (see src/plugins/openrouter.ts)
 *  - `str(response)` becomes `await response.textAsync()`
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as llm from "../src/index.js";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { pm } from "../src/plugins.js";
import * as openrouter from "../src/plugins/openrouter.js";
import { FetchMock } from "./fetchMock.js";
import { loadCassette } from "./cassettes.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

const OPENROUTER_KEY = process.env.PYTEST_OPENROUTER_KEY || "sk-...";

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000a60000011a0203000000e699c45e" +
    "00000009504c5445ffffff00ff00fe01001274014a000000474944415478daedd8" +
    "3111003008c0c02e5deaaf2651890456e03ef32bc8915af4a208455114455114455" +
    "1144551d44291244933bbbf0845511445511445511445d1a5d41791c69505150f9f" +
    "c5099fa40000000049454e44ae426082",
  "hex",
);

let env: TestEnv;
let fetchMock: FetchMock;
let prevKey: string | undefined;

beforeEach(() => {
  env = setupTestEnvironment();
  prevKey = process.env.OPENROUTER_KEY;
  process.env.OPENROUTER_KEY = OPENROUTER_KEY;
  fetchMock = new FetchMock();
  fetchMock.install();
  pm.register(openrouter, "llm_openrouter");
});

afterEach(() => {
  try {
    pm.unregister(undefined, "llm_openrouter");
  } catch {
    // already unregistered
  }
  fetchMock.uninstall();
  if (prevKey === undefined) {
    delete process.env.OPENROUTER_KEY;
  } else {
    process.env.OPENROUTER_KEY = prevKey;
  }
  env.cleanup();
});

test("test_prompt", async () => {
  loadCassette(fetchMock, "test_llm_openrouter/test_prompt");
  await openrouter.ensureModelsCached();
  const model = llm.getModel("openrouter/openai/gpt-4o");
  const response = model.prompt("Two names for a pet pelican, be brief", {
    key: OPENROUTER_KEY,
  });
  expect(await response.textAsync()).toBe("Pebbles and Skipper.");
  const responseDict = { ...(response.response_json as Record<string, unknown>) };
  delete responseDict.id; // differs between requests
  expect(responseDict).toEqual({
    content: "Pebbles and Skipper.",
    role: "assistant",
    finish_reason: "stop",
    usage: {
      completion_tokens: 6,
      prompt_tokens: 17,
      total_tokens: 23,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 0.0001025,
      is_byok: false,
    },
    object: "chat.completion.chunk",
    model: "openai/gpt-4o",
    created: 1754441342,
  });
});

test("test_llm_models", async () => {
  loadCassette(fetchMock, "test_llm_openrouter/test_llm_models");
  await openrouter.ensureModelsCached();
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["models", "list"]);
  expect(result.exit_code, result.output).toBe(0);
  for (const fragment of [
    "OpenRouter: openrouter/openai/gpt-3.5-turbo",
    "OpenRouter: openrouter/anthropic/claude-sonnet-4",
  ]) {
    expect(result.output).toContain(fragment);
  }
});

test("test_image_prompt", async () => {
  loadCassette(fetchMock, "test_llm_openrouter/test_image_prompt");
  await openrouter.ensureModelsCached();
  const model = llm.getModel("openrouter/anthropic/claude-3.5-sonnet");
  const response = model.prompt("Describe image in three words", {
    attachments: [new llm.Attachment({ content: TINY_PNG })],
    key: OPENROUTER_KEY,
  });
  expect(await response.textAsync()).toBe("Red green geometric shapes");
  const responseDict = { ...(response.response_json as Record<string, unknown>) };
  delete responseDict.id; // differs between requests
  expect(responseDict).toEqual({
    content: "Red green geometric shapes",
    role: "assistant",
    finish_reason: "stop",
    usage: {
      completion_tokens: 7,
      prompt_tokens: 82,
      total_tokens: 89,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 0.000351,
      is_byok: false,
    },
    object: "chat.completion.chunk",
    model: "anthropic/claude-3.5-sonnet",
    created: 1754441344,
  });
});

test("test_tool_calls", async () => {
  loadCassette(fetchMock, "test_llm_openrouter/test_tool_calls");
  await openrouter.ensureModelsCached();
  const model = llm.getModel("openrouter/openai/gpt-4.1-mini");

  const llmVersion = llm.Tool.function(() => "0.0+test", {
    name: "llm_version",
    description: "Return the installed version of llm",
  });

  const chain = model.chain("What is the current llm version?", {
    tools: [llmVersion],
    key: OPENROUTER_KEY,
  });

  // Python's `list(chain.responses())` drives the chain to completion;
  // in TS the responses execute asynchronously, so drive it with text()
  // and then read the accumulated responses.
  await chain.text();
  const responses = chain._responses;

  const first = { ...(responses[0].response_json as Record<string, unknown>) };
  delete first.id; // differs between requests
  delete first.created; // differs between requests
  expect(first).toEqual({
    content: "",
    role: "assistant",
    finish_reason: "tool_calls",
    usage: {
      completion_tokens: 11,
      prompt_tokens: 48,
      total_tokens: 59,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 3.68e-5,
      is_byok: false,
    },
    object: "chat.completion.chunk",
    model: "openai/gpt-4.1-mini",
  });

  const second = { ...(responses[1].response_json as Record<string, unknown>) };
  delete second.id;
  delete second.created;
  expect(second).toEqual({
    content: "The current LLM version is 0.0+test.",
    role: "assistant",
    finish_reason: "stop",
    usage: {
      completion_tokens: 14,
      prompt_tokens: 73,
      total_tokens: 87,
      completion_tokens_details: { reasoning_tokens: 0 },
      prompt_tokens_details: { cached_tokens: 0 },
      cost: 5.16e-5,
      is_byok: false,
    },
    object: "chat.completion.chunk",
    model: "openai/gpt-4.1-mini",
  });
});
