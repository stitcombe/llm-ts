/**
 * Port of tests/test_tools.py — tool execution, toolboxes, chains,
 * before/after callbacks, CLI tool options.
 *
 * The two @pytest.mark.vcr tests that hit the OpenAI API
 * (test_tool_use_basic, test_tool_use_chain_of_two_calls) are deferred
 * to the fetch-mock/cassette infrastructure (see test_openai_* ports).
 *
 * --functions takes JavaScript source in this port, so the Python
 * source snippets become JS equivalents; exception strings use the JS
 * error name ("Error: ...") where Python shows "Exception: ...".
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as llm from "../src/index.js";
import {
  AsyncChainResponse,
  CancelToolCall,
  ChainResponse,
  Tool,
  ToolCall,
  Toolbox,
  ToolOutput,
  ToolResult,
} from "../src/models.js";
import { ToolCallPart } from "../src/parts.js";
import { llm_time, llm_version } from "../src/tools.js";
import { dumps } from "../src/pyjson.js";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { migrate } from "../src/migrations.js";
import { Database } from "../src/sqliteUtils.js";
import { FetchMock } from "./fetchMock.js";
import { loadCassette } from "./cassettes.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

const API_KEY = process.env.PYTEST_OPENAI_API_KEY || "badkey";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

/** Split the echo model's two concatenated JSON objects. */
function splitEchoObjects(output: string): Array<Record<string, unknown>> {
  const bits = output.split("\n}{\n");
  expect(bits.length).toBe(2);
  return [JSON.parse(bits[0] + "}"), JSON.parse("{" + bits[1])];
}

test("test_tool_use_basic", async () => {
  const fetchMock = new FetchMock();
  fetchMock.install();
  try {
    loadCassette(fetchMock, "test_tools/test_tool_use_basic");
    const model = llm.getModel("gpt-4o-mini");

    function multiply(a: number, b: number): number {
      return a * b;
    }
    multiply.description = "Multiply two numbers.";
    multiply.annotations = { a: "integer", b: "integer" };

    const chainResponse = model.chain("What is 1231 * 2331?", {
      tools: [multiply],
      key: API_KEY,
    });

    const chunks: string[] = [];
    for await (const chunk of chainResponse) {
      chunks.push(chunk);
    }
    const output = chunks.join("");

    expect(output).toBe(
      "The result of \\( 1231 \\times 2331 \\) is \\( 2,869,461 \\).",
    );

    const [first, second] = chainResponse._responses;

    expect(first.prompt.prompt).toBe("What is 1231 * 2331?");
    expect(first.prompt.tools[0].name).toBe("multiply");

    expect(second.prompt.tool_results.length).toBe(1);
    expect(second.prompt.tool_results[0].name).toBe("multiply");
    expect(second.prompt.tool_results[0].output).toBe("2869461");

    // Test writing to the database
    const db = new Database({ memory: true });
    migrate(db);
    await chainResponse.logToDb(db);
    for (const name of [
      "tools",
      "tool_responses",
      "tool_calls",
      "tool_results",
    ]) {
      expect(db.tableNames()).toContain(name);
    }

    const responses = db.table("responses").rows;
    expect(responses.length).toBe(2);
    const [firstResponse, secondResponse] = responses as Array<
      Record<string, unknown>
    >;

    const tools = db.table("tools").rows as Array<Record<string, unknown>>;
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("multiply");
    expect(tools[0].description).toBe("Multiply two numbers.");
    expect(tools[0].plugin).toBe(null);

    const toolResults = db.table("tool_results").rows as Array<
      Record<string, unknown>
    >;
    const toolCalls = db.table("tool_calls").rows as Array<
      Record<string, unknown>
    >;

    expect(toolCalls.length).toBe(1);
    expect(toolCalls[0].response_id).toBe(firstResponse.id);
    expect(toolCalls[0].name).toBe("multiply");
    expect(toolCalls[0].arguments).toBe('{"a": 1231, "b": 2331}');

    expect(toolResults.length).toBe(1);
    expect(toolResults[0].response_id).toBe(secondResponse.id);
    expect(toolResults[0].output).toBe("2869461");
    expect(toolResults[0].tool_call_id).toBe(toolCalls[0].tool_call_id);
  } finally {
    fetchMock.uninstall();
  }
});

