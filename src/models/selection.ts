import type { ServerConfig } from "../config.js";
import type { OpenRouterModel } from "../openrouter/types.js";
import { round } from "../util.js";
import { isDecisionModel, supportsTools } from "./capabilities.js";
import { isAllowedByPolicy } from "./policy.js";
import { blendedPricePerM } from "./pricing.js";

export type Tier = "economy" | "balanced" | "quality";

export interface ModelRequirements {
  requireTools?: boolean;
  minContext?: number;
  textOutputOnly?: boolean;
}

export function meetsRequirements(model: OpenRouterModel, req: ModelRequirements): boolean {
  if (req.requireTools && !supportsTools(model)) return false;
  if (req.minContext !== undefined && (model.context_length ?? 0) < req.minContext) {
    return false;
  }
  if (req.textOutputOnly) {
    if (isDecisionModel(model)) return false;
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

    const preferredCandidates = candidates.filter((m) => preferred.has(providerOf(m.id)));
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
        (tier === "quality" ? "highest-priced candidate within the cap" : "cheapest candidate") +
        (preferred.has(providerOf(chosen.id)) ? ", from preferred providers" : ""),
      candidatesConsidered: eligible.length,
      runnersUp: candidates.slice(1, 4).map((m) => ({
        id: m.id,
        blendedPricePerM: round(blendedPricePerM(m), 2),
      })),
    };
  }

  return {
    error:
      "No models fall inside any price tier with the current TIER_*_MAX_PRICE settings in .env.",
  };
}
