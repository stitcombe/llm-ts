/**
 * Port of tests/test_templates.py. The `functions:` blocks contain
 * JavaScript source in this port.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { Template, TemplateMissingVariables } from "../src/templates.js";
import { Toolbox } from "../src/models.js";
import { userDir } from "../src/config.js";
import { llm_version } from "../src/tools.js";
import { hookimpl } from "../src/hookspecs.js";
import { pm } from "../src/plugins.js";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { dumps } from "../src/pyjson.js";
import { FetchMock, mockedOpenaiChat, mockedOpenaiChatReturningFencedCode } from "./fetchMock.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;
let savedOpenaiKey: string | undefined;

beforeEach(() => {
  env = setupTestEnvironment();
  savedOpenaiKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  if (savedOpenaiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedOpenaiKey;
  }
  env.cleanup();
});

function templatesPath(): string {
  const dir = path.join(env.userPath, "templates");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

describe.each([
  ["S: $input", null, null, {}, "S: input", null, null],
  ["S: $input", "system", null, {}, "S: input", "system", null],
  ["No vars", null, null, {}, "No vars", null, null],
  ["$one and $two", null, null, {}, null, null, "Missing variables: one, two"],
  ["$one and $two", null, null, { one: 1, two: 2 }, "1 and 2", null, null],
  ["$one and $two", null, { one: 1 }, { two: 2 }, "1 and 2", null, null],
  ["$one and $$2", null, null, { one: 1 }, "1 and $2", null, null],
  ["$one and $two", null, { one: 99 }, { one: 1, two: 2 }, "1 and 2", null, null],
] as Array<
  [
    string,
    string | null,
    Record<string, unknown> | null,
    Record<string, unknown>,
    string | null,
    string | null,
    string | null,
  ]
>)(
  "test_template_evaluate %#",
  (prompt, system, defaults, params, expectedPrompt, expectedSystem, expectedError) => {
    test("evaluate", () => {
      const t = new Template({ name: "t", prompt, system, defaults });
      if (expectedError) {
        let caught: Error | null = null;
        try {
          t.evaluate("input", params);
        } catch (ex) {
          caught = ex as Error;
        }
        expect(caught).toBeInstanceOf(TemplateMissingVariables);
        expect(caught!.message).toBe(expectedError);
      } else {
        const [evaluatedPrompt, evaluatedSystem] = t.evaluate("input", params);
        expect(evaluatedPrompt).toBe(expectedPrompt);
        expect(evaluatedSystem).toBe(expectedSystem);
      }
    });
  },
);

test("test_templates_list_no_templates_found", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["templates", "list"]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("");
});

describe.each([[["templates", "list"]], [["templates"]]])(
  "test_templates_list args=%j",
  (args) => {
    test("templates list", async () => {
      const dir = templatesPath();
      fs.writeFileSync(path.join(dir, "one.yaml"), "template one", "utf-8");
      fs.writeFileSync(path.join(dir, "two.yaml"), "template two", "utf-8");
      fs.writeFileSync(
        path.join(dir, "three.yaml"),
        "template three is very long ".repeat(4),
        "utf-8",
      );
      fs.writeFileSync(
        path.join(dir, "four.yaml"),
        "'this one\n\nhas newlines in it'",
        "utf-8",
      );
      fs.writeFileSync(
        path.join(dir, "both.yaml"),
        "system: summarize this\nprompt: $input",
        "utf-8",
      );
      fs.writeFileSync(
        path.join(dir, "sys.yaml"),
        "system: Summarize this",
        "utf-8",
      );
      fs.writeFileSync(
        path.join(dir, "invalid.yaml"),
        "system2: This is invalid",
        "utf-8",
      );
      const runner = new CliRunner();
      const result = await runner.invoke(cli, args);
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe(
        "both  : system: summarize this prompt: $input\n" +
          "four  : this one has newlines in it\n" +
          "one   : template one\n" +
          "sys   : system: Summarize this\n" +
          "three : template three is very long template three is very long template thre...\n" +
          "two   : template two\n",
      );
    });
  },
);

describe.each([
  [["-m", "gpt4", "hello"], { model: "gpt-4", prompt: "hello" }, null],
  [["hello $foo"], { prompt: "hello $foo" }, null],
  [["--system", "system"], { system: "system" }, null],
  [["-t", "template"], null, "--save cannot be used with --template"],
  [["--continue"], null, "--save cannot be used with --continue"],
  [["--cid", "123"], null, "--save cannot be used with --cid"],
  [["--conversation", "123"], null, "--save cannot be used with --cid"],
  [
    ["Say hello as $name", "-p", "name", "default-name"],
    { prompt: "Say hello as $name", defaults: { name: "default-name" } },
    null,
  ],
  // Options
  [
    ["-o", "temperature", "0.5", "--system", "in french"],
    { system: "in french", options: { temperature: 0.5 } },
    null,
  ],
  // -x/--extract should be persisted:
  [
    ["--system", "write python", "--extract"],
    { system: "write python", extract: true },
    null,
  ],
  // So should schemas (and should not sort properties)
  [
    [
      "--schema",
      '{"properties": {"b": {"type": "string"}, "a": {"type": "string"}}}',
    ],
    {
      schema_object: {
        properties: { b: { type: "string" }, a: { type: "string" } },
      },
    },
    null,
  ],
  // And fragments and system_fragments
  [
    ["--fragment", "f1.txt", "--system-fragment", "https://example.com/f2.txt"],
    {
      fragments: ["f1.txt"],
      system_fragments: ["https://example.com/f2.txt"],
    },
    null,
  ],
  // And attachments and attachment_types
  [
    ["--attachment", "a.txt", "--attachment-type", "b.txt", "text/plain"],
    {
      attachments: ["a.txt"],
      attachment_types: [{ type: "text/plain", value: "b.txt" }],
    },
    null,
  ],
  // Model option using an enum: https://github.com/simonw/llm/issues/1237
  [
    ["-m", "gpt-5", "-o", "reasoning_effort", "minimal"],
    { model: "gpt-5", options: { reasoning_effort: "minimal" } },
    null,
  ],
] as Array<[string[], Record<string, unknown> | null, string | null]>)(
  "test_templates_prompt_save args=%j",
  (args, expected, expectedError) => {
    test("prompt save", async () => {
      const dir = templatesPath();
      expect(fs.existsSync(path.join(dir, "saved.yaml"))).toBe(false);
      const runner = new CliRunner();
      const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-ts-isofs-"));
      const prevCwd = process.cwd();
      process.chdir(workDir);
      let result;
      try {
        // Create a file to test attachment
        fs.writeFileSync("a.txt", "attachment", "utf-8");
        fs.writeFileSync("b.txt", "attachment type", "utf-8");
        result = await runner.invoke(cli, [...args, "--save", "saved"], {
          catchExceptions: false,
        });
      } finally {
        process.chdir(prevCwd);
        fs.rmSync(workDir, { recursive: true, force: true });
      }
      if (!expectedError) {
        expect(result.exitCode).toBe(0);
        const yamlData = yaml.load(
          fs.readFileSync(path.join(dir, "saved.yaml"), "utf-8"),
        ) as Record<string, unknown>;
        // Adjust attachment and attachment_types paths to just filename
        if ("attachments" in yamlData) {
          yamlData.attachments = (yamlData.attachments as string[]).map((p) =>
            path.basename(p),
          );
        }
        for (const item of (yamlData.attachment_types as Array<{
          value: string;
        }>) ?? []) {
          item.value = path.basename(item.value);
        }
        expect(yamlData).toEqual(expected);
      } else {
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(expectedError);
      }
    });
  },
);

test("test_templates_error_on_missing_schema", async () => {
  templatesPath();
  const runner = new CliRunner();
  await runner.invoke(cli, ["the-prompt", "--save", "prompt_no_schema"], {
    catchExceptions: false,
  });
  // This should complain about no schema
  const result = await runner.invoke(
    cli,
    ["hi", "--schema", "t:prompt_no_schema"],
    { catchExceptions: false },
  );
  expect(result.output).toBe(
    "Error: Template 'prompt_no_schema' has no schema\n",
  );
  // And this is just an invalid template
  const result2 = await runner.invoke(
    cli,
    ["hi", "--schema", "t:bad_template"],
    { catchExceptions: false },
  );
  expect(result2.output).toBe("Error: Invalid template: bad_template\n");
});

describe.each([
  [
    "'Summarize this: $input'",
    "Input text",
    [],
    "gpt-4o-mini",
    "Summarize this: Input text",
    null,
    null,
  ],
  [
    "prompt: 'Summarize this: $input'\nmodel: gpt-4",
    "Input text",
    [],
    "gpt-4",
    "Summarize this: Input text",
    null,
    null,
  ],
  [
    "prompt: 'Summarize this: $input'",
    "Input text",
    ["-m", "4"],
    "gpt-4",
    "Summarize this: Input text",
    null,
    null,
  ],
  // -s system prompt should over-ride template system prompt
  [
    "boo",
    "Input text",
    ["-s", "custom system"],
    "gpt-4o-mini",
    [
      { role: "system", content: "custom system" },
      { role: "user", content: "boo\nInput text" },
    ],
    null,
    null,
  ],
  [
    "prompt: 'Say $hello'",
    "Input text",
    [],
    null,
    null,
    "Error: Missing variables: hello",
    null,
  ],
  // Template generated prompt should combine with CLI prompt
  [
    "prompt: 'Say $hello'",
    "Input text",
    ["-p", "hello", "Blah"],
    "gpt-4o-mini",
    "Say Blah\nInput text",
    null,
    null,
  ],
  ["prompt: 'Say pelican'", "", [], "gpt-4o-mini", "Say pelican", null, null],
  // Template with just a system prompt
  [
    "system: 'Summarize this'",
    "Input text",
    [],
    "gpt-4o-mini",
    [
      { content: "Summarize this", role: "system" },
      { content: "Input text", role: "user" },
    ],
    null,
    null,
  ],
  // Options
  [
    "prompt: 'Summarize this: $input'\noptions:\n  temperature: 0.5",
    "Input text",
    [],
    "gpt-4o-mini",
    "Summarize this: Input text",
    null,
    { temperature: 0.5 },
  ],
  // Should be over-ridden by CLI
  [
    "prompt: 'Summarize this: $input'\noptions:\n  temperature: 0.5",
    "Input text",
    ["-o", "temperature", "0.7"],
    "gpt-4o-mini",
    "Summarize this: Input text",
    null,
    { temperature: 0.7 },
  ],
] as Array<
  [
    string,
    string,
    string[],
    string | null,
    string | Array<Record<string, string>> | null,
    string | null,
    Record<string, unknown> | null,
  ]
>)(
  "test_execute_prompt_with_a_template %#",
  (
    template,
    inputText,
    extraArgs,
    expectedModel,
    expectedInput,
    expectedError,
    expectedOptions,
  ) => {
    test("execute with template", async () => {
      process.env.OPENAI_API_KEY = "X";
      const fetchMock = new FetchMock();
      fetchMock.install();
      try {
        mockedOpenaiChat(fetchMock);
        fs.writeFileSync(
          path.join(templatesPath(), "template.yaml"),
          template,
          "utf-8",
        );
        const runner = new CliRunner();
        const result = await runner.invoke(
          cli,
          [
            "--no-stream",
            "-t",
            "template",
            ...(inputText ? [inputText] : []),
            ...extraArgs,
          ],
          { catchExceptions: false },
        );
        const expectedMessages =
          typeof expectedInput === "string"
            ? [{ role: "user", content: expectedInput }]
            : expectedInput;

        if (expectedError === null) {
          expect(result.exitCode).toBe(0);
          const requests = fetchMock.getRequests();
          const lastRequest = requests[requests.length - 1];
          const expectedData: Record<string, unknown> = {
            model: expectedModel,
            messages: expectedMessages,
            stream: false,
          };
          if (expectedOptions) {
            Object.assign(expectedData, expectedOptions);
          }
          expect(JSON.parse(lastRequest.content)).toEqual(expectedData);
        } else {
          expect(result.exitCode).toBe(1);
          expect(result.output.trim()).toBe(expectedError);
        }
      } finally {
        fetchMock.uninstall();
      }
    });
  },
);

describe.each([
  [
    "system: system\nprompt: prompt",
    {
      prompt: "prompt",
      system: "system",
      attachments: [],
      stream: true,
      previous: [],
    },
  ],
  [
    "prompt: |\n  This is\n  ```\n  code to extract\n  ```",
    {
      prompt: "This is\n```\ncode to extract\n```",
      system: "",
      attachments: [],
      stream: true,
      previous: [],
    },
  ],
  // Now try that with extract: true
  [
    'extract: true\nprompt: |\n  {"raw": "This is\\n```\\ncode to extract\\n```"}',
    "code to extract",
  ],
] as Array<[string, Record<string, unknown> | string]>)(
  "test_execute_prompt_from_template_url %#",
  (template, expected) => {
    test("execute from template url", async () => {
      const fetchMock = new FetchMock();
      fetchMock.install();
      try {
        fetchMock.addResponse({
          method: "GET",
          url: "https://example.com/prompt.yaml",
          text: template,
        });
        const runner = new CliRunner();
        const result = await runner.invoke(
          cli,
          ["-t", "https://example.com/prompt.yaml", "-m", "echo"],
          { catchExceptions: false },
        );
        expect(result.exitCode).toBe(0);
        if (typeof expected === "object") {
          expect(JSON.parse(result.output.trim())).toEqual(expected);
        } else {
          expect(result.output.trim()).toBe(expected);
        }
      } finally {
        fetchMock.uninstall();
      }
    });
  },
);

test("test_execute_prompt_from_template_path", async () => {
  const runner = new CliRunner();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-ts-isofs-"));
  try {
    const templateFile = path.join(workDir, "my-template.yaml");
    fs.writeFileSync(templateFile, "system: system\nprompt: prompt", "utf-8");
    const result = await runner.invoke(cli, ["-t", templateFile, "-m", "echo"], {
      catchExceptions: false,
    });
    expect(result.exitCode, result.output).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      prompt: "prompt",
      system: "system",
      attachments: [],
      stream: true,
      previous: [],
    });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("test_template_respects_cli_extract_flag", async () => {
  const fetchMock = new FetchMock();
  fetchMock.install();
  try {
    mockedOpenaiChatReturningFencedCode(fetchMock);
    fs.writeFileSync(
      path.join(templatesPath(), "code.yaml"),
      "prompt: Write code",
      "utf-8",
    );
    const runner = new CliRunner();
    const result = await runner.invoke(
      cli,
      ["-t", "code", "-m", "gpt-4o-mini", "--key", "x", "-x"],
      { catchExceptions: false },
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).not.toContain("```");
    expect(result.output.trim()).toBe("function foo() {\n  return 'bar';\n}");
  } finally {
    fetchMock.uninstall();
  }
});

const FUNCTIONS_EXAMPLE = `
function greet(name) {
  return "Hello, " + name + "!";
}
`;

class Greeting extends Toolbox {
  greeting: string;

  constructor(greeting: string) {
    super({ greeting });
    this.greeting = greeting;
  }

  greet(name: string): string {
    return `${this.greeting}, ${name}!`;
  }
}
(Greeting.prototype.greet as { description?: string }).description =
  "Greet name with a greeting";

const greetingsPlugin = {
  __name__: "GreetingsPlugin",
  register_tools: hookimpl(function register_tools(
    register: (tool: unknown) => void,
  ) {
    register(Greeting);
  }),
};

const TEMPLATE_YAML = `
name: test
tools:
- llm_version
- Greeting("hi")
functions: |
  function demo() {
    return "Demo";
  }
`;

describe.each([
  ["alias", true, true],
  ["file", true, true],
  // Loaded from URL or plugin = functions: should not work
  ["url", true, false],
  ["plugin", true, false],
] as Array<[string, boolean, boolean]>)(
  "test_tools_in_templates source=%s",
  (source, expectedToolSuccess, expectedFunctionsSuccess) => {
    test("tools in templates", async () => {
      const fetchMock = new FetchMock();
      fetchMock.install();
      let args: string[] = [];
      let before = () => {};
      let after = () => {};

      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-ts-tools-tpl-"));

      if (source === "alias") {
        args = ["-t", "test"];
        const dir = path.join(userDir(), "templates");
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "test.yaml"), TEMPLATE_YAML, "utf-8");
      } else if (source === "file") {
        fs.writeFileSync(path.join(tmpDir, "test.yaml"), TEMPLATE_YAML, "utf-8");
        args = ["-t", path.join(tmpDir, "test.yaml")];
      } else if (source === "url") {
        fetchMock.addResponse({
          method: "GET",
          url: "https://example.com/test.yaml",
          text: TEMPLATE_YAML,
        });
        fetchMock.addResponse({
          method: "GET",
          url: "https://example.com/test.yaml",
          text: TEMPLATE_YAML,
        });
        fetchMock.addResponse({
          method: "GET",
          url: "https://example.com/test.yaml",
          text: TEMPLATE_YAML,
        });
        fetchMock.addResponse({
          method: "GET",
          url: "https://example.com/test.yaml",
          text: TEMPLATE_YAML,
        });
        args = ["-t", "https://example.com/test.yaml"];
      } else if (source === "plugin") {
        const loadTemplatePlugin = {
          __name__: "LoadTemplatePlugin",
          register_template_loaders: hookimpl(
            function register_template_loaders(
              register: (prefix: string, loader: unknown) => void,
            ) {
              register(
                "tool-template",
                () =>
                  new Template({
                    name: "tool-template",
                    tools: ["llm_version", 'Greeting("hi")'],
                    functions: FUNCTIONS_EXAMPLE.replace(
                      /function greet[\s\S]*/,
                      'function demo() {\n  return "Demo";\n}\n',
                    ),
                  }),
              );
            },
          ),
        };

        before = () => {
          pm.register(loadTemplatePlugin, "test-tools-in-templates");
        };
        after = () => {
          pm.unregister(undefined, "test-tools-in-templates");
        };

        args = ["-t", "tool-template:"];
      }

      before();
      pm.register(greetingsPlugin, "greetings-plugin");
      // chdir away from the repo root so a template name like "test"
      // doesn't collide with the local test/ directory (Python's
      // load_template checks the filesystem first).
      const prevCwd = process.cwd();
      process.chdir(tmpDir);
      try {
        const runner = new CliRunner();
        // Test llm_version, then Greeting, then demo
        const cases: Array<[Record<string, unknown>, string, boolean]> = [
          [{ name: "llm_version" }, llm_version(), true],
          [
            { name: "Greeting_greet", arguments: { name: "Alice" } },
            "hi, Alice",
            expectedToolSuccess,
          ],
          [
            { name: "Greeting_greet", arguments: { name: "Bob" } },
            "hi, Bob!",
            expectedToolSuccess,
          ],
          [{ name: "demo" }, '"output": "Demo"', expectedFunctionsSuccess],
        ];
        for (const [toolCall, text, shouldBePresent] of cases) {
          const result = await runner.invoke(
            cli,
            [
              ...args,
              "-m",
              "echo",
              "--no-stream",
              dumps({ tool_calls: [toolCall] }),
            ],
            { catchExceptions: false },
          );
          expect(result.exitCode).toBe(0);
          if (shouldBePresent) {
            expect(result.output).toContain(text);
          } else {
            expect(result.output).not.toContain(text);
          }
        }
      } finally {
        process.chdir(prevCwd);
        after();
        pm.unregister(undefined, "greetings-plugin");
        fetchMock.uninstall();
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  },
);
