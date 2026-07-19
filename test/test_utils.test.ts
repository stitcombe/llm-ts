import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  extractFencedCodeBlock,
  instantiateFromSpec,
  maybeFencedCode,
  schemaDsl,
  simplifyUsageDict,
  truncateString,
  monotonicUlid,
} from "../src/utils.js";
import { getKey } from "../src/config.js";
import { Toolbox } from "../src/models.js";
import { setupTestEnvironment, type TestEnv } from "./conftest.js";

describe("test_simplify_usage_dict", () => {
  test.each([
    [
      {
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
        completion_tokens_details: {
          reasoning_tokens: 0,
          audio_tokens: 1,
          accepted_prediction_tokens: 0,
          rejected_prediction_tokens: 0,
        },
      },
      { completion_tokens_details: { audio_tokens: 1 } },
    ],
    [
      {
        details: { tokens: 5, audio_tokens: 2 },
        more_details: { accepted_tokens: 3 },
      },
      {
        details: { tokens: 5, audio_tokens: 2 },
        more_details: { accepted_tokens: 3 },
      },
    ],
    [{ details: { tokens: 0, audio_tokens: 0 }, more_details: {} }, {}],
    [{ level1: { level2: { value: 0, another_value: {} } } }, {}],
    [
      {
        level1: { level2: { value: 0, another_value: 1 } },
        level3: { empty_dict: {}, valid_token: 10 },
      },
      { level1: { level2: { another_value: 1 } }, level3: { valid_token: 10 } },
    ],
  ])("simplify_usage_dict(%j)", (inputData, expectedOutput) => {
    expect(simplifyUsageDict(inputData)).toEqual(expectedOutput);
  });
});

describe("test_extract_fenced_code_block", () => {
  test.each<[string, boolean, string | null]>([
    ["This is a sample text without any code blocks.", false, null],
    [
      "Here is some text.\n\n```\ndef foo():\n    return 'bar'\n```\n\nMore text.",
      false,
      "def foo():\n    return 'bar'\n",
    ],
    [
      "Here is some text.\n\n```python\ndef foo():\n    return 'bar'\n```\n\nMore text.",
      false,
      "def foo():\n    return 'bar'\n",
    ],
    [
      "Here is some text.\n\n````\ndef foo():\n    return 'bar'\n````\n\nMore text.",
      false,
      "def foo():\n    return 'bar'\n",
    ],
    [
      "Here is some text.\n\n````javascript\nfunction foo() {\n    return 'bar';\n}\n````\n\nMore text.",
      false,
      "function foo() {\n    return 'bar';\n}\n",
    ],
    [
      "Here is some text.\n\n```python\ndef foo():\n    return 'bar'\n````\n\nMore text.",
      false,
      null,
    ],
    [
      "First code block:\n\n```python\ndef foo():\n    return 'bar'\n```\n\n" +
        "Second code block:\n\n```javascript\nfunction foo() {\n    return 'bar';\n}\n```",
      false,
      "def foo():\n    return 'bar'\n",
    ],
    [
      "First code block:\n\n```python\ndef foo():\n    return 'bar'\n```\n\n" +
        "Second code block:\n\n```javascript\nfunction foo() {\n    return 'bar';\n}\n```",
      true,
      "function foo() {\n    return 'bar';\n}\n",
    ],
    [
      "First code block:\n\n```python\ndef foo():\n    return 'bar'\n```\n\n" +
        // This one has trailing whitespace after the second code block
        "Second code block:\n\n```javascript\nfunction foo() {\n    return 'bar';\n}\n``` ",
      true,
      "function foo() {\n    return 'bar';\n}\n",
    ],
    [
      "Here is some text.\n\n```python\ndef foo():\n    return `bar`\n```\n\nMore text.",
      false,
      "def foo():\n    return `bar`\n",
    ],
  ])("extract_fenced_code_block case %#", (input, last, expected) => {
    expect(extractFencedCodeBlock(input, last)).toBe(expected);
  });
});

