import type { ServerConfig } from "./config.js";

const API_BASE = "https://openrouter.ai/api/v1";

// ---------- Types (subset of the OpenRouter API we use) ----------

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  created?: number;
  context_length: number | null;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing: {
    prompt: string;
    completion: string;
    [key: string]: string | undefined;
  };
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  };
  supported_parameters?: string[];
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export type ReasoningEffort = "none" | "low" | "medium" | "high";

export interface ChatCompletionResult {
  id: string;
  model: string;
  content: string;
  finishReason?: string;
  usage?: ChatUsage;
}

export class OpenRouterError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "OpenRouterError";
  }
}

// ---------- Pricing helpers ----------

/** Price in USD per 1M tokens from OpenRouter's per-token string. */
export function pricePerM(perToken: string | undefined): number {
  const n = Number(perToken ?? "0");
  return Number.isNaN(n) ? 0 : n * 1_000_000;
}

/** Blended $/M used for ranking: input weighs more in typical delegation. */
export function blendedPricePerM(model: OpenRouterModel): number {
  return (
    0.7 * pricePerM(model.pricing.prompt) +
    0.3 * pricePerM(model.pricing.completion)
  );
}

export function isFreeModel(model: OpenRouterModel): boolean {
  return (
    pricePerM(model.pricing.prompt) === 0 &&
    pricePerM(model.pricing.completion) === 0
  );
}

export function supportsTools(model: OpenRouterModel): boolean {
  return model.supported_parameters?.includes("tools") ?? false;
}

export function estimateCostUsd(
  model: OpenRouterModel,
  usage: ChatUsage | undefined
): number | undefined {
  if (!usage) return undefined;
  const promptCost =
    (usage.prompt_tokens ?? 0) * Number(model.pricing.prompt ?? "0");
  const completionCost =
    (usage.completion_tokens ?? 0) * Number(model.pricing.completion ?? "0");
  return promptCost + completionCost;
}

export function round(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

// ---------- Client ----------

export class OpenRouterClient {
  private modelsCache: { models: OpenRouterModel[]; fetchedAt: number } | null =
    null;

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

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown; timeoutMs?: number }
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      init?.timeoutMs ?? 120_000
    );
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
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
      throw new OpenRouterError(
        `Network error reaching OpenRouter: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
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
    // /models/user is the catalog filtered by the account's provider
    // preferences and data policy (e.g. ZDR); models it omits would 404 at
    // completion time anyway. Fall back to the public catalog if unavailable.
    let data: { data: OpenRouterModel[] };
    try {
      data = await this.request<{ data: OpenRouterModel[] }>("/models/user", {
        timeoutMs: 30_000,
      });
      if (!Array.isArray(data.data) || data.data.length === 0) {
        throw new OpenRouterError("empty /models/user response");
      }
    } catch {
      data = await this.request<{ data: OpenRouterModel[] }>("/models", {
        timeoutMs: 30_000,
      });
    }
    this.modelsCache = { models: data.data, fetchedAt: now };
    return data.data;
  }

  async getModel(id: string): Promise<OpenRouterModel | undefined> {
    const models = await this.listModels();
    return models.find((m) => m.id === id);
  }

  async chatCompletion(params: {
    model: string;
    messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
    maxTokens?: number;
    temperature?: number;
    jsonMode?: boolean;
    reasoningEffort?: ReasoningEffort;
  }): Promise<ChatCompletionResult> {
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
    if (params.maxTokens !== undefined) {
      body.max_completion_tokens = params.maxTokens;
    }
    if (params.temperature !== undefined) body.temperature = params.temperature;
    if (params.jsonMode) body.response_format = { type: "json_object" };
    if (params.reasoningEffort) {
      body.reasoning =
        params.reasoningEffort === "none"
          ? { enabled: false }
          : { effort: params.reasoningEffort };
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

  /** Info about the current API key: usage, limits, free tier. */
  async keyInfo(): Promise<Record<string, unknown>> {
    const data = await this.request<{ data: Record<string, unknown> }>("/key", {
      timeoutMs: 15_000,
    });
    return data.data;
  }
}
