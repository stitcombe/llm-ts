/**
 * Port of tests/test_parts.py — Part/Message/StreamEvent value types,
 * stream-event assembly, prompt.messages invariants, reply(), chain(),
 * and serialization round-trips.
 *
 * Python `restored == part` becomes `expect(restored).toEqual(part)`
 * (deep structural equality) plus toBeInstanceOf where the Python test
 * asserts isinstance.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as path from "node:path";
import * as llm from "../src/index.js";
import {
  AttachmentPart,
  Message,
  Part,
  ReasoningPart,
  StreamEvent,
  TextPart,
  ToolCallPart,
  ToolResultPart,
  assistant,
  system,
  tool_message,
  user,
} from "../src/parts.js";
import {
  AsyncConversation,
  AsyncResponse,
  Conversation,
  Prompt,
  Response,
  ToolCall,
  ToolResult,
} from "../src/models.js";
import { Database } from "../src/sqliteUtils.js";
import { migrate } from "../src/migrations.js";
import { loadConversation } from "../src/cli.js";
import {
  AsyncMockModel,
  MockModel,
  setupTestEnvironment,
  type TestEnv,
} from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

describe("TestTextPart", () => {
  test("test_roundtrip", () => {
    const part = new TextPart({ text: "Hello world" });
    const restored = Part.fromDict(part.toDict());
    expect(restored).toEqual(part);
    expect(restored).toBeInstanceOf(TextPart);
    expect((restored as TextPart).text).toBe("Hello world");
  });

  test("test_to_dict_shape", () => {
    expect(new TextPart({ text: "hi" }).toDict()).toEqual({
      type: "text",
      text: "hi",
    });
  });

  test("test_with_provider_metadata", () => {
    const part = new TextPart({
      text: "hi",
      provider_metadata: { openai: { flag: true } },
    });
    const restored = Part.fromDict(part.toDict());
    expect(restored).toEqual(part);
  });
});

describe("TestReasoningPart", () => {
  test("test_roundtrip_with_text", () => {
    const part = new ReasoningPart({ text: "Let me think..." });
    const restored = Part.fromDict(part.toDict()) as ReasoningPart;
    expect(restored).toEqual(part);
    expect(restored.text).toBe("Let me think...");
    expect(restored.redacted).toBe(false);
  });

  test("test_roundtrip_redacted", () => {
    const part = new ReasoningPart({ text: "", redacted: true });
    const d = part.toDict();
    expect(d.redacted).toBe(true);
    expect(d).not.toHaveProperty("token_count");
    const restored = Part.fromDict(d);
    expect(restored).toEqual(part);
  });

  test("test_no_token_count_field", () => {
    // token_count was removed: opaque token totals live on
    // response.token_details, not on the Part.
    expect(
      () =>
        new ReasoningPart({
          text: "",
          redacted: true,
          token_count: 150,
        } as never),
    ).toThrowError(TypeError);
  });
});

describe("TestToolCallPart", () => {
  test("test_roundtrip", () => {
    const part = new ToolCallPart({
      name: "search",
      arguments: { query: "weather" },
      tool_call_id: "call_123",
    });
    const restored = Part.fromDict(part.toDict()) as ToolCallPart;
    expect(restored).toEqual(part);
    expect(restored.server_executed).toBe(false);
  });

  test("test_server_executed_flag_roundtrips", () => {
    const part = new ToolCallPart({
      name: "web_search",
      arguments: { q: "x" },
      tool_call_id: "c1",
      server_executed: true,
    });
    const d = part.toDict();
    expect(d.server_executed).toBe(true);
    const restored = Part.fromDict(d) as ToolCallPart;
    expect(restored.server_executed).toBe(true);
  });
});

describe("TestToolResultPart", () => {
  test("test_roundtrip", () => {
    const part = new ToolResultPart({
      name: "search",
      output: "72F sunny",
      tool_call_id: "c1",
    });
    const restored = Part.fromDict(part.toDict()) as ToolResultPart;
    expect(restored).toEqual(part);
    expect(restored.exception).toBeNull();
    expect(restored.attachments).toEqual([]);
  });

  test("test_with_exception", () => {
    const part = new ToolResultPart({
      name: "t",
      output: "",
      tool_call_id: "c1",
      exception: "boom",
    });
    const restored = Part.fromDict(part.toDict()) as ToolResultPart;
    expect(restored.exception).toBe("boom");
  });
});

describe("TestAttachmentPart", () => {
  test("test_roundtrip_with_url", () => {
    const att = new llm.Attachment({ url: "http://example.com/cat.jpg" });
    const part = new AttachmentPart({ attachment: att });
    const restored = Part.fromDict(part.toDict()) as AttachmentPart;
    expect(restored).toBeInstanceOf(AttachmentPart);
    expect(restored.attachment!.url).toBe("http://example.com/cat.jpg");
  });

  test("test_roundtrip_with_path", () => {
    const att = new llm.Attachment({ type: "image/jpeg", path: "/tmp/x.jpg" });
    const part = new AttachmentPart({ attachment: att });
    const restored = Part.fromDict(part.toDict()) as AttachmentPart;
    expect(restored.attachment!.path).toBe("/tmp/x.jpg");
    expect(restored.attachment!.type).toBe("image/jpeg");
  });

  test("test_roundtrip_with_bytes_uses_base64", () => {
    const raw = Buffer.from("\x89PNG fake bytes", "latin1");
    const att = new llm.Attachment({ type: "image/png", content: raw });
    const part = new AttachmentPart({ attachment: att });
    const d = part.toDict();
    // Content must be a base64-encoded string in the dict form
    expect(typeof d.attachment!.content).toBe("string");
    expect(Buffer.from(d.attachment!.content!, "base64")).toEqual(raw);
    // And round-trip back to the original bytes
    const restored = Part.fromDict(d) as AttachmentPart;
    expect(Buffer.from(restored.attachment!.content!)).toEqual(raw);
  });

  test("test_json_serializable", () => {
    const raw = new Uint8Array([0, 1, 2]);
    const att = new llm.Attachment({ type: "image/png", content: raw });
    const part = new AttachmentPart({ attachment: att });
    // Must survive json dumps/loads
    const restored = Part.fromDict(
      JSON.parse(JSON.stringify(part.toDict())),
    ) as AttachmentPart;
    expect(new Uint8Array(restored.attachment!.content!)).toEqual(raw);
  });
});

describe("TestUnknownPart", () => {
  test("test_from_dict_unknown_type_raises", () => {
    expect(() => Part.fromDict({ type: "nonsense" } as never)).toThrowError();
  });
});

describe("TestRoleNotOnPart", () => {
  test("test_text_part_has_no_role_attribute", () => {
    // Role lives on Message. Parts are content-only.
    const part = new TextPart({ text: "hi" });
    expect("role" in part).toBe(false);
  });

  test("test_reasoning_part_has_no_role_attribute", () => {
    expect("role" in new ReasoningPart({ text: "" })).toBe(false);
  });

  test("test_tool_call_part_has_no_role_attribute", () => {
    expect(
      "role" in
        new ToolCallPart({ name: "t", arguments: {}, tool_call_id: "c1" }),
    ).toBe(false);
  });
});

describe("TestMessage", () => {
  test("test_roundtrip_simple_user_message", () => {
    const m = new Message({
      role: "user",
      parts: [new TextPart({ text: "hi" })],
    });
    const restored = Message.fromDict(m.toDict());
    expect(restored).toEqual(m);
  });

  test("test_roundtrip_with_provider_metadata", () => {
    const m = new Message({
      role: "assistant",
      parts: [new TextPart({ text: "hi" })],
      provider_metadata: { anthropic: { signature: "abc" } },
    });
    const restored = Message.fromDict(m.toDict());
    expect(restored).toEqual(m);
  });

  test("test_roundtrip_mixed_parts", () => {
    const m = new Message({
      role: "assistant",
      parts: [
        new ReasoningPart({ text: "Thinking" }),
        new TextPart({ text: "Result" }),
        new ToolCallPart({
          name: "search",
          arguments: { q: "x" },
          tool_call_id: "c1",
        }),
      ],
    });
    const restored = Message.fromDict(m.toDict());
    expect(restored).toEqual(m);
  });

  test("test_empty_provider_metadata_omitted", () => {
    const m = new Message({
      role: "user",
      parts: [new TextPart({ text: "x" })],
    });
    const d = m.toDict();
    expect(d).not.toHaveProperty("provider_metadata");
  });

  test("test_none_and_empty_provider_metadata_equivalent", () => {
    const mNone = new Message({
      role: "user",
      parts: [new TextPart({ text: "x" })],
    });
    const mEmpty = new Message({
      role: "user",
      parts: [new TextPart({ text: "x" })],
      provider_metadata: {},
    });
    // Both serialize the same (empty metadata is omitted)
    expect(mNone.toDict()).toEqual(mEmpty.toDict());
  });
});

describe("TestHelpers", () => {
  test("test_user_with_string", () => {
    const m = user("hi");
    expect(m.role).toBe("user");
    expect(m.parts).toEqual([new TextPart({ text: "hi" })]);
  });

  test("test_assistant_with_string", () => {
    const m = assistant("there");
    expect(m.role).toBe("assistant");
    expect(m.parts).toEqual([new TextPart({ text: "there" })]);
  });

  test("test_system_with_string", () => {
    const m = system("be brief");
    expect(m.role).toBe("system");
    expect(m.parts).toEqual([new TextPart({ text: "be brief" })]);
  });

  test("test_tool_message_with_part", () => {
    const tr = new ToolResultPart({
      name: "t",
      output: "r",
      tool_call_id: "c1",
    });
    const m = tool_message(tr);
    expect(m.role).toBe("tool");
    expect(m.parts).toEqual([tr]);
  });

  test("test_helper_accepts_attachment", () => {
    const att = new llm.Attachment({ url: "http://example.com/x.jpg" });
    const m = user("describe this", att);
    expect(m.parts).toEqual([
      new TextPart({ text: "describe this" }),
      new AttachmentPart({ attachment: att }),
    ]);
  });

  test("test_helper_accepts_existing_part", () => {
    const tp = new TextPart({ text: "pre-built" });
    const m = user(tp);
    expect(m.parts).toEqual([tp]);
  });

  test("test_helper_flattens_one_level", () => {
    // Nested list gets flattened one level.
    const m = user(["one", "two"], "three");
    expect(m.parts).toEqual([
      new TextPart({ text: "one" }),
      new TextPart({ text: "two" }),
      new TextPart({ text: "three" }),
    ]);
  });

  test("test_helper_rejects_unknown_types", () => {
    expect(() => user(42 as never)).toThrowError(TypeError);
  });

  test("test_helper_with_provider_metadata", () => {
    const m = assistant("hi", { provider_metadata: { openai: { id: "x" } } });
    expect(m.provider_metadata).toEqual({ openai: { id: "x" } });
  });
});

describe("TestStreamEvent", () => {
  test("test_dataclass_defaults", () => {
    const ev = new StreamEvent({ type: "text", chunk: "hi", part_index: 0 });
    expect(ev.type).toBe("text");
    expect(ev.chunk).toBe("hi");
    expect(ev.part_index).toBe(0);
    expect(ev.tool_call_id).toBeNull();
    expect(ev.server_executed).toBe(false);
    expect(ev.tool_name).toBeNull();
    expect(ev.provider_metadata).toBeNull();
    expect(ev.message_index).toBe(0);
  });

  test("test_all_fields_accepted", () => {
    const ev = new StreamEvent({
      type: "tool_call_args",
      chunk: '{"q":',
      part_index: 2,
      tool_call_id: "c1",
      server_executed: true,
      tool_name: "search",
      provider_metadata: { openai: { x: 1 } },
      message_index: 1,
    });
    expect(ev.tool_call_id).toBe("c1");
    expect(ev.server_executed).toBe(true);
    expect(ev.tool_name).toBe("search");
    expect(ev.provider_metadata).toEqual({ openai: { x: 1 } });
    expect(ev.message_index).toBe(1);
  });
});

// Backward compat for plain-str plugins: iterating a Response still
// yields text strings, response.text() still works, self._chunks is
// still populated.

describe("TestPlainStrPluginCompat", () => {
  test("test_iter_yields_strings", () => {
    env.mockModel.enqueue(["hello", " ", "world"]);
    const response = env.mockModel.prompt("hi");
    const chunks = [...response];
    expect(chunks).toEqual(["hello", " ", "world"]);
  });

  test("test_text_returns_concatenation", () => {
    env.mockModel.enqueue(["hello ", "world"]);
    const response = env.mockModel.prompt("hi");
    expect(response.text()).toBe("hello world");
  });

  test("test_chunks_are_preserved", () => {
    env.mockModel.enqueue(["a", "b", "c"]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response._chunks).toEqual(["a", "b", "c"]);
  });
});

describe("TestStreamEventsFromPlainStrPlugin", () => {
  test("test_stream_events_yields_text_events", () => {
    env.mockModel.enqueue(["hel", "lo"]);
    const response = env.mockModel.prompt("hi");
    const events = [...response.stream_events()];
    for (const e of events) {
      expect(e).toBeInstanceOf(StreamEvent);
    }
    expect(events.map((e) => e.type)).toEqual(["text", "text"]);
    expect(events.map((e) => e.chunk)).toEqual(["hel", "lo"]);
    for (const e of events) {
      expect(e.part_index).toBe(0);
    }
  });

  test("test_response_messages_is_single_assistant_text", () => {
    env.mockModel.enqueue(["hello"]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()).toEqual([
      new Message({
        role: "assistant",
        parts: [new TextPart({ text: "hello" })],
      }),
    ]);
  });

  test("test_empty_response_has_empty_messages", () => {
    env.mockModel.enqueue([]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()).toEqual([]);
  });
});

describe("TestStreamEventsFromStreamEventPlugin", () => {
  test("test_iter_yields_only_text_chunks", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "think ", part_index: 0 }),
      new StreamEvent({ type: "text", chunk: "hel", part_index: 1 }),
      new StreamEvent({ type: "text", chunk: "lo", part_index: 1 }),
    ]);
    const response = env.mockModel.prompt("hi");
    const chunks = [...response];
    expect(chunks).toEqual(["hel", "lo"]);
  });

  test("test_stream_events_yields_all_events", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "t", part_index: 0 }),
      new StreamEvent({ type: "text", chunk: "x", part_index: 1 }),
    ]);
    const response = env.mockModel.prompt("hi");
    const got = [...response.stream_events()];
    expect(got.map((e) => e.type)).toEqual(["reasoning", "text"]);
  });

  test("test_messages_assembles_reasoning_then_text", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "thinking", part_index: 0 }),
      new StreamEvent({ type: "text", chunk: "hello", part_index: 1 }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()).toEqual([
      new Message({
        role: "assistant",
        parts: [
          new ReasoningPart({ text: "thinking" }),
          new TextPart({ text: "hello" }),
        ],
      }),
    ]);
  });

  test("test_tool_call_name_and_args_merge", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "calling", part_index: 0 }),
      new StreamEvent({
        type: "tool_call_name",
        chunk: "search",
        part_index: 1,
        tool_call_id: "c1",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: '{"q":',
        part_index: 1,
        tool_call_id: "c1",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: '"weather"}',
        part_index: 1,
        tool_call_id: "c1",
      }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    const msgs = response.messages();
    expect(msgs.length).toBe(1);
    expect(msgs[0].parts).toEqual([
      new TextPart({ text: "calling" }),
      new ToolCallPart({
        name: "search",
        arguments: { q: "weather" },
        tool_call_id: "c1",
      }),
    ]);
  });

  test("test_tool_call_args_unparseable_json_falls_back", () => {
    env.mockModel.enqueue([
      new StreamEvent({
        type: "tool_call_name",
        chunk: "t",
        part_index: 0,
        tool_call_id: "c1",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: "not json",
        part_index: 0,
        tool_call_id: "c1",
      }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    const part = response.messages()[0].parts[0] as ToolCallPart;
    expect(part.name).toBe("t");
    expect(part.arguments).toEqual({ _raw: "not json" });
  });

  test("test_family_mismatch_at_same_part_index_raises", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "x", part_index: 0 }),
      new StreamEvent({
        type: "tool_call_name",
        chunk: "t",
        part_index: 0,
        tool_call_id: "c1",
      }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(() => response.messages()).toThrowError(/part_index/);
  });

  test("test_provider_metadata_merges_last_wins", () => {
    env.mockModel.enqueue([
      new StreamEvent({
        type: "reasoning",
        chunk: "think",
        part_index: 0,
        provider_metadata: { anthropic: { signature: "one" } },
      }),
      new StreamEvent({
        type: "reasoning",
        chunk: "",
        part_index: 0,
        provider_metadata: { anthropic: { signature: "final" } },
      }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    const part = response.messages()[0].parts[0];
    expect(part.provider_metadata).toEqual({
      anthropic: { signature: "final" },
    });
  });

  test("test_redacted_reasoning_event_emits_marker_part", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "", redacted: true }),
      new StreamEvent({ type: "text", chunk: "hi" }),
    ]);
    const response = env.mockModel.prompt("x");
    response.text();
    const parts = response.messages()[0].parts;
    expect(parts).toEqual([
      new ReasoningPart({ text: "", redacted: true }),
      new TextPart({ text: "hi" }),
    ]);
  });

  test("test_redacted_reasoning_hoisted_to_start_when_emitted_late", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "hello" }),
      new StreamEvent({ type: "reasoning", chunk: "", redacted: true }),
    ]);
    const response = env.mockModel.prompt("x");
    response.text();
    const parts = response.messages()[0].parts;
    expect(parts).toEqual([
      new ReasoningPart({ text: "", redacted: true }),
      new TextPart({ text: "hello" }),
    ]);
  });

  test("test_redacted_reasoning_event_default_redacted_is_false", () => {
    const ev = new StreamEvent({ type: "reasoning", chunk: "thinking" });
    expect(ev.redacted).toBe(false);
  });
});

describe("TestPartIndexAutoAllocation", () => {
  test("test_streamevent_part_index_defaults_to_none", () => {
    const ev = new StreamEvent({ type: "text", chunk: "hi" });
    expect(ev.part_index).toBeNull();
  });

  test("test_consecutive_text_concatenates_into_one_part", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "hello " }),
      new StreamEvent({ type: "text", chunk: "world" }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new TextPart({ text: "hello world" }),
    ]);
  });

  test("test_text_then_reasoning_splits_into_two_parts", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "hello" }),
      new StreamEvent({ type: "reasoning", chunk: "thinking" }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new TextPart({ text: "hello" }),
      new ReasoningPart({ text: "thinking" }),
    ]);
  });

  test("test_text_tool_call_text_produces_three_parts", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "before" }),
      new StreamEvent({
        type: "tool_call_name",
        chunk: "search",
        tool_call_id: "c1",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: '{"q": "x"}',
        tool_call_id: "c1",
      }),
      new StreamEvent({ type: "text", chunk: "after" }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new TextPart({ text: "before" }),
      new ToolCallPart({
        name: "search",
        arguments: { q: "x" },
        tool_call_id: "c1",
      }),
      new TextPart({ text: "after" }),
    ]);
  });

  test("test_tool_call_groups_by_tool_call_id", () => {
    env.mockModel.enqueue([
      new StreamEvent({
        type: "tool_call_name",
        chunk: "search",
        tool_call_id: "c1",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: '{"q":',
        tool_call_id: "c1",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: '"weather"}',
        tool_call_id: "c1",
      }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new ToolCallPart({
        name: "search",
        arguments: { q: "weather" },
        tool_call_id: "c1",
      }),
    ]);
  });

  test("test_parallel_tool_calls_interleaved_by_id", () => {
    env.mockModel.enqueue([
      new StreamEvent({
        type: "tool_call_name",
        chunk: "search",
        tool_call_id: "A",
      }),
      new StreamEvent({
        type: "tool_call_name",
        chunk: "lookup",
        tool_call_id: "B",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: '{"q":"a"}',
        tool_call_id: "A",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: '{"k":"b"}',
        tool_call_id: "B",
      }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new ToolCallPart({
        name: "search",
        arguments: { q: "a" },
        tool_call_id: "A",
      }),
      new ToolCallPart({
        name: "lookup",
        arguments: { k: "b" },
        tool_call_id: "B",
      }),
    ]);
  });

  test("test_tool_result_is_always_own_part", () => {
    env.mockModel.enqueue([
      new StreamEvent({
        type: "tool_call_name",
        chunk: "web_search",
        tool_call_id: "c1",
        server_executed: true,
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: '{"q":"x"}',
        tool_call_id: "c1",
        server_executed: true,
      }),
      new StreamEvent({
        type: "tool_result",
        chunk: "results...",
        tool_call_id: "c1",
        tool_name: "web_search",
        server_executed: true,
      }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new ToolCallPart({
        name: "web_search",
        arguments: { q: "x" },
        tool_call_id: "c1",
        server_executed: true,
      }),
      new ToolResultPart({
        name: "web_search",
        output: "results...",
        tool_call_id: "c1",
        server_executed: true,
      }),
    ]);
  });

  test("test_two_reasoning_blocks_split_by_tool_call", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "first" }),
      new StreamEvent({
        type: "tool_call_name",
        chunk: "t",
        tool_call_id: "c1",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: "{}",
        tool_call_id: "c1",
      }),
      new StreamEvent({ type: "reasoning", chunk: "second" }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new ReasoningPart({ text: "first" }),
      new ToolCallPart({ name: "t", arguments: {}, tool_call_id: "c1" }),
      new ReasoningPart({ text: "second" }),
    ]);
  });

  test("test_parallel_tool_calls_without_id_each_get_own_part", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "tool_call_name", chunk: "store_fact" }),
      new StreamEvent({ type: "tool_call_args", chunk: '{"fact":"a"}' }),
      new StreamEvent({ type: "tool_call_name", chunk: "store_fact" }),
      new StreamEvent({ type: "tool_call_args", chunk: '{"fact":"b"}' }),
      new StreamEvent({ type: "tool_call_name", chunk: "store_fact" }),
      new StreamEvent({ type: "tool_call_args", chunk: '{"fact":"c"}' }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new ToolCallPart({ name: "store_fact", arguments: { fact: "a" } }),
      new ToolCallPart({ name: "store_fact", arguments: { fact: "b" } }),
      new ToolCallPart({ name: "store_fact", arguments: { fact: "c" } }),
    ]);
  });

  test("test_explicit_part_index_still_works", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "t", part_index: 0 }),
      new StreamEvent({ type: "text", chunk: "hi", part_index: 1 }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new ReasoningPart({ text: "t" }),
      new TextPart({ text: "hi" }),
    ]);
  });

  test("test_mix_explicit_zero_and_none_for_text_concatenates", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "before ", part_index: 0 }),
      new StreamEvent({
        type: "tool_call_name",
        chunk: "t",
        tool_call_id: "c1",
      }),
      new StreamEvent({
        type: "tool_call_args",
        chunk: "{}",
        tool_call_id: "c1",
      }),
      new StreamEvent({ type: "text", chunk: "after", part_index: 0 }),
    ]);
    const response = env.mockModel.prompt("hi");
    response.text();
    expect(response.messages()[0].parts).toEqual([
      new TextPart({ text: "before after" }),
      new ToolCallPart({ name: "t", arguments: {}, tool_call_id: "c1" }),
    ]);
  });
});

describe("TestStreamEventsLiveDuringStreaming", () => {
  test("test_events_arrive_before_done", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "t", part_index: 0 }),
      new StreamEvent({ type: "text", chunk: "hi", part_index: 1 }),
    ]);
    const response = env.mockModel.prompt("x");
    const seen: Array<[string, boolean]> = [];
    for (const event of response.stream_events()) {
      // Record the _done state at the moment we receive the event.
      seen.push([event.type, response._done]);
    }
    // Events arrived before _done was set.
    expect(seen.map((s) => s[0])).toEqual(["reasoning", "text"]);
    expect(seen.every(([, done]) => !done)).toBe(true);
    // And after the generator is drained, the response is done.
    expect(response._done).toBe(true);
  });

  test("test_stream_events_after_done_replays", () => {
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "hi", part_index: 0 }),
    ]);
    const response = env.mockModel.prompt("x");
    const first = [...response.stream_events()];
    // Second call replays from the stored events.
    const second = [...response.stream_events()];
    expect(first.length).toBe(1);
    expect(second.map((e) => e.type)).toEqual(["text"]);
    expect(second.map((e) => e.chunk)).toEqual(["hi"]);
  });

  test("test_plain_str_stream_events_after_done_replays", () => {
    env.mockModel.enqueue(["hello"]);
    const response = env.mockModel.prompt("x");
    response.text();
    const events = [...response.stream_events()];
    expect(events.length).toBe(1);
    expect(events[0].type).toBe("text");
    expect(events[0].chunk).toBe("hello");
  });
});

describe("TestAsyncStreamEvents", () => {
  test("test_async_stream_events_live", async () => {
    env.asyncMockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "r", part_index: 0 }),
      new StreamEvent({ type: "text", chunk: "t", part_index: 1 }),
    ]);
    const response = env.asyncMockModel.prompt("x");
    const seenTypes: string[] = [];
    for await (const event of response.astream_events()) {
      seenTypes.push(event.type);
    }
    expect(seenTypes).toEqual(["reasoning", "text"]);
  });

  test("test_async_iter_yields_only_text", async () => {
    env.asyncMockModel.enqueue([
      new StreamEvent({ type: "reasoning", chunk: "r", part_index: 0 }),
      new StreamEvent({ type: "text", chunk: "hi", part_index: 1 }),
    ]);
    const response = env.asyncMockModel.prompt("x");
    const chunks: string[] = [];
    for await (const chunk of response) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["hi"]);
  });

  test("test_async_messages_after_await", async () => {
    env.asyncMockModel.enqueue(["hi"]);
    const response = env.asyncMockModel.prompt("x");
    await response.text();
    expect(await response.messages()).toEqual([
      new Message({ role: "assistant", parts: [new TextPart({ text: "hi" })] }),
    ]);
  });
});

describe("TestMessagesIsCallable", () => {
  test("test_sync_messages_is_callable_and_returns_list", () => {
    env.mockModel.enqueue(["hi"]);
    const response = env.mockModel.prompt("x");
    // No prior .text() or iteration — calling messages() forces
    // execution and returns the assembled list.
    expect(response.messages()).toEqual([
      new Message({ role: "assistant", parts: [new TextPart({ text: "hi" })] }),
    ]);
  });

  test("test_sync_messages_after_text_returns_same_list", () => {
    env.mockModel.enqueue(["hi"]);
    const response = env.mockModel.prompt("x");
    response.text();
    expect(response.messages()).toEqual([
      new Message({ role: "assistant", parts: [new TextPart({ text: "hi" })] }),
    ]);
  });

  test("test_async_messages_is_awaitable", async () => {
    env.asyncMockModel.enqueue(["hi"]);
    const response = env.asyncMockModel.prompt("x");
    // No prior await — `await response.messages()` forces it.
    const result = await response.messages();
    expect(result).toEqual([
      new Message({ role: "assistant", parts: [new TextPart({ text: "hi" })] }),
    ]);
  });

  test("test_async_messages_after_text_returns_same_list", async () => {
    env.asyncMockModel.enqueue(["hi"]);
    const response = env.asyncMockModel.prompt("x");
    await response.text();
    const result = await response.messages();
    expect(result).toEqual([
      new Message({ role: "assistant", parts: [new TextPart({ text: "hi" })] }),
    ]);
  });
});

describe("TestPromptMessagesSynthesis", () => {
  test("test_empty_prompt_yields_empty_messages", () => {
    const p = new Prompt(null, env.mockModel);
    expect(p.messages).toEqual([]);
  });

  test("test_prompt_text_synthesizes_user_message", () => {
    const p = new Prompt("hi", env.mockModel);
    expect(p.messages).toEqual([
      new Message({ role: "user", parts: [new TextPart({ text: "hi" })] }),
    ]);
  });

  test("test_system_and_prompt_synthesizes_two_messages", () => {
    const p = new Prompt("hi", env.mockModel, { system: "be brief" });
    expect(p.messages).toEqual([
      new Message({
        role: "system",
        parts: [new TextPart({ text: "be brief" })],
      }),
      new Message({ role: "user", parts: [new TextPart({ text: "hi" })] }),
    ]);
  });

  test("test_attachments_join_user_message", () => {
    const att = new llm.Attachment({ url: "http://example.com/a.jpg" });
    const p = new Prompt("look", env.mockModel, { attachments: [att] });
    expect(p.messages).toEqual([
      new Message({
        role: "user",
        parts: [
          new TextPart({ text: "look" }),
          new AttachmentPart({ attachment: att }),
        ],
      }),
    ]);
  });

  test("test_tool_results_become_tool_role_message", () => {
    const tr = new ToolResult({ name: "t", output: "ok", tool_call_id: "c1" });
    const p = new Prompt(null, env.mockModel, { tool_results: [tr] });
    expect(p.messages).toEqual([
      new Message({
        role: "tool",
        parts: [
          new ToolResultPart({ name: "t", output: "ok", tool_call_id: "c1" }),
        ],
      }),
    ]);
  });
});

describe("TestPromptMessagesExplicit", () => {
  test("test_explicit_messages_returned_verbatim", () => {
    const explicit = [system("x"), user("y")];
    const p = new Prompt(null, env.mockModel, { messages: explicit });
    expect(p.messages).toEqual(explicit);
  });

  test("test_explicit_messages_ignores_prompt_kwarg", () => {
    const explicit = [system("x"), user("prior"), user("follow-up")];
    const p = new Prompt("ignored text", env.mockModel, {
      messages: explicit,
    });
    expect(p.messages).toEqual(explicit);
  });

  test("test_explicit_messages_independent_copy", () => {
    const explicit = [user("x")];
    const p = new Prompt(null, env.mockModel, { messages: explicit });
    explicit.push(user("later"));
    expect(p.messages).toEqual([user("x")]);
  });
});

describe("TestModelPromptMessagesKwarg", () => {
  test("test_model_prompt_accepts_messages", () => {
    env.mockModel.enqueue(["ok"]);
    const response = env.mockModel.prompt(null, { messages: [user("hi")] });
    response.text();
    expect(response.prompt.messages).toEqual([user("hi")]);
  });

  test("test_model_prompt_messages_with_system", () => {
    env.mockModel.enqueue(["ok"]);
    const response = env.mockModel.prompt(null, {
      messages: [system("be brief"), user("hi")],
    });
    response.text();
    expect(response.prompt.messages).toEqual([system("be brief"), user("hi")]);
  });

  test("test_conversation_prompt_accepts_messages", () => {
    env.mockModel.enqueue(["ok"]);
    const conv = env.mockModel.conversation();
    const response = conv.prompt(null, { messages: [user("q")] });
    response.text();
    expect(response.prompt.messages).toEqual([user("q")]);
  });

  test("test_async_model_prompt_accepts_messages", async () => {
    env.asyncMockModel.enqueue(["ok"]);
    const response = env.asyncMockModel.prompt(null, {
      messages: [user("hi")],
    });
    await response.text();
    expect(response.prompt.messages).toEqual([user("hi")]);
  });

  test("test_async_conversation_prompt_accepts_messages", async () => {
    env.asyncMockModel.enqueue(["ok"]);
    const conv = env.asyncMockModel.conversation();
    const response = conv.prompt(null, { messages: [user("q")] });
    await response.text();
    expect(response.prompt.messages).toEqual([user("q")]);
  });
});

describe("TestConversationFullChainInvariant", () => {
  test("test_explicit_messages_is_authoritative_no_prompt_combine", () => {
    env.mockModel.enqueue(["ok"]);
    const response = env.mockModel.prompt("this prompt argument is ignored", {
      messages: [user("q")],
    });
    response.text();
    expect(response.prompt.messages).toEqual([user("q")]);
  });

  test("test_conversation_second_turn_prompt_messages_has_full_chain", () => {
    env.mockModel.enqueue(["a1"]);
    env.mockModel.enqueue(["a2"]);
    const conv = env.mockModel.conversation();

    const r1 = conv.prompt("q1");
    r1.text();
    const r2 = conv.prompt("q2");
    r2.text();

    // r2 was sent the full chain.
    expect(r2.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("q2"),
    ]);
  });

  test("test_conversation_third_turn_includes_everything_before", () => {
    env.mockModel.enqueue(["a1"]);
    env.mockModel.enqueue(["a2"]);
    env.mockModel.enqueue(["a3"]);
    const conv = env.mockModel.conversation();
    const r1 = conv.prompt("q1");
    r1.text();
    const r2 = conv.prompt("q2");
    r2.text();
    const r3 = conv.prompt("q3");
    r3.text();

    expect(r3.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("q2"),
      assistant("a2"),
      user("q3"),
    ]);
  });

  test("test_conversation_first_turn_chain_is_single_user_message", () => {
    env.mockModel.enqueue(["a1"]);
    const conv = env.mockModel.conversation();
    const r1 = conv.prompt("q1");
    r1.text();
    expect(r1.prompt.messages).toEqual([user("q1")]);
  });

  test("test_conversation_preserves_reasoning_and_tool_call_parts", () => {
    env.mockModel.enqueue([
      new StreamEvent({
        type: "reasoning",
        chunk: "thinking...",
        part_index: 0,
      }),
      new StreamEvent({ type: "text", chunk: "answer", part_index: 1 }),
    ]);
    env.mockModel.enqueue(["follow-up answer"]);
    const conv = env.mockModel.conversation();
    const r1 = conv.prompt("q1");
    r1.text();
    const r2 = conv.prompt("q2");
    r2.text();

    expect(r2.prompt.messages).toEqual([
      user("q1"),
      new Message({
        role: "assistant",
        parts: [
          new ReasoningPart({ text: "thinking..." }),
          new TextPart({ text: "answer" }),
        ],
      }),
      user("q2"),
    ]);
  });

  test("test_async_conversation_full_chain", async () => {
    env.asyncMockModel.enqueue(["a1"]);
    env.asyncMockModel.enqueue(["a2"]);
    const conv = env.asyncMockModel.conversation();
    const r1 = conv.prompt("q1");
    await r1.text();
    const r2 = conv.prompt("q2");
    await r2.text();

    expect(r2.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("q2"),
    ]);
  });
});

describe("TestSqliteRehydrateMessages", () => {
  test("test_from_row_response_messages_synthesized_from_chunks", async () => {
    env.mockModel.enqueue(["answer text"]);
    const r1 = env.mockModel.prompt("q1");
    r1.text();

    const db = new Database(path.join(env.userPath, "logs-a.db"));
    migrate(db);
    await r1.logToDb(db);

    // Rehydrate the response
    const row = db.table("responses").rows[0];
    const rehydrated = await Response.fromRow(db, row);
    // _stream_events is empty (SQLite doesn't persist those), but
    // _chunks carries the text. response.messages() must fall back
    // to synthesizing a TextPart.
    expect(rehydrated._stream_events).toEqual([]);
    expect(rehydrated.messages()).toEqual([
      new Message({
        role: "assistant",
        parts: [new TextPart({ text: "answer text" })],
      }),
    ]);
  });

  test("test_llm_dash_c_chain_preserves_prior_assistant_turn", async () => {
    env.mockModel.enqueue(["first answer"]);
    env.mockModel.enqueue(["second answer"]);
    const r1 = env.mockModel.prompt("q1");
    r1.text();

    const dbPath = path.join(env.userPath, "logs-b.db");
    const db = new Database(dbPath);
    migrate(db);
    await r1.logToDb(db);

    const conv = (await loadConversation(null, false, dbPath)) as Conversation;
    const r2 = conv.prompt("q2");
    r2.text();

    expect(r2.prompt.messages).toEqual([
      user("q1"),
      assistant("first answer"),
      user("q2"),
    ]);
  });

  test("test_llm_dash_c_after_logged_tool_chain_preserves_full_chain", async () => {
    class ToolChainMock extends MockModel {
      calls = 0;

      override *execute(
        prompt: Prompt,
        stream: boolean,
        response: Response,
        conversation: Conversation | null,
      ): Generator<string | StreamEvent> {
        void prompt;
        void stream;
        void conversation;
        this.calls += 1;
        if (this.calls === 1) {
          response.add_tool_call(
            new ToolCall({ name: "tick", arguments: {}, tool_call_id: "c1" }),
          );
        } else {
          yield "final answer";
        }
      }
    }

    function tick(): string {
      return "tock";
    }
    (tick as { description?: string }).description = "Tick";

    const m = new ToolChainMock();
    const chainResponse = m.chain("q1", { tools: [tick] });
    await chainResponse.text();

    const dbPath = path.join(env.userPath, "logs-c.db");
    const db = new Database(dbPath);
    migrate(db);
    await chainResponse.logToDb(db);

    const conv = (await loadConversation(null, false, dbPath)) as Conversation;
    const r3 = conv.prompt("q2");

    expect(r3.prompt.messages.map((msg) => msg.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
      "user",
    ]);
    expect(r3.prompt.messages[1].parts[0]).toBeInstanceOf(ToolCallPart);
    expect(r3.prompt.messages[2].parts[0]).toBeInstanceOf(ToolResultPart);
    expect(
      (r3.prompt.messages[2].parts[0] as ToolResultPart).tool_call_id,
    ).toBe("c1");
  });
});

describe("TestAddToolCallWithStreamEvents", () => {
  test("test_text_yield_plus_add_tool_call_emits_both_parts", () => {
    class TextAndAddToolCallMock extends MockModel {
      override *execute(
        _prompt: Prompt,
        _stream: boolean,
        response: Response,
        _conversation: Conversation | null,
      ): Generator<string | StreamEvent> {
        yield "answer";
        response.add_tool_call(
          new ToolCall({
            name: "search",
            arguments: { q: "weather" },
            tool_call_id: "c1",
          }),
        );
      }
    }

    const m = new TextAndAddToolCallMock();
    const response = m.prompt("hi");
    response.text();
    const parts = response.messages()[0].parts;
    expect(parts).toContainEqual(new TextPart({ text: "answer" }));
    const toolCallParts = parts.filter((p) => p instanceof ToolCallPart);
    expect(toolCallParts).toEqual([
      new ToolCallPart({
        name: "search",
        arguments: { q: "weather" },
        tool_call_id: "c1",
      }),
    ]);
  });

  test("test_stream_event_tool_call_plus_matching_add_tool_call_dedups", () => {
    class DualApiMock extends MockModel {
      override *execute(
        _prompt: Prompt,
        _stream: boolean,
        response: Response,
        _conversation: Conversation | null,
      ): Generator<string | StreamEvent> {
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: "search",
          tool_call_id: "c1",
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: '{"q":"weather"}',
          tool_call_id: "c1",
        });
        response.add_tool_call(
          new ToolCall({
            name: "search",
            arguments: { q: "weather" },
            tool_call_id: "c1",
          }),
        );
      }
    }

    const m = new DualApiMock();
    const response = m.prompt("hi");
    response.text();
    const toolCallParts = response
      .messages()[0]
      .parts.filter((p) => p instanceof ToolCallPart);
    expect(toolCallParts).toEqual([
      new ToolCallPart({
        name: "search",
        arguments: { q: "weather" },
        tool_call_id: "c1",
      }),
    ]);
  });
});

describe("TestResponseReply", () => {
  test("test_reply_builds_next_turn_from_this_response", async () => {
    env.mockModel.enqueue(["a1"]);
    env.mockModel.enqueue(["a2"]);
    const r1 = env.mockModel.prompt("q1");
    r1.text();

    const r2 = await r1.reply("q2");
    r2.text();
    expect(r2.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("q2"),
    ]);
  });

  test("test_reply_chains", async () => {
    env.mockModel.enqueue(["a1"]);
    env.mockModel.enqueue(["a2"]);
    env.mockModel.enqueue(["a3"]);
    const r1 = env.mockModel.prompt("q1");
    r1.text();
    const r2 = await r1.reply("q2");
    r2.text();
    const r3 = await r2.reply("q3");
    r3.text();
    expect(r3.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("q2"),
      assistant("a2"),
      user("q3"),
    ]);
  });

  test("test_reply_no_prompt_reuses_messages_kwarg", async () => {
    env.mockModel.enqueue(["a1"]);
    env.mockModel.enqueue(["a2"]);
    const r1 = env.mockModel.prompt("q1");
    r1.text();
    const r2 = await r1.reply(null, { messages: [user("alt")] });
    r2.text();
    expect(r2.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("alt"),
    ]);
  });

  test("test_reply_from_conversation_response_extends_chain", async () => {
    env.mockModel.enqueue(["a1"]);
    env.mockModel.enqueue(["a2"]);
    const conv = env.mockModel.conversation();
    const r1 = conv.prompt("q1");
    r1.text();
    const r2 = await r1.reply("q2");
    r2.text();
    expect(r2.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("q2"),
    ]);
  });

  test("test_async_reply", async () => {
    env.asyncMockModel.enqueue(["a1"]);
    env.asyncMockModel.enqueue(["a2"]);
    const r1 = env.asyncMockModel.prompt("q1");
    await r1.text();
    const r2 = await r1.reply("q2");
    await r2.text();
    expect(r2.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("q2"),
    ]);
  });

  test("test_reply_with_tool_results_appends_tool_message", async () => {
    // First-turn assistant message has a tool call.
    const firstAssistant = new Message({
      role: "assistant",
      parts: [
        new ToolCallPart({
          name: "echo",
          arguments: { x: 1 },
          tool_call_id: "c1",
        }),
      ],
    });

    class ToolCallMock extends MockModel {
      override supports_tools = true;

      override *execute(
        _prompt: Prompt,
        _stream: boolean,
        _response: Response,
        _conversation: Conversation | null,
      ): Generator<string | StreamEvent> {
        // Yield the assistant turn's parts as StreamEvents so
        // response.messages() contains the tool call.
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: "echo",
          tool_call_id: "c1",
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: '{"x": 1}',
          tool_call_id: "c1",
        });
      }
    }

    const m = new ToolCallMock();
    const r1 = m.prompt("call echo");
    r1.text();

    const toolResults = [
      new ToolResult({ name: "echo", output: "ok", tool_call_id: "c1" }),
    ];
    m.enqueue(["follow-up text"]);
    const r2 = await r1.reply(null, { tool_results: toolResults });
    r2.text();
    expect(r2.prompt.messages).toEqual([
      user("call echo"),
      firstAssistant,
      new Message({
        role: "tool",
        parts: [
          new ToolResultPart({
            name: "echo",
            output: "ok",
            tool_call_id: "c1",
          }),
        ],
      }),
    ]);
  });

  test("test_reply_with_tool_results_and_prompt", async () => {
    class ToolCallMock extends MockModel {
      override supports_tools = true;

      override *execute(
        _prompt: Prompt,
        _stream: boolean,
        _response: Response,
        _conversation: Conversation | null,
      ): Generator<string | StreamEvent> {
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: "echo",
          tool_call_id: "c1",
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: '{"x": 1}',
          tool_call_id: "c1",
        });
      }
    }

    const m = new ToolCallMock();
    const r1 = m.prompt("call echo");
    r1.text();
    m.enqueue(["follow-up"]);
    const r2 = await r1.reply("now summarise", {
      tool_results: [
        new ToolResult({ name: "echo", output: "ok", tool_call_id: "c1" }),
      ],
    });
    r2.text();
    const roles = r2.prompt.messages.map((msg) => msg.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user"]);
    // tool message goes BEFORE the new user prompt.
    const toolMsg = r2.prompt.messages[2];
    expect(toolMsg.parts).toEqual([
      new ToolResultPart({ name: "echo", output: "ok", tool_call_id: "c1" }),
    ]);
    expect(r2.prompt.messages[3]).toEqual(user("now summarise"));
  });

  test("test_reply_auto_executes_tool_calls_when_none_passed", async () => {
    const executed: number[] = [];

    function echo(x: number): string {
      executed.push(x);
      return `echo:${x}`;
    }
    (echo as { annotations?: Record<string, string> }).annotations = {
      x: "integer",
    };

    class ToolCallMock extends MockModel {
      override supports_tools = true;

      override *execute(
        _prompt: Prompt,
        _stream: boolean,
        response: Response,
        _conversation: Conversation | null,
      ): Generator<string | StreamEvent> {
        response.add_tool_call(
          new ToolCall({
            name: "echo",
            arguments: { x: 42 },
            tool_call_id: "c1",
          }),
        );
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: "echo",
          tool_call_id: "c1",
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: '{"x": 42}',
          tool_call_id: "c1",
        });
      }
    }

    const m = new ToolCallMock();
    const r1 = m.prompt("call echo", { tools: [echo] });
    r1.text();

    m.enqueue(["follow-up"]);
    // No tool_results passed — sugar kicks in and auto-executes.
    const r2 = await r1.reply();
    r2.text();

    expect(executed).toEqual([42]);
    // The tool message landed in the chain.
    const roles = r2.prompt.messages.map((msg) => msg.role);
    expect(roles).toEqual(["user", "assistant", "tool"]);
    const toolMsg = r2.prompt.messages[2];
    expect(toolMsg.parts).toEqual([
      new ToolResultPart({
        name: "echo",
        output: "echo:42",
        tool_call_id: "c1",
      }),
    ]);
  });

  test("test_reply_auto_execute_with_prompt", async () => {
    const executed: number[] = [];

    function echo(x: number): string {
      executed.push(x);
      return "out";
    }
    (echo as { annotations?: Record<string, string> }).annotations = {
      x: "integer",
    };

    class ToolCallMock extends MockModel {
      override supports_tools = true;

      override *execute(
        _prompt: Prompt,
        _stream: boolean,
        response: Response,
        _conversation: Conversation | null,
      ): Generator<string | StreamEvent> {
        response.add_tool_call(
          new ToolCall({
            name: "echo",
            arguments: { x: 1 },
            tool_call_id: "c1",
          }),
        );
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: "echo",
          tool_call_id: "c1",
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: '{"x": 1}',
          tool_call_id: "c1",
        });
      }
    }

    const m = new ToolCallMock();
    const r1 = m.prompt("call echo", { tools: [echo] });
    r1.text();
    m.enqueue(["follow-up"]);
    const r2 = await r1.reply("now summarise");
    r2.text();
    expect(executed).toEqual([1]);
    const roles = r2.prompt.messages.map((msg) => msg.role);
    expect(roles).toEqual(["user", "assistant", "tool", "user"]);
  });

  test("test_reply_explicit_tool_results_skips_auto_execute", async () => {
    const executed: number[] = [];

    function echo(x: number): string {
      executed.push(x);
      return "should not see";
    }
    (echo as { annotations?: Record<string, string> }).annotations = {
      x: "integer",
    };

    class ToolCallMock extends MockModel {
      override supports_tools = true;

      override *execute(
        _prompt: Prompt,
        _stream: boolean,
        _response: Response,
        _conversation: Conversation | null,
      ): Generator<string | StreamEvent> {
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: "echo",
          tool_call_id: "c1",
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: '{"x": 1}',
          tool_call_id: "c1",
        });
      }
    }

    const m = new ToolCallMock();
    const r1 = m.prompt("call echo", { tools: [echo] });
    r1.text();
    m.enqueue(["follow-up"]);
    const r2 = await r1.reply(null, {
      tool_results: [
        new ToolResult({ name: "echo", output: "custom", tool_call_id: "c1" }),
      ],
    });
    r2.text();
    expect(executed).toEqual([]); // echo was NOT called
    const toolMsg = r2.prompt.messages[2];
    expect((toolMsg.parts[0] as ToolResultPart).output).toBe("custom");
  });

  test("test_reply_no_tool_calls_no_tool_message", async () => {
    env.mockModel.enqueue(["a1"]);
    env.mockModel.enqueue(["a2"]);
    const r1 = env.mockModel.prompt("q1");
    r1.text();
    const r2 = await r1.reply();
    r2.text();
    expect(r2.prompt.messages).toEqual([user("q1"), assistant("a1")]);
  });

  test("test_async_reply_auto_executes_tool_calls", async () => {
    const executed: number[] = [];

    async function echo(x: number): Promise<string> {
      executed.push(x);
      return `echo:${x}`;
    }
    (echo as { annotations?: Record<string, string> }).annotations = {
      x: "integer",
    };

    class ToolCallMock extends AsyncMockModel {
      override supports_tools = true;

      override async *execute(
        _prompt: Prompt,
        _stream: boolean,
        response: AsyncResponse,
        _conversation: AsyncConversation | null,
      ): AsyncGenerator<string | StreamEvent> {
        response.add_tool_call(
          new ToolCall({
            name: "echo",
            arguments: { x: 7 },
            tool_call_id: "c1",
          }),
        );
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: "echo",
          tool_call_id: "c1",
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: '{"x": 7}',
          tool_call_id: "c1",
        });
      }
    }

    const m = new ToolCallMock();
    const r1 = m.prompt("call echo", { tools: [echo] });
    await r1.text();
    m.enqueue(["follow-up"]);
    const r2 = await r1.reply();
    await r2.text();
    expect(executed).toEqual([7]);
    const toolMsg = r2.prompt.messages[2];
    expect(toolMsg.parts).toEqual([
      new ToolResultPart({
        name: "echo",
        output: "echo:7",
        tool_call_id: "c1",
      }),
    ]);
  });

  test("test_async_reply_with_tool_results", async () => {
    class ToolCallMock extends AsyncMockModel {
      override supports_tools = true;

      override async *execute(
        _prompt: Prompt,
        _stream: boolean,
        _response: AsyncResponse,
        _conversation: AsyncConversation | null,
      ): AsyncGenerator<string | StreamEvent> {
        yield new StreamEvent({
          type: "tool_call_name",
          chunk: "echo",
          tool_call_id: "c1",
        });
        yield new StreamEvent({
          type: "tool_call_args",
          chunk: '{"x": 1}',
          tool_call_id: "c1",
        });
      }
    }

    const m = new ToolCallMock();
    const r1 = m.prompt("call echo");
    await r1.text();
    m.enqueue(["follow-up"]);
    const r2 = await r1.reply(null, {
      tool_results: [
        new ToolResult({ name: "echo", output: "ok", tool_call_id: "c1" }),
      ],
    });
    await r2.text();
    expect(r2.prompt.messages).toEqual([
      user("call echo"),
      new Message({
        role: "assistant",
        parts: [
          new ToolCallPart({
            name: "echo",
            arguments: { x: 1 },
            tool_call_id: "c1",
          }),
        ],
      }),
      new Message({
        role: "tool",
        parts: [
          new ToolResultPart({
            name: "echo",
            output: "ok",
            tool_call_id: "c1",
          }),
        ],
      }),
    ]);
  });
});

// chain() propagates system across tool-result turns

describe("TestChainPropagatesSystem", () => {
  function assertSystem(prompt: Prompt, ...expected: string[]): void {
    expect(prompt.messages[0].role).toBe("system");
    for (const e of expected) {
      expect(prompt.system).toContain(e);
      expect((prompt.messages[0].parts[0] as TextPart).text).toContain(e);
    }
  }

  const toolCall = new ToolCall({
    tool_call_id: "c1",
    name: "tick",
    arguments: {},
  });

  class ChainMock extends MockModel {
    override *execute(
      _prompt: Prompt,
      _stream: boolean,
      response: Response,
      _conversation: Conversation | null,
    ): Generator<string | StreamEvent> {
      if (!this._queue.length) {
        yield "done";
        return;
      }
      const msgs = this._queue.shift()!;
      for (const m of msgs) {
        yield m;
      }
      if (!response._tool_calls.length) {
        response.add_tool_call(toolCall);
      }
    }
  }

  function tick(): string {
    return "tock";
  }
  (tick as { description?: string }).description = "Tick";

  test("test_sync_chain_tool_result_turn_preserves_system", async () => {
    const m = new ChainMock();
    m.enqueue(["tool-turn"]); // first response; chain will loop
    m.enqueue(["final"]); // second response, after tool results

    const chain = m.chain("q", { system: "be brief", tools: [tick] });
    for await (const _ of chain.responses()) {
      // drain
    }
    // Second response was the tool-result turn.
    assertSystem(chain._responses[1].prompt, "be brief");
  });

  test("test_sync_chain_tool_result_turn_preserves_system_fragments", async () => {
    const m = new ChainMock();
    m.enqueue(["tool-turn"]);
    m.enqueue(["final"]);

    const chain = m.chain("q", {
      system: "inline sys",
      system_fragments: ["fragment A", "fragment B"],
      tools: [tick],
    });
    for await (const _ of chain.responses()) {
      // drain
    }
    assertSystem(
      chain._responses[1].prompt,
      "inline sys",
      "fragment A",
      "fragment B",
    );
  });

  test("test_async_chain_tool_result_turn_preserves_system", async () => {
    class AsyncChainMock extends AsyncMockModel {
      override supports_tools = true;

      override async *execute(
        _prompt: Prompt,
        _stream: boolean,
        response: AsyncResponse,
        _conversation: AsyncConversation | null,
      ): AsyncGenerator<string | StreamEvent> {
        if (!this._queue.length) {
          yield "done";
          return;
        }
        const msgs = this._queue.shift()!;
        for (const m of msgs) {
          yield m;
        }
        if (!response._tool_calls.length) {
          response.add_tool_call(toolCall);
        }
      }
    }

    const m = new AsyncChainMock();
    m.enqueue(["tool-turn"]);
    m.enqueue(["final"]);

    const chain = m.chain("q", { system: "be brief", tools: [tick] });
    const responses: AsyncResponse[] = [];
    for await (const r of chain.responses()) {
      responses.push(r);
    }
    assertSystem(responses[1].prompt, "be brief");
  });

  test("test_chain_includes_system_in_messages", () => {
    const chain = env.mockModel.chain("q", { system: "be brief" });
    assertSystem(chain.prompt, "be brief");
  });
});

// chain() accepts messages= (parity with prompt())

describe("TestChainMessagesKwarg", () => {
  test("test_conversation_chain_accepts_messages", async () => {
    env.mockModel.enqueue(["ok"]);
    const conv = env.mockModel.conversation();
    const chain = conv.chain(null, { messages: [user("explicit")] });
    await chain.text();
    const r1 = chain._responses[0];
    expect(r1.prompt.messages).toEqual([user("explicit")]);
  });

  test("test_model_chain_accepts_messages", async () => {
    env.mockModel.enqueue(["ok"]);
    const chain = env.mockModel.chain(null, { messages: [user("explicit")] });
    await chain.text();
    const r1 = chain._responses[0];
    expect(r1.prompt.messages).toEqual([user("explicit")]);
  });

  test("test_chain_messages_is_authoritative_over_prompt_kwarg", async () => {
    env.mockModel.enqueue(["ok"]);
    const chain = env.mockModel.chain("ignored text", {
      messages: [user("explicit")],
    });
    await chain.text();
    const r1 = chain._responses[0];
    expect(r1.prompt.messages).toEqual([user("explicit")]);
  });

  test("test_chain_with_messages_and_prior_conversation", async () => {
    env.mockModel.enqueue(["first"]);
    env.mockModel.enqueue(["second"]);
    const conv = env.mockModel.conversation();
    const r1 = conv.prompt("prior");
    r1.text();

    // Now start a chain with explicit messages= — prior turn is
    // ignored (consistent with prompt() behavior).
    const chain = conv.chain(null, { messages: [user("fresh start")] });
    await chain.text();
    const firstChainResponse = chain._responses[0];
    expect(firstChainResponse.prompt.messages).toEqual([user("fresh start")]);
  });

  test("test_async_conversation_chain_accepts_messages", async () => {
    env.asyncMockModel.enqueue(["ok"]);
    const conv = env.asyncMockModel.conversation();
    const chain = conv.chain(null, { messages: [user("explicit")] });
    await chain.text();
    const r1 = chain._responses[0];
    expect(r1.prompt.messages).toEqual([user("explicit")]);
  });

  test("test_async_model_chain_accepts_messages", async () => {
    env.asyncMockModel.enqueue(["ok"]);
    const chain = env.asyncMockModel.chain(null, {
      messages: [user("explicit")],
    });
    await chain.text();
    const r1 = chain._responses[0];
    expect(r1.prompt.messages).toEqual([user("explicit")]);
  });
});

// Response.to_dict / Response.from_dict

describe("TestResponseToDictFromDict", () => {
  test("test_to_dict_captures_chain_and_output", () => {
    env.mockModel.enqueue(["hello"]);
    const r = env.mockModel.prompt("hi");
    r.text();

    const d = r.toDict();
    expect(d.model).toBe("mock");
    expect(d.prompt.messages).toEqual([user("hi").toDict()]);
    expect(d.messages).toEqual([assistant("hello").toDict()]);
  });

  test("test_from_dict_rehydrates_with_messages", async () => {
    env.mockModel.enqueue(["hello"]);
    const r = env.mockModel.prompt("hi");
    r.text();
    const payload = JSON.stringify(r.toDict());

    const restored = await Response.fromDict(JSON.parse(payload));
    expect(restored._done).toBe(true);
    expect(restored.text()).toBe("hello");
    expect(restored.messages()).toEqual([assistant("hello")]);
    expect(restored.prompt.messages).toEqual([user("hi")]);
  });

  test("test_from_dict_then_reply_continues_conversation", async () => {
    env.mockModel.enqueue(["a1"]);
    env.mockModel.enqueue(["a2"]);
    const r1 = env.mockModel.prompt("q1");
    r1.text();

    // Serialize across the process boundary
    const payload = JSON.stringify(r1.toDict());
    const restored = await Response.fromDict(JSON.parse(payload));

    // Continue from the restored response
    const r2 = await restored.reply("q2");
    r2.text();
    expect(r2.prompt.messages).toEqual([
      user("q1"),
      assistant("a1"),
      user("q2"),
    ]);
  });

  test("test_to_dict_preserves_reasoning_and_signatures", async () => {
    env.mockModel.enqueue([
      new StreamEvent({
        type: "reasoning",
        chunk: "thinking...",
        part_index: 0,
        provider_metadata: { anthropic: { signature: "sig-abc" } },
      }),
      new StreamEvent({ type: "text", chunk: "answer", part_index: 1 }),
    ]);
    const r = env.mockModel.prompt("q");
    r.text();

    const payload = JSON.stringify(r.toDict());
    const restored = await Response.fromDict(JSON.parse(payload));

    const msgs = restored.messages();
    expect(msgs[0].role).toBe("assistant");
    expect(msgs[0].parts[0]).toBeInstanceOf(ReasoningPart);
    expect((msgs[0].parts[0] as ReasoningPart).text).toBe("thinking...");
    expect(msgs[0].parts[0].provider_metadata).toEqual({
      anthropic: { signature: "sig-abc" },
    });
  });

  test("test_from_dict_reply_includes_prior_reasoning_in_chain", async () => {
    env.mockModel.enqueue([
      new StreamEvent({
        type: "reasoning",
        chunk: "thinking...",
        part_index: 0,
        provider_metadata: { anthropic: { signature: "sig-xyz" } },
      }),
      new StreamEvent({ type: "text", chunk: "answer", part_index: 1 }),
    ]);
    env.mockModel.enqueue(["a2"]);
    const r1 = env.mockModel.prompt("q1");
    r1.text();

    const payload = JSON.stringify(r1.toDict());
    const restored = await Response.fromDict(JSON.parse(payload));
    const r2 = await restored.reply("q2");
    r2.text();

    // The signature must be in the chain sent to the model.
    const chain = r2.prompt.messages;
    const reasoningParts = chain
      .flatMap((m) => m.parts)
      .filter((p) => p instanceof ReasoningPart);
    expect(reasoningParts.length).toBe(1);
    expect(reasoningParts[0].provider_metadata).toEqual({
      anthropic: { signature: "sig-xyz" },
    });
  });

  test("test_to_dict_captures_options", () => {
    env.mockModel.enqueue(["ok"]);
    const r = env.mockModel.prompt("hi", { max_tokens: 42 });
    r.text();

    const d = r.toDict();
    expect(d.prompt.options).toEqual({ max_tokens: 42 });
  });

  test("test_from_dict_options_restored", async () => {
    env.mockModel.enqueue(["ok"]);
    const r = env.mockModel.prompt("hi", { max_tokens: 42 });
    r.text();

    const payload = JSON.stringify(r.toDict());
    const restored = await Response.fromDict(JSON.parse(payload));
    expect(
      (restored.prompt.options as { max_tokens?: number }).max_tokens,
    ).toBe(42);
  });

  test("test_message_from_dict_static_method_unchanged", () => {
    const m = assistant("hi");
    expect(Message.fromDict(m.toDict())).toEqual(m);
  });
});

describe("TestChainResponseStreamEvents", () => {
  test("test_sync_chain_stream_events_yields_text_when_no_tools", async () => {
    // Chain with no tool calls is a single-response chain — its
    // stream_events should concatenate from each underlying response.
    env.mockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "done", part_index: 0 }),
    ]);
    const chain = env.mockModel.conversation().chain("q");
    const events: StreamEvent[] = [];
    for await (const event of chain.stream_events()) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(["text"]);
    expect(events.map((e) => e.chunk)).toEqual(["done"]);
  });

  test("test_async_chain_astream_events_yields", async () => {
    env.asyncMockModel.enqueue([
      new StreamEvent({ type: "text", chunk: "done", part_index: 0 }),
    ]);
    const chain = env.asyncMockModel.conversation().chain("q");
    const events: StreamEvent[] = [];
    for await (const event of chain.astream_events()) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(["text"]);
  });
});

// Client-side serialization round-trip

describe("TestClientSerializationRoundTrip", () => {
  test("test_response_messages_json_roundtrip", () => {
    env.mockModel.enqueue(["hello there"]);
    const r = env.mockModel.prompt("hi");
    r.text();

    // Serialize via Message.toDict / JSON.stringify
    const payload = JSON.stringify(r.messages().map((m) => m.toDict()));
    // Deserialize — no LLM state needed beyond the types.
    const restored = (JSON.parse(payload) as unknown[]).map((d) =>
      Message.fromDict(d as never),
    );

    expect(restored).toEqual(r.messages());
  });

  test("test_rebuilt_messages_reach_plugin_via_prompt", () => {
    // Turn 1
    env.mockModel.enqueue(["turn 1 answer"]);
    const r1 = env.mockModel.prompt("turn 1 question");
    r1.text();

    // Persist everything the client cares about.
    const history = [
      user("turn 1 question").toDict(),
      ...r1.messages().map((m) => m.toDict()),
    ];
    const payload = JSON.stringify(history);

    // Later — rebuild from the wire form and continue.
    const rebuilt = (JSON.parse(payload) as unknown[]).map((d) =>
      Message.fromDict(d as never),
    );
    env.mockModel.enqueue(["turn 2 answer"]);
    const r2 = env.mockModel.prompt(null, {
      messages: [...rebuilt, user("turn 2 question")],
    });
    r2.text();

    // The plugin saw the full structured history on prompt.messages.
    expect(r2.prompt.messages).toEqual([
      ...rebuilt,
      user("turn 2 question"),
    ]);
    expect(r2.messages()).toEqual([assistant("turn 2 answer")]);
  });

  test("test_roundtrip_preserves_tool_calls_and_results", () => {
    const messages = [
      user("what's the weather?"),
      assistant(
        "let me check",
        new ToolCallPart({
          name: "get_weather",
          arguments: { city: "Paris" },
          tool_call_id: "c1",
        }),
      ),
      tool_message(
        new ToolResultPart({
          name: "get_weather",
          output: "sunny",
          tool_call_id: "c1",
        }),
      ),
    ];
    const payload = JSON.stringify(messages.map((m) => m.toDict()));
    const restored = (JSON.parse(payload) as unknown[]).map((d) =>
      Message.fromDict(d as never),
    );
    expect(restored).toEqual(messages);
  });

  test("test_roundtrip_preserves_redacted_reasoning", () => {
    const msg = new Message({
      role: "assistant",
      parts: [
        new ReasoningPart({ text: "", redacted: true }),
        new TextPart({ text: "result" }),
      ],
    });
    const restored = Message.fromDict(JSON.parse(JSON.stringify(msg.toDict())));
    expect(restored).toEqual(msg);
  });

  test("test_roundtrip_preserves_provider_metadata", () => {
    const msg = new Message({
      role: "assistant",
      parts: [
        new ReasoningPart({
          text: "thinking",
          provider_metadata: { anthropic: { signature: "abc" } },
        }),
        new TextPart({ text: "answer" }),
      ],
    });
    const restored = Message.fromDict(JSON.parse(JSON.stringify(msg.toDict())));
    expect(restored).toEqual(msg);
  });
});
