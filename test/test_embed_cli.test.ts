/** Port of tests/test_embed_cli.py */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { Collection } from "../src/embeddings.js";
import { Database } from "../src/sqliteUtils.js";
import {
  setupTestEnvironment,
  userPathWithEmbeddings,
  type TestEnv,
} from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

const EMBEDDING_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0xa0, 0x40, 0x00, 0x00, 0xa0, 0x40]),
  Buffer.alloc(56),
]);

describe.each([
  ["json", "[5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]\n"],
  [
    "base64",
    "AACgQAAAoEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==\n",
  ],
  [
    "hex",
    "0000a0400000a04000000000000000000000000000000000000000000" +
      "000000000000000000000000000000000000000000000000000000000" +
      "00000000000000\n",
  ],
  // Raw bytes decoded as UTF-8 with replacement characters
  ["blob", EMBEDDING_BYTES.toString("utf-8") + "\n"],
] as Array<[string, string]>)(
  "test_embed_output_format format=%s",
  (format, expected) => {
    describe.each([["argument"], ["file"], ["stdin"]])(
      "scenario=%s",
      (scenario) => {
        test("embed output format", async () => {
          const runner = new CliRunner();
          const args = ["embed", "--format", format, "-m", "embed-demo"];
          let input: string | null = null;
          if (scenario === "argument") {
            args.push("-c", "hello world");
          } else if (scenario === "file") {
            const inputPath = path.join(env.userPath, "input.txt");
            fs.writeFileSync(inputPath, "hello world", "utf-8");
            args.push("-i", inputPath);
          } else {
            input = "hello world";
            args.push("-i", "-");
          }
          const result = await runner.invoke(cli, args, { input });
          expect(result.exitCode).toBe(0);
          expect(result.output).toBe(expected);
        });
      },
    );
  },
);

describe.each([
  [["-c", "Content", "stories"], "Must provide both collection and id"],
] as Array<[string[], string]>)(
  "test_embed_errors args=%j",
  (args, expectedError) => {
    test("embed errors", async () => {
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["embed", ...args]);
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain(expectedError);
    });
  },
);

describe.each([
  [null, null],
  ['{"foo": "bar"}', null],
  ['{"foo": [1, 2, 3]}', null],
  ["[1, 2, 3]", "metadata must be a JSON object"], // Must be a dictionary
  ['{"foo": "incomplete}', "metadata must be valid JSON"],
] as Array<[string | null, string | null]>)(
  "test_embed_store metadata=%s",
  (metadata, metadataError) => {
    test("embed store", async () => {
      const embeddingsDb = path.join(env.userPath, "embeddings.db");
      expect(fs.existsSync(embeddingsDb)).toBe(false);
      const runner = new CliRunner();
      const result = await runner.invoke(cli, [
        "embed",
        "-c",
        "hello",
        "-m",
        "embed-demo",
      ]);
      expect(result.exitCode).toBe(0);
      // Should not have created the table
      expect(fs.existsSync(embeddingsDb)).toBe(false);
      // Now run it to store
      const args = ["embed", "-c", "hello", "-m", "embed-demo", "items", "1"];
      if (metadata !== null) {
        args.push("--metadata", metadata);
      }
      const result2 = await runner.invoke(cli, args);
      if (metadataError) {
        // Should have returned an error message about invalid metadata
        expect(result2.exitCode).toBe(2);
        expect(result2.output).toContain(metadataError);
        return;
      }
      // No error, should have succeeded and stored the data
      expect(result2.exitCode).toBe(0);
      expect(fs.existsSync(embeddingsDb)).toBe(true);
      // Check the contents
      const db = new Database(embeddingsDb);
      expect(db.table("collections").rows).toEqual([
        { id: 1, name: "items", model: "embed-demo" },
      ]);
      const expectedMetadata = metadata && !metadataError ? metadata : null;
      expect(db.table("embeddings").rows).toEqual([
        {
          collection_id: 1,
          id: "1",
          embedding: Buffer.concat([
            Buffer.from([0x00, 0x00, 0xa0, 0x40]),
            Buffer.alloc(60),
          ]),
          content: null,
          content_blob: null,
          content_hash: Collection.content_hash("hello"),
          metadata: expectedMetadata,
          updated: expect.any(Number),
        },
      ]);
      // Should show up in 'llm collections list'
      for (const isJson of [false, true]) {
        const listArgs = ["collections"];
        if (isJson) {
          listArgs.push("list", "--json");
        }
        const result3 = await runner.invoke(cli, listArgs);
        expect(result3.exitCode).toBe(0);
        if (isJson) {
          expect(JSON.parse(result3.output)).toEqual([
            { name: "items", model: "embed-demo", num_embeddings: 1 },
          ]);
        } else {
          expect(result3.output).toBe("items: embed-demo\n  1 embedding\n");
        }
      }

      // And test deleting it too
      const result4 = await runner.invoke(cli, [
        "collections",
        "delete",
        "items",
      ]);
      expect(result4.exitCode).toBe(0);
      expect(db.table("collections").count).toBe(0);
      expect(db.table("embeddings").count).toBe(0);
    });
  },
);