test("test_tool_use_chain_of_two_calls", async () => {
  const fetchMock = new FetchMock();
  fetchMock.install();
  try {
    loadCassette(fetchMock, "test_tools/test_tool_use_chain_of_two_calls");
    const model = llm.getModel("gpt-4o-mini");

    function lookup_population(country: string): number {
      return 123124;
    }
    lookup_population.description =
      "Returns the current population of the specified fictional country";

    function can_have_dragons(population: number): boolean {
      return population > 10000;
    }
    can_have_dragons.description =
      "Returns True if the specified population can have dragons, False otherwise";
    can_have_dragons.annotations = { population: "integer" };

    const chainResponse = model.chain(
      "Can the country of Crumpet have dragons? Answer with only YES or NO",
      {
        tools: [lookup_population, can_have_dragons],
        stream: false,
        key: API_KEY,
      },
    );

    const output = await chainResponse.text();
    expect(output).toBe("YES");
    expect(chainResponse._responses.length).toBe(3);

    const [first, second, third] = chainResponse._responses;
    expect(first.tool_calls()[0].arguments).toEqual({ country: "Crumpet" });
    expect(first.prompt.tool_results).toEqual([]);
    expect(second.prompt.tool_results[0].output).toBe("123124");
    expect(second.tool_calls()[0].arguments).toEqual({ population: 123124 });
    expect(third.prompt.tool_results[0].output).toBe("true");
    expect(third.tool_calls()).toEqual([]);
  } finally {
    fetchMock.uninstall();
  }
});

test("test_tool_use_async_tool_function", async () => {
  async function hello(): Promise<string> {
    return "world";
  }

  const model = llm.getModel("echo");
  const chainResponse = model.chain(
    dumps({ tool_calls: [{ name: "hello" }] }),
    { tools: [hello] },
  );
  const output = await chainResponse.text();
  const objects = splitEchoObjects(output);
  const toolResults = (objects[1] as { tool_results: Array<Record<string, unknown>> })
    .tool_results;
  const toolCallId = toolResults[0].tool_call_id as string;
  expect(toolCallId.startsWith("tc_")).toBe(true);
  toolResults[0].tool_call_id = null;
  expect(objects).toEqual([
    { prompt: "", system: "", attachments: [], stream: true, previous: [] },
    {
      prompt: "",
      system: "",
      attachments: [],
      stream: true,
      previous: [{ prompt: '{"tool_calls": [{"name": "hello"}]}' }],
      tool_results: [{ name: "hello", output: "world", tool_call_id: null }],
    },
  ]);
});

test("test_async_tools_run_tools_in_parallel", async () => {
  const startTimestamps: Array<[string, number]> = [];
  const startMs = performance.now();

  async function hello(): Promise<string> {
    startTimestamps.push(["hello", performance.now() - startMs]);
    await new Promise((r) => setTimeout(r, 200));
    return "world";
  }

  async function hello2(): Promise<string> {
    startTimestamps.push(["hello2", performance.now() - startMs]);
    await new Promise((r) => setTimeout(r, 200));
    return "world2";
  }

  const model = llm.getAsyncModel("echo");
  const chainResponse = model.chain(
    dumps({ tool_calls: [{ name: "hello" }, { name: "hello2" }] }),
    { tools: [hello, hello2] },
  );
  const output = await chainResponse.text();
  const objects = splitEchoObjects(output);
  const toolResults = (objects[1] as { tool_results: Array<Record<string, unknown>> })
    .tool_results;
  const ids = toolResults.map((r) => r.tool_call_id as string);
  expect(ids.every((i) => i.startsWith("tc_"))).toBe(true);
  expect(new Set(ids).size).toBe(2);
  for (const r of toolResults) {
    r.tool_call_id = null;
  }
  expect(objects).toEqual([
    { prompt: "", system: "", attachments: [], stream: true, previous: [] },
    {
      prompt: "",
      system: "",
      attachments: [],
      stream: true,
      previous: [
        { prompt: '{"tool_calls": [{"name": "hello"}, {"name": "hello2"}]}' },
      ],
      tool_results: [
        { name: "hello", output: "world", tool_call_id: null },
        { name: "hello2", output: "world2", tool_call_id: null },
      ],
    },
  ]);
  const deltaMs = startTimestamps[1][1] - startTimestamps[0][1];
  // They should have run in parallel so it should be less than 20ms apart
  expect(deltaMs).toBeLessThan(20);
});

