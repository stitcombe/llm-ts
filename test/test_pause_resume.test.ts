/** Port of tests/test_pause_resume.py — llm.PauseChain and chain
 * resume from message history. */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as llm from "../src/index.js";
import {
  ChainResponse,
  PauseChain,
  Tool,
  ToolCall,
  ToolResult,
} from "../src/models.js";
import {
  Message,
  TextPart,
  ToolCallPart,
  ToolResultPart,
} from "../src/parts.js";
import { dumps } from "../src/pyjson.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

async function expectPause(fn: () => Promise<unknown>): Promise<PauseChain> {
  try {
    await fn();
  } catch (ex) {
    expect(ex).toBeInstanceOf(PauseChain);
    return ex as PauseChain;
  }
  throw new Error("Expected PauseChain to be raised");
}

// ---- PauseChain ----

test("test_pause_chain_sync_model", async () => {
  const afterCalls: string[] = [];

  function needs_input(path: string): string {
    void path;
    throw new PauseChain("waiting for approval");
  }

  const before = (_tool: Tool | null, _toolCall: ToolCall) => {};
  const after = (
    _tool: Tool | null,
    _toolCall: ToolCall,
    toolResult: ToolResult,
  ) => {
    afterCalls.push(toolResult.name);
  };

  const model = llm.getModel("echo");
  const chain = model.chain(
    dumps({
      tool_calls: [{ name: "needs_input", arguments: { path: "/tmp" } }],
    }),
    { tools: [needs_input], before_call: before, after_call: after },
  ) as ChainResponse;
  const pause = await expectPause(() => chain.text());

  expect(pause.message).toBe("waiting for approval");
  expect(pause.tool_call).not.toBeNull();
  expect(pause.tool_call!.name).toBe("needs_input");
  expect(pause.tool_call!.arguments).toEqual({ path: "/tmp" });
  expect(pause.tool_call!.tool_call_id!.startsWith("tc_")).toBe(true);
  expect(pause.tool_results).toEqual([]);
  // after_call must not fire for the paused tool
  expect(afterCalls).toEqual([]);
  // The response that requested the tool call completed normally
  expect(chain._responses.length).toBe(1);
});

test("test_pause_chain_async_model_siblings_complete", async () => {
  const afterCalls: string[] = [];
  const executed: string[] = [];

  async function needs_input(): Promise<string> {
    throw new PauseChain("hold on");
  }

  async function sibling(): Promise<string> {
    await new Promise((r) => setTimeout(r, 10));
    executed.push("sibling");
    return "done";
  }

  const after = async (
    _tool: Tool | null,
    _toolCall: ToolCall,
    toolResult: ToolResult,
  ) => {
    afterCalls.push(toolResult.name);
  };

  const model = llm.getAsyncModel("echo");
  const chain = model.chain(
    dumps({ tool_calls: [{ name: "needs_input" }, { name: "sibling" }] }),
    { tools: [needs_input, sibling], after_call: after },
  );
  const pause = await expectPause(() => chain.text());

  expect(pause.tool_call!.name).toBe("needs_input");
  // The concurrent sibling ran to completion - no orphaned tasks
  expect(executed).toEqual(["sibling"]);
  expect(afterCalls).toEqual(["sibling"]);
  // Completed sibling results ride on the exception
  expect(pause.tool_results.map((r) => r.name)).toEqual(["sibling"]);
  expect(pause.tool_results[0].output).toBe("done");
});

test("test_pause_chain_sync_model_stops_remaining_calls", async () => {
  const executed: string[] = [];

  function pauser(): string {
    throw new PauseChain("wait");
  }

  function later(): string {
    executed.push("later");
    return "x";
  }

  const model = llm.getModel("echo");
  const chain = model.chain(
    dumps({ tool_calls: [{ name: "pauser" }, { name: "later" }] }),
    { tools: [pauser, later] },
  );
  const pause = await expectPause(() => chain.text());
  // Sequential execution stops at the pause; later call never starts,
  // so it can safely re-execute on resume.
  expect(executed).toEqual([]);
  expect(pause.tool_results).toEqual([]);
});

test("test_pause_chain_async_first_of_two_pauses_propagates", async () => {
  async function pause_a(): Promise<string> {
    throw new PauseChain("a");
  }

  async function pause_b(): Promise<string> {
    throw new PauseChain("b");
  }

  const model = llm.getAsyncModel("echo");
  const chain = model.chain(
    dumps({ tool_calls: [{ name: "pause_a" }, { name: "pause_b" }] }),
    { tools: [pause_a, pause_b] },
  );
  const pause = await expectPause(() => chain.text());
  expect(pause.message).toBe("a");
  expect(pause.tool_call!.name).toBe("pause_a");
});

