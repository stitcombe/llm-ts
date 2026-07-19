/** Port of tests/test_keys.py */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { FetchMock, mockedOpenaiChat } from "./fetchMock.js";
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

describe.each([[{}], [{ LLM_USER_PATH: "/tmp/llm-keys-test" }]])(
  "test_keys_in_user_path env=%j",
  (envVars) => {
    test("keys path", async () => {
      for (const [key, value] of Object.entries(envVars)) {
        process.env[key] = value;
      }
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["keys", "path"]);
      expect(result.exitCode).toBe(0);
      const expected = Object.keys(envVars).length
        ? (envVars as { LLM_USER_PATH: string }).LLM_USER_PATH + "/keys.json"
        : env.userPath + "/keys.json";
      expect(result.output.trim()).toBe(expected);
    });
  },
);

test("test_keys_set", async () => {
  const userPath = path.join(env.userPath, "user", "keys");
  process.env.LLM_USER_PATH = userPath;
  const keysPath = path.join(userPath, "keys.json");
  expect(fs.existsSync(keysPath)).toBe(false);
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["keys", "set", "openai"], {
    input: "foo",
  });
  expect(result.exitCode).toBe(0);
  expect(fs.existsSync(keysPath)).toBe(true);
  // Should be chmod 600
  expect(fs.statSync(keysPath).mode & 0o777).toBe(0o600);
  const content = fs.readFileSync(keysPath, "utf-8");
  expect(JSON.parse(content)).toEqual({
    "// Note": "This file stores secret API credentials. Do not share!",
    openai: "foo",
  });
});

test("test_keys_get", async () => {
  const userPath = path.join(env.userPath, "user", "keys");
  process.env.LLM_USER_PATH = userPath;
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["keys", "set", "openai"], {
    input: "fx",
  });
  expect(result.exitCode).toBe(0);
  const result2 = await runner.invoke(cli, ["keys", "get", "openai"]);
  expect(result2.exitCode).toBe(0);
  expect(result2.output.trim()).toBe("fx");
});

describe.each([[["keys", "list"]], [["keys"]]])(
  "test_keys_list args=%j",
  (args) => {
    test("keys list", async () => {
      const userPath = path.join(env.userPath, "user", "keys");
      process.env.LLM_USER_PATH = userPath;
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["keys", "set", "openai"], {
        input: "foo",
      });
      expect(result.exitCode).toBe(0);
      const result2 = await runner.invoke(cli, args);
      expect(result2.exitCode).toBe(0);
      expect(result2.output.trim()).toBe("openai");
    });
  },
);

test("test_uses_correct_key", async () => {
  const fetchMock = new FetchMock();
  fetchMock.install();
  try {
    mockedOpenaiChat(fetchMock);
    const userDir = path.join(env.userPath, "user-dir");
    fs.mkdirSync(userDir, { recursive: true });
    const keysPath = path.join(userDir, "keys.json");
    const KEYS = {
      openai: "from-keys-file",
      other: "other-key",
    };
    fs.writeFileSync(keysPath, JSON.stringify(KEYS), "utf-8");
    process.env.LLM_USER_PATH = userDir;
    process.env.OPENAI_API_KEY = "from-env";

    const assertKey = (key: string) => {
      const requests = fetchMock.getRequests();
      const request = requests[requests.length - 1];
      expect(request.headers.Authorization).toBe(`Bearer ${key}`);
    };

    const runner = new CliRunner();

    // Called without --key uses stored key
    const result = await runner.invoke(cli, ["hello", "--no-stream"], {
      catchExceptions: false,
    });
    expect(result.exitCode).toBe(0);
    assertKey("from-keys-file");

    // Called without --key and without keys.json uses environment variable
    fs.writeFileSync(keysPath, "{}", "utf-8");
    const result2 = await runner.invoke(cli, ["hello", "--no-stream"], {
      catchExceptions: false,
    });
    expect(result2.exitCode).toBe(0);
    assertKey("from-env");
    fs.writeFileSync(keysPath, JSON.stringify(KEYS), "utf-8");

    // Called with --key name-in-keys.json uses that value
    const result3 = await runner.invoke(
      cli,
      ["hello", "--key", "other", "--no-stream"],
      { catchExceptions: false },
    );
    expect(result3.exitCode).toBe(0);
    assertKey("other-key");

    // Called with --key something-else uses exactly that
    const result4 = await runner.invoke(
      cli,
      ["hello", "--key", "custom-key", "--no-stream"],
      { catchExceptions: false },
    );
    expect(result4.exitCode).toBe(0);
    assertKey("custom-key");
  } finally {
    fetchMock.uninstall();
  }
});
