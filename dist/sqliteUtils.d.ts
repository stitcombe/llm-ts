/**
 * A subset of Python's sqlite-utils implemented over better-sqlite3 —
 * just the API surface llm uses (create/transform/add_column/
 * add_foreign_key/enable_fts/insert/rows_where/...).
 *
 * Column types use the sqlite-utils Python tokens: "str" (TEXT),
 * "int" (INTEGER), "float" (REAL), "bytes" (BLOB). columnsDict returns
 * those tokens, so ported tests can compare against
 * `{id: "int", name: "str"}` where Python compared `{id: int, ...}`.
 */
import { type Database as BetterSqlite3 } from "better-sqlite3";
export type ColumnType = "str" | "int" | "float" | "bytes";
export declare class NotFoundError extends Error {
    constructor(message?: string);
}
export interface ForeignKey {
    table: string;
    column: string;
    other_table: string;
    other_column: string;
}
export interface ColumnInfo {
    cid: number;
    name: string;
    type: string;
    notnull: number;
    default_value: unknown;
    is_pk: number;
}
export interface Trigger {
    name: string;
    table: string;
    sql: string;
}
export declare class Database {
    conn: BetterSqlite3;
    constructor(pathOrOptions?: string | {
        memory: boolean;
    });
    table(name: string): Table;
    /** Python's db["name"] */
    t(name: string): Table;
    query(sql: string, params?: unknown[] | Record<string, unknown>): Array<Record<string, unknown>>;
    execute(sql: string, params?: unknown[] | Record<string, unknown>): {
        rows: Array<Record<string, unknown>>;
        lastInsertRowid: number | bigint;
    };
    executescript(sql: string): void;
    tableNames(): string[];
    get triggers(): Trigger[];
    registerFunction(name: string, fn: (...args: unknown[]) => unknown): void;
    attach(alias: string, filepath: string): void;
    /** Run fn inside a transaction (the `with db.conn:` analog). */
    transaction<T>(fn: () => T): T;
    close(): void;
}
export interface CreateOptions {
    pk?: string | string[];
    foreignKeys?: Array<[string, string, string]>;
    ifNotExists?: boolean;
    notNull?: string[];
    defaults?: Record<string, unknown>;
}
export interface InsertOptions {
    pk?: string | string[];
    ignore?: boolean;
    replace?: boolean;
}
export interface TransformOptions {
    pk?: string | string[];
    types?: Record<string, ColumnType>;
    rename?: Record<string, string>;
    drop?: Iterable<string>;
    column_order?: string[];
    drop_foreign_keys?: Iterable<string>;
}
export declare class Table {
    db: Database;
    name: string;
    lastPk: unknown;
    lastRowid: number | bigint | null;
    constructor(db: Database, name: string);
    exists(): boolean;
    get schema(): string;
    get columns(): ColumnInfo[];
    get columnsDict(): Record<string, ColumnType>;
    get pks(): string[];
    get count(): number;
    countWhere(where?: string, params?: unknown[] | Record<string, unknown>): number;
    get rows(): Array<Record<string, unknown>>;
    rowsWhere(where?: string, params?: unknown[] | Record<string, unknown>, { order_by, select, limit, offset, }?: {
        order_by?: string;
        select?: string;
        limit?: number;
        offset?: number;
    }): Array<Record<string, unknown>>;
    get foreignKeys(): ForeignKey[];
    get triggers(): Trigger[];
    create(columns: Record<string, ColumnType>, { pk, foreignKeys, ifNotExists }?: CreateOptions): Table;
    drop(): void;
    get(pkValues: unknown): Record<string, unknown>;
    insert(record: Record<string, unknown>, options?: InsertOptions): Table;
    insertAll(records: Array<Record<string, unknown>>, { pk, ignore, replace }?: InsertOptions): Table;
    get lastPkValue(): unknown;
    deleteWhere(where?: string, params?: unknown[] | Record<string, unknown>): Table;
    addColumn(name: string, type?: ColumnType, { fk, fkCol }?: {
        fk?: string;
        fkCol?: string;
    }): Table;
    addForeignKey(column: string, otherTable: string, otherColumn: string): Table;
    createIndex(columns: string[], { unique, ifNotExists }?: {
        unique?: boolean;
        ifNotExists?: boolean;
    }): Table;
    /**
     * Rebuild the table applying schema changes, sqlite-utils style:
     * new pk, changed types, renamed/dropped columns, new column order,
     * dropped foreign keys. Extra addForeignKeys supports add_foreign_key.
     */
    transform({ pk, types, rename, drop, column_order, drop_foreign_keys, }?: TransformOptions, addForeignKeys?: Array<[string, string, string]>): Table;
    enableFts(columns: string[], { createTriggers, replace, }?: {
        createTriggers?: boolean;
        replace?: boolean;
    }): Table;
    /** FTS search returning rowids of the content table. */
    search(query: string): Array<Record<string, unknown>>;
}