test("test_async_toolbox", async () => {
  class Tools extends Toolbox {
    prepared = false;

    async go(): Promise<string> {
      return "This was async";
    }

    override async prepare_async(): Promise<void> {
      this.prepared = true;
    }
  }

  const instance = new Tools();
  expect(instance.prepared).toBe(false);

  const model = llm.getAsyncModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "Tools_go" }] }),
    { tools: [instance] },
  );
  const output = await chainResponse.text();
  expect(output).toContain('"output": "This was async"');
  expect(instance.prepared).toBe(true);
});

test("test_toolbox_add_tool", async () => {
  const model = llm.getModel("echo");

  class Tools extends Toolbox {
    prepared = false;

    original(): string {
      return "Original method";
    }

    override prepare(): void {
      this.prepared = true;
    }
  }

  function new_method(): string {
    return "New method";
  }

  const tools = new Tools();
  tools.add_tool(new_method);
  expect(tools.prepared).toBe(false);

  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "new_method" }] }),
    { tools: [tools] },
  );
  const output = await chainResponse.text();
  expect(output).toContain('"output": "New method"');
  expect(tools.prepared).toBe(true);
});

test("test_toolbox_add_tool_with_pass_self", async () => {
  const model = llm.getModel("echo");

  class Tools extends Toolbox {
    hotdog: string;

    constructor(hotdog: string) {
      super();
      this.hotdog = hotdog;
    }

    original(): string {
      return "Original method";
    }
  }

  function new_method(self: { hotdog: string }): string {
    return self.hotdog;
  }

  const tools = new Tools("doghot");
  tools.add_tool(new_method, true);

  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "new_method" }] }),
    { tools: [tools] },
  );
  const output = await chainResponse.text();
  expect(output).toContain('"output": "doghot"');
});

test("test_conversation_with_tools", async () => {
  function add(a: number, b: number): number {
    return a + b;
  }
  (add as { annotations?: Record<string, string> }).annotations = {
    a: "integer",
    b: "integer",
  };

  function multiply(a: number, b: number): number {
    return a * b;
  }
  (multiply as { annotations?: Record<string, string> }).annotations = {
    a: "integer",
    b: "integer",
  };

  const model = llm.getModel("echo");
  const conversation = model.conversation({ tools: [add, multiply] });

  const output1 = await conversation
    .chain(
      JSON.stringify({
        tool_calls: [
          { name: "multiply", arguments: { a: 5324, b: 23233 } },
        ],
      }),
    )
    .text();
  expect(output1).toContain("123692492");
  const output2 = await conversation
    .chain(
      JSON.stringify({
        tool_calls: [
          { name: "add", arguments: { a: 841758375, b: 123123 } },
        ],
      }),
    )
    .text();
  expect(output2).toContain("841881498");
});

test("test_default_tool_llm_version", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, [
    "-m",
    "echo",
    "-T",
    "llm_version",
    JSON.stringify({ tool_calls: [{ name: "llm_version" }] }),
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(`"output": "${llm_version()}"`);
});

