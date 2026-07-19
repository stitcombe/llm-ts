/** Port of tests/test_chat.py — the `llm chat` REPL. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { Database } from "../src/sqliteUtils.js";
import { dumps } from "../src/pyjson.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

const CHAT_BANNER =
  "Chatting with mock" +
  "\nType 'exit' or 'quit' to exit" +
  "\nType '!multi' to enter multiple lines, then '!end' to finish" +
  "\nType '!edit' to open your default editor and modify the prompt" +
  "\nType '!fragment <my_fragment> [<another_fragment> ...]' to insert one or more fragments";

test("test_chat_basic", async () => {
  const runner = new CliRunner();
  env.mockModel.enqueue(["one world"]);
  env.mockModel.enqueue(["one again"]);
  const result = await runner.invoke(cli, ["chat", "-m", "mock"], {
    input: "Hi\nHi two\nquit\n",
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe(
    CHAT_BANNER +
      "\n> Hi" +
      "\none world" +
      "\n> Hi two" +
      "\none again" +
      "\n> quit" +
      "\n",
  );
  // Should have logged
  const logsDb = new Database(env.logsDbPath);
  const conversations = logsDb.table("conversations").rows;
  expect(conversations[0]).toEqual({
    id: expect.any(String),
    name: "Hi",
    model: "mock",
  });
  const conversationId = conversations[0].id;
  const responses = logsDb.table("responses").rows;
  const expectedRow = (
    prompt: string,
    response: string,
    inputTokens: number,
  ) => ({
    id: expect.any(String),
    model: "mock",
    resolved_model: null,
    prompt,
    system: null,
    prompt_json: null,
    options_json: "{}",
    response,
    response_json: null,
    conversation_id: conversationId,
    duration_ms: expect.any(Number),
    datetime_utc: expect.any(String),
    input_tokens: inputTokens,
    output_tokens: 1,
    token_details: null,
    schema_id: null,
    reasoning: null,
  });
  expect(responses).toEqual([
    expectedRow("Hi", "one world", 1),
    expectedRow("Hi two", "one again", 2),
  ]);

  // Now continue that conversation
  env.mockModel.enqueue(["continued"]);
  const result2 = await runner.invoke(cli, ["chat", "-m", "mock", "-c"], {
    input: "Continue\nquit\n",
    catchExceptions: false,
  });
  expect(result2.exitCode).toBe(0);
  expect(result2.output).toBe(
    CHAT_BANNER + "\n> Continue" + "\ncontinued" + "\n> quit" + "\n",
  );
  const responseIds = responses.map((r) => r.id);
  const newResponses = logsDb.query(
    `select * from responses where id not in (${responseIds
      .map(() => "?")
      .join(", ")})`,
    responseIds,
  );
  expect(newResponses).toEqual([
    {
      id: expect.any(String),
      model: "mock",
      resolved_model: null,
      prompt: "Continue",
      system: null,
      prompt_json: null,
      options_json: "{}",
      response: "continued",
      response_json: null,
      conversation_id: conversationId,
      duration_ms: expect.any(Number),
      datetime_utc: expect.any(String),
      input_tokens: 1,
      output_tokens: 1,
      token_details: null,
      schema_id: null,
      reasoning: null,
    },
  ]);
});

test("test_chat_system", async () => {
  const runner = new CliRunner();
  env.mockModel.enqueue(["I am mean"]);
  const result = await runner.invoke(
    cli,
    ["chat", "-m", "mock", "--system", "You are mean"],
    { input: "Hi\nquit\n" },
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe(
    CHAT_BANNER + "\n> Hi" + "\nI am mean" + "\n> quit" + "\n",
  );
  const logsDb = new Database(env.logsDbPath);
  expect(logsDb.table("responses").rows).toEqual([
    {
      id: expect.any(String),
      model: "mock",
      resolved_model: null,
      prompt: "Hi",
      system: "You are mean",
      prompt_json: null,
      options_json: "{}",
      response: "I am mean",
      response_json: null,
      conversation_id: expect.any(String),
      duration_ms: expect.any(Number),
      datetime_utc: expect.any(String),
      input_tokens: 1,
      output_tokens: 1,
      token_details: null,
      schema_id: null,
      reasoning: null,
    },
  ]);
});

test("test_chat_options", async () => {
  fs.writeFileSync(
    path.join(env.userPath, "model_options.json"),
    JSON.stringify({ mock: { max_tokens: "5" } }),
    "utf-8",
  );

  const runner = new CliRunner();
  env.mockModel.enqueue(["Default options response"]);
  const result = await runner.invoke(cli, ["chat", "-m", "mock"], {
    input: "Hi\nquit\n",
  });
  expect(result.exitCode).toBe(0);
  env.mockModel.enqueue(["Override options response"]);
  const result2 = await runner.invoke(
    cli,
    ["chat", "-m", "mock", "--option", "max_tokens", "10"],
    { input: "Hi with override\nquit\n" },
  );
  expect(result2.exitCode).toBe(0);
  const logsDb = new Database(env.logsDbPath);
  const responses = logsDb.table("responses").rows;
  expect(responses).toEqual([
    {
      id: expect.any(String),
      model: "mock",
      resolved_model: null,
      prompt: "Hi",
      system: null,
      prompt_json: null,
      options_json: '{"max_tokens": 5}',
      response: "Default options response",
      response_json: null,
      conversation_id: expect.any(String),
      duration_ms: expect.any(Number),
      datetime_utc: expect.any(String),
      input_tokens: 1,
      output_tokens: 1,
      token_details: null,
      schema_id: null,
      reasoning: null,
    },
    {
      id: expect.any(String),
      model: "mock",
      resolved_model: null,
      prompt: "Hi with override",
      system: null,
      prompt_json: null,
      options_json: '{"max_tokens": 10}',
      response: "Override options response",
      response_json: null,
      conversation_id: expect.any(String),
      duration_ms: expect.any(Number),
      datetime_utc: expect.any(String),
      input_tokens: 3,
      output_tokens: 1,
      token_details: null,
      schema_id: null,
      reasoning: null,
    },
  ]);
});

describe.each([
  [
    "Hi\n!multi\nthis is multiple lines\nuntil the !end\n!end\nquit\n",
    [
      { prompt: "Hi", response: "One\n" },
      { prompt: "this is multiple lines\nuntil the !end", response: "Two\n" },
    ],
  ],
  // quit should not work within !multi
  [
    "!multi\nthis is multiple lines\nquit\nuntil the !end\n!end\nquit\n",
    [
      {
        prompt: "this is multiple lines\nquit\nuntil the !end",
        response: "One\n",
      },
    ],
  ],
  // Try custom delimiter
  [
    "!multi abc\nCustom delimiter\n!end\n!end 123\n!end abc\nquit\n",
    [{ prompt: "Custom delimiter\n!end\n!end 123", response: "One\n" }],
  ],
] as Array<[string, Array<Record<string, string>>]>)(
  "test_chat_multi %#",
  (input, expected) => {
    test("chat multi", async () => {
      const runner = new CliRunner();
      env.mockModel.enqueue(["One\n"]);
      env.mockModel.enqueue(["Two\n"]);
      env.mockModel.enqueue(["Three\n"]);
      const result = await runner.invoke(
        cli,
        ["chat", "-m", "mock", "--option", "max_tokens", "10"],
        { input },
      );
      expect(result.exitCode).toBe(0);
      const logsDb = new Database(env.logsDbPath);
      const rows = logsDb
        .table("responses")
        .rowsWhere(undefined, undefined, { select: "prompt, response" });
      expect(rows).toEqual(expected);
    });
  },
);

describe.each([[false], [true]])(
  "test_llm_chat_creates_log_database custom_database_path=%s",
  (customDatabasePath) => {
    test("chat creates log database", async () => {
      const userPath = path.join(env.userPath, "user");
      const customDbPath = path.join(env.userPath, "custom_log.db");
      process.env.LLM_USER_PATH = userPath;
      const runner = new CliRunner();
      const args = ["chat", "-m", "mock"];
      if (customDatabasePath) {
        args.push("--database", customDbPath);
      }
      const result = await runner.invoke(cli, args, {
        catchExceptions: false,
        input: "Hi\nHi two\nquit\n",
      });
      expect(result.exitCode).toBe(0);
      // Should have created user_path and put a logs.db in it
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

test("test_chat_tools", async () => {
  const runner = new CliRunner();
  const functions = `
function upper(text) {
  return text.toUpperCase();
}
`;
  const result = await runner.invoke(
    cli,
    ["chat", "-m", "echo", "--functions", functions],
    {
      input:
        dumps({
          prompt: "Convert hello to uppercase",
          tool_calls: [{ name: "upper", arguments: { text: "hello" } }],
        }) + "\nquit\n",
      catchExceptions: false,
    },
  );
  expect(result.exitCode).toBe(0);
  const normalizedOutput = result.output.replace(
    /tc_[0-9a-z]{26}/g,
    "tc_TCID",
  );
  expect(normalizedOutput).toBe(
    "Chatting with echo\n" +
      "Type 'exit' or 'quit' to exit\n" +
      "Type '!multi' to enter multiple lines, then '!end' to finish\n" +
      "Type '!edit' to open your default editor and modify the prompt\n" +
      "Type '!fragment <my_fragment> [<another_fragment> ...]' to insert one or more fragments\n" +
      '> {"prompt": "Convert hello to uppercase", "tool_calls": [{"name": "upper", ' +
      '"arguments": {"text": "hello"}}]}\n' +
      "{\n" +
      '  "prompt": "Convert hello to uppercase",\n' +
      '  "system": "",\n' +
      '  "attachments": [],\n' +
      '  "stream": true,\n' +
      '  "previous": []\n' +
      "}{\n" +
      '  "prompt": "",\n' +
      '  "system": "",\n' +
      '  "attachments": [],\n' +
      '  "stream": true,\n' +
      '  "previous": [\n' +
      "    {\n" +
      '      "prompt": "{\\"prompt\\": \\"Convert hello to uppercase\\", ' +
      '\\"tool_calls\\": [{\\"name\\": \\"upper\\", \\"arguments\\": {\\"text\\": ' +
      '\\"hello\\"}}]}"\n' +
      "    }\n" +
      "  ],\n" +
      '  "tool_results": [\n' +
      "    {\n" +
      '      "name": "upper",\n' +
      '      "output": "HELLO",\n' +
      '      "tool_call_id": "tc_TCID"\n' +
      "    }\n" +
      "  ]\n" +
      "}\n" +
      "> quit\n",
  );
});

test("test_chat_fragments", async () => {
  const path1 = path.join(env.userPath, "frag1.txt");
  const path2 = path.join(env.userPath, "frag2.txt");
  fs.writeFileSync(path1, "one", "utf-8");
  fs.writeFileSync(path2, "two", "utf-8");
  const runner = new CliRunner();
  const output = (
    await runner.invoke(cli, ["chat", "-m", "echo", "-f", path1], {
      input: `hi\n!fragment ${path2}\nquit\n`,
    })
  ).output;
  expect(output).toContain('"prompt": "one');
  expect(output).toContain('"prompt": "two"');
});
