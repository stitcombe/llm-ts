/**
 * Fetch-based stand-in for pytest-httpx. Tests register canned
 * responses matched by method + URL; requests are captured for later
 * assertions. Matching consumes registered responses in order; when
 * all matching responses have been used, the last one is reused
 * (mirroring how the Python suite uses pytest-httpx).
 */

export interface CapturedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Raw request body text (pytest-httpx's request.content). */
  content: string;
}

interface MockResponseSpec {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  json?: unknown;
  text?: string;
  /** SSE chunks, each delivered as a separate stream read. */
  streamChunks?: string[];
  used: boolean;
}

type HeadersLike = Headers | Array<[string, string]> | Record<string, string>;

function normalizeHeaders(
  headers: HeadersLike | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key] = value;
    }
  } else {
    Object.assign(out, headers);
  }
  return out;
}

export class FetchMock {
  private specs: MockResponseSpec[] = [];
  private requests: CapturedRequest[] = [];
  private originalFetch: typeof fetch | null = null;

  install(): void {
    if (this.originalFetch) return;
    this.originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      this.handle(input, init)) as typeof fetch;
  }

  uninstall(): void {
    if (this.originalFetch) {
      globalThis.fetch = this.originalFetch;
      this.originalFetch = null;
    }
  }

  addResponse({
    method = "POST",
    url,
    json,
    text,
    streamChunks,
    headers = {},
    statusCode = 200,
  }: {
    method?: string;
    url: string;
    json?: unknown;
    text?: string;
    streamChunks?: string[];
    headers?: Record<string, string>;
    statusCode?: number;
  }): void {
    this.specs.push({
      method: method.toUpperCase(),
      url,
      status: statusCode,
      headers,
      json,
      text,
      streamChunks,
      used: false,
    });
  }

  getRequests(): CapturedRequest[] {
    return this.requests;
  }

  reset(): void {
    this.specs = [];
    this.requests = [];
  }

  private async handle(
    input: Parameters<typeof fetch>[0],
    init?: RequestInit,
  ): Promise<Response> {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    const method = (
      init?.method ??
      (typeof input === "object" && "method" in input ? input.method : "GET")
    ).toUpperCase();

    let content = "";
    if (init?.body) {
      if (typeof init.body === "string") {
        content = init.body;
      } else if (init.body instanceof Uint8Array) {
        content = new TextDecoder().decode(init.body);
      } else {
        content = String(init.body);
      }
    }

    this.requests.push({
      method,
      url,
      headers: normalizeHeaders(init?.headers as HeadersLike | undefined),
      content,
    });

    const candidates = this.specs.filter(
      (s) => s.method === method && s.url === url,
    );
    if (!candidates.length) {
      throw new TypeError(
        `FetchMock: no response registered for ${method} ${url}`,
      );
    }
    const spec = candidates.find((s) => !s.used) ?? candidates[candidates.length - 1];
    spec.used = true;

    if (spec.streamChunks) {
      const encoder = new TextEncoder();
      const chunks = spec.streamChunks;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
      return new Response(stream, {
        status: spec.status,
        headers: { "Content-Type": "text/event-stream", ...spec.headers },
      });
    }

    const body =
      spec.json !== undefined ? JSON.stringify(spec.json) : (spec.text ?? "");
    return new Response(body, {
      status: spec.status,
      headers: {
        "Content-Type": spec.json !== undefined ? "application/json" : "text/plain",
        ...spec.headers,
      },
    });
  }
}

// ---- Fixture helpers mirroring tests/conftest.py --------------------

export function mockedOpenaiChat(mock: FetchMock): FetchMock {
  mock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    json: {
      model: "gpt-4o-mini",
      usage: {},
      choices: [{ message: { content: "Bob, Alice, Eve" } }],
    },
  });
  return mock;
}

export function mockedOpenaiChatReturningFencedCode(mock: FetchMock): FetchMock {
  mock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    json: {
      model: "gpt-4o-mini",
      usage: {},
      choices: [
        {
          message: {
            content:
              "Code:\n\n````javascript\nfunction foo() {\n  return 'bar';\n}\n````\nDone.",
          },
        },
      ],
    },
  });
  return mock;
}

