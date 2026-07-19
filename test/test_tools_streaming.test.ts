/**
 * Port of tests/test_tools_streaming.py — streaming tool-call argument
 * accumulation variants, replayed from the recorded OpenAI cassettes
 * (@pytest.mark.vcr record_mode="none") via test/cassettes.ts.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as llm from "../src/index.js";
import { llm_version } from "../src/tools.js";
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

async function runChain(): Promise<string> {
  const model = llm.getModel("gpt-4.1-mini");
  const chain = model.chain("What is the current llm version?", {
    tools: [llm_version],
    key: API_KEY,
  });
  const chunks: string[] = [];
  for await (const chunk of chain) {
    chunks.push(chunk);
  }
  return chunks.join("");
}

// This response contains streaming variant "a" where arguments="" is
// followed by arguments="{}"
test("test_tools_streaming_variant_a", async () => {
  loadCassette(fetchMock, "test_tools_streaming/test_tools_streaming_variant_a");
  expect(await runChain()).toBe(
    "The current version of *llm* is **0.fixed-version**.",
  );
});

// This response contains streaming variant "b" where arguments="{}" is
// the first partial stream received.
test("test_tools_streaming_variant_b", async () => {
  loadCassette(fetchMock, "test_tools_streaming/test_tools_streaming_variant_b");
  expect(await runChain()).toBe(
    "The current version of *llm* is **0.fixed-version**.",
  );
});

// This response contains streaming variant "c".
test("test_tools_streaming_variant_c", async () => {
  loadCassette(fetchMock, "test_tools_streaming/test_tools_streaming_variant_c");
  expect(await runChain()).toBe(
    "The installed version of LLM on this system is 0.fixed-version.",
  );
});

// This response contains streaming variant "d" where a no-argument tool call
// streams arguments=null and never sends a "{}" chunk, so the accumulated
// arguments string stays empty - json.loads("") used to raise here.
test("test_tools_streaming_variant_d", async () => {
  loadCassette(fetchMock, "test_tools_streaming/test_tools_streaming_variant_d");
  expect(await runChain()).toBe(
    "The current version of *llm* is **0.fixed-version**.",
  );
});