test("test_cli_tools_with_options", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "-m",
      "mock",
      "-o",
      "max_tokens",
      "10",
      "-T",
      "llm_version",
      JSON.stringify({ tool_calls: [{ name: "llm_version" }] }),
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  // It just needs not to crash
  // https://github.com/simonw/llm/issues/1233
});

test("test_functions_tool_locals", async () => {
  // https://github.com/simonw/llm/issues/1107 — Python aliases the
  // builtin (`my_locals = locals`); the JS analog is a named function
  // expression whose runtime .name ("locals") differs from the binding.
  const runner = new CliRunner();
  const result = await runner.invoke(cli, [
    "-m",
    "echo",
    "--functions",
    "const my_locals = function locals() { return 'x' }",
    "-T",
    "llm_version",
    JSON.stringify({ tool_calls: [{ name: "locals" }] }),
  ]);
  expect(result.exitCode).toBe(0);
});

test("test_default_tool_llm_time", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, [
    "-m",
    "echo",
    "-T",
    "llm_time",
    JSON.stringify({ tool_calls: [{ name: "llm_time" }] }),
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("timezone_offset");

  // Test it by calling it directly
  const info = llm_time();
  expect(new Set(Object.keys(info))).toEqual(
    new Set([
      "timezone_offset",
      "utc_time_iso",
      "local_time",
      "local_timezone",
      "utc_time",
      "is_dst",
    ]),
  );
});

test("test_incorrect_tool_usage", async () => {
  const model = llm.getModel("echo");

  function simple(name: string): string {
    return name;
  }

  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "bad_tool" }] }),
    { tools: [simple] },
  );
  const output = await chainResponse.text();
  expect(output).toContain('Error: tool \\"bad_tool\\" does not exist');
});

test("test_tool_returning_attachment", async () => {
  const model = llm.getModel("echo");

  function return_attachment(): ToolOutput {
    return new ToolOutput({
      output: "Output",
      attachments: [
        new llm.Attachment({
          content: Buffer.from("This is a test attachment"),
          type: "image/png",
        }),
      ],
    });
  }

  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "return_attachment" }] }),
    { tools: [return_attachment] },
  );
  const output = await chainResponse.text();
  expect(output).toContain('"type": "image/png"');
  expect(output).toContain('"output": "Output"');
});

test("test_async_tool_returning_attachment", async () => {
  const model = llm.getAsyncModel("echo");

  async function return_attachment(): Promise<ToolOutput> {
    return new ToolOutput({
      output: "Output",
      attachments: [
        new llm.Attachment({
          content: Buffer.from("This is a test attachment"),
          type: "image/png",
        }),
      ],
    });
  }

  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "return_attachment" }] }),
    { tools: [return_attachment] },
  );
  const output = await chainResponse.text();
  expect(output).toContain('"type": "image/png"');
  expect(output).toContain('"output": "Output"');
});

test("test_tool_conversation_settings", async () => {
  const model = llm.getModel("echo");
  const beforeCollected: unknown[] = [];
  const afterCollected: unknown[] = [];

  const before = (...args: unknown[]) => {
    beforeCollected.push(args);
  };
  const after = (...args: unknown[]) => {
    afterCollected.push(args);
  };

  const conversation = model.conversation({
    tools: [llm_time],
    before_call: before,
    after_call: after,
  });
  // Run two things
  await conversation
    .chain(JSON.stringify({ tool_calls: [{ name: "llm_time" }] }))
    .text();
  await conversation
    .chain(JSON.stringify({ tool_calls: [{ name: "llm_time" }] }))
    .text();
  expect(beforeCollected.length).toBe(2);
  expect(afterCollected.length).toBe(2);
});

