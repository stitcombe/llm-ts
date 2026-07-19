/** Port of tests/test_async.py */

import { afterEach, beforeEach, expect, test } from "vitest";
import * as llm from "../src/index.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

test("test_async_model", async () => {
  const asyncMockModel = env.asyncMockModel;
  const gathered: string[] = [];
  asyncMockModel.enqueue(["hello world"]);
  for await (const chunk of asyncMockModel.prompt("hello")) {
    gathered.push(chunk);
  }
  expect(gathered).toEqual(["hello world"]);
  // Not as an iterator
  asyncMockModel.enqueue(["hello world"]);
  const response = asyncMockModel.prompt("hello");
  const text = await response.text();
  expect(text).toBe("hello world");
  expect(response).toBeInstanceOf(llm.AsyncResponse);
  const usage = await response.usage();
  expect(usage.input).toBe(1);
  expect(usage.output).toBe(1);
  expect(usage.details).toBeNull();
});

test("test_async_model_conversation", async () => {
  const asyncMockModel = env.asyncMockModel;
  asyncMockModel.enqueue(["joke 1"]);
  const conversation = asyncMockModel.conversation();
  const response = conversation.prompt("joke");
  const text = await response.text();
  expect(text).toBe("joke 1");
  asyncMockModel.enqueue(["joke 2"]);
  const response2 = conversation.prompt("again");
  const text2 = await response2.text();
  expect(text2).toBe("joke 2");
});

test("test_async_on_done", async () => {
  const asyncMockModel = env.asyncMockModel;
  asyncMockModel.enqueue(["hello world"]);
  const response = asyncMockModel.prompt("hello");
  const caught: unknown[] = [];

  expect(caught.length).toBe(0);
  await response.on_done((r) => {
    caught.push(r);
  });
  await response.text();
  expect(response._done).toBe(true);
  expect(caught.length).toBe(1);
});

test("test_async_conversation", async () => {
  const asyncMockModel = env.asyncMockModel;
  asyncMockModel.enqueue(["one"]);
  const conversation = asyncMockModel.conversation();
  const response1 = await conversation.prompt("hi").text();
  asyncMockModel.enqueue(["two"]);
  const response2 = await conversation.prompt("hi").text();
  expect(response1).toBe("one");
  expect(response2).toBe("two");
});