test("test_embed_store_binary", async () => {
  const runner = new CliRunner();
  const args = ["embed", "-m", "embed-demo", "items", "2", "--binary", "--store"];
  const result = await runner.invoke(cli, args, {
    input: Buffer.from([0x00, 0x01, 0x02]),
  });
  expect(result.exitCode).toBe(0);
  const db = new Database(path.join(env.userPath, "embeddings.db"));
  expect(db.table("embeddings").rows).toEqual([
    {
      collection_id: 1,
      id: "2",
      embedding: Buffer.concat([
        Buffer.from([0x00, 0x00, 0x40, 0x40]),
        Buffer.alloc(60),
      ]),
      content: null,
      content_blob: Buffer.from([0x00, 0x01, 0x02]),
      content_hash: Buffer.from("b95f67f61ebb03619622d798f45fc2d3", "hex"),
      metadata: null,
      updated: expect.any(Number),
    },
  ]);
});

test("test_collection_delete_errors", async () => {
  const db = new Database(path.join(env.userPath, "embeddings.db"));
  const collection = new Collection("items", db, { model_id: "embed-demo" });
  await collection.embed("1", "hello");
  expect(db.table("collections").count).toBe(1);
  expect(db.table("embeddings").count).toBe(1);
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    ["collections", "delete", "does-not-exist"],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Collection does not exist");
  expect(db.table("collections").count).toBe(1);
});

describe.each([
  [[], "Missing argument 'COLLECTION'"],
  [["badcollection", "-c", "content"], "Collection does not exist"],
  [["demo", "bad-id"], "ID not found in collection"],
] as Array<[string[], string]>)(
  "test_similar_errors args=%j",
  (args, expectedError) => {
    test("similar errors", async () => {
      await userPathWithEmbeddings(env);
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["similar", ...args], {
        catchExceptions: false,
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.output).toContain(expectedError);
    });
  },
);

test("test_similar_by_id_cli", async () => {
  await userPathWithEmbeddings(env);
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["similar", "demo", "1"], {
    catchExceptions: false,
  });
  expect(result.exitCode).toBe(0);
  const parsed = JSON.parse(result.output);
  expect(parsed.id).toBe("2");
  expect(parsed.score).toBeCloseTo(0.9863939238321437, 10);
  expect(parsed.content).toBe("goodbye world");
  expect(parsed.metadata).toBeNull();
});

describe.each([["-p"], ["--plain"]])(
  "test_similar_by_id_cli_output_plain option=%s",
  (option) => {
    test("similar plain output", async () => {
      await userPathWithEmbeddings(env);
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["similar", "demo", "1", option], {
        catchExceptions: false,
      });
      expect(result.exitCode).toBe(0);
      // Replace score with a placeholder
      const output =
        result.output.split("(")[0] + "(score)" + result.output.split(")")[1];
      expect(output).toBe("2 (score)\n\n  goodbye world\n\n");
    });
  },
);