test("test_tool_conversation_settings_async", async () => {
  const model = llm.getAsyncModel("echo");
  const beforeCollected: unknown[] = [];
  const afterCollected: unknown[] = [];

  const before = async (...args: unknown[]) => {
    beforeCollected.push(args);
  };
  const after = async (...args: unknown[]) => {
    afterCollected.push(args);
  };

  const conversation = model.conversation({
    tools: [llm_time],
    before_call: before,
    after_call: after,
  });
  await conversation
    .chain(JSON.stringify({ tool_calls: [{ name: "llm_time" }] }))
    .text();
  await conversation
    .chain(JSON.stringify({ tool_calls: [{ name: "llm_time" }] }))
    .text();
  expect(beforeCollected.length).toBe(2);
  expect(afterCollected.length).toBe(2);
});

const ERROR_FUNCTION = `
function trigger_error(msg) {
  throw new Error(msg);
}
`;

describe.each([[false], [true]])("test_tool_errors async_=%s", (async_) => {
  test("tool errors logged", async () => {
    // https://github.com/simonw/llm/issues/1107
    const runner = new CliRunner();
    const result = await runner.invoke(cli, [
      "-m",
      "echo",
      "--functions",
      ERROR_FUNCTION,
      JSON.stringify({
        tool_calls: [{ name: "trigger_error", arguments: { msg: "Error!" } }],
      }),
      ...(async_ ? ["--async"] : []),
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('"output": "Error: Error!"');
    // llm logs --json output
    const logJsonResult = await runner.invoke(cli, ["logs", "--json", "-c"]);
    expect(logJsonResult.exitCode).toBe(0);
    const logData = JSON.parse(logJsonResult.output);
    expect(logData.length).toBe(2);
    // Python shows "Exception: Error!"; the JS error class is Error.
    expect(logData[1].tool_results[0].exception).toBe("Error: Error!");
    // llm logs -c output
    const logTextResult = await runner.invoke(cli, ["logs", "-c"]);
    expect(logTextResult.exitCode).toBe(0);
    const normalizedLogText = logTextResult.output.replace(
      /tc_[0-9a-z]{26}/g,
      "tc_TCID",
    );
    expect(normalizedLogText).toContain(
      "- **trigger_error**: `tc_TCID`<br>\n" +
        "    ```\n" +
        "    Error: Error!\n" +
        "    ```<br>\n" +
        "    **Error**: Error: Error!\n",
    );
  });
});

test("test_chain_sync_cancel_only_first_of_two", async () => {
  const model = llm.getModel("echo");

  function t1(): string {
    return "ran1";
  }

  function t2(): string {
    return "ran2";
  }

  const before = (tool: Tool | null, _toolCall: ToolCall) => {
    if (tool && tool.name === "t1") {
      throw new CancelToolCall("skip1");
    }
    // allow t2
  };

  const payload = JSON.stringify({
    tool_calls: [{ name: "t1" }, { name: "t2" }],
  });
  const chain = model.chain(payload, {
    tools: [t1, t2],
    before_call: before,
  }) as ChainResponse;
  await chain.text();

  // second response has two results
  const second = chain._responses[1];
  const results = second.prompt.tool_results;
  expect(results.length).toBe(2);

  // first cancelled, second executed
  expect(results[0].name).toBe("t1");
  expect(results[0].output).toBe("Cancelled: skip1");
  expect(results[0].exception).toBeInstanceOf(CancelToolCall);

  expect(results[1].name).toBe("t2");
  expect(results[1].output).toBe("ran2");
  expect(results[1].exception).toBeNull();
});

test("test_chain_async_cancel_only_first_of_two", async () => {
  const asyncModel = llm.getAsyncModel("echo");

  function t1(): string {
    return "ran1";
  }

  async function t2(): Promise<string> {
    return "ran2";
  }

  const before = async (tool: Tool | null, _toolCall: ToolCall) => {
    if (tool && tool.name === "t1") {
      throw new CancelToolCall("skip1");
    }
  };

  const payload = JSON.stringify({
    tool_calls: [{ name: "t1" }, { name: "t2" }],
  });
  const chain = asyncModel.chain(payload, {
    tools: [t1, t2],
    before_call: before,
  }) as AsyncChainResponse;
  await chain.text();

  const second = chain._responses[1];
  const results = second.prompt.tool_results;
  expect(results.length).toBe(2);

  expect(results[0].name).toBe("t1");
  expect(results[0].output).toBe("Cancelled: skip1");
  expect(results[0].exception).toBeInstanceOf(CancelToolCall);

  expect(results[1].name).toBe("t2");
  expect(results[1].output).toBe("ran2");
  expect(results[1].exception).toBeNull();
});

test("test_tool_function_receives_llm_tool_call", async () => {
  const captured: { tool_call?: ToolCall } = {};

  function lookup(name: string, llm_tool_call: ToolCall): string {
    captured.tool_call = llm_tool_call;
    return "result for " + name;
  }
  (lookup as { description?: string }).description = "Look up a name";

  const model = llm.getModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({
      tool_calls: [{ name: "lookup", arguments: { name: "simon" } }],
    }),
    { tools: [lookup] },
  ) as ChainResponse;
  await chainResponse.text();

  const toolCall = captured.tool_call!;
  expect(toolCall).toBeInstanceOf(ToolCall);
  expect(toolCall.name).toBe("lookup");
  expect(toolCall.arguments).toEqual({ name: "simon" });
  const second = chainResponse._responses[1];
  expect(second.prompt.tool_results[0].output).toBe("result for simon");
});

test("test_async_tool_function_receives_llm_tool_call_with_sync_model", async () => {
  const captured: { tool_call?: ToolCall } = {};

  async function lookup(name: string, llm_tool_call: ToolCall): Promise<string> {
    captured.tool_call = llm_tool_call;
    return "result for " + name;
  }
  (lookup as { description?: string }).description = "Look up a name";

  const model = llm.getModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({
      tool_calls: [{ name: "lookup", arguments: { name: "simon" } }],
    }),
    { tools: [lookup] },
  );
  await chainResponse.text();

  const toolCall = captured.tool_call!;
  expect(toolCall).toBeInstanceOf(ToolCall);
  expect(toolCall.name).toBe("lookup");
  expect(toolCall.arguments).toEqual({ name: "simon" });
});

