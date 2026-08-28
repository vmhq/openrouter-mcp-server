import type { ServerConfig } from "../src/config.js";
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  OpenRouterModel,
} from "../src/openrouter.js";

export function makeConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return {
    openRouterApiKey: "test-key",
    openRouterBaseUrl: "https://openrouter.ai/api/v1",
    port: 3000,
    allowedModels: [],
    blockedModels: [],
    allowFreeModels: true,
    preferredProviders: [],
    tierEconomyMaxPrice: 0.5,
    tierBalancedMaxPrice: 3,
    tierQualityMaxPrice: 15,
    modelsCacheTtlMs: 300_000,
    defaultMaxTokens: 4096,
    reasoningMinMaxTokens: 2000,
    maxOutputTokens: 32_000,
    maxContinuations: 3,
    maxResponseChars: 25_000,
    ...overrides,
  };
}

export function makeModel(
  overrides: Partial<OpenRouterModel> & { id?: string } = {}
): OpenRouterModel {
  return {
    id: "test/model",
    name: "Test Model",
    context_length: 128_000,
    pricing: { prompt: "0.0000001", completion: "0.0000004" },
    supported_parameters: ["max_tokens", "temperature"],
    ...overrides,
  };
}

export interface ScriptedTurn {
  content: string;
  finishReason?: string;
  completionTokens?: number;
  reasoningTokens?: number;
}

/** Chat client that replays a scripted list of turns and records its calls. */
export class FakeClient {
  calls: ChatCompletionParams[] = [];

  constructor(private turns: ScriptedTurn[]) {}

  async chatCompletion(
    params: ChatCompletionParams
  ): Promise<ChatCompletionResult> {
    this.calls.push(params);
    const turn = this.turns[this.calls.length - 1];
    if (!turn) throw new Error(`unexpected call #${this.calls.length}`);
    const completion = turn.completionTokens ?? turn.content.length;
    return {
      id: `gen-${this.calls.length}`,
      model: params.model,
      content: turn.content,
      finishReason: turn.finishReason ?? "stop",
      usage: {
        prompt_tokens: 10,
        completion_tokens: completion,
        total_tokens: 10 + completion,
        ...(turn.reasoningTokens !== undefined
          ? { completion_tokens_details: { reasoning_tokens: turn.reasoningTokens } }
          : {}),
      },
    };
  }
}
