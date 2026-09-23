/** The .env cost/allow-list policy applied to every delegation. */
import type { ServerConfig } from "../config.js";
import type { OpenRouterModel } from "../openrouter/types.js";
import { stripAlias } from "../util.js";
import { isFreeModel, pricePerM } from "./pricing.js";

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
}

/** Matches an entry from ALLOWED_MODELS/BLOCKED_MODELS: exact id or "provider/" prefix. */
function matchesEntry(rawId: string, rawEntry: string): boolean {
  // "~author/model-latest" aliases are matched like "author/model-latest".
  const modelId = stripAlias(rawId);
  const entry = stripAlias(rawEntry);
  if (entry.endsWith("/")) return modelId.startsWith(entry);
  if (entry.endsWith("/*")) return modelId.startsWith(entry.slice(0, -1));
  return modelId === entry;
}

/** ALLOWED_MODELS/BLOCKED_MODELS check for an id that may not be in the catalog. */
export function isIdAllowedByLists(modelId: string, cfg: ServerConfig): PolicyVerdict {
  if (cfg.blockedModels.some((e) => matchesEntry(modelId, e))) {
    return { allowed: false, reason: "blocked by BLOCKED_MODELS in .env" };
  }
  if (cfg.allowedModels.length > 0 && !cfg.allowedModels.some((e) => matchesEntry(modelId, e))) {
    return { allowed: false, reason: "not in ALLOWED_MODELS in .env" };
  }
  return { allowed: true };
}

export function isAllowedByPolicy(model: OpenRouterModel, cfg: ServerConfig): PolicyVerdict {
  const lists = isIdAllowedByLists(model.id, cfg);
  if (!lists.allowed) return lists;
  if (!cfg.allowFreeModels && isFreeModel(model)) {
    return { allowed: false, reason: "free models disabled (ALLOW_FREE_MODELS=false)" };
  }
  if (
    cfg.maxPromptPricePerM !== undefined &&
    pricePerM(model.pricing.prompt) > cfg.maxPromptPricePerM
  ) {
    return {
      allowed: false,
      reason: `prompt price $${pricePerM(model.pricing.prompt).toFixed(
        2
      )}/M exceeds MAX_PROMPT_PRICE_PER_M ($${cfg.maxPromptPricePerM}/M)`,
    };
  }
  if (
    cfg.maxCompletionPricePerM !== undefined &&
    pricePerM(model.pricing.completion) > cfg.maxCompletionPricePerM
  ) {
    return {
      allowed: false,
      reason: `completion price $${pricePerM(model.pricing.completion).toFixed(
        2
      )}/M exceeds MAX_COMPLETION_PRICE_PER_M ($${cfg.maxCompletionPricePerM}/M)`,
    };
  }
  return { allowed: true };
}