test("test_async_hook_exception_does_not_orphan_siblings", async () => {
  // Defined failure semantics: an exception raised by an after_call
  // hook propagates only after all concurrent tool tasks finish.
  const executed: string[] = [];

  async function boomer(): Promise<string> {
    return "boom";
  }

  async function slow(): Promise<string> {
    await new Promise((r) => setTimeout(r, 50));
    executed.push("slow");
    return "ok";
  }

  const after = async (
    _tool: Tool | null,
    _toolCall: ToolCall,
    toolResult: ToolResult,
  ) => {
    if (toolResult.name === "boomer") {
      throw new Error("hook bug");
    }
  };

  const model = llm.getAsyncModel("echo");
  const chain = model.chain(
    dumps({ tool_calls: [{ name: "boomer" }, { name: "slow" }] }),
    { tools: [boomer, slow], after_call: after },
  );
  await expect(chain.text()).rejects.toThrowError(/hook bug/);
  // The slow sibling was not orphaned mid-flight
  expect(executed).toEqual(["slow"]);
});

test("test_pause_chain_async_model_sync_tool", async () => {
  function pauser(): string {
    throw new PauseChain("wait");
  }

  const model = llm.getAsyncModel("echo");
  const chain = model.chain(dumps({ tool_calls: [{ name: "pauser" }] }), {
    tools: [pauser],
  });
  const pause = await expectPause(() => chain.text());
  expect(pause.tool_call!.name).toBe("pauser");
});

// ---- chain resume from message history ----

function pendingHistory(toolCallId = "tc_resume1"): Message[] {
  return [
    new Message({
      role: "user",
      parts: [new TextPart({ text: "Convert hello to uppercase" })],
    }),
    new Message({
      role: "assistant",
      parts: [
        new ToolCallPart({
          name: "upper",
          arguments: { text: "hello" },
          tool_call_id: toolCallId,
        }),
      ],
    }),
  ];
}

test("test_chain_resumes_trailing_pending_tool_calls", async () => {
  const executed: string[] = [];
  const hookCalls: Array<[string, string, string | null]> = [];

  function upper(text: string): string {
    executed.push(text);
    return text.toUpperCase();
  }

  const before = (_tool: Tool | null, toolCall: ToolCall) => {
    hookCalls.push(["before", toolCall.name, toolCall.tool_call_id]);
  };
  const after = (
    _tool: Tool | null,
    _toolCall: ToolCall,
    toolResult: ToolResult,
  ) => {
    hookCalls.push(["after", toolResult.name, toolResult.tool_call_id]);
  };

  const model = llm.getModel("echo");
  const chain = model.chain(null, {
    messages: pendingHistory(),
    tools: [upper],
    before_call: before,
    after_call: after,
  }) as ChainResponse;
  const output = await chain.text();

  // The pending call executed through the normal hook machinery
  expect(executed).toEqual(["hello"]);
  expect(hookCalls).toEqual([
    ["before", "upper", "tc_resume1"],
    ["after", "upper", "tc_resume1"],
  ]);
  // The model then received the tool result (echo renders
  // prompt.tool_results), correlated by the original id
  const data = JSON.parse(output);
  expect(data.tool_results).toEqual([
    { name: "upper", output: "HELLO", tool_call_id: "tc_resume1" },
  ]);
  // Exactly one provider call was made
  expect(chain._responses.length).toBe(1);
});

test("test_chain_resumes_trailing_pending_tool_calls_async", async () => {
  const executed: string[] = [];

  async function upper(text: string): Promise<string> {
    executed.push(text);
    return text.toUpperCase();
  }

  const model = llm.getAsyncModel("echo");
  const chain = model.chain(null, {
    messages: pendingHistory(),
    tools: [upper],
  });
  const output = await chain.text();

  expect(executed).toEqual(["hello"]);
  const data = JSON.parse(output);
  expect(data.tool_results).toEqual([
    { name: "upper", output: "HELLO", tool_call_id: "tc_resume1" },
  ]);
});

