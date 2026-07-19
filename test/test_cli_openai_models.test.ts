/** Port of tests/test_cli_openai_models.py */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import * as llm from "../src/index.js";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { Database } from "../src/sqliteUtils.js";
import { FetchMock } from "./fetchMock.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;
let fetchMock: FetchMock;
let savedOpenaiKey: string | undefined;

beforeEach(() => {
  env = setupTestEnvironment();
  fetchMock = new FetchMock();
  fetchMock.install();
  savedOpenaiKey = process.env.OPENAI_API_KEY;
});

afterEach(() => {
  fetchMock.uninstall();
  if (savedOpenaiKey === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = savedOpenaiKey;
  }
  env.cleanup();
});

function mockModelsEndpoint(): void {
  fetchMock.addResponse({
    method: "GET",
    url: "https://api.openai.com/v1/models",
    json: {
      data: [
        {
          id: "ada:2020-05-03",
          object: "model",
          created: 1588537600,
          owned_by: "openai",
        },
        {
          id: "babbage:2020-05-03",
          object: "model",
          created: 1588537600,
          owned_by: "openai",
        },
      ],
    },
  });
}

test("test_openai_models", async () => {
  mockModelsEndpoint();
  const runner = new CliRunner();
  const result = await runner.invoke(cli, ["openai", "models", "--key", "x"]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toBe(
    "id                    owned_by    created                  \n" +
      "ada:2020-05-03        openai      2020-05-03T20:26:40+00:00\n" +
      "babbage:2020-05-03    openai      2020-05-03T20:26:40+00:00\n",
  );
});

test("test_openai_options_min_max", async () => {
  const options: Record<string, [number, number]> = {
    temperature: [0, 2],
    top_p: [0, 1],
    frequency_penalty: [-2, 2],
    presence_penalty: [-2, 2],
  };
  const runner = new CliRunner();

  for (const [option, [minVal, maxVal]] of Object.entries(options)) {
    const result = await runner.invoke(cli, [
      "-m",
      "chatgpt",
      "-o",
      option,
      "-10",
    ]);
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(`greater than or equal to ${minVal}`);
    const result2 = await runner.invoke(cli, [
      "-m",
      "chatgpt",
      "-o",
      option,
      "10",
    ]);
    expect(result2.exitCode).toBe(1);
    expect(result2.output).toContain(`less than or equal to ${maxVal}`);
  }
});

function optionsFields(model: unknown): Record<string, { description?: string | null }> {
  return (model as { Options: { fields: Record<string, { description?: string | null }> } })
    .Options.fields;
}

describe.each([
  ["gpt-5"],
  ["gpt-5-mini"],
  ["gpt-5.1"],
  ["gpt-5.2"],
  ["gpt-5.4"],
  ["gpt-5.5"],
])("test_gpt5_models_support_verbosity_option model=%s", (modelId) => {
  test("supports verbosity", () => {
    expect(Object.keys(optionsFields(llm.getModel(modelId)))).toContain(
      "verbosity",
    );
    expect(Object.keys(optionsFields(llm.getAsyncModel(modelId)))).toContain(
      "verbosity",
    );
  });
});

describe.each([["gpt-4o"], ["gpt-4.5-preview"], ["o3"], ["o4-mini"]])(
  "test_non_gpt5_openai_chat_models_do_not_support_verbosity_option model=%s",
  (modelId) => {
    test("no verbosity", () => {
      expect(Object.keys(optionsFields(llm.getModel(modelId)))).not.toContain(
        "verbosity",
      );
      expect(
        Object.keys(optionsFields(llm.getAsyncModel(modelId))),
      ).not.toContain("verbosity");
    });
  },
);

test("test_gpt5_verbosity_option_is_sent_to_openai_chat_completions", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    json: {
      model: "gpt-5",
      usage: {},
      choices: [{ message: { content: "Verbose enough" } }],
    },
  });
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "-m",
      "gpt-5",
      "-o",
      "chat_completions",
      "1",
      "-o",
      "verbosity",
      "high",
      "--no-stream",
      "--key",
      "x",
      "Say hi",
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  const requests = fetchMock.getRequests();
  const requestBody = JSON.parse(requests[requests.length - 1].content);
  expect(requestBody.verbosity).toBe("high");
  expect("text" in requestBody).toBe(false);
});

