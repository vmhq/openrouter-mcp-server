import type { ServerConfig } from "../config.js";
import { delay, errorMessage } from "../util.js";
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatUsage,
  OpenRouterModel,
  SystemOneQuestion,
  SystemOneResult,
} from "./types.js";

export class OpenRouterError extends Error {
  constructor(
    message: string,
    public status?: number
  ) {
    super(message);
    this.name = "OpenRouterError";
  }
}

// ---------- Client ----------

export class OpenRouterClient {
  private modelsCache: { models: OpenRouterModel[]; fetchedAt: number } | null = null;
  /** De-duplicates concurrent catalog refreshes across parallel MCP requests. */
  private modelsInFlight: Promise<OpenRouterModel[]> | null = null;

  constructor(private cfg: ServerConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${this.cfg.openRouterApiKey}`,
      "Content-Type": "application/json",
    };
    if (this.cfg.appUrl) h["HTTP-Referer"] = this.cfg.appUrl;
    if (this.cfg.appTitle) h["X-OpenRouter-Title"] = this.cfg.appTitle;
    return h;
  }

  /**
   * Transient failures (rate limits, provider hiccups) are retried with
   * exponential backoff; the completions endpoint is not billed for a failed
   * request, so a retry is safe.
   */
  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number; retries?: number }
  ): Promise<T> {
    const maxAttempts = (init?.retries ?? 2) + 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.requestOnce<T>(path, init);
      } catch (err) {
        lastError = err;
        const retriable =
          err instanceof OpenRouterError &&
          (err.status === 429 || (err.status !== undefined && err.status >= 500));
        if (!retriable || attempt === maxAttempts) throw err;
        await delay(400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 200));
      }
    }
    throw lastError;
  }

  private async requestOnce<T>(
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number }
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), init?.timeoutMs ?? 120_000);
    let res: Response;
    try {
      res = await fetch(`${this.cfg.openRouterBaseUrl}${path}`, {
        method: init?.method ?? "GET",
        headers: this.headers(),
        body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new OpenRouterError(
          "Request to OpenRouter timed out. Try a smaller max_tokens or a faster model."
        );
      }
      throw new OpenRouterError(`Network error reaching OpenRouter: ${errorMessage(err)}`);
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      let detail = "";
      try {
        const body = (await res.json()) as {
          error?: { message?: string };
        };
        detail = body?.error?.message ?? "";
      } catch {
        // ignore body parse errors
      }
      const hints: Record<number, string> = {
        401: "Check that OPENROUTER_API_KEY in .env is valid.",
        402: "Insufficient OpenRouter credits. Top up at https://openrouter.ai/credits.",
        404: "Model not found, or no endpoints match your account's data policy (e.g. ZDR — see openrouter.ai/settings/privacy). Use openrouter_list_models to see valid model ids.",
        429: "Rate limited by OpenRouter. Wait a moment or use a paid (non :free) model.",
      };
      throw new OpenRouterError(
        `OpenRouter API error ${res.status}${detail ? `: ${detail}` : ""}${
          hints[res.status] ? ` — ${hints[res.status]}` : ""
        }`,
        res.status
      );
    }
    return (await res.json()) as T;
  }

  /** Live model catalog, cached for MODELS_CACHE_TTL_SECONDS. */
  async listModels(forceRefresh = false): Promise<OpenRouterModel[]> {
    const now = Date.now();
    if (
      !forceRefresh &&
      this.modelsCache &&
      now - this.modelsCache.fetchedAt < this.cfg.modelsCacheTtlMs
    ) {
      return this.modelsCache.models;
    }
    if (this.modelsInFlight) return this.modelsInFlight;
    this.modelsInFlight = this.fetchModels().finally(() => {
      this.modelsInFlight = null;
    });
    return this.modelsInFlight;
  }

  private async fetchModels(): Promise<OpenRouterModel[]> {
    // /models/user is the catalog filtered by the account's provider
    // preferences and data policy (e.g. ZDR); models it omits would 404 at
    // completion time anyway. Fall back to the public catalog if unavailable.
    let data: { data: OpenRouterModel[] };
    try {
      data = await this.request<{ data: OpenRouterModel[] }>("/models/user", {
        timeoutMs: 30_000,
        retries: 0, // a failure here just means falling back to /models
      });
      if (!Array.isArray(data.data) || data.data.length === 0) {
        throw new OpenRouterError("empty /models/user response");
      }
    } catch {
      data = await this.request<{ data: OpenRouterModel[] }>("/models", {
        timeoutMs: 30_000,
      });
    }
    this.modelsCache = { models: data.data, fetchedAt: Date.now() };
    return data.data;
  }

  async getModel(id: string): Promise<OpenRouterModel | undefined> {
    const models = await this.listModels();
    return models.find((m) => m.id === id);
  }

  async chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    interface RawResponse {
      id: string;
      model: string;
      choices: Array<{
        message?: { content?: string | null };
        finish_reason?: string;
      }>;
      usage?: ChatUsage;
    }
    const body: Record<string, unknown> = {
      model: params.model,
      messages: params.messages,
    };
    // OpenRouter's documented completion cap; it normalizes the value to
    // whatever the upstream provider expects (max_completion_tokens on the
    // OpenAI reasoning models, and so on).
    if (params.maxTokens !== undefined) body.max_tokens = params.maxTokens;
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.jsonMode) body.response_format = { type: "json_object" };
    if (params.reasoningEffort) {
      body.reasoning =
        params.reasoningEffort === "none" ? { enabled: false } : { effort: params.reasoningEffort };
    }
    if (params.webSearch) {
      body.plugins = [
        {
          id: "web",
          ...(params.webMaxResults !== undefined ? { max_results: params.webMaxResults } : {}),
        },
      ];
    }

    const raw = await this.request<RawResponse>("/chat/completions", {
      method: "POST",
      body,
    });
    const choice = raw.choices?.[0];
    return {
      id: raw.id,
      model: raw.model,
      content: choice?.message?.content ?? "",
      finishReason: choice?.finish_reason,
      usage: raw.usage,
    };
  }

  /**
   * Ask a System One model typed questions about a state. Bare ids such as
   * "jev-latest" are mapped by OpenRouter onto its typesafe/ namespace.
   */
  async systemOne(params: {
    model: string;
    state: string;
    questions: Record<string, SystemOneQuestion>;
  }): Promise<SystemOneResult> {
    return this.request<SystemOneResult>("/systemone", {
      method: "POST",
      body: params,
      timeoutMs: 60_000,
    });
  }

  /** Info about the current API key: usage, limits, free tier. */
  async keyInfo(): Promise<Record<string, unknown>> {
    const data = await this.request<{ data: Record<string, unknown> }>("/key", {
      timeoutMs: 15_000,
    });
    return data.data;
  }
}
