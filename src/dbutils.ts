/**
 * Database helpers from llm/utils.py that need the sqlite wrapper and
 * Tool type (split out to avoid circular imports).
 */

import { createHash } from "node:crypto";
import type { Database } from "./sqliteUtils.js";
import type { Tool } from "./models.js";
import { Fragment } from "./utils.js";
import { dumps } from "./pyjson.js";

export function ensureFragment(db: Database, content: string | Fragment): number {
  const sql = `
    insert into fragments (hash, content, datetime_utc, source)
    values (:hash, :content, datetime('now'), :source)
    on conflict(hash) do nothing
    `;
  const hashId = createHash("sha256")
    .update(String(content), "utf8")
    .digest("hex");
  let source: string | null = null;
  if (content instanceof Fragment) {
    source = content.source;
  }
  db.execute(sql, { hash: hashId, content: String(content), source });
  return db.query("select id from fragments where hash = :hash", {
    hash: hashId,
  })[0].id as number;
}

export function ensureTool(db: Database, tool: Tool): number {
  const sql = `
    insert into tools (hash, name, description, input_schema, plugin)
    values (:hash, :name, :description, :input_schema, :plugin)
    on conflict(hash) do nothing
    `;
  db.execute(sql, {
    hash: tool.hash(),
    name: tool.name,
    description: tool.description,
    input_schema: dumps(tool.input_schema),
    plugin: tool.plugin,
  });
  return db.query("select id from tools where hash = :hash", {
    hash: tool.hash(),
  })[0].id as number;
}