describe.each([["argument"], ["file"], ["stdin"]])(
  "test_similar_by_content_cli scenario=%s",
  (scenario) => {
    test("similar by content", async () => {
      await userPathWithEmbeddings(env);
      const runner = new CliRunner();
      const args = ["similar", "demo"];
      let input: string | null = null;
      if (scenario === "argument") {
        args.push("-c", "hello world");
      } else if (scenario === "file") {
        const contentPath = path.join(env.userPath, "content.txt");
        fs.writeFileSync(contentPath, "hello world", "utf-8");
        args.push("-i", contentPath);
      } else {
        input = "hello world";
        args.push("-i", "-");
      }
      const result = await runner.invoke(cli, args, {
        input,
        catchExceptions: false,
      });
      expect(result.exitCode).toBe(0);
      const lines = result.output.split("\n").filter((line) => line.trim());
      expect(lines.length).toBe(2);
      const first = JSON.parse(lines[0]);
      expect(first.id).toBe("1");
      expect(first.score).toBeCloseTo(0.9999999999999999, 10);
      expect(first.content).toBe("hello world");
      expect(first.metadata).toBeNull();
      const second = JSON.parse(lines[1]);
      expect(second.id).toBe("2");
      expect(second.score).toBeCloseTo(0.9863939238321437, 10);
      expect(second.content).toBe("goodbye world");
      expect(second.metadata).toBeNull();
    });
  },
);

describe.each([
  [
    "1",
    { id: "1", score: 0.7071067811865475, content: "hello world", metadata: null },
  ],
  [
    "2",
    {
      id: "2",
      score: 0.8137334712067349,
      content: "goodbye world",
      metadata: null,
    },
  ],
] as Array<
  [string, { id: string; score: number; content: string; metadata: null }]
>)("test_similar_by_content_prefixed prefix=%s", (prefix, expectedResult) => {
  test("similar prefixed", async () => {
    await userPathWithEmbeddings(env);
    const runner = new CliRunner();
    const result = await runner.invoke(
      cli,
      ["similar", "demo", "-c", "world", "--prefix", prefix, "-n", "1"],
      { catchExceptions: false },
    );
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output);
    expect(parsed.id).toBe(expectedResult.id);
    expect(parsed.score).toBeCloseTo(expectedResult.score, 10);
    expect(parsed.content).toBe(expectedResult.content);
    expect(parsed.metadata).toBeNull();
  });
});

describe.each([
  ["phrases.csv", "id,phrase\n1,hello world\n2,goodbye world"],
  ["phrases.tsv", "id\tphrase\n1\thello world\n2\tgoodbye world"],
  [
    "phrases.jsonl",
    '{"id": 1, "phrase": "hello world"}\n{"id": 2, "phrase": "goodbye world"}',
  ],
  [
    "phrases.json",
    '[{"id": 1, "phrase": "hello world"}, {"id": 2, "phrase": "goodbye world"}]',
  ],
] as Array<[string, string]>)(
  "test_embed_multi_file_input filename=%s",
  (filename, content) => {
    describe.each([[false], [true]])("use_stdin=%s", (useStdin) => {
      describe.each([[null], ["prefix"]])("prefix=%s", (prefix) => {
        describe.each([[null], ["search_document: "]])(
          "prepend=%s",
          (prepend) => {
            test("embed multi file input", async () => {
              const dbPath = path.join(env.userPath, "embeddings-multi.db");
              const args = [
                "embed-multi",
                "phrases",
                "-d",
                dbPath,
                "-m",
                "embed-demo",
              ];
              let input: string | null = null;
              if (useStdin) {
                input = content;
                args.push("-");
              } else {
                const filePath = path.join(env.userPath, filename);
                fs.writeFileSync(filePath, content, "utf-8");
                args.push(filePath);
              }
              if (prefix) {
                args.push("--prefix", prefix);
              }
              if (prepend) {
                args.push("--prepend", prepend);
              }
              // Auto-detection can't detect JSON-nl, so make that explicit
              if (filename.endsWith(".jsonl")) {
                args.push("--format", "nl");
              }
              const runner = new CliRunner();
              const result = await runner.invoke(cli, args, {
                input,
                catchExceptions: false,
              });
              expect(result.exitCode).toBe(0);
              // Check that everything was embedded correctly
              const db = new Database(dbPath);
              expect(db.table("embeddings").count).toBe(2);
              const ids = db.table("embeddings").rows.map((row) => row.id);
              const expectedIds = prefix ? ["prefix1", "prefix2"] : ["1", "2"];
              expect(ids).toEqual(expectedIds);
            });
          },
        );
      });
    });
  },
);

