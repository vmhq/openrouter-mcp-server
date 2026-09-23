import type { ChatUsage, OpenRouterModel } from "../openrouter/types.js";

/** Price in USD per 1M tokens from OpenRouter's per-token string. */
export function pricePerM(perToken: string | undefined): number {
  const n = Number(perToken ?? "0");
  return Number.isNaN(n) ? 0 : n * 1_000_000;
}

/** Blended $/M used for ranking: input weighs more in typical delegation. */
export function blendedPricePerM(model: OpenRouterModel): number {
  return 0.7 * pricePerM(model.pricing.prompt) + 0.3 * pricePerM(model.pricing.completion);
}

export function isFreeModel(model: OpenRouterModel): boolean {
  return pricePerM(model.pricing.prompt) === 0 && pricePerM(model.pricing.completion) === 0;
}

export function estimateCostUsd(
  model: OpenRouterModel,
  usage: ChatUsage | undefined
): number | undefined {
  if (!usage) return undefined;
  const promptCost = (usage.prompt_tokens ?? 0) * Number(model.pricing.prompt ?? "0");
  const completionCost = (usage.completion_tokens ?? 0) * Number(model.pricing.completion ?? "0");
  return promptCost + completionCost;
}
