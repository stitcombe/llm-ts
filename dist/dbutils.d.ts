/**
 * Database helpers from llm/utils.py that need the sqlite wrapper and
 * Tool type (split out to avoid circular imports).
 */
import type { Database } from "./sqliteUtils.js";
import type { Tool } from "./models.js";
import { Fragment } from "./utils.js";
export declare function ensureFragment(db: Database, content: string | Fragment): number;
export declare function ensureTool(db: Database, tool: Tool): number;
