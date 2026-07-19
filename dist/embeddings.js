/**
 * Port of llm/embeddings.py — Collection. Embedding operations are async
 * in TS (models call the network); DB operations stay sync.
 */
import { createHash } from "node:crypto";
import { embeddingsMigrations } from "./embeddingsMigrations.js";
import { Database } from "./sqliteUtils.js";
import { dumps } from "./pyjson.js";
export class Entry {
    id;
    score;
    content;
    metadata;
    constructor({ id, score, content = null, metadata = null, }) {
        this.id = id;
        this.score = score;
        this.content = content;
        this.metadata = metadata;
    }
}
export class CollectionDoesNotExist extends Error {
    constructor(message) {
        super(message);
        this.name = "DoesNotExist";
    }
}
export class Collection {
    static DoesNotExist = CollectionDoesNotExist;
    db;
    name;
    id;
    model_id = null;
    _model;
    constructor(name, db = null, { model = null, model_id = null, create = true, } = {}) {
        this.db = db ?? new Database({ memory: true });
        this.name = name;
        this._model = model;
        embeddingsMigrations.apply(this.db);
        const rows = this.db.table("collections").rowsWhere("name = ?", [this.name]);
        if (rows.length) {
            const row = rows[0];
            this.id = row.id;
            this.model_id = row.model;
        }
        else {
            if (create) {
                // Collection does not exist, so model or model_id is required
                if (!model && !model_id) {
                    throw new Error("Either model= or model_id= must be provided when creating a new collection");
                }
                let resolvedModel = model;
                let resolvedModelId = model_id;
                if (model_id) {
                    // Resolve alias — lazy import to avoid a circular module cycle
                    // at evaluation time.
                    const { getEmbeddingModel } = requireIndex();
                    resolvedModel = getEmbeddingModel(model_id);
                    this._model = resolvedModel;
                }
                resolvedModelId = resolvedModel.model_id;
                this.id = this.db.table("collections").insert({
                    name: this.name,
                    model: resolvedModelId,
                }).lastPk;
                this.model_id = resolvedModelId;
            }
            else {
                throw new CollectionDoesNotExist(`Collection '${name}' does not exist`);
            }
        }
    }
    /** Return the embedding model used by this collection. */
    model() {
        if (this._model === null) {
            const { getEmbeddingModel } = requireIndex();
            this._model = getEmbeddingModel(this.model_id);
        }
        return this._model;
    }
    /** Count the number of items in the collection. */
    count() {
        return this.db.query(`
            select count(*) as c from embeddings where collection_id = (
                select id from collections where name = ?
            )
            `, [this.name])[0].c;
    }
    /** Embed value and store it in the collection with a given ID. */
    async embed(id, value, { metadata = null, store = false, } = {}) {
        const { encode } = requireIndex();
        const contentHash = Collection.content_hash(value);
        if (this.db
            .table("embeddings")
            .countWhere("content_hash = ? and collection_id = ?", [
            contentHash,
            this.id,
        ])) {
            return;
        }
        const embedding = await this.model().embed(value);
        this.db.table("embeddings").insert({
            collection_id: this.id,
            id,
            embedding: encode(embedding),
            content: store && typeof value === "string" ? value : null,
            content_blob: store && value instanceof Uint8Array ? value : null,
            content_hash: contentHash,
            metadata: metadata && Object.keys(metadata).length ? dumps(metadata) : null,
            updated: Math.floor(Date.now() / 1000),
        }, { replace: true });
    }
    /** Embed multiple texts and store them with given IDs. */
    async embedMulti(entries, { store = false, batch_size = 100, } = {}) {
        await this.embedMultiWithMetadata([...entries].map(([id, value]) => [id, value, null]), { store, batch_size });
    }
    /** Embed multiple values along with metadata. */
    async embedMultiWithMetadata(entries, { store = false, batch_size = 100, } = {}) {
        const { encode } = requireIndex();
        const effectiveBatchSize = Math.min(batch_size, this.model().batch_size ?? batch_size);
        const allEntries = [...entries];
        const collectionId = this.id;
        for (let i = 0; i < allEntries.length; i += effectiveBatchSize) {
            const batch = allEntries.slice(i, i + effectiveBatchSize);
            // Calculate hashes first
            const itemsAndHashes = batch.map((item) => [item, Collection.content_hash(item[1])]);
            // Any of those hashes already exist?
            const existingIds = this.db
                .query(`
                    select id from embeddings
                    where collection_id = ? and content_hash in (${itemsAndHashes
                .map(() => "?")
                .join(",")})
                    `, [collectionId, ...itemsAndHashes.map(([, h]) => h)])
                .map((row) => row.id);
            const filteredBatch = batch.filter((item) => !existingIds.includes(item[0]));
            const embeddings = [];
            for await (const embedding of this.model().embedMulti(filteredBatch.map((item) => item[1]))) {
                embeddings.push(embedding);
            }
            this.db.table("embeddings").insertAll(embeddings.map((embedding, j) => {
                const [id, value, metadata] = filteredBatch[j];
                return {
                    collection_id: collectionId,
                    id,
                    embedding: encode(embedding),
                    content: store && typeof value === "string" ? value : null,
                    content_blob: store && value instanceof Uint8Array ? value : null,
                    content_hash: Collection.content_hash(value),
                    metadata: metadata && Object.keys(metadata).length ? dumps(metadata) : null,
                    updated: Math.floor(Date.now() / 1000),
                };
            }), { replace: true });
        }
    }
    /** Find similar items in the collection by a given vector. */
    similarByVector(vector, number = 10, { skipId = null, prefix = null, } = {}) {
        const { decode, cosineSimilarity } = requireIndex();
        this.db.registerFunction("distance_score", (otherEncoded) => {
            const otherVector = decode(otherEncoded);
            return cosineSimilarity(otherVector, vector);
        });
        const whereBits = ["collection_id = ?"];
        const whereArgs = [String(this.id)];
        if (prefix) {
            whereBits.push("id LIKE ? || '%'");
            whereArgs.push(prefix);
        }
        if (skipId) {
            whereBits.push("id != ?");
            whereArgs.push(skipId);
        }
        return this.db
            .query(`
            select id, content, metadata, distance_score(embedding) as score
            from embeddings
            where ${whereBits.join(" and ")}
            order by score desc limit ${number}
        `, whereArgs)
            .map((row) => new Entry({
            id: row.id,
            score: row.score,
            content: row.content,
            metadata: row.metadata
                ? JSON.parse(row.metadata)
                : null,
        }));
    }
    /** Find similar items in the collection by a given ID. */
    similarById(id, number = 10, { prefix = null } = {}) {
        const { decode } = requireIndex();
        const matches = this.db
            .table("embeddings")
            .rowsWhere("collection_id = ? and id = ?", [this.id, id]);
        if (!matches.length) {
            throw new CollectionDoesNotExist("ID not found");
        }
        const embedding = matches[0].embedding;
        const comparisonVector = decode(embedding);
        return this.similarByVector(comparisonVector, number, {
            skipId: id,
            prefix,
        });
    }
    /** Find similar items in the collection by a given value. */
    async similar(value, number = 10, { prefix = null } = {}) {
        const comparisonVector = await this.model().embed(value);
        return this.similarByVector(comparisonVector, number, { prefix });
    }
    /** Does this collection exist in the database? */
    static exists(db, name) {
        return db.table("collections").rowsWhere("name = ?", [name]).length > 0;
    }
    /** Delete the collection and its embeddings from the database. */
    delete() {
        this.db.execute("delete from embeddings where collection_id = ?", [this.id]);
        this.db.execute("delete from collections where id = ?", [this.id]);
    }
    /** Hash content for deduplication. */
    static content_hash(input) {
        const data = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
        return createHash("md5").update(data).digest();
    }
}
let indexApi = null;
export function registerIndex(api) {
    indexApi = api;
}
function requireIndex() {
    if (!indexApi) {
        throw new Error("llm index module not initialized — import the package root first");
    }
    return indexApi;
}