describe("test_schema_dsl", () => {
  test.each<[string, Record<string, unknown>]>([
    [
      "name, bio",
      {
        type: "object",
        properties: { name: { type: "string" }, bio: { type: "string" } },
        required: ["name", "bio"],
      },
    ],
    [
      "name, age int, balance float, active bool",
      {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
          balance: { type: "number" },
          active: { type: "boolean" },
        },
        required: ["name", "age", "balance", "active"],
      },
    ],
    [
      "name: full name, age int: years old",
      {
        type: "object",
        properties: {
          name: { type: "string", description: "full name" },
          age: { type: "integer", description: "years old" },
        },
        required: ["name", "age"],
      },
    ],
    [
      "\n        name\n        bio\n        age int\n        ",
      {
        type: "object",
        properties: {
          name: { type: "string" },
          bio: { type: "string" },
          age: { type: "integer" },
        },
        required: ["name", "bio", "age"],
      },
    ],
    [
      "\n        name: the person's name\n        age int: their age in years, must be positive\n        bio: a short bio, no more than three sentences\n        ",
      {
        type: "object",
        properties: {
          name: { type: "string", description: "the person's name" },
          age: {
            type: "integer",
            description: "their age in years, must be positive",
          },
          bio: {
            type: "string",
            description: "a short bio, no more than three sentences",
          },
        },
        required: ["name", "age", "bio"],
      },
    ],
    ["", { type: "object", properties: {}, required: [] }],
    [
      "name str, description str",
      {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "description"],
      },
    ],
    [
      "  name  ,  age   int  :  person's age  ",
      {
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer", description: "person's age" },
        },
        required: ["name", "age"],
      },
    ],
  ])("schema_dsl case %#", (schema, expected) => {
    expect(schemaDsl(schema)).toEqual(expected);
  });
});

test("test_schema_dsl_multi", () => {
  const result = schemaDsl("name, age int: The age", true);
  expect(result).toEqual({
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            age: { type: "integer", description: "The age" },
          },
          required: ["name", "age"],
        },
      },
    },
    required: ["items"],
  });
});

describe("test_truncate_string", () => {
  test.each<[string | null, number, boolean, boolean, string | null]>([
    ["Hello, world!", 100, false, false, "Hello, world!"],
    ["Hello, world!", 5, false, false, "He..."],
    ["", 10, false, false, ""],
    [null, 10, false, false, null],
    ["Hello   world!", 100, true, false, "Hello world!"],
    ["Hello \n\t world!", 100, true, false, "Hello world!"],
    ["Hello   world!", 5, true, false, "He..."],
    ["Hello, world!", 10, false, true, "He... d!"],
    ["Hello, world!", 7, false, false, "Hell..."],
    ["1234567890", 7, false, false, "1234..."],
    ["Hello   world!", 10, true, true, "He... d!"],
    ["Hello \n\t world!", 12, true, true, "Hello world!"],
    ["12345", 5, false, false, "12345"],
    ["123456", 5, false, false, "12..."],
    ["12345", 5, false, true, "12345"],
    ["123456", 5, false, false, "12..."],
    ["A".repeat(200), 10, false, false, "AAAAAAA..."],
    ["A".repeat(200), 10, false, true, "AA... AA"],
    ["123456789", 9, false, false, "123456789"],
    ["1234567890", 9, false, false, "123456..."],
    ["123456789", 9, false, true, "123456789"],
    ["1234567890", 9, false, true, "12... 90"],
    ["1234567890", 8, false, true, "12345..."],
    ["1234567890", 9, false, true, "12... 90"],
  ])(
    "truncate_string case %#",
    (text, maxLength, normalizeWhitespace, keepEnd, expected) => {
      const result = truncateString(
        text as string,
        maxLength,
        normalizeWhitespace,
        keepEnd,
      );
      expect(result).toBe(expected);
    },
  );
});