describe.each([[false], [true]])(
  "test_tool_function_receives_llm_tool_call_async_model async_tool=%s",
  (asyncTool) => {
    test("receives llm_tool_call", async () => {
      const captured: { tool_call?: ToolCall } = {};

      function lookup(name: string, llm_tool_call: ToolCall): string {
        captured.tool_call = llm_tool_call;
        return "result for " + name;
      }
      (lookup as { description?: string }).description = "Look up a name";

      async function async_lookup(
        name: string,
        llm_tool_call: ToolCall,
      ): Promise<string> {
        captured.tool_call = llm_tool_call;
        return "result for " + name;
      }
      (async_lookup as { description?: string }).description =
        "Look up a name";

      const fn = asyncTool ? async_lookup : lookup;
      const model = llm.getAsyncModel("echo");
      const chainResponse = model.chain(
        JSON.stringify({
          tool_calls: [{ name: fn.name, arguments: { name: "simon" } }],
        }),
        { tools: [fn] },
      );
      const output = await chainResponse.text();
      expect(output).toContain('"output": "result for simon"');

      const toolCall = captured.tool_call!;
      expect(toolCall).toBeInstanceOf(ToolCall);
      expect(toolCall.name).toBe(fn.name);
      expect(toolCall.arguments).toEqual({ name: "simon" });
    });
  },
);

test("test_llm_tool_call_excluded_from_input_schema", () => {
  function lookup(name: string, llm_tool_call: ToolCall): string {
    void llm_tool_call;
    return name;
  }
  (lookup as { description?: string }).description = "Look up a name";

  const tool = Tool.function(lookup);
  const properties =
    (tool.input_schema.properties as Record<string, unknown>) ?? {};
  expect("llm_tool_call" in properties).toBe(false);
  expect(
    ((tool.input_schema.required as string[]) ?? []).includes("llm_tool_call"),
  ).toBe(false);
  expect("name" in properties).toBe(true);
});

