/**
 * Port of tests/conftest.py — shared fixtures for the llm-ts test suite.
 *
 * pytest fixtures become explicit helper functions used with vitest
 * beforeEach/afterEach. The autouse fixtures (env_setup,
 * register_embed_demo_model, register_echo_model) are bundled into
 * setupTestEnvironment(), which test files call in beforeEach.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  AsyncConversation,
  AsyncKeyModel,
  AsyncModel,
  AsyncResponse,
  Conversation,
  EmbeddingModel,
  KeyModel,
  Model,
  Options,
  Prompt,
  Response,
} from "../src/models.js";
import type { FieldDef } from "../src/pydantic.js";
import { hookimpl } from "../src/hookspecs.js";
import { pm, resetLoadedForTests, testState } from "../src/plugins.js";
import { Database } from "../src/sqliteUtils.js";
import { Collection } from "../src/embeddings.js";
import * as llmEcho from "./llm_echo.js";
import type { StreamEvent } from "../src/parts.js";

testState.calledFromTest = true;

export class MockOptions extends Options {
  static override fields: Record<string, FieldDef> = {
    max_tokens: {
      type: "integer",
      description: "Maximum number of tokens to generate.",
      default: null,
    },
  };
}

export class MockModel extends Model {
  model_id = "mock";
  override attachment_types = new Set(["image/png", "audio/wav"]);
  override can_stream = true;
  override supports_schema = true;
  override supports_tools = true;
  static override Options = MockOptions;

  history: Array<
    [Prompt, boolean, Response, Conversation | null]
  > = [];
  protected _queue: Array<Array<string | StreamEvent>> = [];
  resolved_model_name: string | null = null;

  enqueue(messages: Array<string | StreamEvent>): void {
    if (!Array.isArray(messages)) {
      throw new Error("enqueue() requires a list");
    }
    this._queue.push(messages);
  }

  *execute(
    prompt: Prompt,
    stream: boolean,
    response: Response,
    conversation: Conversation | null,
  ): Generator<string | StreamEvent> {
    this.history.push([prompt, stream, response, conversation]);
    const gathered: Array<string | StreamEvent> = [];
    const messages = this._queue.shift();
    if (messages) {
      for (const message of messages) {
        gathered.push(message);
        yield message;
      }
    }
    response.set_usage({
      input: (prompt.prompt || "").split(/\s+/).filter(Boolean).length,
      output: gathered.length,
    });
    if (this.resolved_model_name !== null) {
      response.set_resolved_model(this.resolved_model_name);
    }
  }
}

export class MockKeyModel extends KeyModel {
  model_id = "mock_key";
  override needs_key: string | null = "mock";

  *execute(
    _prompt: Prompt,
    _stream: boolean,
    _response: Response,
    _conversation: Conversation | null,
    key: string | null,
  ): Generator<string> {
    yield `key: ${key}`;
  }
}

export class MockAsyncKeyModel extends AsyncKeyModel {
  model_id = "mock_key";
  override needs_key: string | null = "mock";

  async *execute(
    _prompt: Prompt,
    _stream: boolean,
    _response: AsyncResponse,
    _conversation: AsyncConversation | null,
    key: string | null,
  ): AsyncGenerator<string> {
    yield `async, key: ${key}`;
  }
}

export class AsyncMockModel extends AsyncModel {
  model_id = "mock";
  override can_stream = true;
  override supports_schema = true;
  static override Options = MockOptions;

  history: Array<
    [Prompt, boolean, AsyncResponse, AsyncConversation | null]
  > = [];
  protected _queue: Array<Array<string | StreamEvent>> = [];
  resolved_model_name: string | null = null;

  enqueue(messages: Array<string | StreamEvent>): void {
    if (!Array.isArray(messages)) {
      throw new Error("enqueue() requires a list");
    }
    this._queue.push(messages);
  }

  async *execute(
    prompt: Prompt,
    stream: boolean,
    response: AsyncResponse,
    conversation: AsyncConversation | null,
  ): AsyncGenerator<string | StreamEvent> {
    this.history.push([prompt, stream, response, conversation]);
    const gathered: Array<string | StreamEvent> = [];
    const messages = this._queue.shift();
    if (messages) {
      for (const message of messages) {
        gathered.push(message);
        yield message;
      }
    }
    response.set_usage({
      input: (prompt.prompt || "").split(/\s+/).filter(Boolean).length,
      output: gathered.length,
    });
    if (this.resolved_model_name !== null) {
      response.set_resolved_model(this.resolved_model_name);
    }
  }
}

export class EmbedDemo extends EmbeddingModel {
  model_id = "embed-demo";
  override batch_size: number | null = 10;
  override supports_binary = true;

  embedded_content: Array<string | Uint8Array> = [];
  batch_count = 0;

  async *embedBatch(
    texts: Iterable<string | Uint8Array>,
  ): AsyncGenerator<number[]> {
    this.batch_count += 1;
    for (const text of texts) {
      this.embedded_content.push(text);
      const str = typeof text === "string" ? text : Buffer.from(text).toString("latin1");
      const words = str.split(/\s+/).filter(Boolean).slice(0, 16);
      const embedding = words.map((word) => word.length);
      while (embedding.length < 16) {
        embedding.push(0);
      }
      yield embedding;
    }
  }
}

export class EmbedBinaryOnly extends EmbedDemo {
  override model_id = "embed-binary-only";
  override supports_text = false;
  override supports_binary = true;
}

export class EmbedTextOnly extends EmbedDemo {
  override model_id = "embed-text-only";
  override supports_text = true;
  override supports_binary = false;
}

export interface TestEnv {
  userPath: string;
  logsDbPath: string;
  embedDemo: EmbedDemo;
  mockModel: MockModel;
  asyncMockModel: AsyncMockModel;
  mockKeyModel: MockKeyModel;
  mockAsyncKeyModel: MockAsyncKeyModel;
  cleanup: () => void;
}

let envCounter = 0;

/**
 * Combined port of the autouse fixtures: creates a tmp LLM_USER_PATH,
 * registers the mock-models plugin and the echo plugin. Call the
 * returned cleanup() in afterEach.
 */
