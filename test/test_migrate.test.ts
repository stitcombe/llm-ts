import { describe, expect, test } from "vitest";
import { Collection } from "../src/embeddings.js";
import { embeddingsMigrations } from "../src/embeddingsMigrations.js";
import { migrate } from "../src/migrations.js";
import { Database } from "../src/sqliteUtils.js";

const EXPECTED = {
  id: "str",
  model: "str",
  resolved_model: "str",
  prompt: "str",
  system: "str",
  prompt_json: "str",
  options_json: "str",
  response: "str",
  response_json: "str",
  conversation_id: "str",
  duration_ms: "int",
  datetime_utc: "str",
  input_tokens: "int",
  output_tokens: "int",
  token_details: "str",
  schema_id: "str",
  reasoning: "str",
};

test("test_migrate_blank", () => {
  const db = new Database({ memory: true });
  migrate(db);
  const tableNames = new Set(db.tableNames());
  for (const name of ["_llm_migrations", "conversations", "responses", "responses_fts"]) {
    expect(tableNames).toContain(name);
  }
  expect(db.table("responses").columnsDict).toEqual(EXPECTED);

  const foreignKeys = db.table("responses").foreignKeys;
  expect(foreignKeys).toContainEqual({
    table: "responses",
    column: "conversation_id",
    other_table: "conversations",
    other_column: "id",
  });

  // Should have FTS configured with triggers on correct tables
  expect(new Set(db.triggers.map((t) => t.name))).toEqual(
    new Set(["responses_ai", "responses_ad", "responses_au"]),
  );
});

describe.each([[true], [false]])(
  "test_migrate_from_original_schema has_record=%s",
  (hasRecord) => {
    test("migrates", () => {
      const db = new Database({ memory: true });
      if (hasRecord) {
        db.table("log").insert({
          provider: "provider",
          system: "system",
          prompt: "prompt",
          chat_id: null,
          response: "response",
          model: "model",
          timestamp: "timestamp",
        });
      } else {
        // Create empty logs table
        db.table("log").create({
          provider: "str",
          system: "str",
          prompt: "str",
          chat_id: "str",
          response: "str",
          model: "str",
          timestamp: "str",
        });
      }
      migrate(db);
      const expectedTables = new Set([
        "_llm_migrations",
        "conversations",
        "responses",
        "responses_fts",
      ]);
      if (hasRecord) {
        expectedTables.add("logs");
      }
      const tableNames = new Set(db.tableNames());
      for (const name of expectedTables) {
        expect(tableNames).toContain(name);
      }
      expect(new Set(db.triggers.map((t) => t.name))).toEqual(
        new Set(["responses_ai", "responses_ad", "responses_au"]),
      );
    });
  },
);

test("test_migrations_with_legacy_alter_table", () => {
  // https://github.com/simonw/llm/issues/162
  const db = new Database({ memory: true });
  db.conn.pragma("legacy_alter_table = on");
  migrate(db);
});

test("test_migrations_for_embeddings", () => {
  const db = new Database({ memory: true });
  embeddingsMigrations.apply(db);
  expect(db.table("collections").columnsDict).toEqual({
    id: "int",
    name: "str",
    model: "str",
  });
  expect(db.table("embeddings").columnsDict).toEqual({
    collection_id: "int",
    id: "str",
    embedding: "bytes",
    content: "str",
    content_blob: "bytes",
    content_hash: "bytes",
    metadata: "str",
    updated: "int",
  });
  expect(db.table("embeddings").foreignKeys[0].column).toBe("collection_id");
  expect(db.table("embeddings").foreignKeys[0].other_table).toBe("collections");
});

test("test_backfill_content_hash", () => {
  const db = new Database({ memory: true });
  // Run migrations up to but not including m004_store_content_hash
  embeddingsMigrations.apply(db, { stopBefore: "m004_store_content_hash" });
  expect(db.table("embeddings").columnsDict).not.toHaveProperty("content_hash");
  // Add some rows directly because llm.Collection would run migrations
  const embedding1 = Buffer.alloc(64);
  embedding1.writeFloatLE(5.0, 0);
  embedding1.writeFloatLE(5.0, 4);
  const embedding2 = Buffer.alloc(64);
  embedding2.writeFloatLE(7.0, 0);
  embedding2.writeFloatLE(5.0, 4);
  db.table("embeddings").insertAll([
    {
      collection_id: 1,
      id: "1",
      embedding: embedding1,
      content: null,
      metadata: null,
      updated: 1693763088,
    },
    {
      collection_id: 1,
      id: "2",
      embedding: embedding2,
      content: "goodbye world",
      metadata: null,
      updated: 1693763088,
    },
  ]);
  // Now finish the migrations
  embeddingsMigrations.apply(db);
  const [row1, row2] = db.table("embeddings").rows;
  // This one should be random:
  expect(row1.content_hash).not.toBeNull();
  // This should be a hash of 'goodbye world'
  expect(Buffer.from(row2.content_hash as Uint8Array)).toEqual(
    Collection.content_hash("goodbye world"),
  );
});
