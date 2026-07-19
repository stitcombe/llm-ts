/**
 * Port of tests/test_async_parity.py — every sync API must work the
 * same way on AsyncResponse and AsyncConversation.
 *
 * Uses the llm-echo plugin (sync Echo + async EchoAsync) so both paths
 * exercise real registered models with identical behaviour.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as path from "node:path";
import * as llm from "../src/index.js";
import {
  AsyncConversation,
  AsyncModel,
  AsyncResponse,
  Model,
  Response,
  Tool,
} from "../src/models.js";
import { Message, TextPart, user } from "../src/parts.js";
import { Database } from "../src/sqliteUtils.js";
import { migrate } from "../src/migrations.js";
import { loadConversation } from "../src/cli.js";
import { dumps } from "../src/pyjson.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

// ---- basic sanity: both variants are registered --------------------

test("test_echo_registered_for_both", () => {
  expect(llm.getModel("echo")).toBeInstanceOf(Model);
  expect(llm.getAsyncModel("echo")).toBeInstanceOf(AsyncModel);
});

// ---- AsyncResponse.to_dict / from_dict -----------------------------

test("test_async_to_dict_captures_chain_and_output", async () => {
  const model = llm.getAsyncModel("echo");
  const r = model.prompt("hello");
  await r.text();

  const d = r.toDict();
  expect(d.model).toBe("echo");
  expect(d.prompt.messages).toEqual([user("hello").toDict()]);
  // Echo's output is JSON describing the input; it's the assistant's text.
  expect(d.messages.length).toBe(1);
  expect(d.messages[0].role).toBe("assistant");
});

test("test_async_to_dict_raises_before_awaited", () => {
  const model = llm.getAsyncModel("echo");
  const r = model.prompt("hello");
  expect(() => r.toDict()).toThrowError();
});

test("test_async_from_dict_rehydrates", async () => {
  const model = llm.getAsyncModel("echo");
  const r = model.prompt("hello");
  await r.text();

  const payload = JSON.stringify(r.toDict());
  const restored = await AsyncResponse.fromDict(JSON.parse(payload));

  expect(restored._done).toBe(true);
  // text_or_raise should match (same text as original)
  expect(restored.text_or_raise()).toBe(r.text_or_raise());
  // messages structure preserved
  expect(await restored.messages()).toEqual(await r.messages());
  // prompt.messages (the chain that was sent) preserved
  expect(restored.prompt.messages).toEqual(r.prompt.messages);
});

test("test_async_from_dict_then_reply_continues", async () => {
  const model = llm.getAsyncModel("echo");
  const r1 = model.prompt("q1");
  await r1.text();

  const payload = JSON.stringify(r1.toDict());
  const restored = await AsyncResponse.fromDict(JSON.parse(payload));

  const r2 = await restored.reply("q2");
  await r2.text();

  // r2 was sent the full chain including r1's output.
  const chainRoles = r2.prompt.messages.map((m: Message) => m.role);
  expect(chainRoles).toEqual(["user", "assistant", "user"]);
  expect((r2.prompt.messages[0].parts[0] as TextPart).text).toBe("q1");
  expect(
    (r2.prompt.messages[r2.prompt.messages.length - 1].parts[0] as TextPart)
      .text,
  ).toBe("q2");
});

// ---- AsyncResponse rehydrated via from_row (SQLite path) -----------

test("test_async_from_row_response_messages_synthesized", async () => {
  const model = llm.getAsyncModel("echo");
  const r = model.prompt("hello");
  await r.text();

  const db = new Database(path.join(env.userPath, "logs-parity-a.db"));
  migrate(db);
  // toSyncResponse is what logToDb uses for async.
  const syncR = await r.toSyncResponse();
  await syncR.logToDb(db);

  const row = db.table("responses").rows[0];
  const rehydrated = await AsyncResponse.fromRow(db, row);

  expect(rehydrated._stream_events).toEqual([]);
  // response.messages falls back to _chunks — must not be empty.
  const msgs = await rehydrated.messages();
  expect(msgs.length).toBe(1);
  expect(msgs[0].role).toBe("assistant");
  expect(msgs[0].parts[0]).toBeInstanceOf(TextPart);
});

// ---- AsyncConversation follow-up via load_conversation -------------

test("test_async_load_conversation_follow_up_preserves_chain", async () => {
  const model = llm.getAsyncModel("echo");
  const r1 = model.prompt("q1");
  await r1.text();

  const dbPath = path.join(env.userPath, "logs-parity-b.db");
  const db = new Database(dbPath);
  migrate(db);
  await (await r1.toSyncResponse()).logToDb(db);

  const conv = (await loadConversation(
    null,
    true,
    dbPath,
  )) as AsyncConversation;
  const r2 = conv.prompt("q2");
  await r2.text();

  const chain = r2.prompt.messages;
  expect(chain.map((m: Message) => m.role)).toEqual(["user", "assistant", "user"]);
  expect((chain[0].parts[0] as TextPart).text).toBe("q1");
  expect((chain[chain.length - 1].parts[0] as TextPart).text).toBe("q2");
});

// ---- Sync/async semantic parity for reply()+to_dict() --------------

async function captureSync(model: Model) {
  const r1 = model.prompt("ping");
  r1.text();
  const payload1 = JSON.stringify(r1.toDict());
  const restored = await Response.fromDict(JSON.parse(payload1));
  const r2 = await restored.reply("pong");
  r2.text();
  return r2.prompt.messages;
}

async function captureAsync(model: AsyncModel) {
  const r1 = model.prompt("ping");
  await r1.text();
  const payload1 = JSON.stringify(r1.toDict());
  const restored = await AsyncResponse.fromDict(JSON.parse(payload1));
  const r2 = await restored.reply("pong");
  await r2.text();
  return r2.prompt.messages;
}

test("test_sync_and_async_produce_identical_chain", async () => {
  const syncChain = await captureSync(llm.getModel("echo") as Model);
  const asyncChain = await captureAsync(
    llm.getAsyncModel("echo") as AsyncModel,
  );

  // Echo's assistant output differs between invocations only in
  // the "previous" field — but for the first turn both see empty
  // previous, so outputs match.
  const syncDicts = syncChain.map((m: Message) => m.toDict());
  const asyncDicts = asyncChain.map((m: Message) => m.toDict());
  expect(syncDicts).toEqual(asyncDicts);
});

// ---- AsyncChainResponse tool-result turn pre-bakes chain -----------

test("test_async_chain_tool_result_turn_has_full_chain", async () => {
  async function my_tool(x: number): Promise<number> {
    return x * 2;
  }
  (my_tool as { description?: string }).description = "Double the input.";
  (my_tool as { annotations?: Record<string, string> }).annotations = {
    x: "integer",
  };

  const model = llm.getAsyncModel("echo");
  // Drive a one-iteration chain by asking echo to emit a tool call
  // (echo's JSON-prompt syntax).
  const chain = model.chain(
    dumps({
      tool_calls: [{ name: "my_tool", arguments: { x: 5 } }],
      prompt: "prompt",
    }),
    { tools: [Tool.function(my_tool, { name: "my_tool" })] },
  );

  const responses: AsyncResponse[] = [];
  for await (const response of chain.responses()) {
    responses.push(response);
  }

  // Two responses: the tool-call turn and the tool-result turn.
  expect(responses.length).toBe(2);
  const second = responses[1];
  // Second turn's prompt.messages includes the prior turn (user +
  // assistant with tool call) plus a tool-role message with the result.
  const chainRoles = second.prompt.messages.map((m: Message) => m.role);
  expect(chainRoles).toContain("tool");
  expect(chainRoles[0]).toBe("user");
});

// ---- astream_events() parity with stream_events() ------------------

test("test_astream_events_matches_stream_events_for_text_only", async () => {
  const syncModel = llm.getModel("echo");
  const asyncModel = llm.getAsyncModel("echo");

  const syncR = syncModel.prompt("hello") as Response;
  const syncEvents = [...syncR.stream_events()];

  const asyncR = asyncModel.prompt("hello") as AsyncResponse;
  const asyncEvents = [];
  for await (const ev of asyncR.astream_events()) {
    asyncEvents.push(ev);
  }

  // Same event types, same payload.
  expect(syncEvents.map((e) => e.type)).toEqual(
    asyncEvents.map((e) => e.type),
  );
  expect(syncEvents.every((e) => e.type === "text")).toBe(true);
  expect(syncEvents.map((e) => e.chunk).join("")).toBe(
    asyncEvents.map((e) => e.chunk).join(""),
  );
});

// ---- Additional edge cases ----------------------------------------

test("test_async_from_dict_model_override", async () => {
  const model = llm.getAsyncModel("echo");
  const r = model.prompt("hi");
  await r.text();
  const payload = JSON.stringify(r.toDict());

  // Pass model explicitly to override whatever's in the payload.
  const alt = llm.getAsyncModel("echo") as AsyncModel;
  const restored = await AsyncResponse.fromDict(JSON.parse(payload), {
    model: alt,
  });
  expect(restored.model).toBe(alt);
});

test("test_sync_from_dict_model_override", async () => {
  const model = llm.getModel("echo");
  const r = model.prompt("hi") as Response;
  r.text();
  const payload = JSON.stringify(r.toDict());

  const alt = llm.getModel("echo") as Model;
  const restored = await Response.fromDict(JSON.parse(payload), {
    model: alt,
  });
  expect(restored.model).toBe(alt);
});

test("test_async_to_dict_preserves_datetime", async () => {
  const model = llm.getAsyncModel("echo");
  const r = model.prompt("hi");
  await r.text();
  const d = r.toDict();
  expect("datetime_utc" in d).toBe(true);
  expect(typeof d.datetime_utc).toBe("string");
});

test("test_async_to_dict_preserves_usage_when_set", async () => {
  // When a plugin calls response.set_usage, to_dict captures it.
  // asyncMockModel does set usage; llm-echo's async variant doesn't.
  env.asyncMockModel.enqueue(["ok"]);
  const r = env.asyncMockModel.prompt("hi");
  await r.text();
  const d = r.toDict();
  expect("usage" in d).toBe(true);
  expect(d.usage!.input).not.toBeNull();
  expect(d.usage!.output).not.toBeNull();

  // And it round-trips.
  const restored = await AsyncResponse.fromDict(d, {
    model: env.asyncMockModel,
  });
  expect(restored.input_tokens).toBe(d.usage!.input);
  expect(restored.output_tokens).toBe(d.usage!.output);
});

test("test_async_reply_messages_kwarg_appends", async () => {
  const model = llm.getAsyncModel("echo");
  const r1 = model.prompt("q1");
  await r1.text();
  const r2 = await r1.reply(null, { messages: [user("extra")] });
  await r2.text();
  expect(r2.prompt.messages.map((m: Message) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
  ]);
  expect(
    (r2.prompt.messages[r2.prompt.messages.length - 1].parts[0] as TextPart)
      .text,
  ).toBe("extra");
});

test("test_async_full_chain_to_dict_round_trip_three_turns", async () => {
  const model = llm.getAsyncModel("echo");
  const r1 = model.prompt("q1");
  await r1.text();
  const r2 = await r1.reply("q2");
  await r2.text();
  const r3 = await r2.reply("q3");
  await r3.text();

  const payload = JSON.stringify(r3.toDict());
  const restored = await AsyncResponse.fromDict(JSON.parse(payload));
  expect(restored.prompt.messages.map((m: Message) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
  const texts = restored.prompt.messages
    .filter((m: Message) => m.parts.length)
    .map((m: Message) => (m.parts[0] as TextPart).text);
  expect(texts[0]).toBe("q1");
  expect(texts[2]).toBe("q2");
  expect(texts[4]).toBe("q3");

  // And continuing from the restored response extends the chain.
  const r4 = await restored.reply("q4");
  await r4.text();
  expect(r4.prompt.messages.map((m: Message) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
});

test("test_async_reply_chains_three_turns", async () => {
  const model = llm.getAsyncModel("echo");
  const r1 = model.prompt("q1");
  await r1.text();
  const r2 = await r1.reply("q2");
  await r2.text();
  const r3 = await r2.reply("q3");
  await r3.text();

  const chain = r3.prompt.messages;
  expect(chain.map((m: Message) => m.role)).toEqual([
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
  ]);
  const texts = chain
    .filter((m: Message) => m.parts.length)
    .map((m: Message) => (m.parts[0] as TextPart).text);
  expect(texts[0]).toBe("q1");
  expect(texts[2]).toBe("q2");
  expect(texts[4]).toBe("q3");
});