test("test_resume_skips_calls_that_already_have_results", async () => {
  const executed: string[] = [];

  function first(): string {
    executed.push("first");
    return "one";
  }

  function second(): string {
    executed.push("second");
    return "two";
  }

  const history = [
    new Message({ role: "user", parts: [new TextPart({ text: "go" })] }),
    new Message({
      role: "assistant",
      parts: [
        new ToolCallPart({ name: "first", arguments: {}, tool_call_id: "tc_a" }),
        new ToolCallPart({
          name: "second",
          arguments: {},
          tool_call_id: "tc_b",
        }),
      ],
    }),
    new Message({
      role: "tool",
      parts: [
        new ToolResultPart({
          name: "first",
          output: "one",
          tool_call_id: "tc_a",
        }),
      ],
    }),
  ];
  const model = llm.getModel("echo");
  const chain = model.chain(null, {
    messages: history,
    tools: [first, second],
  });
  const output = await chain.text();

  expect(executed).toEqual(["second"]);
  const data = JSON.parse(output);
  expect(data.tool_results).toEqual([
    { name: "second", output: "two", tool_call_id: "tc_b" },
  ]);
});

test("test_no_resume_when_conversation_moved_on", async () => {
  const executed: string[] = [];

  function upper(text: string): string {
    executed.push(text);
    return text.toUpperCase();
  }

  const history = [
    ...pendingHistory(),
    new Message({
      role: "user",
      parts: [new TextPart({ text: "never mind" })],
    }),
  ];
  const model = llm.getModel("echo");
  const chain = model.chain(null, { messages: history, tools: [upper] });
  await chain.text();
  expect(executed).toEqual([]);
});

test("test_no_resume_without_tools", async () => {
  const model = llm.getModel("echo");
  const chain = model.chain(null, { messages: pendingHistory() });
  // No tools provided: nothing to execute, chain proceeds normally
  const output = await chain.text();
  expect("tool_results" in JSON.parse(output)).toBe(false);
});

test("test_resume_matches_idless_calls_by_name", async () => {
  // Histories persisted before guaranteed ids may have None ids
  const executed: string[] = [];

  function upper(text: string): string {
    executed.push(text);
    return text.toUpperCase();
  }

  const history = [
    new Message({ role: "user", parts: [new TextPart({ text: "go" })] }),
    new Message({
      role: "assistant",
      parts: [
        new ToolCallPart({
          name: "upper",
          arguments: { text: "a" },
          tool_call_id: null,
        }),
        new ToolCallPart({
          name: "upper",
          arguments: { text: "b" },
          tool_call_id: null,
        }),
      ],
    }),
    new Message({
      role: "tool",
      parts: [
        new ToolResultPart({ name: "upper", output: "A", tool_call_id: null }),
      ],
    }),
  ];
  const model = llm.getModel("echo");
  const chain = model.chain(null, { messages: history, tools: [upper] });
  await chain.text();
  // One result already present: only one of the two calls re-executes
  expect(executed).toEqual(["b"]);
});

test("test_resume_ignores_server_executed_calls", async () => {
  const executed: string[] = [];

  function upper(text: string): string {
    executed.push(text);
    return text.toUpperCase();
  }

  const history = [
    new Message({ role: "user", parts: [new TextPart({ text: "go" })] }),
    new Message({
      role: "assistant",
      parts: [
        new ToolCallPart({
          name: "upper",
          arguments: { text: "x" },
          tool_call_id: "tc_srv",
          server_executed: true,
        }),
      ],
    }),
  ];
  const model = llm.getModel("echo");
  const chain = model.chain(null, { messages: history, tools: [upper] });
  await chain.text();
  expect(executed).toEqual([]);
});

test("test_resumed_tool_can_pause_again", async () => {
  function needs_more(text: string): string {
    void text;
    throw new PauseChain("second question");
  }

  const history = [
    new Message({ role: "user", parts: [new TextPart({ text: "go" })] }),
    new Message({
      role: "assistant",
      parts: [
        new ToolCallPart({
          name: "needs_more",
          arguments: { text: "x" },
          tool_call_id: "tc_again",
        }),
      ],
    }),
  ];
  const model = llm.getModel("echo");
  const chain = model.chain(null, {
    messages: history,
    tools: [needs_more],
  }) as ChainResponse;
  const pause = await expectPause(() => chain.text());
  expect(pause.tool_call!.name).toBe("needs_more");
  expect(pause.tool_call!.tool_call_id).toBe("tc_again");
  // No provider call was made: the chain paused before reaching the model
  expect(chain._responses.length).toBe(0);
});
