/** Port of tests/test_llm_logs.py */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { Database } from "../src/sqliteUtils.js";
import { migrate } from "../src/migrations.js";
import { Fragment, monotonicUlid } from "../src/utils.js";
import { ULID } from "../src/ulid.js";
import { StreamEvent } from "../src/parts.js";
import { dumps } from "../src/pyjson.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

const SINGLE_ID = "5843577700ba729bb14c327b30441885";
const MULTI_ID = "4860edd987df587d042a9eb2b299ce5c";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

/** Python datetime.isoformat() with microseconds and +00:00 suffix. */
function isoUtcMicro(d: Date): string {
  return d.toISOString().replace("Z", "000+00:00");
}

/** Port of the log_path fixture. */
function makeLogPath(): string {
  const logPath = path.join(env.userPath, "logs.db");
  const db = new Database(logPath);
  migrate(db);
  const start = Date.now();
  db.table("responses").insertAll(
    Array.from({ length: 100 }, (_, i) => ({
      id: monotonicUlid().toString().toLowerCase(),
      system: "system",
      prompt: "prompt",
      response: 'response\n```python\nprint("hello word")\n```',
      model: "davinci",
      datetime_utc: isoUtcMicro(new Date(start + i * 1000)),
      conversation_id: "abc123",
      input_tokens: 2,
      output_tokens: 5,
    })),
  );
  return logPath;
}

/** Port of the schema_log_path fixture. */
function makeSchemaLogPath(): string {
  const logPath = path.join(env.userPath, "logs_schema.db");
  const db = new Database(logPath);
  migrate(db);
  const start = Date.now();
  db.table("schemas").insert({ id: SINGLE_ID, content: '{"name": "string"}' });
  db.table("schemas").insert({ id: MULTI_ID, content: '{"name": "array"}' });
  for (let i = 0; i < 2; i++) {
    db.table("responses").insert({
      id: ULID.fromTimestamp(Date.now() / 1000 + i)
        .toString()
        .toLowerCase(),
      system: "system",
      prompt: "prompt",
      response: `{"name": "${i}"}`,
      model: "davinci",
      datetime_utc: isoUtcMicro(new Date(start + i * 1000)),
      conversation_id: "abc123",
      input_tokens: 2,
      output_tokens: 5,
      schema_id: SINGLE_ID,
    });
  }
  for (let j = 0; j < 4; j++) {
    db.table("responses").insert({
      id: ULID.fromTimestamp(Date.now() / 1000 + j)
        .toString()
        .toLowerCase(),
      system: "system",
      prompt: "prompt",
      response: '{"items": [{"name": "one"}, {"name": "two"}]}',
      model: "davinci",
      datetime_utc: isoUtcMicro(new Date(start + 1000)),
      conversation_id: "abc456",
      input_tokens: 2,
      output_tokens: 5,
      schema_id: MULTI_ID,
    });
  }
  return logPath;
}

const datetimeRe = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/g;
const idRe = /id: \w+/g;

describe.each([[false], [true]])("test_logs_text usage=%s", (usage) => {
  test("logs text", async () => {
    const logPath = makeLogPath();
    const runner = new CliRunner();
    const args = ["logs", "-p", logPath];
    if (usage) {
      args.push("-u");
    }
    const result = await runner.invoke(cli, args, { catchExceptions: false });
    expect(result.exitCode).toBe(0);
    let output = result.output;
    output = output.replace(datetimeRe, "YYYY-MM-DDTHH:MM:SS");
    output = output.replace(idRe, "id: xxx");
    const usageBlock = usage ? "## Token usage\n\n2 input, 5 output\n\n" : "";
    const expected =
      "# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx\n\n" +
      "Model: **davinci**\n\n" +
      "## Prompt\n\n" +
      "prompt\n\n" +
      "## System\n\n" +
      "system\n\n" +
      "## Response\n\n" +
      'response\n```python\nprint("hello word")\n```\n\n' +
      usageBlock +
      "# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx\n\n" +
      "Model: **davinci**\n\n" +
      "## Prompt\n\n" +
      "prompt\n\n" +
      "## Response\n\n" +
      'response\n```python\nprint("hello word")\n```\n\n' +
      usageBlock +
      "# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx\n\n" +
      "Model: **davinci**\n\n" +
      "## Prompt\n\n" +
      "prompt\n\n" +
      "## Response\n\n" +
      'response\n```python\nprint("hello word")\n```\n\n' +
      usageBlock;
    expect(output).toBe(expected);
  });
});

