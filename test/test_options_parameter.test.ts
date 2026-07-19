/**
 * Port of tests/test_options_parameter.py — tests for the `options`
 * key on `.prompt()` and `.reply()`.
 *
 * In TS both "options=" and "**kwargs" ride in the single trailing
 * object: `options: {...}` is the documented dict form, while unknown
 * extra keys (e.g. `max_tokens`) are the kwargs form.
 */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as llm from "../src/index.js";
import {
  AsyncModel,
  AsyncConversation,
  AsyncResponse,
  Options,
  Prompt,
} from "../src/models.js";
import type { FieldDef } from "../src/pydantic.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

test("test_prompt_with_options_dict", async () => {
  const mockModel = env.mockModel;
  mockModel.enqueue(["ok"]);
  const r = mockModel.prompt("q", { options: { max_tokens: 42 } });
  r.text();
  expect((r.prompt.options as { max_tokens?: number }).max_tokens).toBe(42);
  expect(r.toDict().prompt.options).toEqual({ max_tokens: 42 });
});

test("test_prompt_kwargs_still_work", () => {
  const mockModel = env.mockModel;
  mockModel.enqueue(["ok"]);
  const r = mockModel.prompt("q", { max_tokens: 42 });
  r.text();
  expect((r.prompt.options as { max_tokens?: number }).max_tokens).toBe(42);
});

test("test_prompt_options_and_kwargs_merge", () => {
  const mockModel = env.mockModel;
  mockModel.enqueue(["ok"]);
  // Pass an empty options dict alongside a kwarg to confirm both paths
  // coexist.
  const r = mockModel.prompt("q", { options: {}, max_tokens: 7 });
  r.text();
  expect((r.prompt.options as { max_tokens?: number }).max_tokens).toBe(7);
});

test("test_prompt_options_and_kwargs_conflict_raises", () => {
  const mockModel = env.mockModel;
  mockModel.enqueue(["ok"]);
  expect(() =>
    mockModel.prompt("q", { options: { max_tokens: 1 }, max_tokens: 2 }),
  ).toThrowError(/both in options=/);
});

test("test_conversation_prompt_with_options_dict", () => {
  const mockModel = env.mockModel;
  mockModel.enqueue(["ok"]);
  const convo = mockModel.conversation();
  const r = convo.prompt("q", { options: { max_tokens: 99 } });
  r.text();
  expect((r.prompt.options as { max_tokens?: number }).max_tokens).toBe(99);
});

test("test_response_reply_with_options_dict", async () => {
  const mockModel = env.mockModel;
  mockModel.enqueue(["first"]);
  mockModel.enqueue(["second"]);
  const r1 = mockModel.prompt("q1", { options: { max_tokens: 5 } });
  r1.text();
  const r2 = await r1.reply("q2", { options: { max_tokens: 17 } });
  r2.text();
  expect((r2.prompt.options as { max_tokens?: number }).max_tokens).toBe(17);
});

test("test_response_reply_kwargs_still_work", async () => {
  const mockModel = env.mockModel;
  mockModel.enqueue(["first"]);
  mockModel.enqueue(["second"]);
  const r1 = mockModel.prompt("q1", { max_tokens: 5 });
  r1.text();
  const r2 = await r1.reply("q2", { max_tokens: 17 });
  r2.text();
  expect((r2.prompt.options as { max_tokens?: number }).max_tokens).toBe(17);
});

test("test_async_prompt_with_options_dict", async () => {
  const asyncMockModel = env.asyncMockModel;
  asyncMockModel.enqueue(["ok"]);
  const r = await asyncMockModel.prompt("q", { options: {} }).text();
  expect(r).toBe("ok");
});

test("test_async_prompt_options_and_kwargs_conflict_raises", async () => {
  class AsyncOptionsWithMax extends Options {
    static override fields: Record<string, FieldDef> = {
      max_tokens: { type: "integer", default: null },
    };
  }
  class AsyncModelWithOption extends AsyncModel {
    model_id = "async-with-option";
    static override Options = AsyncOptionsWithMax;

    async *execute(
      _prompt: Prompt,
      _stream: boolean,
      _response: AsyncResponse,
      _conversation: AsyncConversation | null,
    ): AsyncGenerator<string> {
      yield "ok";
    }
  }

  const m = new AsyncModelWithOption();
  expect(() =>
    m.prompt("q", { options: { max_tokens: 1 }, max_tokens: 2 }),
  ).toThrowError(/both in options=/);
});
