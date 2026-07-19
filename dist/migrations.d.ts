/**
 * Port of llm/migrations.py — the logs database migrations.
 */
import type { Database } from "./sqliteUtils.js";
export type MigrationFn = ((db: Database) => void) & {
    migrationName?: string;
};
export declare const MIGRATIONS: MigrationFn[];
export declare function migrate(db: Database): void;
export declare function ensureMigrationsTable(db: Database): void;
