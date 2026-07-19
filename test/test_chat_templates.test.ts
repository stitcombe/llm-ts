/** Port of tests/test_chat_templates.py */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { Database } from "../src/sqliteUtils.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

function templatesPath(): string {
  const dir = path.join(env.userPath, "templates");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("test_chat_template_system_only_no_duplicate_prompt", async () => {
  // Template that only sets a system prompt, no user prompt
  fs.writeFileSync(
    path.join(templatesPath(), "wild-french.yaml"),
    "system: Speak in French\n",
    "utf-8",
  );

  const runner = new CliRunner();
  env.mockModel.enqueue(["Bonjour !"]);
  const result = await runner.invoke(
    cli,
    ["chat", "-m", "mock", "-t", "wild-french"],
    { input: "hi\nquit\n", catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);

  // Ensure the logged prompt is not duplicated (no "hi\nhi")
  const logsDb = new Database(env.logsDbPath);
  const rows = logsDb.table("responses").rows;
  expect(rows.length).toBe(1);
  expect(rows[0].prompt).toBe("hi");
  expect(rows[0].system).toBe("Speak in French");
});

test("test_chat_system_fragments_only_first_turn", async () => {
  // Create a system fragment file
  const sysFragPath = path.join(env.userPath, "sys.txt");
  fs.writeFileSync(sysFragPath, "System fragment content", "utf-8");

  const runner = new CliRunner();
  // Two responses queued for two turns
  env.mockModel.enqueue(["first"]);
  env.mockModel.enqueue(["second"]);
  const result = await runner.invoke(
    cli,
    ["chat", "-m", "mock", "--system-fragment", sysFragPath],
    { input: "Hi\nHi two\nquit\n", catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);

  // Verify only the first response has the system fragment
  const logsDb = new Database(env.logsDbPath);
  const responses = logsDb.table("responses").rows;
  expect(responses.length).toBe(2);
  const firstId = responses[0].id;
  const secondId = responses[1].id;

  const sysFrags = logsDb.table("system_fragments").rows;
  // Exactly one system fragment row, attached to the first response only
  expect(sysFrags.length).toBe(1);
  expect(sysFrags[0].response_id).toBe(firstId);
  expect(sysFrags[0].response_id).not.toBe(secondId);
});

test("test_chat_template_loads_tools_into_logs", async () => {
  // Template that specifies tools; ensure chat picks them up
  fs.writeFileSync(
    path.join(templatesPath(), "mytools.yaml"),
    "model: echo\ntools:\n- llm_version\n- llm_time\n",
    "utf-8",
  );

  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["chat", "-t", "mytools"], {
    input: "hi\nquit\n",
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);

  // Verify a single response was logged for the conversation
  const logsDb = new Database(env.logsDbPath);
  const responses = logsDb.table("responses").rows;
  expect(responses.length).toBe(1);
  expect(responses[0].prompt).toBe("hi");
  const responseId = responses[0].id;

  // Tools from the template should be recorded against that response
  const rows = logsDb.query(
    `
    select tools.name from tools
    join tool_responses tr on tr.tool_id = tools.id
    where tr.response_id = ?
    order by tools.name
    `,
    [responseId],
  );
  expect(rows.map((r) => r.name)).toEqual(["llm_time", "llm_version"]);
});
