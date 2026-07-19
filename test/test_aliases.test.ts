/** Port of tests/test_aliases.py */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as llm from "../src/index.js";
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

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

describe.each([["gpt-3.5-turbo"], ["chatgpt"]])(
  "test_set_alias %s",
  (modelIdOrAlias) => {
    test("set alias", () => {
      expect(() => llm.getModel("this-is-a-new-alias")).toThrowError(
        llm.UnknownModelError,
      );
      llm.setAlias("this-is-a-new-alias", modelIdOrAlias);
      expect(llm.getModel("this-is-a-new-alias").model_id).toBe(
        "gpt-3.5-turbo",
      );
    });
  },
);

test("test_remove_alias", () => {
  expect(() => llm.removeAlias("some-other-alias")).toThrowError();
  llm.setAlias("some-other-alias", "gpt-3.5-turbo");
  expect(llm.getModel("some-other-alias").model_id).toBe("gpt-3.5-turbo");
  llm.removeAlias("some-other-alias");
  expect(() => llm.getModel("some-other-alias")).toThrowError(
    llm.UnknownModelError,
  );
});

describe.each([[["aliases", "list"]], [["aliases"]]])(
  "test_cli_aliases_list args=%j",
  (args) => {
    test("aliases list", async () => {
      llm.setAlias("e-demo", "embed-demo");
      const runner = new CliRunner();
      const result = await runner.invoke(cli, args);
      expect(result.exitCode).toBe(0);
      const lines = [
        "3.5         : gpt-3.5-turbo",
        "chatgpt     : gpt-3.5-turbo",
        "chatgpt-16k : gpt-3.5-turbo-16k",
        "3.5-16k     : gpt-3.5-turbo-16k",
        "4           : gpt-4",
        "gpt4        : gpt-4",
        "4-32k       : gpt-4-32k",
        "e-demo      : embed-demo (embedding)",
        "ada         : text-embedding-ada-002 (embedding)",
      ];
      for (const line of lines) {
        // Turn the whitespace into a regex
        const regex = new RegExp(
          line
            .trim()
            .split(/\s+/)
            .map((part) => escapeRegExp(part))
            .join("\\s+"),
        );
        expect(result.output).toMatch(regex);
      }
    });
  },
);

describe.each([[["aliases", "list"]], [["aliases"]]])(
  "test_cli_aliases_list_json args=%j",
  (args) => {
    test("aliases list json", async () => {
      llm.setAlias("e-demo", "embed-demo");
      const runner = new CliRunner();
      const result = await runner.invoke(cli, [...args, "--json"]);
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.output)).toMatchObject({
        "3.5": "gpt-3.5-turbo",
        chatgpt: "gpt-3.5-turbo",
        "chatgpt-16k": "gpt-3.5-turbo-16k",
        "3.5-16k": "gpt-3.5-turbo-16k",
        "4": "gpt-4",
        gpt4: "gpt-4",
        "4-32k": "gpt-4-32k",
        ada: "text-embedding-ada-002",
        "e-demo": "embed-demo",
      });
    });
  },
);

describe.each([
  [["foo", "bar"], { foo: "bar" }, null],
  [["foo", "-q", "mo"], { foo: "mock" }, null],
  [["foo", "-q", "mog"], null, "No model found matching query: mog"],
] as Array<[string[], Record<string, string> | null, string | null]>)(
  "test_cli_aliases_set args=%j",
  (args, expected, expectedError) => {
    test("aliases set", async () => {
      // Should be no aliases.json at start
      const aliasesPath = path.join(env.userPath, "aliases.json");
      expect(fs.existsSync(aliasesPath)).toBe(false);
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["aliases", "set", ...args]);
      if (!expectedError) {
        expect(result.exitCode).toBe(0);
        expect(fs.existsSync(aliasesPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(aliasesPath, "utf-8"))).toEqual(
          expected,
        );
      } else {
        expect(result.exitCode).toBe(1);
        expect(result.output.trim()).toBe(`Error: ${expectedError}`);
      }
    });
  },
);

test("test_cli_aliases_path", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["aliases", "path"]);
  expect(result.exitCode).toBe(0);
  expect(result.output.trim()).toBe(path.join(env.userPath, "aliases.json"));
});

test("test_cli_aliases_remove", async () => {
  const aliasesPath = path.join(env.userPath, "aliases.json");
  fs.writeFileSync(aliasesPath, JSON.stringify({ foo: "bar" }), "utf-8");
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["aliases", "remove", "foo"]);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(aliasesPath, "utf-8"))).toEqual({});
});

test("test_cli_aliases_remove_invalid", async () => {
  const aliasesPath = path.join(env.userPath, "aliases.json");
  fs.writeFileSync(aliasesPath, JSON.stringify({ foo: "bar" }), "utf-8");
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["aliases", "remove", "invalid"]);
  expect(result.exitCode).toBe(1);
  expect(result.output).toBe("Error: No such alias: invalid\n");
});

describe.each([[["models"]], [["models", "list"]]])(
  "test_cli_aliases_are_registered args=%j",
  (args) => {
    test("aliases are registered", async () => {
      const aliasesPath = path.join(env.userPath, "aliases.json");
      fs.writeFileSync(
        aliasesPath,
        JSON.stringify({ foo: "bar", turbo: "gpt-3.5-turbo" }),
        "utf-8",
      );
      const runner = new CliRunner();
      const result = await runner.invoke(cli, args);
      expect(result.exitCode).toBe(0);
      // Check for model line only, without keys, as --options is not used
      expect(result.output).toContain(
        "gpt-3.5-turbo (aliases: 3.5, chatgpt, turbo)",
      );
    });
  },
);