test("test_kwargs_only_function_does_not_receive_llm_tool_call", async () => {
  // A tool whose implementation does not name llm_tool_call explicitly
  // should NOT have it injected. (Python uses **kwargs; the TS analog
  // is a function that only declares the schema parameters.)
  const captured: Record<string, unknown> = {};

  async function impl(name: string): Promise<string> {
    captured.name = name;
    return "ok";
  }

  const tool = new Tool({
    name: "t",
    description: "A tool",
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
    },
    implementation: impl,
  });
  const model = llm.getModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "t", arguments: { name: "x" } }] }),
    { tools: [tool] },
  );
  await chainResponse.text();
  expect(captured).toEqual({ name: "x" });
});

test("test_toolbox_method_receives_llm_tool_call", async () => {
  const captured: { tool_call?: ToolCall } = {};

  class Tools extends Toolbox {
    lookup(name: string, llm_tool_call: ToolCall): string {
      captured.tool_call = llm_tool_call;
      return "hi " + name;
    }
  }

  const model = llm.getModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({
      tool_calls: [{ name: "Tools_lookup", arguments: { name: "simon" } }],
    }),
    { tools: [new Tools()] },
  );
  const output = await chainResponse.text();
  expect(output).toContain('"output": "hi simon"');

  const toolCall = captured.tool_call!;
  expect(toolCall).toBeInstanceOf(ToolCall);
  expect(toolCall.arguments).toEqual({ name: "simon" });
});

test("test_add_tool_call_synthesizes_missing_tool_call_id", () => {
  const model = llm.getModel("echo");
  const response = model.prompt("hello");
  response.add_tool_call(new ToolCall({ name: "a", arguments: {} }));
  response.add_tool_call(
    new ToolCall({ name: "b", arguments: {}, tool_call_id: "given" }),
  );
  response.add_tool_call(new ToolCall({ name: "c", arguments: {} }));
  const ids = response._tool_calls.map((tc) => tc.tool_call_id);
  expect(ids[0]).not.toBeNull();
  expect(ids[0]!.startsWith("tc_")).toBe(true);
  expect(ids[1]).toBe("given");
  expect(ids[2]).not.toBeNull();
  expect(ids[2]!.startsWith("tc_")).toBe(true);
  expect(ids[0]).not.toBe(ids[2]);
});

test("test_tool_call_ids_guaranteed_through_chain", async () => {
  const seenBeforeCall: Array<string | null> = [];
  const captured: { first_id?: string | null } = {};

  function first(llm_tool_call: ToolCall): string {
    captured.first_id = llm_tool_call.tool_call_id;
    return "one";
  }

  function second(): string {
    return "two";
  }

  const before = (_tool: Tool | null, toolCall: ToolCall) => {
    seenBeforeCall.push(toolCall.tool_call_id);
  };

  const model = llm.getModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "first" }, { name: "second" }] }),
    { tools: [first, second], before_call: before },
  ) as ChainResponse;
  await chainResponse.text();

  expect(seenBeforeCall.length).toBe(2);
  expect(
    seenBeforeCall.every((i) => i !== null && i.startsWith("tc_")),
  ).toBe(true);
  expect(seenBeforeCall[0]).not.toBe(seenBeforeCall[1]);
  // The implementation saw the same id via llm_tool_call
  expect(captured.first_id).toBe(seenBeforeCall[0]);

  // ToolResults and the next prompt's tool message carry the same ids
  const secondResponse = chainResponse._responses[1];
  const resultIds = secondResponse.prompt.tool_results.map(
    (r: ToolResult) => r.tool_call_id,
  );
  expect(resultIds).toEqual(seenBeforeCall);

  // The assistant message parts carry the synthesized ids too, so a
  // persisted-and-replayed history stays correlated
  const firstResponse = chainResponse._responses[0];
  const partIds = firstResponse
    .messagesNow()[0]
    .parts.filter((p) => p instanceof ToolCallPart)
    .map((p) => (p as ToolCallPart).tool_call_id);
  expect(partIds).toEqual(seenBeforeCall);
});

