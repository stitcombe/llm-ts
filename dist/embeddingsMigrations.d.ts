/**
 * Port of llm/embeddings_migrations.py (which uses sqlite-migrate's
 * Migrations class — reimplemented minimally here).
 */
import type { Database } from "./sqliteUtils.js";
type MigrationFn = (db: Database) => void;
export declare class Migrations {
    name: string;
    private migrations;
    constructor(name: string);
    register(fnName: string, fn: MigrationFn): void;
    private ensureTable;
    apply(db: Database, { stopBefore }?: {
        stopBefore?: string;
    }): void;
}
export declare const embeddingsMigrations: Migrations;
export {};