export function setupTestEnvironment(): TestEnv {
  envCounter += 1;
  const userPath = fs.mkdtempSync(
    path.join(os.tmpdir(), `llm-ts-test-${process.pid}-${envCounter}-`),
  );
  const prevUserPath = process.env.LLM_USER_PATH;
  process.env.LLM_USER_PATH = userPath;

  const embedDemo = new EmbedDemo();
  const mockModel = new MockModel();
  const asyncMockModel = new AsyncMockModel();
  const mockKeyModel = new MockKeyModel();
  const mockAsyncKeyModel = new MockAsyncKeyModel();

  const mockModelsPlugin = {
    __name__: "MockModelsPlugin",
    register_embedding_models: hookimpl(function register_embedding_models(
      register: (model: EmbeddingModel) => void,
    ) {
      register(embedDemo);
      register(new EmbedBinaryOnly());
      register(new EmbedTextOnly());
    }),
    register_models: hookimpl(function register_models(
      register: (model: Model, asyncModel?: AsyncModel) => void,
    ) {
      register(mockModel, asyncMockModel);
    }),
  };
  pm.register(mockModelsPlugin, "undo-mock-models-plugin");

  const echoModelPlugin = {
    __name__: "EchoModelPlugin",
    register_models: hookimpl(function register_models(
      register: (model: Model, asyncModel?: AsyncModel) => void,
    ) {
      register(new llmEcho.Echo(), new llmEcho.EchoAsync());
    }),
  };
  pm.register(echoModelPlugin, "undo-EchoModelPlugin");

  const cleanup = (): void => {
    try {
      pm.unregister(undefined, "undo-mock-models-plugin");
    } catch {
      // already unregistered
    }
    try {
      pm.unregister(undefined, "undo-EchoModelPlugin");
    } catch {
      // already unregistered
    }
    if (prevUserPath === undefined) {
      delete process.env.LLM_USER_PATH;
    } else {
      process.env.LLM_USER_PATH = prevUserPath;
    }
    fs.rmSync(userPath, { recursive: true, force: true });
  };

  return {
    userPath,
    logsDbPath: path.join(userPath, "logs.db"),
    embedDemo,
    mockModel,
    asyncMockModel,
    mockKeyModel,
    mockAsyncKeyModel,
    cleanup,
  };
}

export function logsDb(env: TestEnv): Database {
  return new Database(env.logsDbPath);
}

/** Port of the user_path_with_embeddings fixture. */
export async function userPathWithEmbeddings(env: TestEnv): Promise<void> {
  const db = new Database(path.join(env.userPath, "embeddings.db"));
  const collection = new Collection("demo", db, { model_id: "embed-demo" });
  await collection.embed("1", "hello world", { store: true });
  await collection.embed("2", "goodbye world", { store: true });
}

export function extractBraces(s: string): string | null {
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first !== -1 && last !== -1 && first < last) {
    return s.slice(first, last + 1);
  }
  return null;
}

export { resetLoadedForTests };
