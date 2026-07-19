/**
 * Minimal fetch-based OpenAI API client covering what llm uses from the
 * Python `openai` package: chat completions, legacy completions, the
 * Responses API, and embeddings — with SSE streaming support.
 *
 * Responses are plain parsed-JSON objects (the analog of the Python
 * client's model_dump()).
 */

export class APIError extends Error {
  status: number | null;
  body: unknown;

  constructor(message: string, status: number | null = null, body: unknown = null) {
    super(message);
    this.name = "APIError";
    this.status = status;
    this.body = body;
  }
}

export interface OpenAIClientOptions {
  apiKey: string;
  baseUrl?: string | null;
  defaultHeaders?: Record<string, string> | null;
  /** Log requests/responses to stderr (LLM_OPENAI_SHOW_RESPONSES). */
  logResponses?: boolean;
}

interface RequestOptions {
  path: string;
  body: Record<string, unknown>;
}

function messageFromErrorBody(body: unknown, status: number): string {
  if (body && typeof body === "object") {
    const err = (body as { error?: { message?: string } }).error;
    if (err && typeof err.message === "string") {
      return `Error code: ${status} - ${JSON.stringify(body)}`;
    }
  }
  return `Error code: ${status}`;
}

export class OpenAIClient {
  apiKey: string;
  baseUrl: string;
  defaultHeaders: Record<string, string>;
  logResponses: boolean;

  constructor({
    apiKey,
    baseUrl = null,
    defaultHeaders = null,
    logResponses = false,
  }: OpenAIClientOptions) {
    this.apiKey = apiKey;
    this.baseUrl = (baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    this.defaultHeaders = defaultHeaders ?? {};
    this.logResponses = logResponses;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
      ...this.defaultHeaders,
    };
  }

  private logRequest(url: string, body: Record<string, unknown>): void {
    if (!this.logResponses) return;
    process.stderr.write(`Request: POST ${url}\n`);
    process.stderr.write("  Body:\n");
    process.stderr.write(
      JSON.stringify(body, null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n") + "\n",
    );
  }

  private async post({ path, body }: RequestOptions): Promise<unknown> {
    const url = this.baseUrl + path;
    this.logRequest(url, body);
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    const text = await response.text();
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    if (!response.ok) {
      throw new APIError(
        messageFromErrorBody(parsed, response.status),
        response.status,
        parsed,
      );
    }
    if (this.logResponses) {
      process.stderr.write(`Response: status_code=${response.status}\n`);
      process.stderr.write("  Body:\n" + text + "\n");
    }
    return parsed;
  }

  /** POST with stream: parse the SSE response into JSON chunk objects. */
  private async *postStream({
    path,
    body,
  }: RequestOptions): AsyncGenerator<any> {
    const url = this.baseUrl + path;
    this.logRequest(url, body);
    const response = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = text;
      }
      throw new APIError(
        messageFromErrorBody(parsed, response.status),
        response.status,
        parsed,
      );
    }
    if (!response.body) {
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let eventEnd: number;
        while ((eventEnd = buffer.indexOf("\n\n")) !== -1) {
          const rawEvent = buffer.slice(0, eventEnd);
          buffer = buffer.slice(eventEnd + 2);
          for (const line of rawEvent.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const data = line.slice(5).trim();
            if (data === "[DONE]") {
              return;
            }
            if (this.logResponses) {
              process.stderr.write(data + "\n");
            }
            yield JSON.parse(data);
          }
        }
      }
      // Trailing event without final blank line
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "[DONE]") return;
          yield JSON.parse(data);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  chat = {
    completions: {
      create: (
        params: Record<string, unknown> & { stream?: boolean },
      ): Promise<any> | AsyncGenerator<any> => {
        if (params.stream) {
          return this.postStream({ path: "/chat/completions", body: params });
        }
        return this.post({ path: "/chat/completions", body: params });
      },
    },
  };

  completions = {
    create: (
      params: Record<string, unknown> & { stream?: boolean },
    ): Promise<any> | AsyncGenerator<any> => {
      if (params.stream) {
        return this.postStream({ path: "/completions", body: params });
      }
      return this.post({ path: "/completions", body: params });
    },
  };

  responses = {
    create: (
      params: Record<string, unknown> & { stream?: boolean },
    ): Promise<any> | AsyncGenerator<any> => {
      if (params.stream) {
        return this.postStream({ path: "/responses", body: params });
      }
      return this.post({ path: "/responses", body: params });
    },
  };

  embeddings = {
    create: (params: Record<string, unknown>): Promise<any> => {
      return this.post({ path: "/embeddings", body: params });
    },
  };
}