function simpleResponsesJson(
  text: string,
  model: string,
): Record<string, unknown> {
  return {
    id: "resp_test_1",
    object: "response",
    created_at: 1,
    model,
    output: [
      {
        type: "message",
        id: "msg_1",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    usage: {
      input_tokens: 5,
      output_tokens: 3,
      total_tokens: 8,
    },
    status: "completed",
  };
}

test("test_gpt5_verbosity_option_is_sent_to_openai_responses_by_default", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    json: simpleResponsesJson("Verbose enough", "gpt-5"),
  });
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "-m",
      "gpt-5",
      "-o",
      "verbosity",
      "high",
      "--no-stream",
      "--key",
      "x",
      "Say hi",
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  const requests = fetchMock.getRequests();
  const requestBody = JSON.parse(requests[requests.length - 1].content);
  expect(requestBody.text.verbosity).toBe("high");
  expect(requestBody.include).toEqual(["reasoning.encrypted_content"]);
  expect("verbosity" in requestBody).toBe(false);
});

test("test_gpt5_verbosity_option_validates_allowed_values", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, [
    "-m",
    "gpt-5",
    "-o",
    "verbosity",
    "extreme",
    "Say hi",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Input should be 'low', 'medium' or 'high'");
});

describe.each([
  [
    "gpt-4o",
    "Controls the detail level for image attachments. Supported values are low, high, and auto.",
  ],
  [
    "gpt-5.4",
    "Controls the detail level for image attachments. Supported values are low, high, original, and auto.",
  ],
  [
    "gpt-5.5",
    "Controls the detail level for image attachments. Supported values are low, high, original, and auto.",
  ],
] as Array<[string, string]>)(
  "test_openai_image_detail_option_description model=%s",
  (modelId, expectedDescription) => {
    test("image_detail description", () => {
      const field = optionsFields(llm.getModel(modelId)).image_detail;
      expect(field.description).toBe(expectedDescription);
    });
  },
);

test("test_openai_image_detail_option_is_sent_on_image_attachments", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    json: {
      model: "gpt-4o",
      usage: {},
      choices: [{ message: { content: "Looks detailed" } }],
    },
  });
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "-m",
      "gpt-4o",
      "-o",
      "image_detail",
      "high",
      "--at",
      "https://example.com/image.jpg",
      "image/jpeg",
      "--no-stream",
      "--key",
      "x",
      "Describe this",
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  const requests = fetchMock.getRequests();
  const requestBody = JSON.parse(requests[requests.length - 1].content);
  const imagePart = requestBody.messages[0].content[1];
  expect(imagePart).toEqual({
    type: "image_url",
    image_url: {
      url: "https://example.com/image.jpg",
      detail: "high",
    },
  });
  expect("image_detail" in requestBody).toBe(false);
});

test("test_openai_image_detail_original_is_sent_for_gpt54", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    json: {
      model: "gpt-5.4",
      usage: {},
      choices: [{ message: { content: "Original detail" } }],
    },
  });
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "-m",
      "gpt-5.4",
      "-o",
      "chat_completions",
      "1",
      "-o",
      "image_detail",
      "original",
      "--at",
      "https://example.com/image.jpg",
      "image/jpeg",
      "--no-stream",
      "--key",
      "x",
      "Describe this",
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  const requests = fetchMock.getRequests();
  const requestBody = JSON.parse(requests[requests.length - 1].content);
  const imagePart = requestBody.messages[0].content[1];
  expect(imagePart.image_url.detail).toBe("original");
});

test("test_openai_image_detail_original_is_sent_for_gpt54_responses_by_default", async () => {
  fetchMock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/responses",
    json: simpleResponsesJson("Original detail", "gpt-5.4"),
  });
  const runner = new CliRunner();
  const result = await runner.invoke(
    cli,
    [
      "-m",
      "gpt-5.4",
      "-o",
      "image_detail",
      "original",
      "--at",
      "https://example.com/image.jpg",
      "image/jpeg",
      "--no-stream",
      "--key",
      "x",
      "Describe this",
    ],
    { catchExceptions: false },
  );
  expect(result.exitCode).toBe(0);
  const requests = fetchMock.getRequests();
  const requestBody = JSON.parse(requests[requests.length - 1].content);
  const imagePart = requestBody.input[0].content[1];
  expect(imagePart).toEqual({
    type: "input_image",
    image_url: "https://example.com/image.jpg",
    detail: "original",
  });
  expect("image_detail" in requestBody).toBe(false);
});

test("test_openai_image_detail_original_is_rejected_for_other_models", async () => {
  const runner = new CliRunner();
  const result = await runner.invoke(cli, [
    "-m",
    "gpt-5",
    "-o",
    "image_detail",
    "original",
    "Say hi",
  ]);
  expect(result.exitCode).toBe(1);
  expect(result.output).toContain("Input should be 'low', 'high' or 'auto'");
});

