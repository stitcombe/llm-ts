/**
 * Loader for the VCR cassettes recorded by the Python test suite
 * (tests/cassettes/*.yaml, copied into test/cassettes/). Each cassette
 * interaction is registered with the FetchMock in order, so tests decorated
 * with @pytest.mark.vcr in Python replay the same wire traffic here.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";
import type { FetchMock } from "./fetchMock.js";

const CASSETTES_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "cassettes",
);

interface CassetteInteraction {
  request: {
    method: string;
    uri: string;
  };
  response: {
    body: { string: string | Uint8Array };
    headers: Record<string, string[] | string>;
    status?: { code?: number };
  };
}

function headerValue(
  headers: Record<string, string[] | string>,
  name: string,
): string | null {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

function decodeBody(raw: string | Uint8Array): string {
  if (typeof raw === "string") {
    return raw;
  }
  const buf = Buffer.from(raw);
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
    return zlib.gunzipSync(buf).toString("utf-8");
  }
  return buf.toString("utf-8");
}

/** Split an SSE body into one chunk per event (trailing remainder kept). */
function splitSse(body: string): string[] {
  const chunks: string[] = body.match(/[\s\S]*?\n\n/g) ?? [];
  const consumed = chunks.join("");
  if (consumed.length < body.length) {
    chunks.push(body.slice(consumed.length));
  }
  return chunks;
}

/**
 * Register every interaction of a cassette with the mock.
 * `name` is e.g. "test_openai_responses/test_responses_basic_streaming".
 */
export function loadCassette(mock: FetchMock, name: string): void {
  const file = path.join(CASSETTES_DIR, `${name}.yaml`);
  const doc = yaml.load(fs.readFileSync(file, "utf-8")) as {
    interactions: CassetteInteraction[];
  };
  for (const interaction of doc.interactions) {
    const { request, response } = interaction;
    const body = decodeBody(response.body.string);
    const contentType =
      headerValue(response.headers, "content-type") ?? "application/json";
    const statusCode = response.status?.code ?? 200;
    if (contentType.includes("text/event-stream")) {
      mock.addResponse({
        method: request.method,
        url: request.uri,
        streamChunks: splitSse(body),
        headers: { "Content-Type": contentType },
        statusCode,
      });
    } else {
      mock.addResponse({
        method: request.method,
        url: request.uri,
        text: body,
        headers: { "Content-Type": contentType },
        statusCode,
      });
    }
  }
}
