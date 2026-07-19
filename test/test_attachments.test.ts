/** Port of tests/test_attachments.py */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { cli } from "../src/cli.js";
import { CliRunner } from "../src/click/index.js";
import { Attachment } from "../src/models.js";
import { logsDb, setupTestEnvironment, type TestEnv } from "./conftest.js";

let env: TestEnv;

beforeEach(() => {
  env = setupTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

const TINY_PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000a60000011a0203000000e699c45e" +
    "00000009504c5445ffffff00ff00fe01001274014a000000474944415478daedd8" +
    "3111003008c0c02e5deaaf2651890456e03ef32bc8915af4a208455114455114455" +
    "1144551d44291244933bbbf0845511445511445511445d1a5d41791c69505150f9f" +
    "c5099fa40000000049454e44ae426082",
  "hex",
);

const TINY_WAV = Buffer.from(
  "524946462400000057415645666d7420100000000100010044ac0000",
  "hex",
);

describe.each([
  ["image/png", TINY_PNG],
  ["audio/wav", TINY_WAV],
] as Array<[string, Buffer]>)(
  "test_prompt_attachment type=%s",
  (attachmentType, attachmentContent) => {
    test("prompt attachment", async () => {
      const runner = new CliRunner();
      env.mockModel.enqueue(["two boxes"]);
      const result = await runner.invoke(
        cli,
        ["prompt", "-m", "mock", "describe file", "-a", "-"],
        { input: attachmentContent, catchExceptions: false },
      );
      expect(result.exitCode, result.output).toBe(0);
      expect(result.output).toBe("two boxes\n");
      const promptAttachment = env.mockModel.history[0][0].attachments[0];
      expect(promptAttachment).toBeInstanceOf(Attachment);
      expect(promptAttachment.type).toBe(attachmentType);
      expect(promptAttachment.path).toBe(null);
      expect(promptAttachment.url).toBe(null);
      expect(Buffer.from(promptAttachment.content!)).toEqual(
        attachmentContent,
      );

      // Check it was logged correctly
      const db = logsDb(env);
      const conversations = db.table("conversations").rows;
      expect(conversations.length).toBe(1);
      const conversation = conversations[0] as Record<string, unknown>;
      expect(conversation.model).toBe("mock");
      expect(conversation.name).toBe("describe file");
      const response = db.table("responses").rows[0] as Record<
        string,
        unknown
      >;
      const attachment = db.table("attachments").rows[0] as Record<
        string,
        unknown
      >;
      expect(attachment).toEqual({
        id: expect.any(String),
        type: attachmentType,
        path: null,
        url: null,
        content: attachmentContent,
      });
      const promptAttachmentRow = db
        .table("prompt_attachments")
        .rows[0] as Record<string, unknown>;
      expect(promptAttachmentRow.attachment_id).toBe(attachment.id);
      expect(promptAttachmentRow.response_id).toBe(response.id);
    });
  },
);

function countOpenFds(): number | null {
  // Count open file descriptors (macOS and Linux only).
  let fdDir: string;
  if (process.platform === "darwin") {
    fdDir = "/dev/fd";
  } else if (process.platform === "linux") {
    fdDir = "/proc/self/fd";
  } else {
    return null;
  }
  return fs.readdirSync(fdDir).length;
}

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "test_attachment_no_file_descriptor_leak",
  async () => {
    // Verify reading attachments from paths doesn't leak file descriptors
    const testFile = path.join(env.userPath, "test.bin");
    fs.writeFileSync(testFile, Buffer.alloc(1000, "x"));

    // Warm up - first call may open other resources
    const attachment = new Attachment({ path: testFile });
    attachment.id();
    await attachment.contentBytes();

    const baseline = countOpenFds()!;

    // Create many attachments and read them
    for (let i = 0; i < 100; i++) {
      const a = new Attachment({ path: testFile });
      a.id();
      await a.contentBytes();
    }

    // File descriptor count should not have grown significantly
    expect(countOpenFds()!).toBeLessThanOrEqual(baseline + 5);
  },
);
