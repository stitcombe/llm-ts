/**
 * Port of llm/embeddings.py — Collection. Embedding operations are async
 * in TS (models call the network); DB operations stay sync.
 */
import type { EmbeddingModel } from "./models.js";
import { Database } from "./sqliteUtils.js";
export declare class Entry {
    id: string;
    score: number | null;
    content: string | null;
    metadata: Record<string, unknown> | null;
    constructor({ id, score, content, metadata, }: {
        id: string;
        score: number | null;
        content?: string | null;
        metadata?: Record<string, unknown> | null;
    });
}
export declare class CollectionDoesNotExist extends Error {
    constructor(message?: string);
}
export declare class Collection {
    static DoesNotExist: typeof CollectionDoesNotExist;
    db: Database;
    name: string;
    id: number;
    model_id: string | null;
    private _model;
    constructor(name: string, db?: Database | null, { model, model_id, create, }?: {
        model?: EmbeddingModel | null;
        model_id?: string | null;
        create?: boolean;
    });
    /** Return the embedding model used by this collection. */
    model(): EmbeddingModel;
    /** Count the number of items in the collection. */
    count(): number;
    /** Embed value and store it in the collection with a given ID. */
    embed(id: string, value: string | Uint8Array, { metadata, store, }?: {
        metadata?: Record<string, unknown> | null;
        store?: boolean;
    }): Promise<void>;
    /** Embed multiple texts and store them with given IDs. */
    embedMulti(entries: Iterable<[string, string | Uint8Array]>, { store, batch_size, }?: {
        store?: boolean;
        batch_size?: number;
    }): Promise<void>;
    /** Embed multiple values along with metadata. */
    embedMultiWithMetadata(entries: Iterable<[
        string,
        string | Uint8Array,
        Record<string, unknown> | null
    ]>, { store, batch_size, }?: {
        store?: boolean;
        batch_size?: number;
    }): Promise<void>;
    /** Find similar items in the collection by a given vector. */
    similarByVector(vector: number[], number?: number, { skipId, prefix, }?: {
        skipId?: string | null;
        prefix?: string | null;
    }): Entry[];
    /** Find similar items in the collection by a given ID. */
    similarById(id: string, number?: number, { prefix }?: {
        prefix?: string | null;
    }): Entry[];
    /** Find similar items in the collection by a given value. */
    similar(value: string | Uint8Array, number?: number, { prefix }?: {
        prefix?: string | null;
    }): Promise<Entry[]>;
    /** Does this collection exist in the database? */
    static exists(db: Database, name: string): boolean;
    /** Delete the collection and its embeddings from the database. */
    delete(): void;
    /** Hash content for deduplication. */
    static content_hash(input: string | Uint8Array): Buffer;
}
/**
 * Lazy accessor for the top-level llm index module. Uses require-style
 * caching via a registration hook: index.ts calls registerIndex() at
 * module evaluation, which happens before any Collection is used at
 * runtime (Collection is only reachable through the index).
 */
interface IndexApi {
    getEmbeddingModel: (name: string) => EmbeddingModel;
    encode: (values: number[]) => Buffer;
    decode: (binary: Uint8Array) => number[];
    cosineSimilarity: (a: number[], b: number[]) => number;
}
export declare function registerIndex(api: IndexApi): void;
export {};
