import type { OpenRouterModel } from "../src/openrouter.js";

export interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

type Reply = { status?: number; body: unknown };
type ChatHandler = (body: Record<string, unknown>, call: number) => Reply;

/**
 * In-process stand-in for the OpenRouter HTTP API, installed as the global
 * fetch. Tests exercise the real OpenRouterClient against it.
 */
export class FakeOpenRouter {
  requests: RecordedRequest[] = [];
  models: OpenRouterModel[];
  chat: ChatHandler = (body) => ({
    body: {
      id: "gen-1",
      model: body.model,
      choices: [{ message: { content: "fake answer" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    },
  });
  systemOne: (body: Record<string, unknown>) => Reply = (body) => ({
    body: {
      model: body.model,
      provider: "TypeSafe",
      answers: { q: { noul: 0.9 } },
      usage: { input_tokens: 12, output_tokens: 1, cost: 0.0000123 },
    },
  });
  keyInfo: Reply = { body: { data: { label: "test", usage: 1.5, limit: null } } };

  private original: typeof fetch | undefined;
  private chatCalls = 0;

  constructor(models: OpenRouterModel[]) {
    this.models = models;
  }

  install(): this {
    this.original = globalThis.fetch;
    globalThis.fetch = this.fetch as typeof fetch;
    return this;
  }

  restore(): void {
    if (this.original) globalThis.fetch = this.original;
  }

  chatBodies(): Array<Record<string, unknown>> {
    return this.requests
      .filter((r) => r.path === "/chat/completions")
      .map((r) => r.body as Record<string, unknown>);
  }

  private fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.hostname !== "openrouter.ai") return this.original!(input, init);
    const path = url.pathname.replace(/^\/api\/v1/, "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    this.requests.push({ method, path, body });

    let reply: Reply;
    if (method === "GET" && (path === "/models/user" || path === "/models")) {
      reply = { body: { data: this.models } };
    } else if (method === "POST" && path === "/chat/completions") {
      reply = this.chat(body, ++this.chatCalls);
    } else if (method === "POST" && path === "/systemone") {
      reply = this.systemOne(body);
    } else if (method === "GET" && path === "/key") {
      reply = this.keyInfo;
    } else {
      reply = { status: 404, body: { error: { message: `no route ${method} ${path}` } } };
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}
