/**
 * Port of tests/test_serialization.py — the runtime spec for the
 * JSON-safe wire form of Message, Part, and Response.
 *
 * Python validates toDict() output against TypedDicts via pydantic's
 * TypeAdapter; here the runtime DictSpec objects + validate* functions
 * in src/serialization.ts play that role. The Python "annotation"
 * tests (typing.get_type_hints on to_dict) are enforced at compile
 * time in TS — see the type-level assertions at the bottom, checked by
 * `tsc --noEmit`.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as llm from "../src/index.js";
import {
  AttachmentPart,
  Message,
  ReasoningPart,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  tool_message,
  user,
} from "../src/parts.js";
import {
  AttachmentPartDictSpec,
  MessageDictSpec,
  PromptDictSpec,
  ReasoningPartDictSpec,
  ResponseDictSpec,
  TextPartDictSpec,
  ToolCallPartDictSpec,
  ToolResultPartDictSpec,
  validateMessageDict,
  validatePartDict,
  validatePartDictAs,
  validateResponseDict,
  type DictSpec,
  type AttachmentPartDict,
  type MessageDict,
  type ReasoningPartDict,
  type ResponseDict,
  type TextPartDict,
  type ToolCallPartDict,
  type ToolResultPartDict,
} from "../src/serialization.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

// ---- required/optional keys ----------------------------------------

describe("TestRequiredOptionalKeys", () => {
  test("test_message_dict_required_keys", () => {
    expect(MessageDictSpec.requiredKeys).toEqual(new Set(["role", "parts"]));
    expect(MessageDictSpec.optionalKeys).toEqual(
      new Set(["provider_metadata"]),
    );
  });

  test("test_text_part_dict_required_keys", () => {
    expect(TextPartDictSpec.requiredKeys).toEqual(new Set(["type", "text"]));
    expect(TextPartDictSpec.optionalKeys).toEqual(
      new Set(["provider_metadata"]),
    );
  });

  test("test_reasoning_part_dict_required_keys", () => {
    expect(ReasoningPartDictSpec.requiredKeys).toEqual(
      new Set(["type", "text"]),
    );
    expect(ReasoningPartDictSpec.optionalKeys).toEqual(
      new Set(["redacted", "provider_metadata"]),
    );
  });

  test("test_tool_call_part_dict_required_keys", () => {
    expect(ToolCallPartDictSpec.requiredKeys).toEqual(
      new Set(["type", "name", "arguments"]),
    );
    expect(ToolCallPartDictSpec.optionalKeys).toEqual(
      new Set(["tool_call_id", "server_executed", "provider_metadata"]),
    );
  });

  test("test_tool_result_part_dict_required_keys", () => {
    expect(ToolResultPartDictSpec.requiredKeys).toEqual(
      new Set(["type", "name", "output"]),
    );
    expect(ToolResultPartDictSpec.optionalKeys).toEqual(
      new Set([
        "tool_call_id",
        "server_executed",
        "exception",
        "attachments",
        "provider_metadata",
      ]),
    );
  });

  test("test_attachment_part_dict_required_keys", () => {
    expect(AttachmentPartDictSpec.requiredKeys).toEqual(new Set(["type"]));
    expect(AttachmentPartDictSpec.optionalKeys).toEqual(
      new Set(["attachment", "provider_metadata"]),
    );
  });

  test("test_response_dict_required_keys", () => {
    expect(ResponseDictSpec.requiredKeys).toEqual(
      new Set(["model", "prompt", "messages"]),
    );
    expect(ResponseDictSpec.optionalKeys).toEqual(
      new Set(["id", "usage", "datetime_utc"]),
    );
  });
});

// ---- to_dict output conforms to the spec ----------------------------

describe("TestPartRoundTrip", () => {
  test("test_text_part_matches", () => {
    const d = new TextPart({ text: "hello" }).toDict();
    validatePartDictAs(d, TextPartDictSpec);
  });

  test("test_text_part_with_provider_metadata_matches", () => {
    const d = new TextPart({
      text: "hi",
      provider_metadata: { anthropic: { cached: true } },
    }).toDict();
    validatePartDictAs(d, TextPartDictSpec);
  });

  test("test_reasoning_part_redacted_matches", () => {
    const d = new ReasoningPart({ text: "", redacted: true }).toDict();
    validatePartDictAs(d, ReasoningPartDictSpec);
  });

  test("test_reasoning_part_with_signature_matches", () => {
    const d = new ReasoningPart({
      text: "thinking...",
      provider_metadata: { anthropic: { signature: "sig-abc" } },
    }).toDict();
    validatePartDictAs(d, ReasoningPartDictSpec);
  });

  test("test_tool_call_part_matches", () => {
    const d = new ToolCallPart({
      name: "search",
      arguments: { q: "x" },
      tool_call_id: "c1",
    }).toDict();
    validatePartDictAs(d, ToolCallPartDictSpec);
  });

  test("test_tool_result_part_matches", () => {
    const d = new ToolResultPart({
      name: "search",
      output: "result",
      tool_call_id: "c1",
    }).toDict();
    validatePartDictAs(d, ToolResultPartDictSpec);
  });

  test("test_attachment_part_with_url_matches", () => {
    const att = new llm.Attachment({
      type: "image/jpeg",
      url: "https://example.com/cat.jpg",
    });
    const d = new AttachmentPart({ attachment: att }).toDict();
    validatePartDictAs(d, AttachmentPartDictSpec);
  });

  test("test_attachment_part_with_bytes_matches", () => {
    const att = new llm.Attachment({
      type: "image/png",
      content: new TextEncoder().encode("\x89PNG..."),
    });
    const d = new AttachmentPart({ attachment: att }).toDict();
    validatePartDictAs(d, AttachmentPartDictSpec);
  });
});

describe("TestPartDiscriminatedUnion", () => {
  test("test_text_part_validates_as_part_dict", () => {
    const d = new TextPart({ text: "hi" }).toDict();
    validatePartDict(d);
  });

  test("test_reasoning_part_validates_as_part_dict", () => {
    const d = new ReasoningPart({ text: "thinking" }).toDict();
    validatePartDict(d);
  });

  test("test_tool_call_part_validates_as_part_dict", () => {
    const d = new ToolCallPart({
      name: "t",
      arguments: {},
      tool_call_id: "c1",
    }).toDict();
    validatePartDict(d);
  });

  test("test_tool_result_part_validates_as_part_dict", () => {
    const d = new ToolResultPart({
      name: "t",
      output: "out",
      tool_call_id: "c1",
    }).toDict();
    validatePartDict(d);
  });

  test("test_attachment_part_validates_as_part_dict", () => {
    const att = new llm.Attachment({ type: "image/jpeg", url: "http://x" });
    const d = new AttachmentPart({ attachment: att }).toDict();
    validatePartDict(d);
  });

  test("test_unknown_type_rejected", () => {
    expect(() =>
      validatePartDict({ type: "nonsense", text: "x" }),
    ).toThrowError();
  });
});

describe("TestMessageDictRoundTrip", () => {
  test("test_user_message_matches", () => {
    const d = user("hi").toDict();
    validateMessageDict(d);
  });

  test("test_assistant_with_mixed_parts_matches", () => {
    const m = new Message({
      role: "assistant",
      parts: [
        new ReasoningPart({
          text: "thinking",
          provider_metadata: { anthropic: { signature: "s" } },
        }),
        new TextPart({ text: "answer" }),
        new ToolCallPart({
          name: "search",
          arguments: { q: "x" },
          tool_call_id: "c1",
        }),
      ],
    });
    validateMessageDict(m.toDict());
  });

  test("test_tool_role_message_with_results_matches", () => {
    const m = tool_message(
      new ToolResultPart({ name: "s", output: "r", tool_call_id: "c1" }),
    );
    validateMessageDict(m.toDict());
  });
});

describe("TestResponseDictRoundTrip", () => {
  test("test_mock_response_to_dict_matches", () => {
    const mockModel = env.mockModel;
    mockModel.enqueue(["answer"]);
    const r = mockModel.prompt("q");
    r.text();

    const d = r.toDict();
    validateResponseDict(d);
  });

  test("test_response_with_reasoning_matches", () => {
    const mockModel = env.mockModel;
    mockModel.enqueue([
      new StreamEvent({
        type: "reasoning",
        chunk: "thinking",
        part_index: 0,
        provider_metadata: { anthropic: { signature: "s" } },
      }),
      new StreamEvent({ type: "text", chunk: "answer", part_index: 1 }),
    ]);
    const r = mockModel.prompt("q");
    r.text();

    const d = r.toDict();
    validateResponseDict(d);
  });

  test("test_response_with_options_matches", () => {
    const mockModel = env.mockModel;
    mockModel.enqueue(["ok"]);
    const r = mockModel.prompt("q", { max_tokens: 42 });
    r.text();

    const d = r.toDict();
    validateResponseDict(d);
    expect(d.prompt.options).toEqual({ max_tokens: 42 });
  });
});

// ---- Literal discriminators ----------------------------------------

describe("TestLiteralDiscriminators", () => {
  test("test_text_part_literal_is_text", () => {
    expect(TextPartDictSpec.typeLiteral).toBe("text");
  });

  test("test_reasoning_part_literal_is_reasoning", () => {
    expect(ReasoningPartDictSpec.typeLiteral).toBe("reasoning");
  });

  test("test_tool_call_part_literal_is_tool_call", () => {
    expect(ToolCallPartDictSpec.typeLiteral).toBe("tool_call");
  });

  test("test_tool_result_part_literal_is_tool_result", () => {
    expect(ToolResultPartDictSpec.typeLiteral).toBe("tool_result");
  });

  test("test_attachment_part_literal_is_attachment", () => {
    expect(AttachmentPartDictSpec.typeLiteral).toBe("attachment");
  });
});

// ---- to_dict / from_dict return-type annotations -------------------
//
// Python inspects runtime annotations; the TS equivalent is the static
// return type of toDict(), which tsc enforces on these assignments.
// The runtime test just confirms the functions exist.

describe("TestAnnotations", () => {
  test("test_to_dict_annotations (compile-time)", () => {
    const textDict: TextPartDict = new TextPart({ text: "x" }).toDict();
    const reasoningDict: ReasoningPartDict = new ReasoningPart({
      text: "x",
    }).toDict();
    const toolCallDict: ToolCallPartDict = new ToolCallPart({
      name: "t",
      arguments: {},
    }).toDict();
    const toolResultDict: ToolResultPartDict = new ToolResultPart({
      name: "t",
      output: "o",
    }).toDict();
    const attachmentDict: AttachmentPartDict = new AttachmentPart({
      attachment: new llm.Attachment({ type: "image/png", url: "http://x" }),
    }).toDict();
    const messageDict: MessageDict = user("hi").toDict();
    for (const d of [
      textDict,
      reasoningDict,
      toolCallDict,
      toolResultDict,
      attachmentDict,
      messageDict,
    ]) {
      expect(d).toBeTruthy();
    }
  });

  test("test_message_from_dict_annotation", () => {
    // Message.fromDict accepts a MessageDict.
    const d: MessageDict = user("hi").toDict();
    const m = Message.fromDict(d);
    expect(m).toBeInstanceOf(Message);
  });

  test("test_response_to_dict_annotation", () => {
    const mockModel = env.mockModel;
    mockModel.enqueue(["a"]);
    const r = mockModel.prompt("q");
    r.text();
    const d: ResponseDict = r.toDict();
    expect(d.model).toBe("mock");
  });
});

// ---- End-to-end JSON round-trip validates against schema -----------

describe("TestEndToEnd", () => {
  test("test_json_roundtrip_validates", () => {
    const mockModel = env.mockModel;
    mockModel.enqueue(["text answer"]);
    const r = mockModel.prompt("q");
    r.text();

    const payload = JSON.stringify(r.toDict());
    const parsed = JSON.parse(payload);
    validateResponseDict(parsed);
  });
});

// ---- to_dict() must not emit keys absent from the spec --------------

function allowed(spec: DictSpec): Set<string> {
  return new Set([...spec.requiredKeys, ...spec.optionalKeys]);
}

function expectSubset(keys: string[], spec: DictSpec): void {
  const allow = allowed(spec);
  for (const key of keys) {
    expect(allow.has(key), `undeclared key: ${key}`).toBe(true);
  }
}

describe("TestNoUndeclaredKeys", () => {
  test("test_text_part_keys", () => {
    const d = new TextPart({
      text: "hi",
      provider_metadata: { k: "v" },
    }).toDict();
    expectSubset(Object.keys(d), TextPartDictSpec);
  });

  test("test_reasoning_part_keys", () => {
    const d = new ReasoningPart({
      text: "t",
      redacted: true,
      provider_metadata: { k: "v" },
    }).toDict();
    expectSubset(Object.keys(d), ReasoningPartDictSpec);
  });

  test("test_tool_call_part_keys", () => {
    const d = new ToolCallPart({
      name: "t",
      arguments: { q: "x" },
      tool_call_id: "c1",
      server_executed: true,
      provider_metadata: { k: "v" },
    }).toDict();
    expectSubset(Object.keys(d), ToolCallPartDictSpec);
  });

  test("test_tool_result_part_keys", () => {
    const d = new ToolResultPart({
      name: "t",
      output: "r",
      tool_call_id: "c1",
      server_executed: true,
      exception: "boom",
      attachments: [
        new llm.Attachment({ type: "image/png", url: "http://x/y.png" }),
      ],
      provider_metadata: { k: "v" },
    }).toDict();
    expectSubset(Object.keys(d), ToolResultPartDictSpec);
  });

  test("test_attachment_part_keys", () => {
    const d = new AttachmentPart({
      attachment: new llm.Attachment({
        type: "image/png",
        url: "http://x/y.png",
      }),
      provider_metadata: { k: "v" },
    }).toDict();
    expectSubset(Object.keys(d), AttachmentPartDictSpec);
  });

  test("test_message_keys", () => {
    const d = new Message({
      role: "assistant",
      parts: [new TextPart({ text: "hi" })],
      provider_metadata: { k: "v" },
    }).toDict();
    expectSubset(Object.keys(d), MessageDictSpec);
  });

  test("test_response_keys", () => {
    const mockModel = env.mockModel;
    mockModel.enqueue(["answer"]);
    const r = mockModel.prompt("q", { max_tokens: 10 });
    r.text();
    const d = r.toDict();
    expectSubset(Object.keys(d), ResponseDictSpec);
    expectSubset(Object.keys(d.prompt), PromptDictSpec);
  });
});