test("test_embed_multi_files_binary_store", async () => {
  const dbPath = path.join(env.userPath, "embeddings-bin.db");
  const args = ["embed-multi", "binfiles", "-d", dbPath, "-m", "embed-demo"];
  const binDir = path.join(env.userPath, "bindir");
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, "file.bin"), Buffer.from([0x00, 0x01, 0x02]));
  args.push("--files", binDir, "*.bin", "--store", "--binary");
  const runner = new CliRunner();
  const result = await runner.invoke(cli, args, { catchExceptions: false });
  expect(result.exitCode).toBe(0);
  const db = new Database(dbPath);
  expect(db.table("embeddings").count).toBe(1);
  const row = db.table("embeddings").rows[0];
  expect(row).toEqual({
    collection_id: 1,
    id: "file.bin",
    embedding: Buffer.concat([
      Buffer.from([0x00, 0x00, 0x40, 0x40]),
      Buffer.alloc(60),
    ]),
    content: null,
    content_blob: Buffer.from([0x00, 0x01, 0x02]),
    content_hash: Buffer.from("b95f67f61ebb03619622d798f45fc2d3", "hex"),
    metadata: null,
    updated: expect.any(Number),
  });
});

describe.each([[true], [false]])(
  "test_embed_multi_sql use_other_db=%s",
  (useOtherDb) => {
    describe.each([[null], ["prefix"]])("prefix=%s", (prefix) => {
      describe.each([[null], ["search_document: "]])(
        "prepend=%s",
        (prepend) => {
          test("embed multi sql", async () => {
            const dbPath = path.join(env.userPath, "embeddings-sql.db");
            let db = new Database(dbPath);
            const extraArgs: string[] = [];
            if (useOtherDb) {
              const dbPath2 = path.join(env.userPath, "other.db");
              db = new Database(dbPath2);
              extraArgs.push("--attach", "other", dbPath2);
            }

            if (prefix) {
              extraArgs.push("--prefix", prefix);
            }
            if (prepend) {
              extraArgs.push("--prepend", prepend);
            }

            db.table("content").insertAll(
              [
                { id: 1, name: "cli", description: "Command line interface" },
                {
                  id: 2,
                  name: "sql",
                  description: "Structured query language",
                },
              ],
              { pk: "id" },
            );
            const runner = new CliRunner();
            const result = await runner.invoke(cli, [
              "embed-multi",
              "stuff",
              "-d",
              dbPath,
              "--sql",
              useOtherDb ? "select * from other.content" : "select * from content",
              "-m",
              "embed-demo",
              "--store",
              ...extraArgs,
            ]);
            expect(result.exitCode).toBe(0);
            const embeddingsDb = new Database(dbPath);
            expect(embeddingsDb.table("embeddings").count).toBe(2);
            const rows = embeddingsDb.query(
              "select id, content from embeddings order by id",
            );
            expect(rows).toEqual([
              {
                id: (prefix ?? "") + "1",
                content: (prepend ?? "") + "cli Command line interface",
              },
              {
                id: (prefix ?? "") + "2",
                content: (prepend ?? "") + "sql Structured query language",
              },
            ]);
          });
        },
      );
    });
  },
);

test("test_embed_multi_batch_size", async () => {
  const dbPath = path.join(env.userPath, "data.db");
  const runner = new CliRunner();
  const sql = `
    with recursive cte (id) as (
      select 1
      union all
      select id+1 from cte where id < 100
    )
    select id, 'Row ' || cast(id as text) as value from cte
    `;
  expect(env.embedDemo.batch_count).toBe(0);
  const result = await runner.invoke(cli, [
    "embed-multi",
    "rows",
    "--sql",
    sql,
    "-d",
    dbPath,
    "-m",
    "embed-demo",
    "--store",
    "--batch-size",
    "8",
  ]);
  expect(result.exitCode).toBe(0);
  const db = new Database(dbPath);
  expect(db.table("embeddings").count).toBe(100);
  expect(env.embedDemo.batch_count).toBe(13);
});

