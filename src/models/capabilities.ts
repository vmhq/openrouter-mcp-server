/** What a catalog model can do, as far as delegation is concerned. */
import type { OpenRouterModel } from "../openrouter/types.js";
import { stripAlias } from "../util.js";

/** True for decision-only model ids like "jev-latest" or "~typesafe/jev-latest". */
export function isSystemOneModelId(id: string): boolean {
  const bare = stripAlias(id);
  return bare.startsWith("typesafe/") || /^jev(-|$)/.test(bare);
}

/** True when the catalog says the model doesn't output text (e.g. decisions). */
export function isDecisionModel(model: OpenRouterModel): boolean {
  if (isSystemOneModelId(model.id)) return true;
  const outputs = model.architecture?.output_modalities ?? [];
  const generative = ["text", "image", "audio"];
  return outputs.length > 0 && !outputs.some((o) => generative.includes(o));
}

export function supportsTools(model: OpenRouterModel): boolean {
  return model.supported_parameters?.includes("tools") ?? false;
}

/**
 * A model whose max_tokens budget is consumed by internal chain-of-thought
 * before any visible text is produced.
 */
export function isReasoningModel(model: OpenRouterModel): boolean {
  const params = model.supported_parameters ?? [];
  return (
    params.includes("reasoning") ||
    params.includes("include_reasoning") ||
    params.includes("reasoning_effort")
  );
}

/** Largest completion the model/provider will accept in a single request. */
export function modelCompletionCap(model: OpenRouterModel): number | undefined {
  const cap = model.top_provider?.max_completion_tokens;
  return typeof cap === "number" && cap > 0 ? cap : undefined;
}
