/**
 * Port of tests/test_plugins.py.
 *
 * Adaptations for TS:
 * - importlib.reload(cli) becomes re-invoking the register_commands hook
 *   on the existing cli group (and deleting the command on cleanup).
 * - Runtime type annotations don't exist, so `tools list` signatures
 *   render as `name(arg, arg)` without `: str` / `-> int`.
 * - --functions takes JavaScript source.
 * - Tool result exception strings use the JS Error name.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as llm from "../src/index.js";
import { cli as cliRoot } from "../src/cli.js";
import { CliRunner, Group, echo } from "../src/click/index.js";
import { hookimpl } from "../src/hookspecs.js";
import { pm } from "../src/plugins.js";
import { Tool, Toolbox } from "../src/models.js";
import { Fragment } from "../src/utils.js";
import { llm_time, llm_version } from "../src/tools.js";
import { Template } from "../src/templates.js";
import { Database } from "../src/sqliteUtils.js";
import { dumps } from "../src/pyjson.js";
import { FetchMock } from "./fetchMock.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

function pluginNames(): string[] {
  return llm.getPlugins().map((plugin) => plugin.name);
}

test("test_register_commands", async () => {
  expect(pluginNames()).not.toContain("HelloWorldPlugin");

  // The transpiler can rename a parameter that shadows an import, so
  // pin the introspected signature via the __wrapped__ convention.
  const registerCommandsImpl = Object.assign(
    (cliGroup: Group) => {
      cliGroup.command({
        name: "hello-world",
        help: "Print hello world",
        handler: async () => {
          echo("Hello world!");
        },
      });
    },
    { __wrapped__: new Function("cli", "") },
  );

  const helloWorldPlugin = {
    __name__: "HelloWorldPlugin",
    register_commands: hookimpl(registerCommandsImpl),
  };

  try {
    pm.register(helloWorldPlugin, "HelloWorldPlugin");
    // Analog of importlib.reload(cli): re-apply register_commands hooks.
    (pm.hook as any).register_commands({ cli: cliRoot });

    expect(pluginNames()).toContain("HelloWorldPlugin");

    const runner = new CliRunner();
    const result = await runner.invoke(cliRoot, ["hello-world"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("Hello world!\n");
  } finally {
    try {
      pm.unregister(undefined, "HelloWorldPlugin");
    } catch {
      // already unregistered
    }
    (cliRoot as Group).commands.delete("hello-world");
    expect(pluginNames()).not.toContain("HelloWorldPlugin");
  }
});

test("test_register_template_loaders", async () => {
  expect(llm.getTemplateLoaders()).toEqual({});

  const one_loader = (templatePath: string) =>
    new Template({ name: "one:" + templatePath, prompt: templatePath });

  const two_loader = (templatePath: string) =>
    new Template({ name: "two:" + templatePath, prompt: templatePath });
  (two_loader as { description?: string }).description = "Docs for two";

  const dupe_two_loader = (templatePath: string) =>
    new Template({ name: "two:" + templatePath, prompt: templatePath });
  (dupe_two_loader as { description?: string }).description =
    "Docs for two dupe";

  const templateLoadersPlugin = {
    __name__: "TemplateLoadersPlugin",
    register_template_loaders: hookimpl(function register_template_loaders(
      register: (prefix: string, loader: unknown) => void,
    ) {
      register("one", one_loader);
      register("two", two_loader);
      register("two", dupe_two_loader);
    }),
  };

  try {
    pm.register(templateLoadersPlugin, "TemplateLoadersPlugin");
    const loaders = llm.getTemplateLoaders();
    expect(loaders).toEqual({
      one: one_loader,
      two: two_loader,
      two_1: dupe_two_loader,
    });

    // Test the CLI command
    const runner = new CliRunner();
    const result = await runner.invoke(cliRoot, ["templates", "loaders"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      "one:\n" +
        "  Undocumented\n" +
        "two:\n" +
        "  Docs for two\n" +
        "two_1:\n" +
        "  Docs for two dupe\n",
    );
  } finally {
    pm.unregister(undefined, "TemplateLoadersPlugin");
    expect(llm.getTemplateLoaders()).toEqual({});
  }
});

test("test_register_fragment_loaders", async () => {
  const fetchMock = new FetchMock();
  fetchMock.install();
  fetchMock.addResponse({
    method: "HEAD",
    url: "https://example.com/attachment.png",
    text: "attachment",
    headers: { "Content-Type": "image/png" },
  });

  expect(llm.getFragmentLoaders()).toEqual({});

  const single_fragment = (argument: string) => {
    void argument;
    return new Fragment("single", "single");
  };
  (single_fragment as { description?: string }).description =
    "This is the fragment documentation";

  const three_fragments = (argument: string) => [
    new Fragment(`one:${argument}`, "one"),
    new Fragment(`two:${argument}`, "two"),
    new Fragment(`three:${argument}`, "three"),
  ];

  const fragment_and_attachment = (argument: string) => [
    new Fragment(`one:${argument}`, "one"),
    new llm.Attachment({ url: "https://example.com/attachment.png" }),
  ];

  const fragmentLoadersPlugin = {
    __name__: "FragmentLoadersPlugin",
    register_fragment_loaders: hookimpl(function register_fragment_loaders(
      register: (prefix: string, loader: unknown) => void,
    ) {
      register("single", single_fragment);
      register("three", three_fragments);
      register("mixed", fragment_and_attachment);
    }),
  };

  try {
    pm.register(fragmentLoadersPlugin, "FragmentLoadersPlugin");
    const loaders = llm.getFragmentLoaders();
    expect(loaders).toEqual({
      single: single_fragment,
      three: three_fragments,
      mixed: fragment_and_attachment,
    });

    // Test the CLI command
    const runner = new CliRunner();
    const result = await runner.invoke(cliRoot, ["-m", "echo", "-f", "three:x"], {
      catchExceptions: false,
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      prompt: "one:x\ntwo:x\nthree:x",
      system: "",
      attachments: [],
      stream: true,
      previous: [],
    });
    // And the llm fragments loaders command:
    const result2 = await runner.invoke(cliRoot, ["fragments", "loaders"]);
    expect(result2.exitCode).toBe(0);
    expect(result2.output).toBe(
      "single:\n" +
        "  This is the fragment documentation\n" +
        "\n" +
        "three:\n" +
        "  Undocumented\n" +
        "\n" +
        "mixed:\n" +
        "  Undocumented\n",
    );

    // Test the one that includes an attachment
    const result3 = await runner.invoke(cliRoot, ["-m", "echo", "-f", "mixed:x"], {
      catchExceptions: false,
    });
    expect(result3.exitCode).toBe(0);
  } finally {
    fetchMock.uninstall();
    pm.unregister(undefined, "FragmentLoadersPlugin");
    expect(llm.getFragmentLoaders()).toEqual({});
  }

  // Let's check the database
  const logsDb = new Database(env.logsDbPath);
  expect(logsDb.query("select content, source from fragments")).toEqual([
    { content: "one:x", source: "one" },
    { content: "two:x", source: "two" },
    { content: "three:x", source: "three" },
  ]);
});

test("test_register_tools", async () => {
  function upper(text: string): string {
    return text.toUpperCase();
  }
  (upper as { description?: string }).description = "Convert text to uppercase.";

  function count_character_in_word(text: string, character: string): number {
    return text.split(character).length - 1;
  }
  (count_character_in_word as { description?: string }).description =
    "Count the number of occurrences of a character in a word.";

  function output_as_json(text: string): Record<string, unknown> {
    return { this_is_in_json: { nested: text } };
  }

  const toolsPlugin = {
    __name__: "ToolsPlugin",
    register_tools: hookimpl(function register_tools(
      register: (tool: unknown, name?: string) => void,
    ) {
      register(Tool.function(upper));
      register(count_character_in_word, "count_chars");
      register(output_as_json);
    }),
  };

  try {
    pm.register(toolsPlugin, "ToolsPlugin");
    const tools = llm.getTools();
    expect(tools).toEqual({
      upper: new Tool({
        name: "upper",
        description: "Convert text to uppercase.",
        input_schema: {
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object",
        },
        implementation: upper,
        plugin: "ToolsPlugin",
      }),
      count_chars: new Tool({
        name: "count_chars",
        description:
          "Count the number of occurrences of a character in a word.",
        input_schema: {
          properties: {
            text: { type: "string" },
            character: { type: "string" },
          },
          required: ["text", "character"],
          type: "object",
        },
        implementation: count_character_in_word,
        plugin: "ToolsPlugin",
      }),
      llm_version: new Tool({
        name: "llm_version",
        description: "Return the installed version of llm",
        input_schema: { properties: {}, type: "object" },
        implementation: llm_version,
        plugin: "llm.default_plugins.default_tools",
      }),
      output_as_json: new Tool({
        name: "output_as_json",
        description: null,
        input_schema: {
          properties: { text: { type: "string" } },
          required: ["text"],
          type: "object",
        },
        implementation: output_as_json,
        plugin: "ToolsPlugin",
      }),
      llm_time: new Tool({
        name: "llm_time",
        description: "Returns the current time, as local time and UTC",
        input_schema: { properties: {}, type: "object" },
        implementation: llm_time,
        plugin: "llm.default_plugins.default_tools",
      }),
    });

    // Test the CLI command (signatures have no type annotations in TS)
    const runner = new CliRunner();
    const result = await runner.invoke(cliRoot, ["tools", "list"]);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      "count_chars(text, character) (plugin: ToolsPlugin)\n\n" +
        "  Count the number of occurrences of a character in a word.\n\n" +
        "llm_time() (plugin: llm.default_plugins.default_tools)\n\n" +
        "  Returns the current time, as local time and UTC\n\n" +
        "llm_version() (plugin: llm.default_plugins.default_tools)\n\n" +
        "  Return the installed version of llm\n\n" +
        "output_as_json(text) (plugin: ToolsPlugin)\n\n" +
        "upper(text) (plugin: ToolsPlugin)\n\n" +
        "  Convert text to uppercase.\n\n",
    );
    // And --json
    const result2 = await runner.invoke(cliRoot, ["tools", "list", "--json"]);
    expect(result2.exitCode).toBe(0);
    expect(JSON.parse(result2.output)).toEqual({
      tools: [
        {
          name: "count_chars",
          description:
            "Count the number of occurrences of a character in a word.",
          arguments: {
            properties: {
              text: { type: "string" },
              character: { type: "string" },
            },
            required: ["text", "character"],
            type: "object",
          },
          plugin: "ToolsPlugin",
        },
        {
          arguments: { properties: {}, type: "object" },
          description: "Returns the current time, as local time and UTC",
          name: "llm_time",
          plugin: "llm.default_plugins.default_tools",
        },
        {
          name: "llm_version",
          description: "Return the installed version of llm",
          arguments: { properties: {}, type: "object" },
          plugin: "llm.default_plugins.default_tools",
        },
        {
          name: "output_as_json",
          description: null,
          arguments: {
            properties: { text: { type: "string" } },
            required: ["text"],
            type: "object",
          },
          plugin: "ToolsPlugin",
        },
        {
          name: "upper",
          description: "Convert text to uppercase.",
          arguments: {
            properties: { text: { type: "string" } },
            required: ["text"],
            type: "object",
          },
          plugin: "ToolsPlugin",
        },
      ],
      toolboxes: [],
    });

    // And test the --functions option (JavaScript source in this port)
    const functionsPath = path.join(env.userPath, "functions.js");
    fs.writeFileSync(
      functionsPath,
      "function example(s, i) {\n  return s + '-' + String(i);\n}",
      "utf-8",
    );
    const result3 = await runner.invoke(cliRoot, [
      "tools",
      "--functions",
      "function reverse(s) { return s.split('').reverse().join(''); }",
      "--functions",
      functionsPath,
    ]);
    expect(result3.exitCode).toBe(0);
    expect(result3.output).toContain("reverse(s)");
    expect(result3.output).toContain("example(s, i)");

    // Now run a prompt using a plugin tool and check it gets logged
    const result4 = await runner.invoke(
      cliRoot,
      [
        "-m",
        "echo",
        "--tool",
        "upper",
        dumps({ tool_calls: [{ name: "upper", arguments: { text: "hi" } }] }),
      ],
      { catchExceptions: false },
    );
    expect(result4.exitCode).toBe(0);
    expect(result4.output).toContain('"output": "HI"');

    // Now check in the database
    const logsDb = new Database(env.logsDbPath);
    const toolRow = logsDb.table("tools").rows[0];
    expect(toolRow.name).toBe("upper");
    expect(toolRow.plugin).toBe("ToolsPlugin");

    // The llm logs command should return that, including with -T upper
    for (const args of [[], ["-T", "upper"]]) {
      const logsResult = await runner.invoke(cliRoot, ["logs", ...args]);
      expect(logsResult.exitCode).toBe(0);
      expect(logsResult.output).toContain("HI");
    }
    // ... but not for -T count_chars
    const logsEmptyResult = await runner.invoke(cliRoot, [
      "logs",
      "-T",
      "count_chars",
    ]);
    expect(logsEmptyResult.exitCode).toBe(0);
    expect(logsEmptyResult.output).not.toContain("HI");

    // Start with a tool, use llm -c to reuse the same tool
    const result5 = await runner.invoke(cliRoot, [
      "prompt",
      "-m",
      "echo",
      "--tool",
      "upper",
      dumps({ tool_calls: [{ name: "upper", arguments: { text: "one" } }] }),
    ]);
    expect(result5.exitCode).toBe(0);
    const contResult = await runner.invoke(cliRoot, [
      "-c",
      dumps({ tool_calls: [{ name: "upper", arguments: { text: "two" } }] }),
    ]);
    expect(contResult.exitCode).toBe(0);
    // Now do it again with llm chat -c
    const chatResult = await runner.invoke(cliRoot, ["chat", "-c"], {
      input:
        dumps({ tool_calls: [{ name: "upper", arguments: { text: "three" } }] }) +
        "\nquit\n",
      catchExceptions: false,
    });
    expect(chatResult.exitCode).toBe(0);
    // Should have logged those three tool uses in llm logs -c -n 0
    const logRowsResult = await runner.invoke(cliRoot, [
      "logs",
      "-c",
      "-n",
      "0",
      "--json",
    ]);
    const logRows = JSON.parse(logRowsResult.output);
    const results = logRows.map(
      (logRow: { prompt: string; tool_results: unknown }) => [
        logRow.prompt,
        dumps(logRow.tool_results).replace(/tc_[0-9a-z]{26}/g, "tc_TCID"),
      ],
    );
    expect(results).toEqual([
      ['{"tool_calls": [{"name": "upper", "arguments": {"text": "one"}}]}', "[]"],
      [
        "",
        '[{"id": 2, "tool_id": 1, "name": "upper", "output": "ONE", "tool_call_id": "tc_TCID", "exception": null, "attachments": []}]',
      ],
      ['{"tool_calls": [{"name": "upper", "arguments": {"text": "two"}}]}', "[]"],
      [
        "",
        '[{"id": 3, "tool_id": 1, "name": "upper", "output": "TWO", "tool_call_id": "tc_TCID", "exception": null, "attachments": []}]',
      ],
      [
        '{"tool_calls": [{"name": "upper", "arguments": {"text": "three"}}]}',
        "[]",
      ],
      [
        "",
        '[{"id": 4, "tool_id": 1, "name": "upper", "output": "THREE", "tool_call_id": "tc_TCID", "exception": null, "attachments": []}]',
      ],
    ]);
    // Test the --td option
    const result6 = await runner.invoke(cliRoot, [
      "prompt",
      "-m",
      "echo",
      "--tool",
      "output_as_json",
      dumps({
        tool_calls: [{ name: "output_as_json", arguments: { text: "hi" } }],
      }),
      "--td",
    ]);
    expect(result6.exitCode).toBe(0);
    expect(result6.output).toContain(
      'Tool call: output_as_json({"text": "hi"})\n' +
        "  {\n" +
        '    "this_is_in_json": {\n' +
        '      "nested": "hi"\n' +
        "    }\n" +
        "  }",
    );
  } finally {
    pm.unregister(undefined, "ToolsPlugin");
  }
});

class Memory extends Toolbox {
  _memory: Record<string, string> | null = null;

  _get_memory(): Record<string, string> {
    if (this._memory === null) {
      this._memory = {};
    }
    return this._memory;
  }

  set(key: string, value: string): void {
    this._get_memory()[key] = value;
  }

  get(key: string): string {
    return this._get_memory()[key] || "";
  }

  append(key: string, value: string): void {
    const memory = this._get_memory();
    memory[key] = (memory[key] || "") + "\n" + value;
  }

  keys(): string[] {
    return Object.keys(this._get_memory());
  }
}
(Memory.prototype.set as { description?: string }).description =
  "Set something as a key";
(Memory.prototype.get as { description?: string }).description =
  "Get something from a key";
(Memory.prototype.append as { description?: string }).description =
  "Append something as a key";
(Memory.prototype.keys as { description?: string }).description =
  "Return a list of keys";

class Filesystem extends Toolbox {
  path: string;

  constructor(pathArg: string) {
    super({ path: pathArg });
    this.path = pathArg;
  }

  async list_files(): Promise<string[]> {
    // async here just to confirm that works
    return fs
      .readdirSync(this.path)
      .map((item) => path.join(this.path, item));
  }
}

const toolboxPlugin = {
  __name__: "ToolboxPlugin",
  register_tools: hookimpl(function register_tools(
    register: (tool: unknown, name?: string) => void,
  ) {
    register(Memory);
    register(Filesystem);
  }),
};

test("test_register_toolbox", async () => {
  // Test the API
  const model = llm.getModel("echo");
  const memory = new Memory();
  const conversation = model.conversation({ tools: [memory] });
  const accumulated: Array<[string, unknown, string]> = [];

  const afterCall = (
    tool: Tool | null,
    toolCall: { arguments: unknown },
    toolResult: { output: string },
  ) => {
    accumulated.push([tool!.name, toolCall.arguments, toolResult.output]);
  };

  await conversation
    .chain(
      dumps({
        tool_calls: [
          { name: "Memory_set", arguments: { key: "hello", value: "world" } },
        ],
      }),
      { after_call: afterCall },
    )
    .text();
  await conversation
    .chain(
      dumps({
        tool_calls: [{ name: "Memory_get", arguments: { key: "hello" } }],
      }),
      { after_call: afterCall },
    )
    .text();
  expect(accumulated).toEqual([
    ["Memory_set", { key: "hello", value: "world" }, "null"],
    ["Memory_get", { key: "hello" }, "world"],
  ]);
  expect(memory._memory).toEqual({ hello: "world" });

  // And for the Filesystem with state
  const myDir = path.join(env.userPath, "mine");
  fs.mkdirSync(myDir);
  fs.writeFileSync(path.join(myDir, "doc.txt"), "hi", "utf-8");
  const conversation2 = model.conversation({ tools: [new Filesystem(myDir)] });
  accumulated.length = 0;
  await conversation2
    .chain(dumps({ tool_calls: [{ name: "Filesystem_list_files" }] }), {
      after_call: afterCall,
    })
    .text();
  expect(accumulated).toEqual([
    ["Filesystem_list_files", {}, dumps([path.join(myDir, "doc.txt")])],
  ]);

  // Now register them with a plugin and use it through the CLI
  try {
    pm.register(toolboxPlugin, "ToolboxPlugin");
    const tools = llm.getTools();
    expect(tools.Memory).toBe(Memory);

    const runner = new CliRunner();
    // llm tools --json
    const result = await runner.invoke(cliRoot, ["tools", "--json"]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      tools: [
        {
          description: "Returns the current time, as local time and UTC",
          name: "llm_time",
          plugin: "llm.default_plugins.default_tools",
          arguments: { properties: {}, type: "object" },
        },
        {
          name: "llm_version",
          description: "Return the installed version of llm",
          arguments: { properties: {}, type: "object" },
          plugin: "llm.default_plugins.default_tools",
        },
      ],
      toolboxes: [
        {
          name: "Filesystem",
          tools: [
            {
              name: "Filesystem_list_files",
              description: null,
              arguments: { properties: {}, type: "object" },
            },
          ],
        },
        {
          name: "Memory",
          tools: [
            {
              name: "Memory_append",
              description: "Append something as a key",
              arguments: {
                properties: {
                  key: { type: "string" },
                  value: { type: "string" },
                },
                required: ["key", "value"],
                type: "object",
              },
            },
            {
              name: "Memory_get",
              description: "Get something from a key",
              arguments: {
                properties: { key: { type: "string" } },
                required: ["key"],
                type: "object",
              },
            },
            {
              name: "Memory_keys",
              description: "Return a list of keys",
              arguments: { properties: {}, type: "object" },
            },
            {
              name: "Memory_set",
              description: "Set something as a key",
              arguments: {
                properties: {
                  key: { type: "string" },
                  value: { type: "string" },
                },
                required: ["key", "value"],
                type: "object",
              },
            },
          ],
        },
      ],
    });

    // llm tools (no JSON; signatures have no type annotations in TS)
    const result2 = await runner.invoke(cliRoot, ["tools"]);
    expect(result2.exitCode).toBe(0);
    expect(result2.output).toBe(
      "llm_time() (plugin: llm.default_plugins.default_tools)\n\n" +
        "  Returns the current time, as local time and UTC\n\n" +
        "llm_version() (plugin: llm.default_plugins.default_tools)\n\n" +
        "  Return the installed version of llm\n\n" +
        "Filesystem:\n\n" +
        "  Filesystem_list_files()\n\n" +
        "Memory:\n\n" +
        "  Memory_append(key, value)\n\n" +
        "    Append something as a key\n\n" +
        "  Memory_get(key)\n\n" +
        "    Get something from a key\n\n" +
        "  Memory_keys()\n\n" +
        "    Return a list of keys\n\n" +
        "  Memory_set(key, value)\n\n" +
        "    Set something as a key\n\n",
    );

    // Test the CLI running a toolbox prompt
    const result3 = await runner.invoke(cliRoot, [
      "prompt",
      "-T",
      "Memory",
      dumps({
        tool_calls: [
          { name: "Memory_set", arguments: { key: "hi", value: "two" } },
          { name: "Memory_get", arguments: { key: "hi" } },
        ],
      }),
      "-m",
      "echo",
    ]);
    expect(result3.exitCode).toBe(0);
    const toolResults3 = JSON.parse(
      "[" + result3.output.split('"tool_results": [')[1].split("]")[0] + "]",
    );
    expect(toolResults3).toEqual([
      {
        name: "Memory_set",
        output: "null",
        tool_call_id: expect.any(String),
      },
      {
        name: "Memory_get",
        output: "two",
        tool_call_id: expect.any(String),
      },
    ]);

    // Test the CLI running a configured toolbox prompt
    const myDir2 = path.join(env.userPath, "mine2");
    fs.mkdirSync(myDir2);
    const otherPath = path.join(myDir2, "other.txt");
    fs.writeFileSync(otherPath, "hi", "utf-8");
    const result4 = await runner.invoke(cliRoot, [
      "prompt",
      "-T",
      `Filesystem(${dumps(myDir2)})`,
      dumps({ tool_calls: [{ name: "Filesystem_list_files" }] }),
      "-m",
      "echo",
    ]);
    expect(result4.exitCode).toBe(0);
    const tail4 = result4.output.split('"tool_results": [')[1];
    const toolResults4 = JSON.parse(
      "[" + tail4.slice(0, tail4.lastIndexOf("]")) + "]",
    );
    expect(toolResults4).toEqual([
      {
        name: "Filesystem_list_files",
        output: dumps([otherPath]),
        tool_call_id: expect.any(String),
      },
    ]);

    // Should show an error if you attempt llm -c with configured toolboxes
    const result5 = await runner.invoke(cliRoot, ["-c", "list them again"]);
    expect(result5.exitCode).toBe(1);
    expect(result5.output).toContain(
      "Error: Tool(s) Filesystem_list_files not found. Available tools:",
    );

    // Test the logging worked
    const logsDb = new Database(env.logsDbPath);
    const rows = logsDb
      .query(TOOL_RESULTS_SQL)
      .map((row) => ({
        ...row,
        tool_calls: JSON.parse(row.tool_calls as string),
        tool_results: JSON.parse(row.tool_results as string),
      }));
    expect(rows).toEqual([
      {
        model: "echo",
        tool_calls: [
          { name: "Memory_set", arguments: '{"key": "hi", "value": "two"}' },
          { name: "Memory_get", arguments: '{"key": "hi"}' },
        ],
        tool_results: [],
      },
      {
        model: "echo",
        tool_calls: [],
        tool_results: [
          {
            name: "Memory_set",
            output: "null",
            instance: {
              name: "Memory",
              plugin: "ToolboxPlugin",
              arguments: "{}",
            },
          },
          {
            name: "Memory_get",
            output: "two",
            instance: {
              name: "Memory",
              plugin: "ToolboxPlugin",
              arguments: "{}",
            },
          },
        ],
      },
      {
        model: "echo",
        tool_calls: [{ name: "Filesystem_list_files", arguments: "{}" }],
        tool_results: [],
      },
      {
        model: "echo",
        tool_calls: [],
        tool_results: [
          {
            name: "Filesystem_list_files",
            output: dumps([otherPath]),
            instance: {
              name: "Filesystem",
              plugin: "ToolboxPlugin",
              arguments: dumps({ path: myDir2 }),
            },
          },
        ],
      },
    ]);
  } finally {
    pm.unregister(undefined, "ToolboxPlugin");
  }
});

test("test_register_toolbox_fails_on_bad_class", () => {
  class BadTools {
    bad(): string {
      return "this is bad";
    }
  }

  const badToolsPlugin = {
    __name__: "BadToolsPlugin",
    register_tools: hookimpl(function register_tools(
      register: (tool: unknown) => void,
    ) {
      // This should fail because BadTools is not a subclass of llm.Toolbox
      register(BadTools);
    }),
  };

  try {
    pm.register(badToolsPlugin, "BadToolsPlugin");
    expect(() => llm.getTools()).toThrowError(TypeError);
  } finally {
    pm.unregister(undefined, "BadToolsPlugin");
  }
});

test("test_toolbox_logging_async", async () => {
  const dirPath = path.join(env.userPath, "path");
  fs.mkdirSync(dirPath);
  const runner = new CliRunner();
  try {
    pm.register(toolboxPlugin, "ToolboxPlugin");

    // Run Memory and Filesystem tests --async
    const result = await runner.invoke(cliRoot, [
      "prompt",
      "--async",
      "-T",
      "Memory",
      "--tool",
      `Filesystem(${dumps(dirPath)})`,
      dumps({
        tool_calls: [
          { name: "Memory_set", arguments: { key: "hi", value: "two" } },
          { name: "Memory_get", arguments: { key: "hi" } },
          { name: "Filesystem_list_files" },
        ],
      }),
      "-m",
      "echo",
    ]);
    expect(result.exitCode).toBe(0);
    const tail = result.output.split('"tool_results": [')[1];
    const toolResults = JSON.parse(
      "[" + tail.slice(0, tail.lastIndexOf("]")) + "]",
    );
    expect(toolResults).toEqual([
      { name: "Memory_set", output: "null", tool_call_id: expect.any(String) },
      { name: "Memory_get", output: "two", tool_call_id: expect.any(String) },
      {
        name: "Filesystem_list_files",
        output: "[]",
        tool_call_id: expect.any(String),
      },
    ]);
  } finally {
    pm.unregister(undefined, "ToolboxPlugin");
  }

  // Check the database
  const logsDb = new Database(env.logsDbPath);
  const rows = logsDb
    .query(TOOL_RESULTS_SQL)
    .map((row) => ({
      ...row,
      tool_calls: JSON.parse(row.tool_calls as string),
      tool_results: JSON.parse(row.tool_results as string),
    }));
  expect(rows).toEqual([
    {
      model: "echo",
      tool_calls: [
        { name: "Memory_set", arguments: '{"key": "hi", "value": "two"}' },
        { name: "Memory_get", arguments: '{"key": "hi"}' },
        { name: "Filesystem_list_files", arguments: "{}" },
      ],
      tool_results: [],
    },
    {
      model: "echo",
      tool_calls: [],
      tool_results: [
        {
          name: "Memory_set",
          output: "null",
          instance: {
            name: "Filesystem",
            plugin: "ToolboxPlugin",
            arguments: "{}",
          },
        },
        {
          name: "Memory_get",
          output: "two",
          instance: {
            name: "Filesystem",
            plugin: "ToolboxPlugin",
            arguments: "{}",
          },
        },
        {
          name: "Filesystem_list_files",
          output: "[]",
          instance: {
            name: "Filesystem",
            plugin: "ToolboxPlugin",
            arguments: dumps({ path: dirPath }),
          },
        },
      ],
    },
  ]);
});

test("test_plugins_command", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cliRoot, ["plugins"]);
  expect(result.exitCode).toBe(0);
  const expected = [
    { name: "EchoModelPlugin", hooks: ["register_models"] },
    {
      name: "MockModelsPlugin",
      hooks: ["register_embedding_models", "register_models"],
    },
  ];
  const actual = JSON.parse(result.output);
  actual.sort((a: { name: string }, b: { name: string }) =>
    a.name < b.name ? -1 : 1,
  );
  expect(actual).toEqual(expected);
  // Test the --hook option
  const result2 = await runner.invoke(cliRoot, [
    "plugins",
    "--hook",
    "register_embedding_models",
  ]);
  expect(result2.exitCode).toBe(0);
  expect(JSON.parse(result2.output)).toEqual([
    {
      name: "MockModelsPlugin",
      hooks: ["register_embedding_models", "register_models"],
    },
  ]);
});

const TOOL_RESULTS_SQL = `
-- First, create ordered subqueries for tool_calls and tool_results
with ordered_tool_calls as (
    select
        tc.response_id,
        json_group_array(
            json_object(
                'name', tc.name,
                'arguments', tc.arguments
            )
        ) as tool_calls_json
    from (
        select * from tool_calls order by id
    ) tc
    where tc.id is not null
    group by tc.response_id
),
ordered_tool_results as (
    select
        tr.response_id,
        json_group_array(
            json_object(
                'name', tr.name,
                'output', tr.output,
                'instance', case
                    when ti.id is not null then json_object(
                        'name', ti.name,
                        'plugin', ti.plugin,
                        'arguments', ti.arguments
                    )
                    else null
                end
            )
        ) as tool_results_json
    from (
        select distinct tr.*, ti.id as ti_id, ti.name as ti_name,
               ti.plugin, ti.arguments as ti_arguments
        from tool_results tr
        left join tool_instances ti on tr.instance_id = ti.id
        order by tr.id
    ) tr
    left join tool_instances ti on tr.instance_id = ti.id
    where tr.id is not null
    group by tr.response_id
)
select
    r.model,
    coalesce(otc.tool_calls_json, '[]') as tool_calls,
    coalesce(otr.tool_results_json, '[]') as tool_results
from responses r
left join ordered_tool_calls otc on r.id = otc.response_id
left join ordered_tool_results otr on r.id = otr.response_id
group by r.id, r.model
order by r.id`;
