/** Port of tests/test_fragments_cli.py */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { Database } from "../src/sqliteUtils.js";
import { migrate } from "../src/migrations.js";
import { llm_version } from "../src/tools.js";
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

test("test_fragments_set_show_remove", async () => {
  const runner = new CliRunner();
  // Analog of runner.isolated_filesystem()
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-ts-isofs-"));
  const prevCwd = process.cwd();
  process.chdir(workDir);
  try {
    fs.writeFileSync("fragment1.txt", "Hello fragment 1", "utf-8");

    // llm fragments --aliases should return nothing
    expect(
      (await runner.invoke(cli, ["fragments", "list", "--aliases"])).output,
    ).toBe("");
    expect(
      (await runner.invoke(cli, ["fragments", "set", "f1", "fragment1.txt"]))
        .exitCode,
    ).toBe(0);
    const result1 = await runner.invoke(cli, ["fragments", "show", "f1"]);
    expect(result1.exitCode).toBe(0);
    expect(result1.output).toBe("Hello fragment 1\n");

    // Should be in the list now
    const getList = async (): Promise<Array<Record<string, unknown>>> => {
      const result2 = await runner.invoke(cli, ["fragments", "list"]);
      expect(result2.exitCode).toBe(0);
      return yaml.load(result2.output) as Array<Record<string, unknown>>;
    };

    // And in llm fragments --aliases
    expect(
      (await runner.invoke(cli, ["fragments", "list", "--aliases"])).output,
    ).toContain("f1");

    const loaded1 = await getList();
    expect(new Set(Object.keys(loaded1[0]))).toEqual(
      new Set(["aliases", "content", "datetime_utc", "source", "hash"]),
    );
    expect(loaded1[0].content).toBe("Hello fragment 1");
    expect(loaded1[0].aliases).toEqual(["f1"]);

    // Show should work against both alias and hash
    for (const key of ["f1", loaded1[0].hash as string]) {
      const result3 = await runner.invoke(cli, ["fragments", "show", key]);
      expect(result3.exitCode).toBe(0);
      expect(result3.output).toBe("Hello fragment 1\n");
    }

    // But not for an invalid alias
    const result4 = await runner.invoke(cli, ["fragments", "show", "badalias"]);
    expect(result4.exitCode).toBe(1);
    expect(result4.output).toContain("Fragment 'badalias' not found");

    // Remove that alias
    const result5 = await runner.invoke(cli, ["fragments", "remove", "f1"]);
    expect(result5.exitCode).toBe(0);
    // Should still be in list but no alias
    const loaded2 = await getList();
    expect(loaded2[0].aliases).toEqual([]);
    expect(loaded2[0].content).toBe("Hello fragment 1");

    // And --aliases list should be empty
    expect(
      (await runner.invoke(cli, ["fragments", "list", "--aliases"])).output,
    ).toBe("");
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test("test_fragments_list", async () => {
  const runner = new CliRunner();
  const db = new Database(env.logsDbPath);
  migrate(db);
  db.table("fragments").insertAll([
    {
      id: 1,
      content: "1",
      datetime_utc: "2023-10-01T00:00:00Z",
      source: "file1.txt",
      hash: "hash1",
    },
    {
      id: 2,
      content: "2",
      datetime_utc: "2022-10-01T00:00:00Z",
      source: "file2.txt",
      hash: "hash2",
    },
    {
      id: 3,
      content: "3",
      datetime_utc: "2024-10-01T00:00:00Z",
      source: "file3.txt",
      hash: "hash3",
    },
  ]);
  db.table("fragment_aliases").insert({
    alias: "f1",
    fragment_id: 1,
  });
  const result = await runner.invoke(cli, ["fragments", "list"]);
  expect(result.exitCode).toBe(0);
  expect(result.output.trim()).toBe(
    [
      "- hash: hash2",
      "  aliases: []",
      "  datetime_utc: '2022-10-01T00:00:00Z'",
      "  source: file2.txt",
      "  content: '2'",
      "- hash: hash1",
      "  aliases:",
      "  - f1",
      "  datetime_utc: '2023-10-01T00:00:00Z'",
      "  source: file1.txt",
      "  content: '1'",
      "- hash: hash3",
      "  aliases: []",
      "  datetime_utc: '2024-10-01T00:00:00Z'",
      "  source: file3.txt",
      "  content: '3'",
    ].join("\n"),
  );
});

test("test_fragment_url_user_agent", async () => {
  process.env.OPENAI_API_KEY = "X";
  const fetchMock = new FetchMock();
  fetchMock.install();
  try {
    mockedOpenaiChat(fetchMock);
    fetchMock.addResponse({
      method: "GET",
      url: "https://example.com/fragment.txt",
      text: "Hello from URL",
    });
    const runner = new CliRunner();
    const result = await runner.invoke(cli, [
      "prompt",
      "-f",
      "https://example.com/fragment.txt",
    ]);
    expect(result.exitCode).toBe(0);

    // Verify the User-Agent header was sent for the fragment URL request
    const requests = fetchMock.getRequests();
    const fragmentRequest = requests.filter((r) =>
      r.url.includes("example.com"),
    )[0];
    const expectedUserAgent = `llm/${llm_version()} (https://llm.datasette.io/)`;
    expect(fragmentRequest.headers["User-Agent"]).toBe(expectedUserAgent);
  } finally {
    fetchMock.uninstall();
  }
});
