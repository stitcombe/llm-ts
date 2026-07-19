/** Port of tests/test_cli_options.py */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
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

describe.each([
  [
    ["gpt-4o-mini", "temperature", "0.5"],
    { "gpt-4o-mini": { temperature: "0.5" } },
    null,
  ],
  [
    ["gpt-4o-mini", "temperature", "invalid"],
    {},
    "Error: temperature\n  Input should be a valid number",
  ],
  [["gpt-4o-mini", "not-an-option", "invalid"], {}, "Extra inputs are not permitted"],
] as Array<[string[], Record<string, unknown>, string | null]>)(
  "test_set_model_default_options args=%j",
  (args, expectedOptions, expectedError) => {
    test("set model default options", async () => {
      const optionsPath = path.join(env.userPath, "model_options.json");
      expect(fs.existsSync(optionsPath)).toBe(false);
      const runner = new CliRunner();
      const result = await runner.invoke(cli, [
        "models",
        "options",
        "set",
        ...args,
      ]);
      if (!expectedError) {
        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(optionsPath)).toBe(true);
        const data = JSON.parse(fs.readFileSync(optionsPath, "utf-8"));
        expect(data).toEqual(expectedOptions);
      } else {
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(expectedError);
      }
    });
  },
);

test("test_model_options_list_and_show", async () => {
  fs.writeFileSync(
    path.join(env.userPath, "model_options.json"),
    JSON.stringify({
      "gpt-4o-mini": { temperature: 0.5 },
      "gpt-4o": { temperature: 0.7 },
    }),
    "utf-8",
  );
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["models", "options", "list"]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe(
    "gpt-4o-mini:\n  temperature: 0.5\ngpt-4o:\n  temperature: 0.7\n",
  );
  const result2 = await runner.invoke(cli, [
    "models",
    "options",
    "show",
    "gpt-4o-mini",
  ]);
  expect(result2.exitCode).toBe(0);
  expect(result2.output).toBe("temperature: 0.5\n");
});

test("test_model_options_clear", async () => {
  const optionsPath = path.join(env.userPath, "model_options.json");
  fs.writeFileSync(
    optionsPath,
    JSON.stringify({
      "gpt-4o-mini": { temperature: 0.5 },
      "gpt-4o": { temperature: 0.7, top_p: 0.9 },
    }),
    "utf-8",
  );
  expect(fs.existsSync(optionsPath)).toBe(true);
  const runner = new CliRunner();
  // Clear all for gpt-4o-mini
  const result = await runner.invoke(cli, [
    "models",
    "options",
    "clear",
    "gpt-4o-mini",
  ]);
  expect(result.exitCode).toBe(0);
  // Clear just top_p for gpt-4o
  const result2 = await runner.invoke(cli, [
    "models",
    "options",
    "clear",
    "gpt-4o",
    "top_p",
  ]);
  expect(result2.exitCode).toBe(0);
  const data = JSON.parse(fs.readFileSync(optionsPath, "utf-8"));
  expect(data).toEqual({ "gpt-4o": { temperature: 0.7 } });
});

test("test_prompt_uses_model_options", async () => {
  const optionsPath = path.join(env.userPath, "model_options.json");
  fs.writeFileSync(optionsPath, "{}", "utf-8");
  // Prompt should not use an option
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["-m", "echo", "prompt"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.output)).toEqual({
    prompt: "prompt",
    system: "",
    attachments: [],
    stream: true,
    previous: [],
  });

  // Now set an option
  fs.writeFileSync(
    optionsPath,
    JSON.stringify({ echo: { example_bool: true } }),
    "utf-8",
  );

  const result2 = await runner.invoke(cli, ["-m", "echo", "prompt"]);
  expect(result2.exitCode).toBe(0);
  expect(JSON.parse(result2.output)).toEqual({
    prompt: "prompt",
    system: "",
    attachments: [],
    stream: true,
    previous: [],
    options: { example_bool: true },
  });

  // Option can be over-ridden
  const result3 = await runner.invoke(cli, [
    "-m",
    "echo",
    "prompt",
    "-o",
    "example_bool",
    "false",
  ]);
  expect(result3.exitCode).toBe(0);
  expect(JSON.parse(result3.output)).toEqual({
    prompt: "prompt",
    system: "",
    attachments: [],
    stream: true,
    previous: [],
    options: { example_bool: false },
  });
  // Using an alias should also pick up that option
  fs.writeFileSync(
    path.join(env.userPath, "aliases.json"),
    '{"e": "echo"}',
    "utf-8",
  );
  const result4 = await runner.invoke(cli, ["-m", "e", "prompt"]);
  expect(result4.exitCode).toBe(0);
  expect(JSON.parse(result4.output)).toEqual({
    prompt: "prompt",
    system: "",
    attachments: [],
    stream: true,
    previous: [],
    options: { example_bool: true },
  });
});
