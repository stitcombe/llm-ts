/**
 * Port of llm/migrations.py — the logs database migrations.
 */
export const MIGRATIONS = [];
function migration(name, fn) {
    const wrapped = fn;
    wrapped.migrationName = name;
    MIGRATIONS.push(wrapped);
}
export function migrate(db) {
    ensureMigrationsTable(db);
    const alreadyApplied = new Set(db.table("_llm_migrations").rows.map((r) => r.name));
    for (const fn of MIGRATIONS) {
        const name = fn.migrationName;
        if (!alreadyApplied.has(name)) {
            fn(db);
            db.table("_llm_migrations").insert({
                name,
                applied_at: pyUtcNowString(),
            });
            alreadyApplied.add(name);
        }
    }
}
/** str(datetime.datetime.now(timezone.utc)) style: "2026-01-01 12:34:56.123456+00:00" */
function pyUtcNowString() {
    const iso = new Date().toISOString(); // 2026-01-01T12:34:56.789Z
    return iso.replace("T", " ").replace("Z", "+00:00");
}
export function ensureMigrationsTable(db) {
    if (!db.table("_llm_migrations").exists()) {
        db.table("_llm_migrations").create({
            name: "str",
            applied_at: "str",
        }, { pk: "name" });
    }
}
migration("m001_initial", (db) => {
    // Ensure the original table design exists, so other migrations can run
    if (db.table("log").exists()) {
        // It needs to have the chat_id column
        if (!("chat_id" in db.table("log").columnsDict)) {
            db.table("log").addColumn("chat_id");
        }
        return;
    }
    db.table("log").create({
        provider: "str",
        system: "str",
        prompt: "str",
        chat_id: "str",
        response: "str",
        model: "str",
        timestamp: "str",
    });
});
migration("m002_id_primary_key", (db) => {
    db.table("log").transform({ pk: "id" });
});
migration("m003_chat_id_foreign_key", (db) => {
    db.table("log").transform({ types: { chat_id: "int" } });
    db.table("log").addForeignKey("chat_id", "log", "id");
});
migration("m004_column_order", (db) => {
    db.table("log").transform({
        column_order: [
            "id",
            "model",
            "timestamp",
            "prompt",
            "system",
            "response",
            "chat_id",
        ],
    });
});
migration("m004_drop_provider", (db) => {
    db.table("log").transform({ drop: ["provider"] });
});
migration("m005_debug", (db) => {
    db.table("log").addColumn("debug", "str");
    db.table("log").addColumn("duration_ms", "int");
});
migration("m006_new_logs_table", (db) => {
    const columns = db.table("log").columnsDict;
    for (const [column, type] of [
        ["options_json", "str"],
        ["prompt_json", "str"],
        ["response_json", "str"],
        ["reply_to_id", "int"],
    ]) {
        // It's possible people running development code might have
        // accidentally created these columns already
        if (!(column in columns)) {
            db.table("log").addColumn(column, type);
        }
    }
    // Use .transform() to rename options and timestamp_utc, and set new order
    db.table("log").transform({
        column_order: [
            "id",
            "model",
            "prompt",
            "system",
            "prompt_json",
            "options_json",
            "response",
            "response_json",
            "reply_to_id",
            "chat_id",
            "duration_ms",
            "timestamp_utc",
        ],
        rename: {
            timestamp: "timestamp_utc",
            options: "options_json",
        },
    });
});
migration("m007_finish_logs_table", (db) => {
    db.table("log").transform({
        drop: ["debug"],
        rename: { timestamp_utc: "datetime_utc" },
        drop_foreign_keys: ["chat_id"],
    });
    db.execute("alter table log rename to logs");
});
migration("m008_reply_to_id_foreign_key", (db) => {
    db.table("logs").addForeignKey("reply_to_id", "logs", "id");
});
migration("m008_fix_column_order_in_logs", (db) => {
    // reply_to_id ended up at the end after foreign key added
    db.table("logs").transform({
        column_order: [
            "id",
            "model",
            "prompt",
            "system",
            "prompt_json",
            "options_json",
            "response",
            "response_json",
            "reply_to_id",
            "chat_id",
            "duration_ms",
            "timestamp_utc",
        ],
    });
});
migration("m009_delete_logs_table_if_empty", (db) => {
    // We moved to a new table design, but we don't delete the table
    // if someone has put data in it
    if (!db.table("logs").count) {
        db.table("logs").drop();
    }
});
migration("m010_create_new_log_tables", (db) => {
    db.table("conversations").create({
        id: "str",
        name: "str",
        model: "str",
    }, { pk: "id" });
    db.table("responses").create({
        id: "str",
        model: "str",
        prompt: "str",
        system: "str",
        prompt_json: "str",
        options_json: "str",
        response: "str",
        response_json: "str",
        conversation_id: "str",
        duration_ms: "int",
        datetime_utc: "str",
    }, {
        pk: "id",
        foreignKeys: [["conversation_id", "conversations", "id"]],
    });
});
migration("m011_fts_for_responses", (db) => {
    db.table("responses").enableFts(["prompt", "response"], {
        createTriggers: true,
    });
});
migration("m012_attachments_tables", (db) => {
    db.table("attachments").create({
        id: "str",
        type: "str",
        path: "str",
        url: "str",
        content: "bytes",
    }, { pk: "id" });
    db.table("prompt_attachments").create({
        response_id: "str",
        attachment_id: "str",
        order: "int",
    }, {
        foreignKeys: [
            ["response_id", "responses", "id"],
            ["attachment_id", "attachments", "id"],
        ],
        pk: ["response_id", "attachment_id"],
    });
});
migration("m013_usage", (db) => {
    db.table("responses").addColumn("input_tokens", "int");
    db.table("responses").addColumn("output_tokens", "int");
    db.table("responses").addColumn("token_details", "str");
});
migration("m014_schemas", (db) => {
    db.table("schemas").create({
        id: "str",
        content: "str",
    }, { pk: "id" });
    db.table("responses").addColumn("schema_id", "str", {
        fk: "schemas",
        fkCol: "id",
    });
    // Clean up SQL create table indentation
    db.table("responses").transform();
    // These changes may have dropped the FTS configuration, fix that
    db.table("responses").enableFts(["prompt", "response"], {
        createTriggers: true,
        replace: true,
    });
});
migration("m015_fragments_tables", (db) => {
    db.table("fragments").create({
        id: "int",
        hash: "str",
        content: "str",
        datetime_utc: "str",
        source: "str",
    }, { pk: "id" });
    db.table("fragments").createIndex(["hash"], { unique: true });
    db.table("fragment_aliases").create({
        alias: "str",
        fragment_id: "int",
    }, {
        foreignKeys: [["fragment_id", "fragments", "id"]],
        pk: "alias",
    });
    db.table("prompt_fragments").create({
        response_id: "str",
        fragment_id: "int",
        order: "int",
    }, {
        foreignKeys: [
            ["response_id", "responses", "id"],
            ["fragment_id", "fragments", "id"],
        ],
        pk: ["response_id", "fragment_id"],
    });
    db.table("system_fragments").create({
        response_id: "str",
        fragment_id: "int",
        order: "int",
    }, {
        foreignKeys: [
            ["response_id", "responses", "id"],
            ["fragment_id", "fragments", "id"],
        ],
        pk: ["response_id", "fragment_id"],
    });
});
migration("m016_fragments_table_pks", (db) => {
    // The same fragment can be attached to a response multiple times
    db.table("prompt_fragments").transform({
        pk: ["response_id", "fragment_id", "order"],
    });
    db.table("system_fragments").transform({
        pk: ["response_id", "fragment_id", "order"],
    });
});
migration("m017_tools_tables", (db) => {
    db.table("tools").create({
        id: "int",
        hash: "str",
        name: "str",
        description: "str",
        input_schema: "str",
    }, { pk: "id" });
    db.table("tools").createIndex(["hash"], { unique: true });
    // Many-to-many relationship between tools and responses
    db.table("tool_responses").create({
        tool_id: "int",
        response_id: "str",
    }, {
        foreignKeys: [
            ["tool_id", "tools", "id"],
            ["response_id", "responses", "id"],
        ],
        pk: ["tool_id", "response_id"],
    });
    // tool_calls and tool_results are one-to-many against responses
    db.table("tool_calls").create({
        id: "int",
        response_id: "str",
        tool_id: "int",
        name: "str",
        arguments: "str",
        tool_call_id: "str",
    }, {
        pk: "id",
        foreignKeys: [
            ["response_id", "responses", "id"],
            ["tool_id", "tools", "id"],
        ],
    });
    db.table("tool_results").create({
        id: "int",
        response_id: "str",
        tool_id: "int",
        name: "str",
        output: "str",
        tool_call_id: "str",
    }, {
        pk: "id",
        foreignKeys: [
            ["response_id", "responses", "id"],
            ["tool_id", "tools", "id"],
        ],
    });
});
migration("m017_tools_plugin", (db) => {
    db.table("tools").addColumn("plugin");
});
migration("m018_tool_instances", (db) => {
    // Used to track instances of Toolbox classes that may be
    // used multiple times by different tools
    db.table("tool_instances").create({
        id: "int",
        plugin: "str",
        name: "str",
        arguments: "str",
    }, { pk: "id" });
    // We record which instance was used only on the results
    db.table("tool_results").addColumn("instance_id", "int", {
        fk: "tool_instances",
    });
});
migration("m019_resolved_model", (db) => {
    // For models like gemini-1.5-flash-latest where we wish to record
    // the resolved model name in addition to the alias
    db.table("responses").addColumn("resolved_model", "str");
});
migration("m020_tool_results_attachments", (db) => {
    db.table("tool_results_attachments").create({
        tool_result_id: "int",
        attachment_id: "str",
        order: "int",
    }, {
        foreignKeys: [
            ["tool_result_id", "tool_results", "id"],
            ["attachment_id", "attachments", "id"],
        ],
        pk: ["tool_result_id", "attachment_id"],
    });
});
migration("m021_tool_results_exception", (db) => {
    db.table("tool_results").addColumn("exception", "str");
});
migration("m022_response_reasoning", (db) => {
    // Concatenated visible reasoning text emitted during the response.
    db.table("responses").addColumn("reasoning", "str");
});
