/** Port of tests/test_embed.py — embedding models and Collections. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as llm from "../src/index.js";
import { Collection, Entry } from "../src/embeddings.js";
import { Database } from "../src/sqliteUtils.js";
import { setupTestEnvironment, type TestEnv, EmbedDemo } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

/** Port of the conftest `collection` fixture. */
async function makeCollection(): Promise<Collection> {
  const collection = new Collection("test", null, { model_id: "embed-demo" });
  await collection.embed("1", "hello world");
  await collection.embed("2", "goodbye world");
  return collection;
}

test("test_demo_plugin", async () => {
  const model = llm.getEmbeddingModel("embed-demo");
  expect(await model.embed("hello world")).toEqual(
    [5, 5].concat(new Array(14).fill(0)),
  );
});

describe.each([
  [null, 100],
  [10, 100],
] as Array<[number | null, number]>)(
  "test_embed_huge_list batch_size=%s",
  (batchSize, expectedBatches) => {
    test("embed huge list", async () => {
      const model = llm.getEmbeddingModel("embed-demo") as EmbedDemo;
      const hugeList = Array.from({ length: 1000 }, (_, i) => `hello ${i}`);
      const results = model.embedMulti(hugeList, batchSize);
      const firstTwos: Record<string, number> = {};
      for await (const result of results) {
        const key = `${result[0]},${result[1]}`;
        firstTwos[key] = (firstTwos[key] ?? 0) + 1;
      }
      expect(firstTwos).toEqual({ "5,1": 10, "5,2": 90, "5,3": 900 });
      expect(model.batch_count).toBe(expectedBatches);
    });
  },
);

test("test_embed_store", async () => {
  const collection = await makeCollection();
  await collection.embed("3", "hello world again", { store: true });
  expect(collection.db.table("embeddings").count).toBe(3);
  expect(
    collection.db.table("embeddings").rowsWhere("id = ?", ["3"])[0].content,
  ).toBe("hello world again");
});

test("test_embed_metadata", async () => {
  const collection = await makeCollection();
  await collection.embed("3", "hello yet again", {
    metadata: { foo: "bar" },
    store: true,
  });
  expect(collection.db.table("embeddings").count).toBe(3);
  expect(
    JSON.parse(
      collection.db.table("embeddings").rowsWhere("id = ?", ["3"])[0]
        .metadata as string,
    ),
  ).toEqual({ foo: "bar" });
  const entry = (await collection.similar("hello yet again"))[0];
  expect(entry.id).toBe("3");
  expect(entry.metadata).toEqual({ foo: "bar" });
  expect(entry.content).toBe("hello yet again");
});