test("test_logs_text_with_options", async () => {
  // Test that ## Options section appears when options_json is set
  const logPath = path.join(env.userPath, "logs_with_options.db");
  const db = new Database(logPath);
  migrate(db);

  db.table("responses").insert({
    id: monotonicUlid().toString().toLowerCase(),
    system: "system",
    prompt: "prompt",
    response: "response",
    model: "davinci",
    datetime_utc: isoUtcMicro(new Date()),
    conversation_id: "abc123",
    input_tokens: 2,
    output_tokens: 5,
    options_json: dumps({
      thinking_level: "high",
      media_resolution: "low",
    }),
  });

  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["logs", "-p", logPath], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  const output = result.output;

  expect(output).toContain("## Options\n\n");
  expect(output).toContain("- thinking_level: high");
  expect(output).toContain("- media_resolution: low");
});

test("test_logs_token_usage_details_are_markdown_code", async () => {
  const logPath = path.join(env.userPath, "logs_token_details.db");
  const db = new Database(logPath);
  migrate(db);
  db.table("responses").insert({
    id: monotonicUlid().toString().toLowerCase(),
    system: null,
    prompt: "prompt",
    response: "response",
    model: "davinci",
    datetime_utc: isoUtcMicro(new Date()),
    conversation_id: "abc123",
    input_tokens: 2,
    output_tokens: 5,
    token_details: dumps({
      output_tokens_details: { reasoning_tokens: 1, label: "`reasoning`" },
    }),
  });

  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["logs", "-p", logPath, "-u"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(
    '## Token usage\n\n2 input, 5 output, ``{"output_tokens_details": ' +
      '{"reasoning_tokens": 1, "label": "`reasoning`"}}``\n',
  );
});

describe.each([[null], [0], [2]])("test_logs_json n=%s", (n) => {
  test("logs json", async () => {
    const logPath = makeLogPath();
    const runner = new CliRunner();
    const args = ["logs", "-p", logPath, "--json"];
    if (n !== null) {
      args.push("-n", String(n));
    }
    const result = await runner.invoke(cli, args, { catchExceptions: false });
    expect(result.exitCode).toBe(0);
    const logs = JSON.parse(result.output);
    let expectedLength = 3;
    if (n !== null) {
      expectedLength = n === 0 ? 100 : n;
    }
    expect(logs.length).toBe(expectedLength);
  });
});

describe.each([
  [["-r"]],
  [["--response"]],
  [["list", "-r"]],
  [["list", "--response"]],
])("test_logs_response_only args=%j", (args) => {
  test("logs response only", async () => {
    makeLogPath();
    const runner = new CliRunner();
    const result = await runner.invoke(cli, ["logs", ...args], {
      catchExceptions: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe(
      'response\n```python\nprint("hello word")\n```\n',
    );
  });
});

describe.each([
  [["-x"]],
  [["--extract"]],
  [["list", "-x"]],
  [["list", "--extract"]],
  // Using -xr together should have same effect as just -x
  [["-xr"]],
  [["-x", "-r"]],
  [["--extract", "--response"]],
])("test_logs_extract_first_code args=%j", (args) => {
  test("logs extract first code", async () => {
    makeLogPath();
    const runner = new CliRunner();
    const result = await runner.invoke(cli, ["logs", ...args], {
      catchExceptions: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('print("hello word")\n\n');
  });
});

describe.each([
  [["--xl"]],
  [["--extract-last"]],
  [["list", "--xl"]],
  [["list", "--extract-last"]],
  [["--xl", "-r"]],
  [["-x", "--xl"]],
])("test_logs_extract_last_code args=%j", (args) => {
  test("logs extract last code", async () => {
    makeLogPath();
    const runner = new CliRunner();
    const result = await runner.invoke(cli, ["logs", ...args], {
      catchExceptions: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('print("hello word")\n\n');
  });
});

describe.each([["-s"], ["--short"]])("test_logs_short arg=%s", (arg) => {
  describe.each([[null], ["-u"], ["--usage"]])("usage=%s", (usage) => {
    test("logs short", async () => {
      const logPath = makeLogPath();
      const runner = new CliRunner();
      const args = ["logs", arg, "-p", logPath];
      if (usage) {
        args.push(usage);
      }
      const result = await runner.invoke(cli, args);
      expect(result.exitCode).toBe(0);
      const output = result.output.replace(datetimeRe, "YYYY-MM-DDTHH:MM:SS");
      const expectedUsage = usage
        ? "  usage:\n    input: 2\n    output: 5\n"
        : "";
      const entry =
        "- model: davinci\n" +
        "  datetime: 'YYYY-MM-DDTHH:MM:SS'\n" +
        "  conversation: abc123\n" +
        "  system: system\n" +
        "  prompt: prompt\n" +
        "  prompt_fragments: []\n" +
        `  system_fragments: []\n${expectedUsage}`;
      expect(output).toBe(entry + entry + entry);
    });
  });
});

describe.each([[{}], [{ LLM_USER_PATH: "/tmp/llm-user-path" }]])(
  "test_logs_path env=%j",
  (envVars) => {
    test("logs path", async () => {
      for (const [key, value] of Object.entries(envVars)) {
        process.env[key] = value;
      }
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["logs", "path"]);
      expect(result.exitCode).toBe(0);
      const expected = Object.keys(envVars).length
        ? (envVars as { LLM_USER_PATH: string }).LLM_USER_PATH + "/logs.db"
        : env.userPath + "/logs.db";
      expect(result.output.trim()).toBe(expected);
    });
  },
);

describe.each([["davinci"], ["curie"]])("test_logs_filtered model=%s", (model) => {
  describe.each([[null], ["-p"], ["--path"], ["-d"], ["--database"]])(
    "path_option=%s",
    (pathOption) => {
      test("logs filtered", async () => {
        let logPath = path.join(env.userPath, "logs.db");
        if (pathOption) {
          logPath = path.join(env.userPath, "logs_alternative.db");
        }
        const db = new Database(logPath);
        migrate(db);
        db.table("responses").insertAll(
          Array.from({ length: 100 }, (_, i) => ({
            id: monotonicUlid().toString().toLowerCase(),
            system: "system",
            prompt: "prompt",
            response: "response",
            model: i % 2 === 0 ? "davinci" : "curie",
          })),
        );
        const runner = new CliRunner();
        const result = await runner.invoke(cli, [
          "logs",
          "list",
          "-m",
          model,
          "--json",
          ...(pathOption ? [pathOption, logPath] : []),
        ]);
        expect(result.exitCode).toBe(0);
        const records = JSON.parse(result.output.trim());
        expect(
          records.every((record: { model: string }) => record.model === model),
        ).toBe(true);
      });
    },
  );
});

describe.each([
  // With no search term order should be by datetime
  ["", [], ["doc1", "doc2", "doc3"]],
  // With a search it's order by rank instead
  ["llama", [], ["doc1", "doc3"]],
  ["alpaca", [], ["doc2"]],
  // Model filter should work too
  ["llama", ["-m", "davinci"], ["doc1", "doc3"]],
  ["llama", ["-m", "davinci2"], []],
  // Adding -l/--latest should return latest first (order by id desc)
  ["llama", ["-l"], ["doc3", "doc1"]],
  ["llama", ["--latest"], ["doc3", "doc1"]],
] as Array<[string, string[], string[]]>)(
  "test_logs_search query=%s extra=%j",
  (query, extraArgs, expected) => {
    test("logs search", async () => {
      const logPath = path.join(env.userPath, "logs.db");
      const db = new Database(logPath);
      migrate(db);

      const insert = (id: string, text: string) => {
        db.table("responses").insert({
          id,
          system: "system",
          prompt: text,
          response: "response",
          model: "davinci",
        });
      };

      insert("doc1", "llama");
      insert("doc2", "alpaca");
      insert("doc3", "llama llama");
      const runner = new CliRunner();
      const result = await runner.invoke(cli, [
        "logs",
        "list",
        "-q",
        query,
        "--json",
        ...extraArgs,
      ]);
      expect(result.exitCode).toBe(0);
      const records = JSON.parse(result.output.trim());
      expect(records.map((record: { id: string }) => record.id)).toEqual(
        expected,
      );
    });
  },
);

describe.each([
  [["--data", "--schema", SINGLE_ID], '{"name": "1"}\n{"name": "0"}\n'],
  [
    ["--data", "--schema", MULTI_ID],
    '{"items": [{"name": "one"}, {"name": "two"}]}\n'.repeat(4),
  ],
  [
    ["--data-array", "--schema", MULTI_ID],
    '[{"items": [{"name": "one"}, {"name": "two"}]},\n' +
      ' {"items": [{"name": "one"}, {"name": "two"}]},\n' +
      ' {"items": [{"name": "one"}, {"name": "two"}]},\n' +
      ' {"items": [{"name": "one"}, {"name": "two"}]}]\n',
  ],
  [
    ["--schema", MULTI_ID, "--data-key", "items"],
    '{"name": "one"}\n{"name": "two"}\n'.repeat(4),
  ],
] as Array<[string[], string]>)(
  "test_logs_schema args=%j",
  (args, expected) => {
    test("logs schema", async () => {
      const schemaLogPath = makeSchemaLogPath();
      const runner = new CliRunner();
      const result = await runner.invoke(
        cli,
        ["logs", "-n", "0", "-p", schemaLogPath, ...args],
        { catchExceptions: false },
      );
      expect(result.exitCode).toBe(0);
      expect(result.output).toBe(expected);
    });
  },
);

test("test_logs_schema_data_ids", async () => {
  const schemaLogPath = makeSchemaLogPath();
  const db = new Database(schemaLogPath);
  const ulid = ULID.fromTimestamp(Date.now() / 1000 + 100);
  db.table("responses").insert({
    id: ulid.toString().toLowerCase(),
    system: "system",
    prompt: "prompt",
    response: dumps({
      name: "three",
      response_id: 1,
      conversation_id: 2,
      conversation_id_: 3,
    }),
    model: "davinci",
    datetime_utc: isoUtcMicro(ulid.datetime),
    conversation_id: "abc123",
    input_tokens: 2,
    output_tokens: 5,
    schema_id: SINGLE_ID,
  });
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "logs",
      "-n",
      "0",
      "-p",
      schemaLogPath,
      "--data-ids",
      "--data-key",
      "items",
      "--data-array",
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  const rows = JSON.parse(result.output);
  const lastRow = rows.pop();
  expect(new Set(Object.keys(lastRow))).toEqual(
    new Set([
      "conversation_id_",
      "conversation_id",
      "response_id",
      "response_id_",
      "name",
      "conversation_id__",
    ]),
  );
  for (const row of rows) {
    expect(new Set(Object.keys(row))).toEqual(
      new Set(["conversation_id", "response_id", "name"]),
    );
  }
});

const EXPECTED_SCHEMAS_YAML_RE = new RegExp(
  "^- id: [a-f0-9]{32}\\n" +
    "  summary: \\|\\n" +
    "    \\n" +
    "  usage: \\|\\n" +
    "    4 times, most recently \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}\\+00:00\\n" +
    "- id: [a-f0-9]{32}\\n" +
    "  summary: \\|\\n" +
    "    \\n" +
    "  usage: \\|\\n" +
    "    2 times, most recently \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{6}\\+00:00",
);

describe.each([[["schemas"]], [["schemas", "list"]]])(
  "test_schemas_list_yaml args=%j",
  (args) => {
    test("schemas list yaml", async () => {
      const schemaLogPath = makeSchemaLogPath();
      const result = await new CliRunner().invoke(cli, [
        ...args,
        "-d",
        schemaLogPath,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.output.trim()).toMatch(EXPECTED_SCHEMAS_YAML_RE);
    });
  },
);

describe.each([[false], [true]])("test_schemas_list_json is_nl=%s", (isNl) => {
  test("schemas list json", async () => {
    const schemaLogPath = makeSchemaLogPath();
    const result = await new CliRunner().invoke(cli, [
      "schemas",
      "list",
      ...(isNl ? ["--nl"] : ["--json"]),
      "-d",
      schemaLogPath,
    ]);
    expect(result.exitCode).toBe(0);
    let rows;
    if (isNl) {
      rows = result.output
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    } else {
      rows = JSON.parse(result.output);
    }
    expect(rows.length).toBe(2);
    expect(rows[0].content).toEqual({ name: "array" });
    expect(rows[0].times_used).toBe(4);
    expect(rows[1].content).toEqual({ name: "string" });
    expect(rows[1].times_used).toBe(2);
    expect(new Set(Object.keys(rows[0]))).toEqual(
      new Set(["id", "content", "recently_used", "times_used"]),
    );
  });
});

interface FragmentsFixture {
  path: string;
  fragmentHashesBySlug: Record<string, string>;
}

/** Port of the fragments_fixture fixture. */
async function makeFragmentsFixture(): Promise<FragmentsFixture> {
  const logPath = path.join(env.userPath, "logs_fragments.db");
  const db = new Database(logPath);
  migrate(db);
  const start = isoUtcMicro(new Date());

  const fragmentHashesBySlug: Record<string, string> = {};
  // Create fragments
  for (let i = 1; i <= 5; i++) {
    const content = `This is fragment ${i}`.repeat(i === 5 ? 100 : 1);
    const fragment = new Fragment(content, "fragment");
    db.table("fragments").insert({
      id: i,
      hash: fragment.id(),
      content,
      datetime_utc: start,
    });
    db.table("fragment_aliases").insert({ alias: `hash${i}`, fragment_id: i });
    fragmentHashesBySlug[`hash${i}`] = fragment.id();
  }

  // Create some more fragment aliases
  db.table("fragment_aliases").insert({ alias: "alias_1", fragment_id: 3 });
  db.table("fragment_aliases").insert({ alias: "alias_3", fragment_id: 4 });
  db.table("fragment_aliases").insert({ alias: "long_5", fragment_id: 5 });

  const makeResponse = async (
    name: string,
    promptFragmentIds: number[] | null = null,
    systemFragmentIds: number[] | null = null,
  ) => {
    // To ensure ULIDs order predictably
    await new Promise((r) => setTimeout(r, 50));
    const responseId = ULID.fromTimestamp(Date.now() / 1000)
      .toString()
      .toLowerCase();
    db.table("responses").insert({
      id: responseId,
      system: `system: ${name}`,
      prompt: `prompt: ${name}`,
      response: `response: ${name}`,
      model: "davinci",
      datetime_utc: start,
      conversation_id: "abc123",
      input_tokens: 2,
      output_tokens: 5,
    });
    for (const fragmentId of promptFragmentIds ?? []) {
      db.table("prompt_fragments").insert({
        response_id: responseId,
        fragment_id: fragmentId,
      });
    }
    for (const fragmentId of systemFragmentIds ?? []) {
      db.table("system_fragments").insert({
        response_id: responseId,
        fragment_id: fragmentId,
      });
    }
  };

  await makeResponse("no_fragments");
  await makeResponse("single_prompt_fragment", [1]);
  await makeResponse("single_system_fragment", null, [2]);
  await makeResponse("multi_prompt_fragment", [1, 2]);
  await makeResponse("multi_system_fragment", null, [1, 2]);
  await makeResponse("both_fragments", [1, 2], [3, 4]);
  await makeResponse("single_long_prompt_fragment_with_alias", [5], null);
  await makeResponse("single_system_fragment_with_alias", null, [4]);
  return { path: logPath, fragmentHashesBySlug };
}

describe.each([
  [
    ["hash1"],
    [
      {
        name: "single_prompt_fragment",
        prompt_fragments: ["hash1"],
        system_fragments: [],
      },
      {
        name: "multi_prompt_fragment",
        prompt_fragments: ["hash1", "hash2"],
        system_fragments: [],
      },
      {
        name: "multi_system_fragment",
        prompt_fragments: [],
        system_fragments: ["hash1", "hash2"],
      },
      {
        name: "both_fragments",
        prompt_fragments: ["hash1", "hash2"],
        system_fragments: ["hash3", "hash4"],
      },
    ],
  ],
  [
    ["alias_3"],
    [
      {
        name: "both_fragments",
        prompt_fragments: ["hash1", "hash2"],
        system_fragments: ["hash3", "hash4"],
      },
      {
        name: "single_system_fragment_with_alias",
        prompt_fragments: [],
        system_fragments: ["hash4"],
      },
    ],
  ],
  // Testing for AND condition
  [
    ["hash1", "hash4"],
    [
      {
        name: "both_fragments",
        prompt_fragments: ["hash1", "hash2"],
        system_fragments: ["hash3", "hash4"],
      },
    ],
  ],
] as Array<
  [string[], Array<{ name: string; prompt_fragments: string[]; system_fragments: string[] }>]
>)("test_logs_fragments refs=%j", (fragmentRefs, expectedTemplate) => {
  test("logs fragments", async () => {
    const fixture = await makeFragmentsFixture();
    const runner = new CliRunner();
    const args = ["logs", "-d", fixture.path, "-n", "0"];
    for (const ref of fragmentRefs) {
      args.push("-f", ref);
    }
    const result = await runner.invoke(cli, [...args, "--json"], {
      catchExceptions: false,
    });
    expect(result.exitCode).toBe(0);
    const responses = JSON.parse(result.output);
    const reshaped = responses.map(
      (response: {
        prompt: string;
        prompt_fragments: Array<{ hash: string }>;
        system_fragments: Array<{ hash: string }>;
      }) => ({
        name: response.prompt.replace("prompt: ", ""),
        prompt_fragments: response.prompt_fragments.map((f) => f.hash),
        system_fragments: response.system_fragments.map((f) => f.hash),
      }),
    );
    // Replace aliases with hash IDs in expected
    const expected = expectedTemplate.map((item) => ({
      name: item.name,
      prompt_fragments: item.prompt_fragments.map(
        (ref) => fixture.fragmentHashesBySlug[ref] ?? ref,
      ),
      system_fragments: item.system_fragments.map(
        (ref) => fixture.fragmentHashesBySlug[ref] ?? ref,
      ),
    }));
    expect(reshaped).toEqual(expected);
    // Now test the `-s/--short` option:
    const result2 = await runner.invoke(cli, [...args, "-s"], {
      catchExceptions: false,
    });
    expect(result2.exitCode).toBe(0);
    const loaded = yaml.load(result2.output) as Array<{
      prompt: string;
      system_fragments: string[];
      prompt_fragments: string[];
    }>;
    const reshaped2 = loaded.map((item) => ({
      name: item.prompt.replace("prompt: ", ""),
      system_fragments: item.system_fragments,
      prompt_fragments: item.prompt_fragments,
    }));
    expect(reshaped2).toEqual(expected);
  });
});

test("test_logs_fragments_markdown", async () => {
  const fixture = await makeFragmentsFixture();
  const runner = new CliRunner();
  const args = ["logs", "-d", fixture.path, "-n", "0"];
  const result = await runner.invoke(cli, args, { catchExceptions: false });
  expect(result.exitCode).toBe(0);
  let output = result.output;
  output = output.replace(datetimeRe, "YYYY-MM-DDTHH:MM:SS");
  output = output.replace(idRe, "id: xxx");
  let expectedOutput = `
# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx

Model: **davinci**

## Prompt

prompt: no_fragments

## System

system: no_fragments

## Response

response: no_fragments

# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx

Model: **davinci**

## Prompt

prompt: single_prompt_fragment

### Prompt fragments

- hash1

## System

system: single_prompt_fragment

## Response

response: single_prompt_fragment

# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx

Model: **davinci**

## Prompt

prompt: single_system_fragment

## System

system: single_system_fragment

### System fragments

- hash2

## Response

response: single_system_fragment

# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx

Model: **davinci**

## Prompt

prompt: multi_prompt_fragment

### Prompt fragments

- hash1
- hash2

## System

system: multi_prompt_fragment

## Response

response: multi_prompt_fragment

# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx

Model: **davinci**

## Prompt

prompt: multi_system_fragment

## System

system: multi_system_fragment

### System fragments

- hash1
- hash2

## Response

response: multi_system_fragment

# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx

Model: **davinci**

## Prompt

prompt: both_fragments

### Prompt fragments

- hash1
- hash2

## System

system: both_fragments

### System fragments

- hash3
- hash4

## Response

response: both_fragments

# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx

Model: **davinci**

## Prompt

prompt: single_long_prompt_fragment_with_alias

### Prompt fragments

- hash5

## System

system: single_long_prompt_fragment_with_alias

## Response

response: single_long_prompt_fragment_with_alias

# YYYY-MM-DDTHH:MM:SS    conversation: abc123 id: xxx

Model: **davinci**

## Prompt

prompt: single_system_fragment_with_alias

## System

system: single_system_fragment_with_alias

### System fragments

- hash4

## Response

response: single_system_fragment_with_alias
    `;
  // Replace hash4 etc with their proper IDs
  for (const [key, value] of Object.entries(fixture.fragmentHashesBySlug)) {
    expectedOutput = expectedOutput.split(key).join(value);
  }
  expect(output.trim()).toBe(expectedOutput.trim());
});

describe.each([["-e"], ["--expand"]])(
  "test_expand_fragment_json arg=%s",
  (arg) => {
    test("expand fragment json", async () => {
      const fixture = await makeFragmentsFixture();
      const runner = new CliRunner();
      const args = ["logs", "-d", fixture.path, "-f", "long_5", "--json"];
      // Without -e the JSON is truncated
      const result = await runner.invoke(cli, args, {
        catchExceptions: false,
      });
      expect(result.exitCode).toBe(0);
      const data = JSON.parse(result.output);
      const fragment = data[0].prompt_fragments[0].content;
      expect(fragment.startsWith("This is fragment 5This is fragment 5")).toBe(
        true,
      );
      expect(fragment.length).toBeLessThan(200);
      // With -e the JSON is expanded
      const result2 = await runner.invoke(cli, [...args, arg], {
        catchExceptions: false,
      });
      expect(result2.exitCode).toBe(0);
      const data2 = JSON.parse(result2.output);
      const fragment2 = data2[0].prompt_fragments[0].content;
      expect(
        fragment2.startsWith("This is fragment 5This is fragment 5"),
      ).toBe(true);
      expect(fragment2.length).toBeGreaterThan(200);
    });
  },
);

test("test_expand_fragment_markdown", async () => {
  const fixture = await makeFragmentsFixture();
  const runner = new CliRunner();
  const args = ["logs", "-d", fixture.path, "-f", "long_5", "--expand"];
  const result = await runner.invoke(cli, args, { catchExceptions: false });
  expect(result.exitCode).toBe(0);
  const output = result.output;
  const interestingBit = output
    .split("prompt: single_long_prompt_fragment_with_alias")[1]
    .split("## System")[0]
    .trim();
  const hash = fixture.fragmentHashesBySlug.hash5;
  const expectedPrefix = `### Prompt fragments\n\n<details><summary>${hash}</summary>\nThis is fragment 5`;
  expect(interestingBit.startsWith(expectedPrefix)).toBe(true);
  expect(interestingBit.endsWith("</details>")).toBe(true);
});

test("test_logs_tools", async () => {
  const runner = new CliRunner();
  const code = `
function demo() {
  return "one\\ntwo\\nthree";
}
`;
  const result1 = await runner.invoke(cli, [
    "-m",
    "echo",
    "--functions",
    code,
    dumps({ tool_calls: [{ name: "demo" }] }),
  ]);
  expect(result1.exitCode).toBe(0);
  const result2 = await runner.invoke(cli, ["logs", "-c"]);
  const normalizedOutput = result2.output.replace(
    /tc_[0-9a-z]{26}/g,
    "tc_TCID",
  );
  expect(normalizedOutput).toContain(
    "### Tool results\n" +
      "\n" +
      "- **demo**: `tc_TCID`<br>\n" +
      "    ```\n" +
      "    one\n" +
      "    two\n" +
      "    three\n" +
      "    ```\n" +
      "\n",
  );
  // Log one that did NOT use tools, check that `llm logs --tools` ignores it
  expect((await runner.invoke(cli, ["-m", "echo", "badger"])).exitCode).toBe(0);
  expect((await runner.invoke(cli, ["logs"])).output).toContain("badger");
  const logsToolsOutput = (await runner.invoke(cli, ["logs", "--tools"]))
    .output;
  expect(logsToolsOutput).not.toContain("badger");
  expect(logsToolsOutput).toContain("three");
});

test("test_logs_repeated_tools_use_short_hash", async () => {
  const runner = new CliRunner();
  const code = `
function demo() {
  return "ok";
}
`;
  const args = [
    "-m",
    "echo",
    "--functions",
    code,
    dumps({ tool_calls: [{ name: "demo" }] }),
  ];
  const result1 = await runner.invoke(cli, args);
  expect(result1.exitCode).toBe(0);
  const result2 = await runner.invoke(cli, args);
  expect(result2.exitCode).toBe(0);

  const result3 = await runner.invoke(cli, ["logs", "-n", "2"]);
  expect(result3.exitCode).toBe(0);
  const toolHashes = [
    ...result3.output.matchAll(/- \*\*demo\*\*: `([0-9a-f]+)`/g),
  ].map((m) => m[1]);
  expect(toolHashes.length).toBe(2);
  expect(toolHashes[0].length).toBe(64);
  expect(toolHashes[1]).toBe(toolHashes[0].slice(0, 7));
});

test("test_logs_tool_call_argument_formatting", async () => {
  const runner = new CliRunner();
  const code = `
function demo(timeout, options) {
  return "ok";
}
`;
  const result1 = await runner.invoke(cli, [
    "-m",
    "echo",
    "--functions",
    code,
    dumps({
      tool_calls: [
        { name: "demo", arguments: { timeout: 120, options: ["`tick`"] } },
      ],
    }),
  ]);
  expect(result1.exitCode).toBe(0);
  const result2 = await runner.invoke(cli, ["logs", "-c"]);
  const normalizedOutput = result2.output.replace(
    /tc_[0-9a-z]{26}/g,
    "tc_TCID",
  );
  expect(normalizedOutput).toContain(
    "### Tool calls\n" +
      "\n" +
      "- **demo**: `tc_TCID`<br>\n" +
      "    timeout: `120`\n" +
      '    options: ``["`tick`"]``\n',
  );
});

test("test_logs_backup", async () => {
  expect(fs.existsSync(env.logsDbPath)).toBe(false);
  const runner = new CliRunner();
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-ts-isofs-"));
  const prevCwd = process.cwd();
  process.chdir(workDir);
  try {
    await runner.invoke(cli, ["-m", "echo", "simple prompt"]);
    expect(new Database(env.logsDbPath).tableNames().length).toBeGreaterThan(0);
    const expectedPath = path.join(workDir, "backup.db");
    expect(fs.existsSync(expectedPath)).toBe(false);
    // Now back it up
    const result = await runner.invoke(cli, ["logs", "backup", "backup.db"]);
    expect(result.exitCode).toBe(0);
    expect(result.output.startsWith("Backed up ")).toBe(true);
    expect(result.output.endsWith("to backup.db\n")).toBe(true);
    expect(fs.existsSync(expectedPath)).toBe(true);
  } finally {
    process.chdir(prevCwd);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

describe.each([[false], [true]])(
  "test_logs_resolved_model async_=%s",
  (async_) => {
    test("logs resolved model", async () => {
      env.mockModel.resolved_model_name = "resolved-mock";
      env.asyncMockModel.resolved_model_name = "resolved-mock";
      const runner = new CliRunner();
      const result = await runner.invoke(cli, [
        "-m",
        "mock",
        "simple prompt",
        ...(async_ ? ["--async"] : []),
      ]);
      expect(result.exitCode).toBe(0);
      // Should have logged the resolved model name
      const logsDb = new Database(env.logsDbPath);
      expect(logsDb.table("responses").count).toBeGreaterThan(0);
      const response = logsDb.table("responses").rows[0];
      expect(response.model).toBe("mock");
      expect(response.resolved_model).toBe("resolved-mock");

      // Should show up in the JSON logs
      const result2 = await runner.invoke(cli, ["logs", "--json"]);
      expect(result2.exitCode).toBe(0);
      const logs = JSON.parse(result2.output.trim());
      expect(logs.length).toBe(1);
      expect(logs[0].model).toBe("mock");
      expect(logs[0].resolved_model).toBe("resolved-mock");

      // And the rendered logs
      const result3 = await runner.invoke(cli, ["logs"]);
      expect(result3.output).toContain(
        "Model: **mock** (resolved: **resolved-mock**)",
      );
    });
  },
);

// ---- Reasoning persistence and markdown rendering -----------------

test("test_log_to_db_persists_visible_reasoning", async () => {
  // A response that streams reasoning events should round-trip the
  // visible reasoning text via the responses.reasoning column.
  const logsDb = new Database(env.logsDbPath);
  migrate(logsDb);
  env.mockModel.enqueue([
    new StreamEvent({ type: "reasoning", chunk: "thinking " }),
    new StreamEvent({ type: "reasoning", chunk: "hard" }),
    new StreamEvent({ type: "text", chunk: "hello" }),
  ]);
  const response = env.mockModel.prompt("hi");
  response.text();
  await response.logToDb(logsDb);

  const row = logsDb.table("responses").rows[0];
  expect(row.response).toBe("hello");
  expect(row.reasoning).toBe("thinking hard");
});

test("test_log_to_db_persists_empty_reasoning_when_absent", async () => {
  // No reasoning emitted → empty/null reasoning column, never raises.
  const logsDb = new Database(env.logsDbPath);
  migrate(logsDb);
  env.mockModel.enqueue(["just text"]);
  const response = env.mockModel.prompt("hi");
  response.text();
  await response.logToDb(logsDb);
  const row = logsDb.table("responses").rows[0];
  expect(row.reasoning ?? null).toBeNull();
});

test("test_logs_markdown_renders_reasoning_heading", async () => {
  // When a row has reasoning text, `llm logs` renders a `## Reasoning`
  // heading between System and Response.
  const logPath = path.join(env.userPath, "logs_with_reasoning.db");
  const db = new Database(logPath);
  migrate(db);
  db.table("responses").insert({
    id: monotonicUlid().toString().toLowerCase(),
    system: null,
    prompt: "hi",
    response: "answer",
    reasoning: "I thought hard about it.\n\n\n",
    model: "mock",
    datetime_utc: isoUtcMicro(new Date()),
    conversation_id: "c1",
  });
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["logs", "-p", logPath], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain(
    "## Reasoning\n\nI thought hard about it.\n\n## Response",
  );
});

test("test_logs_markdown_omits_reasoning_heading_when_empty", async () => {
  makeLogPath();
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    ["logs", "-p", path.join(env.userPath, "logs.db")],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  expect(result.output).not.toContain("## Reasoning");
});