/** Port of the multi_files fixture. */
function makeMultiFiles(): { dbPath: string; files: string } {
  const dbPath = path.join(env.userPath, "files.db");
  const files = path.join(env.userPath, "files");
  const entries: Array<[string, Buffer]> = [
    ["file1.txt", Buffer.from("hello world")],
    ["file2.txt", Buffer.from("goodbye world")],
    ["nested/one.txt", Buffer.from("one")],
    ["nested/two.txt", Buffer.from("two")],
    ["nested/more/three.txt", Buffer.from("three")],
    // This tests the fallback to latin-1 encoding:
    ["nested/more/ignored.ini", Buffer.from("Has weird \x96 character", "latin1")],
  ];
  for (const [filename, content] of entries) {
    const filePath = path.join(files, filename);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return { dbPath, files };
}

describe.each([["single"], ["multi"]])(
  "test_embed_multi_files scenario=%s",
  (scenario) => {
    describe.each([[null], ["search_document: "]])("prepend=%s", (prepend) => {
      test("embed multi files", async () => {
        const { dbPath, files } = makeMultiFiles();
        // Extra file used by this test only
        const extraPath = path.join(
          files,
          "nested",
          "more.txt",
          "ignored.ini",
        );
        fs.mkdirSync(path.dirname(extraPath), { recursive: true });
        fs.writeFileSync(
          extraPath,
          Buffer.from("Has weird \x96 character", "latin1"),
        );

        const extraArgs: string[] = [];

        if (prepend) {
          extraArgs.push("--prepend", prepend);
        }
        if (scenario === "single") {
          extraArgs.push("--files", files, "**/*.txt");
        } else {
          extraArgs.push(
            "--files",
            path.join(files, "nested", "more"),
            "**/*.ini",
            "--files",
            path.join(files, "nested"),
            "*.txt",
          );
        }

        const runner = new CliRunner();
        const result = await runner.invoke(cli, [
          "embed-multi",
          "files",
          "-d",
          dbPath,
          "-m",
          "embed-demo",
          "--store",
          ...extraArgs,
        ]);
        expect(result.exitCode).toBe(0);
        const embeddingsDb = new Database(dbPath);
        const rows = embeddingsDb.query(
          "select id, content from embeddings order by id",
        );
        if (scenario === "single") {
          expect(rows).toEqual([
            { id: "file1.txt", content: (prepend ?? "") + "hello world" },
            { id: "file2.txt", content: (prepend ?? "") + "goodbye world" },
            {
              id: "nested/more/three.txt",
              content: (prepend ?? "") + "three",
            },
            { id: "nested/one.txt", content: (prepend ?? "") + "one" },
            { id: "nested/two.txt", content: (prepend ?? "") + "two" },
          ]);
        } else {
          expect(rows).toEqual([
            {
              id: "ignored.ini",
              content: (prepend ?? "") + "Has weird \x96 character",
            },
            { id: "one.txt", content: (prepend ?? "") + "one" },
            { id: "two.txt", content: (prepend ?? "") + "two" },
          ]);
        }
      });
    });
  },
);

describe.each([
  [["not-a-dir", "*.txt"], "Invalid directory: not-a-dir"],
] as Array<[string[], string]>)(
  "test_embed_multi_files_errors args=%j",
  (args, expectedError) => {
    test("embed multi files errors", async () => {
      makeMultiFiles();
      const runner = new CliRunner();
      const result = await runner.invoke(cli, [
        "embed-multi",
        "files",
        "-m",
        "embed-demo",
        "--files",
        ...args,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.output).toContain(expectedError);
    });
  },
);

describe.each([
  // With no args default utf-8 with latin-1 fallback should work
  [[], null],
  [["--encoding", "utf-8"], "Could not decode text in file"],
  [["--encoding", "latin-1"], null],
  [["--encoding", "latin-1", "--encoding", "utf-8"], null],
  [["--encoding", "utf-8", "--encoding", "latin-1"], null],
] as Array<[string[], string | null]>)(
  "test_embed_multi_files_encoding extra=%j",
  (extraArgs, expectedError) => {
    test("embed multi files encoding", async () => {
      const { dbPath, files } = makeMultiFiles();
      const runner = new CliRunner();
      const result = await runner.invoke(cli, [
        "embed-multi",
        "files",
        "-d",
        dbPath,
        "-m",
        "embed-demo",
        "--files",
        path.join(files, "nested", "more"),
        "*.ini",
        "--store",
        ...extraArgs,
      ]);
      if (expectedError) {
        // Should still succeed with 0, but show a warning
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toContain(expectedError);
      } else {
        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        const embeddingsDb = new Database(dbPath);
        const rows = embeddingsDb.query(
          "select id, content from embeddings order by id",
        );
        expect(rows).toEqual([
          { id: "ignored.ini", content: "Has weird \x96 character" },
        ]);
      }
    });
  },
);

test("test_default_embedding_model", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["embed-models", "default"]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe("<No default embedding model set>\n");
  const result2 = await runner.invoke(cli, [
    "embed-models",
    "default",
    "ada-002",
  ]);
  expect(result2.exitCode).toBe(0);
  const result3 = await runner.invoke(cli, ["embed-models", "default"]);
  expect(result3.exitCode).toBe(0);
  expect(result3.output).toBe("text-embedding-ada-002\n");
  const result4 = await runner.invoke(cli, [
    "embed-models",
    "default",
    "--remove-default",
  ]);
  expect(result4.exitCode).toBe(0);
  const result5 = await runner.invoke(cli, ["embed-models", "default"]);
  expect(result5.exitCode).toBe(0);
  expect(result5.output).toBe("<No default embedding model set>\n");
  // Now set the default and actually use it
  const result6 = await runner.invoke(cli, [
    "embed-models",
    "default",
    "embed-demo",
  ]);
  expect(result6.exitCode).toBe(0);
  const result7 = await runner.invoke(cli, ["embed", "-c", "hello world"]);
  expect(result7.exitCode).toBe(0);
  expect(result7.output).toBe(
    "[5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]\n",
  );
});

describe.each([
  [["-q", "text-embedding-3-large"], "text-embedding-3-large"],
  [["-q", "text", "-q", "3"], "text-embedding-3-large"],
] as Array<[string[], string]>)(
  "test_llm_embed_models_query args=%j",
  (args, expectedModelId) => {
    test("embed models query", async () => {
      const runner = new CliRunner();
      const result = await runner.invoke(cli, ["embed-models", ...args], {
        catchExceptions: false,
      });
      expect(result.exitCode).toBe(0);
      expect(result.output).toContain(expectedModelId);
    });
  },
);

describe.each([[false], [true]])(
  "test_default_embed_model_errors default_is_set=%s",
  (defaultIsSet) => {
    describe.each([["embed"], ["embed-multi"]])("command=%s", (command) => {
      test("default embed model errors", async () => {
        const runner = new CliRunner();
        if (defaultIsSet) {
          fs.writeFileSync(
            path.join(env.userPath, "default_embedding_model.txt"),
            "embed-demo",
            "utf-8",
          );
        }
        let args: string[];
        let input: string | null = null;
        if (command === "embed-multi") {
          args = ["embed-multi", "example", "-"];
          input = "id,name\n1,hello";
        } else {
          args = ["embed", "example", "1", "-c", "hello world"];
        }
        const result = await runner.invoke(cli, args, {
          input,
          catchExceptions: false,
        });
        if (defaultIsSet) {
          expect(result.exitCode).toBe(0);
        } else {
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain(
            "You need to specify an embedding model (no default model is set)",
          );
          // Now set the default model and try again
          const result2 = await runner.invoke(cli, [
            "embed-models",
            "default",
            "embed-demo",
          ]);
          expect(result2.exitCode).toBe(0);
          const result3 = await runner.invoke(cli, args, {
            input,
            catchExceptions: false,
          });
          expect(result3.exitCode).toBe(0);
        }
        // At the end of this, there should be 1 embedding
        const db = new Database(path.join(env.userPath, "embeddings.db"));
        expect(db.table("embeddings").count).toBe(1);
      });
    });
  },
);

test("test_duplicate_content_embedded_only_once", async () => {
  // content_hash should avoid embedding the same content twice
  // per collection
  const embedDemo = env.embedDemo;
  const db = new Database(":memory:");
  expect(embedDemo.embedded_content.length).toBe(0);
  const collection = new Collection("test", db, { model_id: "embed-demo" });
  await collection.embed("1", "hello world");
  expect(embedDemo.embedded_content.length).toBe(1);
  await collection.embed("2", "goodbye world");
  expect(db.table("embeddings").count).toBe(2);
  expect(embedDemo.embedded_content.length).toBe(2);
  await collection.embed("1", "hello world");
  expect(db.table("embeddings").count).toBe(2);
  expect(embedDemo.embedded_content.length).toBe(2);
  // The same string in another collection should be embedded
  const c2 = new Collection("test2", db, { model_id: "embed-demo" });
  await c2.embed("1", "hello world");
  expect(db.table("embeddings").count).toBe(3);
  expect(embedDemo.embedded_content.length).toBe(3);

  // Same again for embed_multi
  await collection.embedMulti([
    ["1", "hello world"],
    ["2", "goodbye world"],
    ["3", "this is new"],
  ]);
  // Should have only embedded one more thing
  expect(db.table("embeddings").count).toBe(4);
  expect(embedDemo.embedded_content.length).toBe(4);
});
