/**
 * Port of the CLI-invoking tests from tests/test_llm.py (the
 * library-level tests live in test_llm.test.ts). pytest-httpx is
 * replaced by test/fetchMock.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as llm from "../src/index.js";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { Database } from "../src/sqliteUtils.js";
import { AsyncChat } from "../src/default_plugins/openai_models.js";
import { dumps } from "../src/pyjson.js";
import {
  FetchMock,
  mockedLocalai,
  mockedOpenaiChat,
  mockedOpenaiChatReturningFencedCode,
  mockedOpenaiChatStream,
  mockedOpenaiCompletion,
  mockedOpenaiCompletionLogprobs,
  mockedOpenaiCompletionLogprobsStream,
} from "./fetchMock.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;
let fetchMock: FetchMock;
let savedOpenaiKey: string | undefined;

beforeEach(() => {
  env = setupTestEnvironment();
  fetchMock = new FetchMock();
  fetchMock.install();
  savedOpenaiKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  fetchMock.uninstall();
  if (savedOpenaiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedOpenaiKey;
  }
  env.cleanup();
});

const dog = { name: "Cleo", age: 10 };

test("test_version", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["--version"]);
  expect(result.exitCode).toBe(0);
  expect(result.output.startsWith("cli, version ")).toBe(true);
});

describe.each([[false], [true]])(
  "test_llm_prompt_creates_log_database custom_database_path=%s",
  (customDatabasePath) => {
    test("creates log database", async () => {
      mockedOpenaiChat(fetchMock);
      const userPath = path.join(env.userPath, "user");
      const customDbPath = path.join(env.userPath, "custom_log.db");
      process.env.LLM_USER_PATH = userPath;
      const runner = new CliRunner();
      const args = ["three names \nfor a pet pelican", "--no-stream", "--key", "x"];
      if (customDatabasePath) {
        args.push("--database", customDbPath);
      }
      const result = await runner.invoke(cli, args, {
        catchExceptions: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe("Bob, Alice, Eve\n");
      // Should have created user_path and put a logs.db in it
      let dbPath: string;
      if (customDatabasePath) {
        expect(fs.existsSync(customDbPath)).toBe(true);
        dbPath = customDbPath;
      } else {
        expect(fs.existsSync(path.join(userPath, "logs.db"))).toBe(true);
        dbPath = path.join(userPath, "logs.db");
      }
      expect(new Database(dbPath).table("responses").count).toBe(1);
    });
  },
);

describe.each([
  [true, [], false],
  [false, [], true],
  [false, ["--no-log"], false],
  [false, ["--log"], true],
  [true, ["-n"], false], // Short for --no-log
  [true, ["--log"], true],
] as Array<[boolean, string[], boolean]>)(
  "test_llm_default_prompt logs_off=%s logs_args=%j should_log=%s",
  (logsOff, logsArgs, shouldLog) => {
    describe.each([[true], [false], ["split"]] as Array<[boolean | "split"]>)(
      "use_stdin=%s",
      (useStdin) => {
        test("default prompt", async () => {
          process.env.OPENAI_API_KEY = "X";
          mockedOpenaiChat(fetchMock);
          const logDb = new Database(env.logsDbPath);

          const logsOffPath = path.join(env.userPath, "logs-off");
          if (logsOff) {
            // Turn off logging
            expect(fs.existsSync(logsOffPath)).toBe(false);
            await new CliRunner().invoke(cli, ["logs", "off"]);
            expect(fs.existsSync(logsOffPath)).toBe(true);
          } else {
            // Turn on logging
            await new CliRunner().invoke(cli, ["logs", "on"]);
            expect(fs.existsSync(logsOffPath)).toBe(false);
          }

          // Run the prompt
          const runner = new CliRunner();
          const prompt = "three names \nfor a pet pelican";
          let input: string | null = null;
          const args = ["--no-stream"];
          if (useStdin === "split") {
            input = "three names";
            args.push("\nfor a pet pelican");
          } else if (useStdin) {
            input = prompt;
          } else {
            args.push(prompt);
          }
          args.push(...logsArgs);
          const result = await runner.invoke(cli, args, {
            input,
            catchExceptions: false,
          });
          expect(result.exitCode).toBe(0);
          expect(result.output).toBe("Bob, Alice, Eve\n");
          const requests = fetchMock.getRequests();
          const lastRequest = requests[requests.length - 1];
          expect(lastRequest.headers.Authorization).toBe("Bearer X");

          // Was it logged?
          const rows = logDb.table("responses").exists()
            ? logDb.table("responses").rows
            : [];

          if (!shouldLog) {
            expect(rows.length).toBe(0);
            return;
          }

          expect(rows.length).toBe(1);
          const row = rows[0];
          expect(row).toMatchObject({
            model: "gpt-4o-mini",
            prompt: "three names \nfor a pet pelican",
            system: null,
            options_json: "{}",
            response: "Bob, Alice, Eve",
          });
          expect(typeof row.duration_ms).toBe("number");
          expect(typeof row.datetime_utc).toBe("string");
          expect(JSON.parse(row.prompt_json as string)).toEqual({
            messages: [
              { role: "user", content: "three names \nfor a pet pelican" },
            ],
          });
          expect(JSON.parse(row.response_json as string)).toEqual({
            choices: [{ message: { content: { $: `r:${row.id}` } } }],
            model: "gpt-4o-mini",
          });

          // Test "llm logs"
          const logResult = await runner.invoke(
            cli,
            ["logs", "-n", "1", "--json"],
            { catchExceptions: false },
          );
          const logJson = JSON.parse(logResult.output);

          // Should have logged correctly:
          expect(logJson[0]).toMatchObject({
            model: "gpt-4o-mini",
            prompt: "three names \nfor a pet pelican",
            system: null,
            prompt_json: {
              messages: [
                { role: "user", content: "three names \nfor a pet pelican" },
              ],
            },
            options_json: {},
            response: "Bob, Alice, Eve",
            response_json: {
              model: "gpt-4o-mini",
              choices: [{ message: { content: { $: `r:${row.id}` } } }],
            },
            // This doesn't have the \n after three names:
            conversation_name: "three names for a pet pelican",
            conversation_model: "gpt-4o-mini",
          });
        });
      },
    );
  },
);

describe.each([[false], [true]])(
  "test_llm_prompt_continue async_=%s",
  (async_) => {
    test("prompt continue", async () => {
      process.env.OPENAI_API_KEY = "X";
      fetchMock.addResponse({
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        json: {
          model: "gpt-4o-mini",
          usage: {},
          choices: [{ message: { content: "Bob, Alice, Eve" } }],
        },
      });
      fetchMock.addResponse({
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        json: {
          model: "gpt-4o-mini",
          usage: {},
          choices: [{ message: { content: "Terry" } }],
        },
      });

      const logDb = new Database(env.logsDbPath);

      // First prompt
      const runner = new CliRunner();
      const args = ["three names \nfor a pet pelican", "--no-stream"];
      if (async_) args.push("--async");
      const result = await runner.invoke(cli, args, {
        catchExceptions: false,
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toBe("Bob, Alice, Eve\n");

      // Should be logged
      expect(logDb.table("responses").rows.length).toBe(1);

      // Now ask a follow-up
      const args2 = ["one more", "-c", "--no-stream"];
      if (async_) args2.push("--async");
      const result2 = await runner.invoke(cli, args2, {
        catchExceptions: false,
      });
      expect(result2.exitCode, result2.output).toBe(0);
      expect(result2.output).toBe("Terry\n");

      expect(logDb.table("responses").rows.length).toBe(2);
    });
  },
);

describe.each([
  [["-x"], true],
  [["--extract"], true],
  [["-x", "--async"], true],
  [["--extract", "--async"], true],
  // Use --no-stream here to ensure it passes test same as -x/--extract cases
  [["--no-stream"], false],
] as Array<[string[], boolean]>)(
  "test_extract_fenced_code args=%j",
  (args, expectJustCode) => {
    test("extract fenced code", async () => {
      mockedOpenaiChatReturningFencedCode(fetchMock);
      const runner = new CliRunner();
      const result = await runner.invoke(
        cli,
        ["-m", "gpt-4o-mini", "--key", "x", "Write code", ...args],
        { catchExceptions: false },
      );
      const output = result.output;
      if (expectJustCode) {
        expect(output).not.toContain("```");
      } else {
        expect(output).toContain("```");
      }
    });
  },
);

test("test_openai_chat_stream", async () => {
  mockedOpenaiChatStream(fetchMock);
  const runner = new CliRunner();
  const result = await runner.invoke(cli, [
    "-m",
    "gpt-3.5-turbo",
    "--key",
    "x",
    "Say hi",
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("Hi.\n");
});

test("test_openai_completion", async () => {
  mockedOpenaiCompletion(fetchMock);
  const logDb = new Database(env.logsDbPath);
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "-m",
      "gpt-3.5-turbo-instruct",
      "Say this is a test",
      "--no-stream",
      "--key",
      "x",
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("\n\nThis is indeed a test\n");

  // Should have requested 256 tokens
  const requests = fetchMock.getRequests();
  const lastRequest = requests[requests.length - 1];
  expect(JSON.parse(lastRequest.content)).toEqual({
    model: "gpt-3.5-turbo-instruct",
    prompt: "Say this is a test",
    stream: false,
    max_tokens: 256,
  });

  // Check it was logged
  const rows = logDb.table("responses").rows;
  expect(rows.length).toBe(1);
  expect(rows[0]).toMatchObject({
    model: "gpt-3.5-turbo-instruct",
    prompt: "Say this is a test",
    system: null,
    prompt_json: '{"messages": ["Say this is a test"]}',
    options_json: "{}",
    response: "\n\nThis is indeed a test",
  });
});

test("test_openai_completion_system_prompt_error", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, [
    "-m",
    "gpt-3.5-turbo-instruct",
    "Say this is a test",
    "--no-stream",
    "--key",
    "x",
    "--system",
    "system prompts not allowed",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain(
    "System prompts are not supported for OpenAI completion models",
  );
});

test("test_openai_completion_logprobs_stream", async () => {
  mockedOpenaiCompletionLogprobsStream(fetchMock);
  const logDb = new Database(env.logsDbPath);
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    ["-m", "gpt-3.5-turbo-instruct", "Say hi", "-o", "logprobs", "2", "--key", "x"],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("\n\nHi.\n");
  const rows = logDb.table("responses").rows;
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(JSON.parse(row.response_json as string)).toEqual({
    content: { $: `r:${row.id}` },
    logprobs: [
      { text: "\n\n", top_logprobs: [{ "\n\n": -0.6, "\n": -1.9 }] },
      { text: "Hi", top_logprobs: [{ Hi: -1.1, Hello: -0.7 }] },
      { text: ".", top_logprobs: [{ ".": -1.1, "!": -0.9 }] },
      { text: "", top_logprobs: [] },
    ],
    id: "cmpl-80MdSaou7NnPuff5ZyRMysWBmgSPS",
    object: "text_completion",
    model: "gpt-3.5-turbo-instruct",
    created: 1695097702,
  });
});

test("test_openai_completion_logprobs_nostream", async () => {
  mockedOpenaiCompletionLogprobs(fetchMock);
  const logDb = new Database(env.logsDbPath);
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "-m",
      "gpt-3.5-turbo-instruct",
      "Say hi",
      "-o",
      "logprobs",
      "2",
      "--key",
      "x",
      "--no-stream",
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("\n\nHi.\n");
  const rows = logDb.table("responses").rows;
  expect(rows.length).toBe(1);
  const row = rows[0];
  expect(JSON.parse(row.response_json as string)).toEqual({
    choices: [
      {
        finish_reason: "stop",
        index: 0,
        logprobs: {
          text_offset: [16, 18, 20],
          token_logprobs: [-0.6, -1.1, -0.9],
          tokens: ["\n\n", "Hi", "1"],
          top_logprobs: [
            { "\n": -1.9, "\n\n": -0.6 },
            { Hello: -0.7, Hi: -1.1 },
            { "!": -1.1, ".": -0.9 },
          ],
        },
        text: { $: `r:${row.id}` },
      },
    ],
    created: 1695097747,
    id: "cmpl-80MeBfKJutM0uMNJkRrebJLeP3bxL",
    model: "gpt-3.5-turbo-instruct",
    object: "text_completion",
    usage: { completion_tokens: 3, prompt_tokens: 5, total_tokens: 8 },
  });
});

const EXTRA_MODELS_YAML = `
- model_id: orca
  model_name: orca-mini-3b
  api_base: "http://localai.localhost"
- model_id: completion-babbage
  model_name: babbage
  api_base: "http://localai.localhost"
  completion: 1
`;

test("test_openai_localai_configuration", async () => {
  mockedLocalai(fetchMock);
  // Write the configuration file
  fs.writeFileSync(
    path.join(env.userPath, "extra-openai-models.yaml"),
    EXTRA_MODELS_YAML,
    "utf-8",
  );
  // Run the prompt
  const runner = new CliRunner();
  const prompt = "three names \nfor a pet pelican";
  const result = await runner.invoke(cli, [
    "--no-stream",
    "--model",
    "orca",
    prompt,
  ]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("Bob, Alice, Eve\n");
  let requests = fetchMock.getRequests();
  expect(JSON.parse(requests[requests.length - 1].content)).toEqual({
    model: "orca-mini-3b",
    messages: [{ role: "user", content: "three names \nfor a pet pelican" }],
    stream: false,
  });
  // And check the completion model too
  const result2 = await runner.invoke(cli, [
    "--no-stream",
    "--model",
    "completion-babbage",
    "hi",
  ]);
  expect(result2.exitCode).toBe(0);
  expect(result2.output).toBe("Hello\n");
  requests = fetchMock.getRequests();
  expect(JSON.parse(requests[requests.length - 1].content)).toEqual({
    model: "babbage",
    prompt: "hi",
    stream: false,
  });
});

test("test_extra_openai_models_async", () => {
  fs.writeFileSync(
    path.join(env.userPath, "extra-openai-models.yaml"),
    EXTRA_MODELS_YAML,
    "utf-8",
  );
  const asyncModel = llm.getAsyncModel("orca") as unknown as AsyncChat;
  expect(asyncModel).toBeInstanceOf(AsyncChat);
  expect(asyncModel.model_id).toBe("orca");
  expect(asyncModel.model_name).toBe("orca-mini-3b");
  expect(asyncModel.api_base).toBe("http://localai.localhost");
  expect(asyncModel.needs_key).toBeNull();
  // Completion models should not have an async variant
  expect(() => llm.getAsyncModel("completion-babbage")).toThrowError(
    llm.UnknownModelError,
  );
});

describe.each([
  [["-q", "mo", "-q", "ck"], 0],
  [["-q", "mock"], 0],
  [["-q", "badmodel"], 1],
  [["-q", "mock", "-q", "badmodel"], 1],
] as Array<[string[], number]>)(
  "test_prompt_select_model_with_queries args=%j",
  (args, exitCode) => {
    test("select model with queries", async () => {
      const runner = new CliRunner();
      const result = await runner.invoke(cli, [...args, "hello"]);
      expect(result.exitCode).toBe(exitCode);
    });
  },
);

test("test_llm_models_options", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["models", "--options"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  // Check for key components instead of exact string match
  expect(result.output).toContain("OpenAI Chat: gpt-4o (aliases: 4o)");
  expect(result.output).toContain("  Options:");
  expect(result.output).toContain("    temperature: float");
  expect(result.output).toContain("  Keys:");
  expect(result.output).toContain("    key: openai");
  expect(result.output).toContain("    env_var: OPENAI_API_KEY");
  expect(result.output).not.toContain("AsyncMockModel (async): mock");
});

test("test_prompt_options_shows_selected_model_options", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["-m", "gpt-5.5", "--options"], {
    catchExceptions: false,
  });
  const expected = await runner.invoke(
    cli,
    ["models", "-m", "gpt-5.5", "--options"],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(expected.exitCode).toBe(0);
  expect(result.output).toBe(expected.output);
  expect(result.output).toContain("OpenAI Responses: gpt-5.5");
  expect(result.output).toContain("  Options:");
  expect(result.output).toContain("    reasoning_effort: str");
  expect(fs.existsSync(env.logsDbPath)).toBe(false);
});

test("test_llm_models_async", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["models", "--async"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("AsyncMockModel (async): mock");
});

describe.each([
  [["-q", "gpt-4o"], ["OpenAI Chat: gpt-4o"], null],
  [["-q", "mock"], ["MockModel: mock"], null],
  [["--query", "mock"], ["MockModel: mock"], null],
  [
    ["-q", "4o", "-q", "mini"],
    ["OpenAI Chat: gpt-4o-mini"],
    ["OpenAI Chat: gpt-4o "],
  ],
  [
    ["-m", "gpt-4o-mini", "-m", "gpt-4.5"],
    ["OpenAI Chat: gpt-4o-mini", "OpenAI Chat: gpt-4.5"],
    ["OpenAI Chat: gpt-4o "],
  ],
] as Array<[string[], string[], string[] | null]>)(
  "test_llm_models_filter args=%j",
  (args, expectedModelIds, unexpectedModelIds) => {
    test("models filter", async () => {
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["models", ...args], {
        catchExceptions: false,
      });
      expect(result.exitCode).toBe(0);
      for (const expectedModelId of expectedModelIds) {
        expect(result.output).toContain(expectedModelId);
      }
      if (unexpectedModelIds) {
        for (const unexpectedModelId of unexpectedModelIds) {
          expect(result.output).not.toContain(unexpectedModelId);
        }
      }
    });
  },
);

test("test_model_environment_variable", async () => {
  process.env.LLM_MODEL = "echo";
  try {
    const runner = new CliRunner();
    const result = await runner.invoke(
      cli,
      ["--no-stream", "hello", "-s", "sys"],
      { catchExceptions: false },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual({
      prompt: "hello",
      system: "sys",
      attachments: [],
      stream: false,
      previous: [],
    });
  } finally {
    delete process.env.LLM_MODEL;
  }
});

describe.each([[true], [false]])(
  "test_schema_via_cli use_filename=%s",
  (useFilename) => {
    test("schema via cli", async () => {
      const userPath = path.join(env.userPath, "user");
      const schemaPath = path.join(env.userPath, "schema.json");
      env.mockModel.enqueue([dumps(dog)]);
      let schemaValue = '{"schema": "one"}';
      fs.writeFileSync(schemaPath, schemaValue, "utf-8");
      process.env.LLM_USER_PATH = userPath;
      if (useFilename) {
        schemaValue = schemaPath;
      }
      const runner = new CliRunner();
      const result = await runner.invoke(
        cli,
        ["--schema", schemaValue, "prompt", "-m", "mock"],
        { catchExceptions: false },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('{"name": "Cleo", "age": 10}\n');
      // Should have created user_path and put a logs.db in it
      expect(fs.existsSync(path.join(userPath, "logs.db"))).toBe(true);
      const rows = new Database(path.join(userPath, "logs.db")).table("schemas")
        .rows;
      expect(rows).toEqual([
        {
          id: "9a8ed2c9b17203f6d8905147234475b5",
          content: '{"schema":"one"}',
        },
      ]);
      if (useFilename) {
        // Run it again to check that the ID option works now it's in the DB
        env.mockModel.enqueue([dumps(dog)]);
        const result2 = await runner.invoke(
          cli,
          [
            "--schema",
            "9a8ed2c9b17203f6d8905147234475b5",
            "prompt",
            "-m",
            "mock",
          ],
          { catchExceptions: false },
        );
        expect(result2.exitCode).toBe(0);
      }
    });
  },
);

describe.each([
  [
    ["--schema", "name, age int"],
    {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name", "age"],
    },
  ],
  [
    ["--schema-multi", "name, age int"],
    {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              age: { type: "integer" },
            },
            required: ["name", "age"],
          },
        },
      },
      required: ["items"],
    },
  ],
] as Array<[string[], Record<string, unknown>]>)(
  "test_schema_using_dsl args=%j",
  (args, expected) => {
    test("schema using dsl", async () => {
      const userPath = path.join(env.userPath, "user");
      env.mockModel.enqueue([dumps(dog)]);
      process.env.LLM_USER_PATH = userPath;
      const runner = new CliRunner();
      const result = await runner.invoke(
        cli,
        ["prompt", "-m", "mock", ...args],
        { catchExceptions: false },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe('{"name": "Cleo", "age": 10}\n');
      const rows = new Database(path.join(userPath, "logs.db")).table("schemas")
        .rows;
      expect(JSON.parse(rows[0].content as string)).toEqual(expected);
    });
  },
);

test("test_schemas_dsl", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, [
    "schemas",
    "dsl",
    "name, age int, bio: short bio",
  ]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.output)).toEqual({
    type: "object",
    properties: {
      name: { type: "string" },
      age: { type: "integer" },
      bio: { type: "string", description: "short bio" },
    },
    required: ["name", "age", "bio"],
  });
  const result2 = await runner.invoke(cli, [
    "schemas",
    "dsl",
    "name, age int",
    "--multi",
  ]);
  expect(result2.exitCode).toBe(0);
  expect(JSON.parse(result2.output)).toEqual({
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
          },
          required: ["name", "age"],
        },
      },
    },
    required: ["items"],
  });
});

describe.each([[false], [true]])(
  "test_llm_prompt_continue_with_database custom_database_path=%s",
  (customDatabasePath) => {
    test("continue with database", async () => {
      process.env.OPENAI_API_KEY = "X";
      fetchMock.addResponse({
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        json: {
          model: "gpt-4o-mini",
          usage: {},
          choices: [{ message: { content: "Bob, Alice, Eve" } }],
        },
      });
      fetchMock.addResponse({
        method: "POST",
        url: "https://api.openai.com/v1/chat/completions",
        json: {
          model: "gpt-4o-mini",
          usage: {},
          choices: [{ message: { content: "Terry" } }],
        },
      });

      const userPath = path.join(env.userPath, "user");
      const customDbPath = path.join(env.userPath, "custom_log.db");
      process.env.LLM_USER_PATH = userPath;

      // First prompt
      const runner = new CliRunner();
      const args = ["three names \nfor a pet pelican", "--no-stream"];
      if (customDatabasePath) {
        args.push("--database", customDbPath);
      }
      const result = await runner.invoke(cli, args, {
        catchExceptions: false,
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toBe("Bob, Alice, Eve\n");

      // Now ask a follow-up
      const args2 = ["one more", "-c", "--no-stream"];
      if (customDatabasePath) {
        args2.push("--database", customDbPath);
      }
      const result2 = await runner.invoke(cli, args2, {
        catchExceptions: false,
      });
      expect(result2.exitCode, result2.output).toBe(0);
      expect(result2.output).toBe("Terry\n");

      let dbPath: string;
      if (customDatabasePath) {
        expect(fs.existsSync(customDbPath)).toBe(true);
        dbPath = customDbPath;
      } else {
        expect(fs.existsSync(path.join(userPath, "logs.db"))).toBe(true);
        dbPath = path.join(userPath, "logs.db");
      }
      expect(new Database(dbPath).table("responses").count).toBe(2);
    });
  },
);
