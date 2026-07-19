import { randomBytes } from "node:crypto";
/**
 * Minimal ULID implementation (port of the parts of python-ulid that llm
 * uses): 16-byte value, Crockford base32 string form, millisecond timestamp.
 */
const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const DECODING = {};
for (let i = 0; i < ENCODING.length; i++)
    DECODING[ENCODING[i]] = i;
// Crockford base32 treats some letters as aliases
DECODING["O"] = 0;
DECODING["I"] = 1;
DECODING["L"] = 1;
export class ULID {
    bytes;
    constructor(bytes) {
        if (bytes !== undefined) {
            if (bytes.length !== 16) {
                throw new Error("ULID must be 16 bytes");
            }
            this.bytes = new Uint8Array(bytes);
        }
        else {
            this.bytes = ULID.fromTimestampBytes(Date.now());
        }
    }
    static fromTimestampBytes(ms) {
        const bytes = new Uint8Array(16);
        let ts = BigInt(ms);
        for (let i = 5; i >= 0; i--) {
            bytes[i] = Number(ts & 0xffn);
            ts >>= 8n;
        }
        bytes.set(randomBytes(10), 6);
        return bytes;
    }
    /** python-ulid's ULID.from_timestamp(seconds). */
    static fromTimestamp(seconds) {
        return new ULID(ULID.fromTimestampBytes(Math.floor(seconds * 1000)));
    }
    static fromString(text) {
        if (text.length !== 26) {
            throw new Error("ULID string must be 26 characters");
        }
        let value = 0n;
        for (const ch of text.toUpperCase()) {
            const digit = DECODING[ch];
            if (digit === undefined) {
                throw new Error(`Invalid ULID character: ${ch}`);
            }
            value = (value << 5n) | BigInt(digit);
        }
        const bytes = new Uint8Array(16);
        for (let i = 15; i >= 0; i--) {
            bytes[i] = Number(value & 0xffn);
            value >>= 8n;
        }
        return new ULID(bytes);
    }
    /** Millisecond timestamp encoded in the first 6 bytes. */
    get timestampMs() {
        let ts = 0n;
        for (let i = 0; i < 6; i++) {
            ts = (ts << 8n) | BigInt(this.bytes[i]);
        }
        return Number(ts);
    }
    /** Unix timestamp in seconds (python-ulid's .timestamp). */
    get timestamp() {
        return this.timestampMs / 1000;
    }
    get datetime() {
        return new Date(this.timestampMs);
    }
    toString() {
        let value = 0n;
        for (const b of this.bytes) {
            value = (value << 8n) | BigInt(b);
        }
        let out = "";
        for (let i = 0; i < 26; i++) {
            out = ENCODING[Number(value & 0x1fn)] + out;
            value >>= 5n;
        }
        return out;
    }
}
