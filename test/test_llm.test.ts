/**
 * Port of tests/test_llm.py — library-level tests.
 * CLI-invoking tests live in test_llm_cli.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as llm from "../src/index.js";
import { Usage } from "../src/models.js";
import { BaseModel, type FieldDef } from "../src/pydantic.js";
import { dumps } from "../src/pyjson.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

test("test_llm_user_dir", () => {
  const userDir = path.join(env.userPath, "u");
  process.env.LLM_USER_PATH = userDir;
  expect(fs.existsSync(userDir)).toBe(false);
  const userDir2 = llm.userDir();
  expect(userDir2).toBe(userDir);
  expect(fs.existsSync(userDir)).toBe(true);
});

test("test_model_defaults", () => {
  const userDir = path.join(env.userPath, "u");
  process.env.LLM_USER_PATH = userDir;
  const configPath = path.join(userDir, "default_model.txt");
  expect(fs.existsSync(configPath)).toBe(false);
  expect(llm.getDefaultModel()).toBe("gpt-4o-mini");
  expect(llm.getModel().model_id).toBe("gpt-4o-mini");
  llm.setDefaultModel("gpt-4o");
  expect(fs.existsSync(configPath)).toBe(true);
  expect(llm.getDefaultModel()).toBe("gpt-4o");
  expect(llm.getModel().model_id).toBe("gpt-4o");
});

test("test_get_models", () => {
  const models = llm.getModels();
  for (const model of models as unknown[]) {
    expect(
      model instanceof llm.Model || model instanceof llm.KeyModel,
    ).toBe(true);
  }
  const modelIds = models.map((m) => m.model_id);
  expect(modelIds).toContain("gpt-4o-mini");
  expect(modelIds).toContain("gpt-5.4-mini");
  expect(modelIds).toContain("gpt-5.4-nano");
  // Ensure no model_ids are duplicated
  expect(modelIds.length).toBe(new Set(modelIds).size);
});

test("test_get_async_models", () => {
  const models = llm.getAsyncModels();
  for (const model of models as unknown[]) {
    expect(
      model instanceof llm.AsyncModel || model instanceof llm.AsyncKeyModel,
    ).toBe(true);
  }
  const modelIds = models.map((m) => m.model_id);
  expect(modelIds).toContain("gpt-4o-mini");
  expect(modelIds).toContain("gpt-5.4-mini");
  expect(modelIds).toContain("gpt-5.4-nano");
});

test("test_mock_model", () => {
  const mockModel = env.mockModel;
  mockModel.enqueue(["hello world"]);
  mockModel.enqueue(["second"]);
  const model = llm.getModel("mock") as unknown as typeof mockModel;
  const response = model.prompt("hello");
  expect(response.text()).toBe("hello world");
  expect(String(response.text())).toBe("hello world");
  expect(mockModel.history[0][0].prompt).toBe("hello");
  expect(response.usage()).toEqual(
    new Usage({ input: 1, output: 1, details: null }),
  );
  const response2 = model.prompt("hello again");
  expect(response2.text()).toBe("second");
  expect(response2.usage()).toEqual(
    new Usage({ input: 2, output: 1, details: null }),
  );
});

class Dog extends BaseModel {
  static override fields: Record<string, FieldDef> = {
    name: { type: "string" },
    age: { type: "integer" },
  };
}

const dogSchema = {
  properties: {
    name: { title: "Name", type: "string" },
    age: { title: "Age", type: "integer" },
  },
  required: ["name", "age"],
  title: "Dog",
  type: "object",
};
const dog = { name: "Cleo", age: 10 };

describe.each([[false], [true]])("test_schema use_pydantic=%s", (usePydantic) => {
  test("schema", () => {
    const mockModel = env.mockModel;
    expect(Dog.modelJsonSchema()).toEqual(dogSchema);
    mockModel.enqueue([dumps(dog)]);
    const response = mockModel.prompt("invent a dog", {
      schema: usePydantic ? Dog : dogSchema,
    });
    expect(JSON.parse(response.text())).toEqual(dog);
    expect(response.prompt.schema).toEqual(dogSchema);
  });
});

describe.each([[false], [true]])(
  "test_schema_async use_pydantic=%s",
  (usePydantic) => {
    test("schema async", async () => {
      const asyncMockModel = env.asyncMockModel;
      asyncMockModel.enqueue([dumps(dog)]);
      const response = asyncMockModel.prompt("invent a dog", {
        schema: usePydantic ? Dog : dogSchema,
      });
      expect(JSON.parse(await response.text())).toEqual(dog);
      expect(response.prompt.schema).toEqual(dogSchema);
    });
  },
);

test("test_mock_key_model", () => {
  const response = env.mockKeyModel.prompt("hello", { key: "hi" });
  expect(response.text()).toBe("key: hi");
});

test("test_mock_async_key_model", async () => {
  const response = env.mockAsyncKeyModel.prompt("hello", { key: "hi" });
  const output = await response.text();
  expect(output).toBe("async, key: hi");
});

test("test_sync_on_done", () => {
  env.mockModel.enqueue(["hello world"]);
  const model = llm.getModel("mock");
  const response = model.prompt("hello");
  const caught: unknown[] = [];

  response.on_done((r) => {
    caught.push(r);
  });
  expect(caught.length).toBe(0);
  response.text();
  expect(caught.length).toBe(1);
});

test("test_default_exports", () => {
  // "Check key exports in the llm __all__ list"
  const exports = llm as Record<string, unknown>;
  for (const name of [
    "Model",
    "AsyncModel",
    "getModel",
    "getAsyncModel",
    "schemaDsl",
  ]) {
    expect(exports[name], `${name} not exported from llm`).toBeDefined();
  }
});
