export declare class ULID {
    readonly bytes: Uint8Array;
    constructor(bytes?: Uint8Array);
    private static fromTimestampBytes;
    /** python-ulid's ULID.from_timestamp(seconds). */
    static fromTimestamp(seconds: number): ULID;
    static fromString(text: string): ULID;
    /** Millisecond timestamp encoded in the first 6 bytes. */
    get timestampMs(): number;
    /** Unix timestamp in seconds (python-ulid's .timestamp). */
    get timestamp(): number;
    get datetime(): Date;
    toString(): string;
}
