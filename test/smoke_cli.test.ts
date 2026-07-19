// Temporary CLI smoke test (not part of the ported suite)
import { afterEach, beforeEach, expect, test } from "vitest";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

test("llm --version", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["--version"]);
  expect(result.exitCode).toBe(0);
  expect(result.output.startsWith("cli, version ")).toBe(true);
});

test("llm prompt via echo model", async () => {
  const runner = new CliRunner();
  process.env.LLM_MODEL = "echo";
  try {
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

test("llm prompt via mock model logs to db", async () => {
  const runner = new CliRunner();
  env.mockModel.enqueue(["hello world"]);
  const result = await runner.invoke(cli, ["-m", "mock", "--no-stream", "hi"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("hello world\n");
  // Should have logged
  const { Database } = await import("../src/sqliteUtils.js");
  const db = new Database(env.logsDbPath);
  expect(db.table("responses").count).toBe(1);
});

test("llm models default", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["models", "default"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output.trim()).toBe("gpt-4o-mini");
});

test("llm schemas dsl", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    ["schemas", "dsl", "name, age int"],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.output)).toEqual({
    type: "object",
    properties: { name: { type: "string" }, age: { type: "integer" } },
    required: ["name", "age"],
  });
});

test("llm keys set/get/list", async () => {
  const runner = new CliRunner();
  let result = await runner.invoke(
    cli,
    ["keys", "set", "openai", "--value", "sk-123"],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  result = await runner.invoke(cli, ["keys", "get", "openai"], {
    catchExceptions: false,
  });
  expect(result.output.trim()).toBe("sk-123");
  result = await runner.invoke(cli, ["keys"], { catchExceptions: false });
  expect(result.output.trim()).toBe("openai");
});

test("llm logs list markdown", async () => {
  const runner = new CliRunner();
  env.mockModel.enqueue(["response one"]);
  await runner.invoke(cli, ["-m", "mock", "--no-stream", "prompt one"], {
    catchExceptions: false,
  });
  const result = await runner.invoke(cli, ["logs"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("## Prompt\n\nprompt one");
  expect(result.output).toContain("## Response\n\nresponse one");
});