test("test_collection", async () => {
  const collection = await makeCollection();
  expect(collection.id).toBe(1);
  expect(collection.count()).toBe(2);
  // Check that the embeddings are there
  const rows = collection.db.table("embeddings").rows;
  expect(rows).toEqual([
    {
      collection_id: 1,
      id: "1",
      embedding: Buffer.from(
        llm.encode([5, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
      content: null,
      content_blob: null,
      content_hash: Collection.content_hash("hello world"),
      metadata: null,
      updated: expect.any(Number),
    },
    {
      collection_id: 1,
      id: "2",
      embedding: Buffer.from(
        llm.encode([7, 5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ),
      content: null,
      content_blob: null,
      content_hash: Collection.content_hash("goodbye world"),
      metadata: null,
      updated: expect.any(Number),
    },
  ]);
  expect(typeof rows[0].updated).toBe("number");
  expect(rows[0].updated as number).toBeGreaterThan(0);
});

test("test_similar", async () => {
  const collection = await makeCollection();
  const results = await collection.similar("hello world");
  expect(results.length).toBe(2);
  expect(results[0].id).toBe("1");
  expect(results[0].score).toBeCloseTo(0.9999999999999999, 10);
  expect(results[1].id).toBe("2");
  expect(results[1].score).toBeCloseTo(0.9863939238321437, 10);
});

test("test_similar_prefixed", async () => {
  const collection = await makeCollection();
  const results = await collection.similar("hello world", 10, { prefix: "2" });
  expect(results.length).toBe(1);
  expect(results[0].id).toBe("2");
  expect(results[0].score).toBeCloseTo(0.9863939238321437, 10);
});

test("test_similar_by_id", async () => {
  const collection = await makeCollection();
  const results = collection.similarById("1");
  expect(results.length).toBe(1);
  expect(results[0].id).toBe("2");
  expect(results[0].score).toBeCloseTo(0.9863939238321437, 10);
});

describe.each([
  [null, 100],
  [5, 200],
] as Array<[number | null, number]>)(
  "test_embed_multi batch_size=%s",
  (batchSize, expectedBatches) => {
    describe.each([[false], [true]])("with_metadata=%s", (withMetadata) => {
      test("embed multi", async () => {
        const db = new Database(":memory:");
        const collection = new Collection("test", db, {
          model_id: "embed-demo",
        });
        const model = collection.model() as EmbedDemo;
        expect(model.batch_count ?? 0).toBe(0);
        if (withMetadata) {
          const idsTextsMeta = Array.from(
            { length: 1000 },
            (_, i) =>
              [String(i), `hello ${i}`, { meta: String(i) }] as [
                string,
                string,
                Record<string, unknown>,
              ],
          );
          await collection.embedMultiWithMetadata(idsTextsMeta, {
            batch_size: batchSize ?? undefined,
          });
        } else {
          const idsAndTexts = Array.from(
            { length: 1000 },
            (_, i) => [String(i), `hello ${i}`] as [string, string],
          );
          // Exercise store=true here too
          await collection.embedMulti(idsAndTexts, {
            store: true,
            batch_size: batchSize ?? undefined,
          });
        }
        const rows = db.table("embeddings").rows;
        expect(rows.length).toBe(1000);
        const rowsWithMetadata = rows.filter((row) => row.metadata !== null);
        const rowsWithContent = rows.filter((row) => row.content !== null);
        if (withMetadata) {
          expect(rowsWithMetadata.length).toBe(1000);
          expect(rowsWithContent.length).toBe(0);
        } else {
          expect(rowsWithMetadata.length).toBe(0);
          expect(rowsWithContent.length).toBe(1000);
        }
        // Every row should have content_hash set
        expect(rows.every((row) => row.content_hash !== null)).toBe(true);
        // Check batch count
        expect((collection.model() as EmbedDemo).batch_count).toBe(
          expectedBatches,
        );
      });
    });
  },
);

test("test_collection_delete", async () => {
  const collection = await makeCollection();
  const db = collection.db;
  expect(db.table("embeddings").count).toBe(2);
  expect(db.table("collections").count).toBe(1);
  collection.delete();
  expect(db.table("embeddings").count).toBe(0);
  expect(db.table("collections").count).toBe(0);
});

test("test_binary_only_and_text_only_embedding_models", async () => {
  const binaryOnly = llm.getEmbeddingModel("embed-binary-only");
  const textOnly = llm.getEmbeddingModel("embed-text-only");

  expect(binaryOnly.supports_binary).toBe(true);
  expect(binaryOnly.supports_text).toBe(false);
  expect(textOnly.supports_binary).toBe(false);
  expect(textOnly.supports_text).toBe(true);

  await expect(binaryOnly.embed("hello world")).rejects.toThrowError();

  await binaryOnly.embed(Buffer.from("hello world"));

  await expect(textOnly.embed(Buffer.from("hello world"))).rejects.toThrowError();

  await textOnly.embed("hello world");

  // Try the multi versions too — must drain the generators
  const drain = async (gen: AsyncGenerator<number[]>) => {
    const out = [];
    for await (const item of gen) {
      out.push(item);
    }
    return out;
  };

  await expect(drain(binaryOnly.embedMulti(["hello world"]))).rejects.toThrowError();
  await drain(binaryOnly.embedMulti([Buffer.from("hello world")]));
  await expect(
    drain(textOnly.embedMulti([Buffer.from("hello world")])),
  ).rejects.toThrowError();
  await drain(textOnly.embedMulti(["hello world"]));
});