describe("test_truncate_string_keep_end", () => {
  test.each<[string, number, boolean, number | null, string]>([
    ["0123456789", 10, true, null, "0123456789"],
    ["012345678901234", 14, true, 4, "0123... 1234"],
    ["abcdefghijklmnopqrstuvwxyz", 10, true, 2, "ab... yz"],
    ["abcdefghijklmnopqrstuvwxyz", 12, true, 3, "abc... xyz"],
    ["abcdefghijklmnopqrstuvwxyz", 8, true, null, "abcde..."],
  ])(
    "keep_end case %#",
    (text, maxLength, keepEnd, prefixLen, expectedFull) => {
      const result = truncateString(text, maxLength, false, keepEnd);
      expect(result).toBe(expectedFull);

      if (prefixLen !== null && text.length > maxLength && maxLength >= 9) {
        expect(result.slice(0, prefixLen)).toBe(text.slice(0, prefixLen));
        expect(result.slice(-prefixLen)).toBe(text.slice(-prefixLen));
        expect(result).toContain("... ");
      }
    },
  );
});

describe("test_maybe_fenced_code", () => {
  test.each<[string, boolean]>([
    [
      "<div><p>Test</p><span>Test</span><a>Test</a><b>Test</b><i>Test</i><u>Test</u>",
      true,
    ],
    ["<p>Just a paragraph</p>", false],
    ["line1\nline2\nline3\nline4\nline5", true],
    [
      "x".repeat(130) + "\n" + "x".repeat(130) + "\n" + "x".repeat(130) + "\n" + "x".repeat(50),
      false,
    ],
    ["<div>\n<p>Line 1</p>\n<p>Line 2</p>\n<p>Line 3</p>\n</div>", true],
    ["<div><p>Only two</p></div>", false],
    ["", false],
    ["```\ndef test():\n    pass\n```", true],
  ])("maybe_fenced_code case %#", (content, expectedFenced) => {
    const result = maybeFencedCode(content);

    if (expectedFenced) {
      expect(result).not.toBe(content);
      expect(result.trim().startsWith("```")).toBe(true);
      expect(result.trim().endsWith("```")).toBe(true);
      expect(result).toContain(content.trim());
    } else {
      expect(result).toBe(content);
    }
  });
});

describe("test_backtick_count_adjustment", () => {
  test.each<[string, number]>([
    ["def test():\n    pass", 3],
    ["```\ndef test():\n    pass\n```", 4],
    ["````\ndef test():\n    pass\n````", 5],
  ])("backtick case %#", (content, backtickCount) => {
    // Force the content to be treated as code by adding many angle brackets
    const contentWithBrackets = content + "<".repeat(11);
    const result = maybeFencedCode(contentWithBrackets);

    const expectedStart = "\n" + "`".repeat(backtickCount) + "\n";
    const expectedEnd = "\n" + "`".repeat(backtickCount);

    expect(result.startsWith(expectedStart)).toBe(true);
    expect(result.endsWith(expectedEnd)).toBe(true);
  });
});

class Files {
  dir: string;

  constructor(dirOrOptions: string | { dir?: string } = ".") {
    if (typeof dirOrOptions === "string") {
      this.dir = dirOrOptions;
    } else {
      this.dir = dirOrOptions.dir ?? ".";
    }
  }
}

class ValueFlag {
  value: unknown;
  flag: boolean;

  constructor(options: { value?: unknown; flag?: boolean } = {}) {
    this.value = options.value ?? null;
    this.flag = options.flag ?? false;
  }
}

describe("test_instantiate_valid", () => {
  test.each<[string, unknown, Record<string, unknown>]>([
    ["Files", Files, { dir: "." }],
    ["Files()", Files, { dir: "." }],
    ['Files("tmp")', Files, { dir: "tmp" }],
    ['Files({"dir": "/tmp"})', Files, { dir: "/tmp" }],
    ['Files(dir="/data")', Files, { dir: "/data" }],
    [
      'ValueFlag({"value": 123, "flag": true})',
      ValueFlag,
      { value: 123, flag: true },
    ],
    ["ValueFlag(flag=true)", ValueFlag, { flag: true }],
    [
      "ValueFlag(value=123, flag=false)",
      ValueFlag,
      { value: 123, flag: false },
    ],
  ])("instantiate %s", (spec, expectedCls, expectedAttrs) => {
    const obj = instantiateFromSpec(
      { Files, ValueFlag } as Record<string, new (...args: any[]) => any>,
      spec,
    );
    expect(obj).toBeInstanceOf(expectedCls as new (...args: any[]) => any);
    for (const [key, val] of Object.entries(expectedAttrs)) {
      expect(obj[key]).toEqual(val);
    }
  });
});

