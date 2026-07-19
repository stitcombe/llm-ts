/**
 * Port of llm/embeddings_migrations.py (which uses sqlite-migrate's
 * Migrations class — reimplemented minimally here).
 */

import { createHash } from "node:crypto";
import type { Database } from "./sqliteUtils.js";

type MigrationFn = (db: Database) => void;

export class Migrations {
  name: string;
  private migrations: Array<[string, MigrationFn]> = [];

  constructor(name: string) {
    this.name = name;
  }

  register(fnName: string, fn: MigrationFn): void {
    this.migrations.push([fnName, fn]);
  }

  private ensureTable(db: Database): void {
    if (!db.table("_sqlite_migrations").exists()) {
      db.table("_sqlite_migrations").create(
        {
          migration_set: "str",
          name: "str",
          applied_at: "str",
        },
        { pk: ["migration_set", "name"] },
      );
    }
  }

  apply(db: Database, { stopBefore }: { stopBefore?: string } = {}): void {
    this.ensureTable(db);
    const applied = new Set(
      db
        .table("_sqlite_migrations")
        .rowsWhere("migration_set = ?", [this.name])
        .map((r) => r.name as string),
    );
    for (const [name, fn] of this.migrations) {
      if (stopBefore && name === stopBefore) {
        break;
      }
      if (!applied.has(name)) {
        fn(db);
        db.table("_sqlite_migrations").insert({
          migration_set: this.name,
          name,
          applied_at: new Date().toISOString().replace("T", " ").replace("Z", "+00:00"),
        });
        applied.add(name);
      }
    }
  }
}

export const embeddingsMigrations = new Migrations("llm.embeddings");

embeddingsMigrations.register("m001_create_tables", (db) => {
  db.table("collections").create(
    { id: "int", name: "str", model: "str" },
    { pk: "id" },
  );
  db.table("collections").createIndex(["name"], { unique: true });
  db.table("embeddings").create(
    {
      collection_id: "int",
      id: "str",
      embedding: "bytes",
      content: "str",
      metadata: "str",
    },
    { pk: ["collection_id", "id"] },
  );
});

embeddingsMigrations.register("m002_foreign_key", (db) => {
  db.table("embeddings").addForeignKey("collection_id", "collections", "id");
});

embeddingsMigrations.register("m003_add_updated", (db) => {
  db.table("embeddings").addColumn("updated", "int");
  // Pretty-print the schema
  db.table("embeddings").transform();
  // Assume anything existing was last updated right now
  db.execute("update embeddings set updated = ? where updated is null", [
    Math.floor(Date.now() / 1000),
  ]);
});

embeddingsMigrations.register("m004_store_content_hash", (db) => {
  db.table("embeddings").addColumn("content_hash", "bytes");
  db.table("embeddings").transform({
    column_order: [
      "collection_id",
      "id",
      "embedding",
      "content",
      "content_hash",
      "metadata",
      "updated",
    ],
  });

  // Register functions manually so we can de-register later
  db.conn.function("temp_md5", (text: unknown) =>
    createHash("md5").update(String(text), "utf8").digest(),
  );
  db.conn.function("temp_random_md5", () =>
    createHash("md5").update(String(Date.now() * Math.random()), "utf8").digest(),
  );

  db.execute(`
            update embeddings
            set content_hash = temp_md5(content)
            where content is not null
        `);
  db.execute(`
            update embeddings
            set content_hash = temp_random_md5()
            where content is null
        `);

  db.table("embeddings").createIndex(["content_hash"]);
});

embeddingsMigrations.register("m005_add_content_blob", (db) => {
  db.table("embeddings").addColumn("content_blob", "bytes");
  db.table("embeddings").transform({
    column_order: ["collection_id", "id", "embedding", "content", "content_blob"],
  });
});