test("test_tool_call_ids_guaranteed_async_model", async () => {
  const seen: Array<string | null> = [];

  async function hello(): Promise<string> {
    return "world";
  }

  const before = async (_tool: Tool | null, toolCall: ToolCall) => {
    seen.push(toolCall.tool_call_id);
  };

  const model = llm.getAsyncModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "hello" }] }),
    { tools: [hello], before_call: before },
  );
  await chainResponse.text();
  expect(seen.length).toBe(1);
  expect(seen[0]).not.toBeNull();
  expect(seen[0]!.startsWith("tc_")).toBe(true);
});

test("test_async_missing_tool_produces_error_result", async () => {
  // Async executor parity with sync: a call to a tool that is not in
  // tools= must produce an error ToolResult, not silently vanish -
  // otherwise the next provider call has a tool_call with no result.
  const beforeCalls: Array<[string | null, string]> = [];

  async function real_tool(): Promise<string> {
    return "ok";
  }

  const before = async (tool: Tool | null, toolCall: ToolCall) => {
    // before_call fires even when tool is None, like the sync path
    beforeCalls.push([tool ? tool.name : null, toolCall.name]);
  };

  const model = llm.getAsyncModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({
      tool_calls: [{ name: "missing_tool" }, { name: "real_tool" }],
    }),
    { tools: [real_tool], before_call: before },
  ) as AsyncChainResponse;
  await chainResponse.text();

  const second = chainResponse._responses[1];
  const results = second.prompt.tool_results.map((r: ToolResult) => [
    r.name,
    r.output,
  ]);
  expect(results).toEqual([
    ["missing_tool", 'Error: tool "missing_tool" does not exist'],
    ["real_tool", "ok"],
  ]);
  // Python raises KeyError here; the port uses a plain Error.
  expect(second.prompt.tool_results[0].exception).toBeInstanceOf(Error);
  expect(beforeCalls).toContainEqual([null, "missing_tool"]);
});

test("test_async_missing_tool_can_be_cancelled_by_before_call", async () => {
  async function real_tool(): Promise<string> {
    return "ok";
  }

  const before = async (tool: Tool | null, _toolCall: ToolCall) => {
    if (tool === null) {
      throw new CancelToolCall("no such tool");
    }
  };

  const model = llm.getAsyncModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({
      tool_calls: [{ name: "missing_tool" }, { name: "real_tool" }],
    }),
    { tools: [real_tool], before_call: before },
  ) as AsyncChainResponse;
  await chainResponse.text();
  const second = chainResponse._responses[1];
  const results = second.prompt.tool_results.map((r: ToolResult) => [
    r.name,
    r.output,
  ]);
  expect(results).toEqual([
    ["missing_tool", "Cancelled: no such tool"],
    ["real_tool", "ok"],
  ]);
});

test("test_async_tool_without_implementation_produces_error_result", async () => {
  const tool = new Tool({
    name: "no_impl",
    description: "A tool with no implementation",
    input_schema: { type: "object", properties: {} },
    implementation: null,
  });
  const model = llm.getAsyncModel("echo");
  const chainResponse = model.chain(
    JSON.stringify({ tool_calls: [{ name: "no_impl" }] }),
    { tools: [tool] },
  ) as AsyncChainResponse;
  await chainResponse.text();
  const second = chainResponse._responses[1];
  expect(
    second.prompt.tool_results.map((r: ToolResult) => [r.name, r.output]),
  ).toEqual([["no_impl", 'Error: tool "no_impl" has no implementation']]);
});