describe("test_instantiate_invalid", () => {
  test.each([
    ['Files({"dir":})'],
    ["Files("],
    ["Files(dir=)"],
    ['Files({"dir": [})'],
    ["Files(.)"],
    ["Files(this is invalid)"],
    ["ValueFlag(value=123, flag=falseTypo)"],
  ])("invalid spec %s", (spec) => {
    expect(() =>
      instantiateFromSpec(
        { Files, ValueFlag } as Record<string, new (...args: any[]) => any>,
        spec,
      ),
    ).toThrow();
  });
});

describe("test_get_key", () => {
  let env: TestEnv;

  beforeEach(() => {
    env = setupTestEnvironment();
  });

  afterEach(() => {
    delete process.env.ENV;
    env.cleanup();
  });

  test("get_key resolution hierarchy", () => {
    process.env.ENV = "from-env";
    fs.writeFileSync(
      path.join(env.userPath, "keys.json"),
      JSON.stringify({ testkey: "TEST" }),
    );
    expect(getKey({ alias: "testkey" })).toBe("TEST");
    expect(getKey({ input: "testkey" })).toBe("TEST");
    expect(getKey({ alias: "missing", env: "ENV" })).toBe("from-env");
    expect(getKey({ alias: "missing" })).toBeNull();
    // found key should over-ride env
    expect(getKey({ input: "testkey", env: "ENV" })).toBe("TEST");
    // explicit key should over-ride alias
    expect(getKey({ input: "explicit", alias: "testkey" })).toBe("explicit");
    expect(getKey({ input: "explicit", alias: "testkey", env: "ENV" })).toBe(
      "explicit",
    );
  });
});

test("test_monotonic_ulids", () => {
  const ulids = Array.from({ length: 1000 }, () => monotonicUlid().toString());
  expect(ulids).toEqual([...ulids].sort());
});

describe("test_toolbox_config_capture", () => {
  // Python's Toolbox captures __init__ args via introspection; the TS
  // convention is that subclass constructors resolve their defaults and
  // pass the final config object to super() (see PORTING_NOTES.md).
  test("captures config", () => {
    class Tool1 extends Toolbox {
      constructor(value: unknown) {
        super({ value });
      }
    }
    expect(new Tool1(42)._config).toEqual({ value: 42 });

    class Tool2 extends Toolbox {
      constructor(a: number, b: number, c: number) {
        super({ a, b, c });
      }
    }
    expect(new Tool2(1, 2, 3)._config).toEqual({ a: 1, b: 2, c: 3 });

    class Tool3 extends Toolbox {
      constructor({ name = "default", count = 10 } = {}) {
        super({ name, count });
      }
    }
    expect(new Tool3()._config).toEqual({ name: "default", count: 10 });
    expect(new Tool3({ name: "custom", count: 20 })._config).toEqual({
      name: "custom",
      count: 20,
    });

    class Tool4 extends Toolbox {
      constructor(required: string, { optional = "default" } = {}) {
        super({ required, optional });
      }
    }
    expect(new Tool4("hello")._config).toEqual({
      required: "hello",
      optional: "default",
    });
    expect(new Tool4("world", { optional: "custom" })._config).toEqual({
      required: "world",
      optional: "custom",
    });

    class Tool5 extends Toolbox {
      constructor(regular: string, ..._args: unknown[]) {
        super({ regular });
      }
    }
    expect(new Tool5("test", 1, 2, { extra: "value" })._config).toEqual({
      regular: "test",
    });

    class Tool6 extends Toolbox {}
    expect(new Tool6()._config).toEqual({});
  });
});
