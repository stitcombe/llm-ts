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
import DatabaseConstructor from "better-sqlite3";
import { dumps } from "./pyjson.js";
const TYPE_TO_SQL = {
    str: "TEXT",
    int: "INTEGER",
    float: "FLOAT",
    bytes: "BLOB",
};
function sqlTypeToToken(sqlType) {
    const t = sqlType.toUpperCase();
    if (t.includes("INT"))
        return "int";
    if (t.includes("BLOB") || t === "")
        return "bytes";
    if (t.includes("REAL") ||
        t.includes("FLOA") ||
        t.includes("DOUB")) {
        return "float";
    }
    return "str";
}
export class NotFoundError extends Error {
    constructor(message = "Not found") {
        super(message);
        this.name = "NotFoundError";
    }
}
function q(name) {
    return `[${name}]`;
}
/** Convert a JS value to something better-sqlite3 can bind, mirroring
 * sqlite-utils' insert conversions (dicts/lists become JSON text). */
function toSqlValue(value) {
    if (value === undefined || value === null)
        return null;
    if (typeof value === "boolean")
        return value ? 1 : 0;
    if (value instanceof String)
        return String(value);
    if (value instanceof Uint8Array)
        return Buffer.from(value);
    if (typeof value === "object" && !(value instanceof Buffer)) {
        return dumps(value, { fallback: (v) => String(v) });
    }
    return value;
}
function sanitizeParams(params) {
    if (params === undefined)
        return undefined;
    if (Array.isArray(params))
        return params.map(toSqlValue);
    const out = {};
    for (const [k, v] of Object.entries(params)) {
        out[k] = toSqlValue(v);
    }
    return out;
}
export class Database {
    conn;
    constructor(pathOrOptions = { memory: true }) {
        const path = typeof pathOrOptions === "string" ? pathOrOptions : ":memory:";
        this.conn = new DatabaseConstructor(path);
        // Python's sqlite3 does not enforce foreign keys by default;
        // better-sqlite3 turns enforcement on. Match Python.
        this.conn.pragma("foreign_keys = off");
    }
    table(name) {
        return new Table(this, name);
    }
    /** Python's db["name"] */
    t(name) {
        return this.table(name);
    }
    query(sql, params) {
        const stmt = this.conn.prepare(sql);
        const cleaned = sanitizeParams(params);
        if (cleaned === undefined)
            return stmt.all();
        return stmt.all(cleaned);
    }
    execute(sql, params) {
        const stmt = this.conn.prepare(sql);
        const cleaned = sanitizeParams(params);
        if (stmt.reader) {
            const rows = cleaned === undefined
                ? stmt.all()
                : stmt.all(cleaned);
            return { rows, lastInsertRowid: -1 };
        }
        const info = cleaned === undefined ? stmt.run() : stmt.run(cleaned);
        return { rows: [], lastInsertRowid: info.lastInsertRowid };
    }
    executescript(sql) {
        this.conn.exec(sql);
    }
    tableNames() {
        return this.query("select name from sqlite_master where type = 'table'").map((r) => r.name);
    }
    get triggers() {
        return this.query("select name, tbl_name as [table], sql from sqlite_master where type = 'trigger'").map((r) => ({
            name: r.name,
            table: r.table,
            sql: r.sql,
        }));
    }
    registerFunction(name, fn) {
        this.conn.function(name, { deterministic: true }, fn);
    }
    attach(alias, filepath) {
        this.conn
            .prepare(`ATTACH DATABASE ? AS ${q(alias)}`)
            .run(filepath);
    }
    /** Run fn inside a transaction (the `with db.conn:` analog). */
    transaction(fn) {
        return this.conn.transaction(fn)();
    }
    close() {
        this.conn.close();
    }
}
export class Table {
    db;
    name;
    lastPk = null;
    lastRowid = null;
    constructor(db, name) {
        this.db = db;
        this.name = name;
    }
    exists() {
        return (this.db.query("select 1 from sqlite_master where type in ('table', 'view') and name = ?", [this.name]).length > 0);
    }
    get schema() {
        const rows = this.db.query("select sql from sqlite_master where name = ?", [this.name]);
        return rows.length ? rows[0].sql : "";
    }
    get columns() {
        return this.db
            .query(`PRAGMA table_info(${q(this.name)})`)
            .map((r) => ({
            cid: r.cid,
            name: r.name,
            type: r.type,
            notnull: r.notnull,
            default_value: r.dflt_value,
            is_pk: r.pk,
        }));
    }
    get columnsDict() {
        const out = {};
        for (const col of this.columns) {
            out[col.name] = sqlTypeToToken(col.type);
        }
        return out;
    }
    get pks() {
        const pkCols = this.columns
            .filter((c) => c.is_pk > 0)
            .sort((a, b) => a.is_pk - b.is_pk)
            .map((c) => c.name);
        return pkCols.length ? pkCols : ["rowid"];
    }
    get count() {
        if (!this.exists())
            return 0;
        return this.db.query(`select count(*) as c from ${q(this.name)}`)[0]
            .c;
    }
    countWhere(where, params) {
        let sql = `select count(*) as c from ${q(this.name)}`;
        if (where)
            sql += ` where ${where}`;
        return this.db.query(sql, params)[0].c;
    }
    get rows() {
        return this.db.query(`select * from ${q(this.name)}`);
    }
    rowsWhere(where, params, { order_by, select = "*", limit, offset, } = {}) {
        if (!this.exists())
            return [];
        let sql = `select ${select} from ${q(this.name)}`;
        if (where)
            sql += ` where ${where}`;
        if (order_by)
            sql += ` order by ${order_by}`;
        if (limit !== undefined)
            sql += ` limit ${limit}`;
        if (offset !== undefined)
            sql += ` offset ${offset}`;
        return this.db.query(sql, params);
    }
    get foreignKeys() {
        return this.db
            .query(`PRAGMA foreign_key_list(${q(this.name)})`)
            .map((r) => ({
            table: this.name,
            column: r.from,
            other_table: r.table,
            other_column: r.to ?? "id",
        }));
    }
    get triggers() {
        return this.db.query("select name, tbl_name as [table], sql from sqlite_master where type = 'trigger' and tbl_name = ?", [this.name]);
    }
    create(columns, { pk, foreignKeys = [], ifNotExists = false } = {}) {
        const pkList = pk === undefined ? [] : Array.isArray(pk) ? pk : [pk];
        const singlePk = pkList.length === 1 ? pkList[0] : null;
        const colDefs = [];
        for (const [name, type] of Object.entries(columns)) {
            let def = `   ${q(name)} ${TYPE_TO_SQL[type]}`;
            if (singlePk === name) {
                def += " PRIMARY KEY";
            }
            const fk = foreignKeys.find(([col]) => col === name);
            if (fk) {
                def += ` REFERENCES ${q(fk[1])}(${q(fk[2])})`;
            }
            colDefs.push(def);
        }
        if (pkList.length > 1) {
            colDefs.push(`   PRIMARY KEY (${pkList.map(q).join(", ")})`);
        }
        const sql = `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${q(this.name)} (\n${colDefs.join(",\n")}\n)`;
        this.db.conn.exec(sql);
        return this;
    }
    drop() {
        this.db.conn.exec(`DROP TABLE ${q(this.name)}`);
    }
    get(pkValues) {
        const pks = this.pks;
        const values = Array.isArray(pkValues) ? pkValues : [pkValues];
        if (pks.length !== values.length) {
            throw new NotFoundError(`Need ${pks.length} primary key value${pks.length === 1 ? "" : "s"}`);
        }
        const where = pks.map((p) => `${q(p)} = ?`).join(" and ");
        const rows = this.rowsWhere(where, values);
        if (!rows.length) {
            throw new NotFoundError();
        }
        return rows[0];
    }
    insert(record, options = {}) {
        return this.insertAll([record], options);
    }
    insertAll(records, { pk, ignore = false, replace = false } = {}) {
        if (!records.length)
            return this;
        if (!this.exists()) {
            // sqlite-utils auto-creates from the first record's shape
            const columns = {};
            const first = records[0];
            for (const [key, value] of Object.entries(first)) {
                if (typeof value === "number" && Number.isInteger(value)) {
                    columns[key] = "int";
                }
                else if (typeof value === "number") {
                    columns[key] = "float";
                }
                else if (value instanceof Uint8Array) {
                    columns[key] = "bytes";
                }
                else {
                    columns[key] = "str";
                }
            }
            this.create(columns, { pk });
        }
        const existingColumns = new Set(this.columns.map((c) => c.name));
        for (const record of records) {
            // sqlite-utils with alter=True adds columns; llm relies on schema
            // being right, so unknown keys are an error except we mirror the
            // lax behavior of ignoring missing ones.
            const keys = Object.keys(record).filter((k) => existingColumns.has(k));
            const conflict = replace ? "OR REPLACE " : ignore ? "OR IGNORE " : "";
            const sql = `INSERT ${conflict}INTO ${q(this.name)} (${keys
                .map(q)
                .join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`;
            const info = this.db.conn
                .prepare(sql)
                .run(...keys.map((k) => toSqlValue(record[k])));
            this.lastRowid = info.lastInsertRowid;
            const pks = this.pks;
            if (pks.length === 1 && pks[0] !== "rowid") {
                if (pks[0] in record) {
                    this.lastPk = record[pks[0]];
                }
                else {
                    this.lastPk = info.lastInsertRowid;
                }
            }
            else {
                this.lastPk = info.lastInsertRowid;
            }
        }
        return this;
    }
    get lastPkValue() {
        return this.lastPk;
    }
    deleteWhere(where, params) {
        if (!this.exists())
            return this;
        let sql = `delete from ${q(this.name)}`;
        if (where)
            sql += ` where ${where}`;
        const stmt = this.db.conn.prepare(sql);
        const cleaned = sanitizeParams(params);
        if (cleaned === undefined)
            stmt.run();
        else
            stmt.run(cleaned);
        return this;
    }
    addColumn(name, type = "str", { fk, fkCol } = {}) {
        let sql = `ALTER TABLE ${q(this.name)} ADD COLUMN ${q(name)} ${TYPE_TO_SQL[type]}`;
        if (fk) {
            const fkTable = this.db.table(fk);
            const fkOther = fkCol ?? (fkTable.pks[0] === "rowid" ? "rowid" : fkTable.pks[0]);
            sql += ` REFERENCES ${q(fk)}(${q(fkOther)})`;
        }
        this.db.conn.exec(sql);
        return this;
    }
    addForeignKey(column, otherTable, otherColumn) {
        return this.transform({}, [[column, otherTable, otherColumn]]);
    }
    createIndex(columns, { unique = false, ifNotExists = false } = {}) {
        const indexName = `idx_${this.name}_${columns.join("_")}`;
        this.db.conn.exec(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${ifNotExists ? "IF NOT EXISTS " : ""}${q(indexName)} ON ${q(this.name)} (${columns.map(q).join(", ")})`);
        return this;
    }
    /**
     * Rebuild the table applying schema changes, sqlite-utils style:
     * new pk, changed types, renamed/dropped columns, new column order,
     * dropped foreign keys. Extra addForeignKeys supports add_foreign_key.
     */
    transform({ pk, types = {}, rename = {}, drop = [], column_order, drop_foreign_keys = [], } = {}, addForeignKeys = []) {
        const oldColumns = this.columns;
        const dropSet = new Set(drop);
        const dropFkSet = new Set(drop_foreign_keys);
        const oldFks = this.foreignKeys;
        const currentPks = this.columns
            .filter((c) => c.is_pk > 0)
            .sort((a, b) => a.is_pk - b.is_pk)
            .map((c) => c.name);
        // Determine new column list (old name -> new name/type)
        let cols = oldColumns
            .filter((c) => !dropSet.has(c.name))
            .map((c) => ({
            oldName: c.name,
            newName: rename[c.name] ?? c.name,
            type: types[c.name] !== undefined
                ? types[c.name]
                : sqlTypeToToken(c.type),
        }));
        if (column_order) {
            const orderIndex = (name) => {
                const i = column_order.indexOf(name);
                return i === -1 ? column_order.length : i;
            };
            cols = cols
                .map((c, i) => ({ c, i }))
                .sort((a, b) => {
                const oa = orderIndex(a.c.newName);
                const ob = orderIndex(b.c.newName);
                if (oa !== ob)
                    return oa - ob;
                return a.i - b.i;
            })
                .map(({ c }) => c);
        }
        const newPkList = pk === undefined
            ? currentPks.map((p) => rename[p] ?? p)
            : Array.isArray(pk)
                ? [...pk]
                : [pk];
        // Ensure a requested pk column exists (transform(pk="id") on a table
        // without an id column creates an integer id, like rowid promotion)
        for (const pkCol of newPkList) {
            if (!cols.some((c) => c.newName === pkCol)) {
                cols.unshift({ oldName: "rowid", newName: pkCol, type: "int" });
            }
        }
        const newFks = [];
        for (const fk of oldFks) {
            if (dropFkSet.has(fk.column))
                continue;
            const renamed = rename[fk.column] ?? fk.column;
            if (dropSet.has(fk.column))
                continue;
            newFks.push([renamed, fk.other_table, fk.other_column]);
        }
        for (const fk of addForeignKeys) {
            if (!newFks.some(([c]) => c === fk[0])) {
                newFks.push(fk);
            }
        }
        const tempName = `${this.name}_new_${Math.random().toString(36).slice(2, 10)}`;
        const singlePk = newPkList.length === 1 ? newPkList[0] : null;
        const colDefs = [];
        for (const col of cols) {
            let def = `   ${q(col.newName)} ${TYPE_TO_SQL[col.type]}`;
            if (singlePk === col.newName)
                def += " PRIMARY KEY";
            const fk = newFks.find(([c]) => c === col.newName);
            if (fk)
                def += ` REFERENCES ${q(fk[1])}(${q(fk[2])})`;
            colDefs.push(def);
        }
        if (newPkList.length > 1) {
            colDefs.push(`   PRIMARY KEY (${newPkList.map(q).join(", ")})`);
        }
        const wasOn = this.db.conn.pragma("foreign_keys", { simple: true });
        this.db.conn.pragma("foreign_keys = off");
        try {
            this.db.conn.exec(`CREATE TABLE ${q(tempName)} (\n${colDefs.join(",\n")}\n)`);
            const selectCols = cols.map((c) => q(c.oldName)).join(", ");
            const insertCols = cols.map((c) => q(c.newName)).join(", ");
            this.db.conn.exec(`INSERT INTO ${q(tempName)} (${insertCols}) SELECT ${selectCols} FROM ${q(this.name)}`);
            this.db.conn.exec(`DROP TABLE ${q(this.name)}`);
            this.db.conn.exec(`ALTER TABLE ${q(tempName)} RENAME TO ${q(this.name)}`);
        }
        finally {
            if (wasOn)
                this.db.conn.pragma("foreign_keys = on");
        }
        return this;
    }
    enableFts(columns, { createTriggers = false, replace = false, } = {}) {
        const ftsName = `${this.name}_fts`;
        if (replace || !this.db.table(ftsName).exists()) {
            // Drop any existing FTS table + triggers first
            this.db.conn.exec(`DROP TABLE IF EXISTS ${q(ftsName)}`);
            for (const suffix of ["ai", "ad", "au"]) {
                this.db.conn.exec(`DROP TRIGGER IF EXISTS ${q(`${this.name}_${suffix}`)}`);
            }
            this.db.conn.exec(`CREATE VIRTUAL TABLE ${q(ftsName)} USING FTS5 (${columns
                .map(q)
                .join(", ")}, content=${q(this.name)})`);
            // Populate with existing content
            this.db.conn.exec(`INSERT INTO ${q(ftsName)} (rowid, ${columns.map(q).join(", ")}) ` +
                `SELECT rowid, ${columns.map(q).join(", ")} FROM ${q(this.name)}`);
            if (createTriggers) {
                const colList = columns.map(q).join(", ");
                const newList = columns.map((c) => `new.${q(c)}`).join(", ");
                const oldList = columns.map((c) => `old.${q(c)}`).join(", ");
                this.db.conn.exec(`
          CREATE TRIGGER ${q(`${this.name}_ai`)} AFTER INSERT ON ${q(this.name)} BEGIN
            INSERT INTO ${q(ftsName)} (rowid, ${colList}) VALUES (new.rowid, ${newList});
          END;
          CREATE TRIGGER ${q(`${this.name}_ad`)} AFTER DELETE ON ${q(this.name)} BEGIN
            INSERT INTO ${q(ftsName)} (${q(ftsName)}, rowid, ${colList}) VALUES('delete', old.rowid, ${oldList});
          END;
          CREATE TRIGGER ${q(`${this.name}_au`)} AFTER UPDATE ON ${q(this.name)} BEGIN
            INSERT INTO ${q(ftsName)} (${q(ftsName)}, rowid, ${colList}) VALUES('delete', old.rowid, ${oldList});
            INSERT INTO ${q(ftsName)} (rowid, ${colList}) VALUES (new.rowid, ${newList});
          END;
        `);
            }
        }
        return this;
    }
    /** FTS search returning rowids of the content table. */
    search(query) {
        const ftsName = `${this.name}_fts`;
        return this.db.query(`select rowid from ${q(ftsName)} where ${q(ftsName)} match ?`, [query]);
    }
}
