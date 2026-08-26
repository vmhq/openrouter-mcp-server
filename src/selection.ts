import type { ServerConfig } from "./config.js";
import {
  OpenRouterModel,
  blendedPricePerM,
  isFreeModel,
  pricePerM,
  supportsTools,
} from "./openrouter.js";

export type Tier = "economy" | "balanced" | "quality";

export interface ModelRequirements {
  requireTools?: boolean;
  minContext?: number;
  textOutputOnly?: boolean;
}

/** Matches an entry from ALLOWED_MODELS/BLOCKED_MODELS: exact id or "provider/" prefix. */
function matchesEntry(modelId: string, entry: string): boolean {
  if (entry.endsWith("/")) return modelId.startsWith(entry);
  if (entry.endsWith("/*")) return modelId.startsWith(entry.slice(0, -1));
  return modelId === entry;
}

export function isAllowedByPolicy(
  model: OpenRouterModel,
  cfg: ServerConfig
): { allowed: boolean; reason?: string } {
  if (cfg.blockedModels.some((e) => matchesEntry(model.id, e))) {
    return { allowed: false, reason: "blocked by BLOCKED_MODELS in .env" };
  }
  if (
    cfg.allowedModels.length > 0 &&
    !cfg.allowedModels.some((e) => matchesEntry(model.id, e))
  ) {
    return { allowed: false, reason: "not in ALLOWED_MODELS in .env" };
  }
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

export function meetsRequirements(
  model: OpenRouterModel,
  req: ModelRequirements
): boolean {
  if (req.requireTools && !supportsTools(model)) return false;
  if (
    req.minContext !== undefined &&
    (model.context_length ?? 0) < req.minContext
  ) {
    return false;
  }
  if (req.textOutputOnly) {
    const outputs = model.architecture?.output_modalities;
    if (outputs && !outputs.includes("text")) return false;
  }
  return true;
}

export function providerOf(modelId: string): string {
  return modelId.split("/")[0] ?? "";
}

export interface AutoPickResult {
  model: OpenRouterModel;
  reason: string;
  candidatesConsidered: number;
  runnersUp: Array<{ id: string; blendedPricePerM: number }>;
}

/**
 * Pick a model for a tier. Strategy (transparent and price-driven):
 * - economy:  cheapest candidate under TIER_ECONOMY_MAX_PRICE (blended $/M).
 * - balanced: cheapest candidate in the band (economy_max, balanced_max].
 * - quality:  most expensive candidate in the band (balanced_max, quality_max]
 *             (price as a proxy for capability, capped by the tier ceiling).
 * Candidates from PREFERRED_PROVIDERS win over unknown providers; if a band
 * is empty the adjacent cheaper band is used as fallback.
 */
export function pickModelForTier(
  models: OpenRouterModel[],
  tier: Tier,
  req: ModelRequirements,
  cfg: ServerConfig
): AutoPickResult | { error: string } {
  const eligible = models.filter(
    (m) => isAllowedByPolicy(m, cfg).allowed && meetsRequirements(m, req)
  );
  if (eligible.length === 0) {
    return {
      error:
        "No models satisfy the current requirements and .env policy. " +
        "Relax min_context/require_tools, or review ALLOWED_MODELS/BLOCKED_MODELS and price caps in .env.",
    };
  }

  const bands: Record<Tier, [number, number]> = {
    economy: [0, cfg.tierEconomyMaxPrice],
    balanced: [cfg.tierEconomyMaxPrice, cfg.tierBalancedMaxPrice],
    quality: [cfg.tierBalancedMaxPrice, cfg.tierQualityMaxPrice],
  };

  const preferred = new Set(cfg.preferredProviders);
  const inBand = (m: OpenRouterModel, [lo, hi]: [number, number]) => {
    const p = blendedPricePerM(m);
    return p > lo ? p <= hi : lo === 0 && p >= 0 && p <= hi;
  };

  // Fallback order: requested band first, then progressively cheaper bands.
  const fallbackOrder: Record<Tier, Tier[]> = {
    economy: ["economy", "balanced", "quality"],
    balanced: ["balanced", "economy", "quality"],
    quality: ["quality", "balanced", "economy"],
  };

  for (const band of fallbackOrder[tier]) {
    let candidates = eligible.filter((m) => inBand(m, bands[band]));
    if (candidates.length === 0) continue;

    const preferredCandidates = candidates.filter((m) =>
      preferred.has(providerOf(m.id))
    );
    if (preferredCandidates.length > 0) candidates = preferredCandidates;

    // economy/balanced: cheapest wins; quality: highest price within cap wins.
    candidates.sort((a, b) =>
      tier === "quality"
        ? blendedPricePerM(b) - blendedPricePerM(a)
        : blendedPricePerM(a) - blendedPricePerM(b)
    );

    const chosen = candidates[0];
    const note =
      band === tier
        ? `tier '${tier}' (blended price band $${bands[band][0]}-$${bands[band][1]}/M)`
        : `tier '${tier}' band was empty; fell back to '${band}' band`;
    return {
      model: chosen,
      reason:
        `Selected from ${note}, ` +
        (tier === "quality"
          ? "highest-priced candidate within the cap"
          : "cheapest candidate") +
        (preferred.has(providerOf(chosen.id))
          ? ", from preferred providers"
          : ""),
      candidatesConsidered: eligible.length,
      runnersUp: candidates.slice(1, 4).map((m) => ({
        id: m.id,
        blendedPricePerM: Math.round(blendedPricePerM(m) * 100) / 100,
      })),
    };
  }

  return {
    error:
      "No models fall inside any price tier with the current TIER_*_MAX_PRICE settings in .env.",
  };
}
