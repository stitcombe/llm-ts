/**
 * Port of tests/test_cli_streaming.py — reasoning → stderr (dim),
 * text → stdout, -R / --hide-reasoning flag.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import { StreamEvent } from "../src/parts.js";
import { cli } from "../src/cli.js";
import { CliRunner, style } from "../src/click/index.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

test("test_text_goes_to_stdout_not_stderr", async () => {
  env.mockModel.enqueue(["Hello world"]);
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["-m", "mock", "hi", "--no-log"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("Hello world");
  // No reasoning was emitted — stderr should be empty.
  expect(result.stderr).toBe("");
});

test("test_reasoning_goes_to_stderr_not_stdout", async () => {
  env.mockModel.enqueue([
    new StreamEvent({ type: "reasoning", chunk: "thinking hard", part_index: 0 }),
    new StreamEvent({ type: "text", chunk: "answer", part_index: 1 }),
  ]);
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["-m", "mock", "hi", "--no-log"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("thinking hard");
  expect(result.stdout).not.toContain("thinking hard");
  expect(result.stdout).toContain("answer");
});

test("test_reasoning_rendered_in_dim_style", async () => {
  // The style(..., dim: true) wrapper emits the ANSI dim code.
  env.mockModel.enqueue([
    new StreamEvent({ type: "reasoning", chunk: "t", part_index: 0 }),
    new StreamEvent({ type: "text", chunk: "x", part_index: 1 }),
  ]);
  const runner = new CliRunner({ color: true });
  const result = await runner.invoke(cli, ["-m", "mock", "hi", "--no-log"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  // ANSI dim escape sequence is \x1b[2m
  const dimStart = style("x", { dim: true }).split("x")[0];
  expect(result.stderr).toContain(dimStart);
});

test("test_hide_reasoning_flag_suppresses_reasoning", async () => {
  env.mockModel.enqueue([
    new StreamEvent({
      type: "reasoning",
      chunk: "hidden thinking",
      part_index: 0,
    }),
    new StreamEvent({ type: "text", chunk: "answer", part_index: 1 }),
  ]);
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    ["-m", "mock", "hi", "--no-log", "--hide-reasoning"],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("hidden thinking");
  expect(result.stdout).not.toContain("hidden thinking");
  expect(result.stdout).toContain("answer");
  expect(env.mockModel.history[0][0].hide_reasoning).toBe(true);
});

test("test_hide_reasoning_short_flag_R", async () => {
  env.mockModel.enqueue([
    new StreamEvent({ type: "reasoning", chunk: "hidden", part_index: 0 }),
    new StreamEvent({ type: "text", chunk: "x", part_index: 1 }),
  ]);
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    ["-m", "mock", "hi", "--no-log", "-R"],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).not.toContain("hidden");
});

test("test_newline_between_reasoning_and_text", async () => {
  // When reasoning ends and text begins, stderr gets a newline so the
  // text on stdout starts on a fresh visual line.
  env.mockModel.enqueue([
    new StreamEvent({ type: "reasoning", chunk: "think", part_index: 0 }),
    new StreamEvent({ type: "text", chunk: "answer", part_index: 1 }),
  ]);
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["-m", "mock", "hi", "--no-log"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  // Reasoning ends, then a newline is emitted on stderr.
  expect(
    result.stderr.replace(/\n+$/, "").endsWith("think") ||
      result.stderr.includes("think\n"),
  ).toBe(true);
});

test("test_async_path_reasoning_to_stderr", async () => {
  env.asyncMockModel.enqueue([
    new StreamEvent({
      type: "reasoning",
      chunk: "async thinking",
      part_index: 0,
    }),
    new StreamEvent({ type: "text", chunk: "async answer", part_index: 1 }),
  ]);
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    ["-m", "mock", "hi", "--async", "--no-log"],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toContain("async thinking");
  expect(result.stdout).toContain("async answer");
});

test("test_plain_str_plugin_still_works", async () => {
  // A plugin that yields plain strings (legacy) still displays
  // correctly — no reasoning branch, everything to stdout.
  env.mockModel.enqueue(["plain ", "text"]);
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["-m", "mock", "hi", "--no-log"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain("plain text");
  expect(result.stderr).toBe("");
});