function chatStreamEvents(): string[] {
  const chunks: string[] = [];
  const deltas: Array<[Record<string, unknown>, string | null]> = [
    [{ role: "assistant", content: "" }, null],
    [{ content: "Hi" }, null],
    [{ content: "." }, null],
    [{}, "stop"],
  ];
  for (const [delta, finishReason] of deltas) {
    chunks.push(
      "data: " +
        JSON.stringify({
          id: "chat-1",
          object: "chat.completion.chunk",
          created: 1695096940,
          model: "gpt-3.5-turbo-0613",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        }) +
        "\n\n",
    );
  }
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

export function mockedOpenaiChatStream(mock: FetchMock): FetchMock {
  mock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/chat/completions",
    streamChunks: chatStreamEvents(),
  });
  return mock;
}

export function mockedOpenaiCompletion(mock: FetchMock): FetchMock {
  mock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/completions",
    json: {
      id: "cmpl-uqkvlQyYK7bGYrRHQ0eXlWi7",
      object: "text_completion",
      created: 1589478378,
      model: "gpt-3.5-turbo-instruct",
      choices: [
        {
          text: "\n\nThis is indeed a test",
          index: 0,
          logprobs: null,
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    },
  });
  return mock;
}

function streamCompletionEvents(): string[] {
  const choicesChunks = [
    [
      {
        text: "\n\n",
        index: 0,
        logprobs: {
          tokens: ["\n\n"],
          token_logprobs: [-0.6],
          top_logprobs: [{ "\n\n": -0.6, "\n": -1.9 }],
          text_offset: [16],
        },
        finish_reason: null,
      },
    ],
    [
      {
        text: "Hi",
        index: 0,
        logprobs: {
          tokens: ["Hi"],
          token_logprobs: [-1.1],
          top_logprobs: [{ Hi: -1.1, Hello: -0.7 }],
          text_offset: [18],
        },
        finish_reason: null,
      },
    ],
    [
      {
        text: ".",
        index: 0,
        logprobs: {
          tokens: ["."],
          token_logprobs: [-1.1],
          top_logprobs: [{ ".": -1.1, "!": -0.9 }],
          text_offset: [20],
        },
        finish_reason: null,
      },
    ],
    [
      {
        text: "",
        index: 0,
        logprobs: {
          tokens: [],
          token_logprobs: [],
          top_logprobs: [],
          text_offset: [],
        },
        finish_reason: "stop",
      },
    ],
  ];
  const chunks: string[] = [];
  for (const choices of choicesChunks) {
    chunks.push(
      "data: " +
        JSON.stringify({
          id: "cmpl-80MdSaou7NnPuff5ZyRMysWBmgSPS",
          object: "text_completion",
          created: 1695097702,
          choices,
          model: "gpt-3.5-turbo-instruct",
        }) +
        "\n\n",
    );
  }
  chunks.push("data: [DONE]\n\n");
  return chunks;
}

export function mockedOpenaiCompletionLogprobsStream(
  mock: FetchMock,
): FetchMock {
  mock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/completions",
    streamChunks: streamCompletionEvents(),
  });
  return mock;
}

export function mockedOpenaiCompletionLogprobs(mock: FetchMock): FetchMock {
  mock.addResponse({
    method: "POST",
    url: "https://api.openai.com/v1/completions",
    json: {
      id: "cmpl-80MeBfKJutM0uMNJkRrebJLeP3bxL",
      object: "text_completion",
      created: 1695097747,
      model: "gpt-3.5-turbo-instruct",
      choices: [
        {
          text: "\n\nHi.",
          index: 0,
          logprobs: {
            tokens: ["\n\n", "Hi", "1"],
            token_logprobs: [-0.6, -1.1, -0.9],
            top_logprobs: [
              { "\n\n": -0.6, "\n": -1.9 },
              { Hi: -1.1, Hello: -0.7 },
              { ".": -0.9, "!": -1.1 },
            ],
            text_offset: [16, 18, 20],
          },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    },
  });
  return mock;
}

export function mockedLocalai(mock: FetchMock): FetchMock {
  mock.addResponse({
    method: "POST",
    url: "http://localai.localhost/chat/completions",
    json: {
      model: "orca",
      usage: {},
      choices: [{ message: { content: "Bob, Alice, Eve" } }],
    },
  });
  mock.addResponse({
    method: "POST",
    url: "http://localai.localhost/completions",
    json: {
      model: "completion-babbage",
      usage: {},
      choices: [{ text: "Hello" }],
    },
  });
  return mock;
}