describe.each([["gpt-4o-mini"], ["gpt-4o-audio-preview"]])(
  "test_only_gpt4_audio_preview_allows_mp3_or_wav model=%s",
  (model) => {
    describe.each([["mp3"], ["wav"]])("filetype=%s", (filetype) => {
      test("audio attachment", async () => {
        const contentType = filetype === "mp3" ? "audio/mpeg" : "audio/wav";
        fetchMock.addResponse({
          method: "HEAD",
          url: `https://www.example.com/example.${filetype}`,
          text: "binary-data",
          headers: { "Content-Type": contentType },
        });
        if (model === "gpt-4o-audio-preview") {
          fetchMock.addResponse({
            method: "POST",
            url: "https://api.openai.com/v1/chat/completions",
            json: {
              id: "chatcmpl-AQT9a30kxEaM1bqxRPepQsPlCyGJh",
              object: "chat.completion",
              created: 1730871958,
              model: "gpt-4o-audio-preview-2024-10-01",
              choices: [
                {
                  index: 0,
                  message: {
                    role: "assistant",
                    content:
                      "Why did the pelican get kicked out of the restaurant?\n\nBecause he had a big bill and no way to pay it!",
                    refusal: null,
                  },
                  finish_reason: "stop",
                },
              ],
              usage: {
                prompt_tokens: 55,
                completion_tokens: 25,
                total_tokens: 80,
                prompt_tokens_details: {
                  cached_tokens: 0,
                  audio_tokens: 44,
                  text_tokens: 11,
                  image_tokens: 0,
                },
                completion_tokens_details: {
                  reasoning_tokens: 0,
                  audio_tokens: 0,
                  text_tokens: 25,
                  accepted_prediction_tokens: 0,
                  rejected_prediction_tokens: 0,
                },
              },
              system_fingerprint: "fp_49254d0e9b",
            },
          });
          fetchMock.addResponse({
            method: "GET",
            url: `https://www.example.com/example.${filetype}`,
            text: "binary-data",
            headers: { "Content-Type": contentType },
          });
        }
        const runner = new CliRunner();
        const result = await runner.invoke(cli, [
          "-m",
          model,
          "-a",
          `https://www.example.com/example.${filetype}`,
          "--no-stream",
          "--key",
          "x",
        ]);
        if (model === "gpt-4o-audio-preview") {
          expect(result.exitCode).toBe(0);
          expect(result.output).toBe(
            "Why did the pelican get kicked out of the restaurant?\n\n" +
              "Because he had a big bill and no way to pay it!\n",
          );
        } else {
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain(
            `This model does not support attachments of type '${contentType}'`,
          );
        }
      });
    });
  },
);

describe.each([[false], [true]])(
  "test_gpt4o_mini_sync_and_async async=%s",
  (async_) => {
    describe.each([[null], ["-u"], ["--usage"]])("usage=%s", (usage) => {
      test("gpt4o mini prompt", async () => {
        const userPath = path.join(env.userPath, "user_dir");
        const logDb = path.join(userPath, "logs.db");
        process.env.LLM_USER_PATH = userPath;
        expect(fs.existsSync(logDb)).toBe(false);
        fetchMock.addResponse({
          method: "POST",
          url: "https://api.openai.com/v1/chat/completions",
          json: {
            id: "chatcmpl-AQT9a30kxEaM1bqxRPepQsPlCyGJh",
            object: "chat.completion",
            created: 1730871958,
            model: "gpt-4o-mini",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Ho ho ho",
                  refusal: null,
                },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 2000,
              total_tokens: 12,
            },
            system_fingerprint: "fp_49254d0e9b",
          },
        });
        const runner = new CliRunner();
        const args = ["-m", "gpt-4o-mini", "--key", "x", "--no-stream"];
        if (usage) {
          args.push(usage);
        }
        if (async_) {
          args.push("--async");
        }
        const result = await runner.invoke(cli, args, {
          catchExceptions: false,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("Ho ho ho\n");
        if (usage) {
          expect(result.stderr).toBe(
            "Token usage: 1,000 input, 2,000 output\n",
          );
        }
        // Confirm it was correctly logged
        expect(fs.existsSync(logDb)).toBe(true);
        const db = new Database(logDb);
        expect(db.table("responses").count).toBe(1);
        const row = db.table("responses").rows[0] as Record<string, unknown>;
        expect(row.response).toBe("Ho ho ho");
      });
    });
  },
);
