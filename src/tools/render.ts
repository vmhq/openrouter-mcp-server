/** Text and structured output for model listings and delegation results. */
import type { DelegationOutcome } from "../delegation/run.js";
import { pageOf } from "../delegation/responseStore.js";
import { isDecisionModel, supportsTools } from "../models/capabilities.js";
import { blendedPricePerM, estimateCostUsd, isFreeModel, pricePerM } from "../models/pricing.js";
import type { ChatUsage, OpenRouterModel } from "../openrouter/types.js";
import { round } from "../util.js";
import type { ToolContext } from "./context.js";
import { textResult, type ToolResult } from "./result.js";

// ---------- Model summaries ----------

export function modelSummary(m: OpenRouterModel) {
  return {
    id: m.id,
    name: m.name,
    context_length: m.context_length ?? 0,
    max_completion_tokens: m.top_provider?.max_completion_tokens ?? null,
    prompt_price_per_m: round(pricePerM(m.pricing.prompt), 4),
    completion_price_per_m: round(pricePerM(m.pricing.completion), 4),
    blended_price_per_m: round(blendedPricePerM(m), 4),
    supports_tools: supportsTools(m),
    free: isFreeModel(m),
    modality: isDecisionModel(m) ? "text->decision" : (m.architecture?.modality ?? "text->text"),
  };
}

export type ModelSummary = ReturnType<typeof modelSummary>;

export function summariesToMarkdown(rows: ModelSummary[]): string {
  const lines = [
    "| Model | $/M in | $/M out | Context | Max out | Tools | Modality |",
    "|---|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id}${r.free ? " (free)" : ""} | ${r.prompt_price_per_m} | ${
        r.completion_price_per_m
      } | ${r.context_length.toLocaleString("en-US")} | ${
        r.max_completion_tokens?.toLocaleString("en-US") ?? "—"
      } | ${r.supports_tools ? "yes" : "no"} | ${r.modality} |`
    );
  }
  return lines.join("\n");
}

// ---------- Delegation output rendering ----------

function usageAndCost(model: OpenRouterModel, usage: ChatUsage) {
  const cost = estimateCostUsd(model, usage);
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;
  return {
    usage: {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      ...(reasoningTokens !== undefined ? { reasoning_tokens: reasoningTokens } : {}),
    },
    estimated_cost_usd: cost !== undefined ? round(cost, 6) : undefined,
  };
}

/**
 * Renders an outcome as the tool result. The answer itself is returned as
 * plain text (not JSON-escaped, which costs the caller tokens and readability)
 * with a compact metadata footer; oversized answers are paged through the
 * response store instead of being clipped.
 */
export function renderDelegation(
  outcome: DelegationOutcome,
  model: OpenRouterModel,
  ctx: ToolContext,
  extra: Record<string, unknown> = {}
): ToolResult {
  const { cfg, responses } = ctx;
  const metrics = usageAndCost(model, outcome.usage);
  const notes = [...outcome.notes];

  const full = outcome.content;
  const oversized = full.length > cfg.maxResponseChars;
  const page = oversized ? pageOf(full, 0, cfg.maxResponseChars) : undefined;
  const stored = oversized ? responses.put(full, outcome.modelUsed) : undefined;

  if (outcome.truncated) {
    notes.push("the delegated model hit its output limit — the answer below is INCOMPLETE");
  }

  const output: Record<string, unknown> = {
    model_used: outcome.modelUsed,
    ...extra,
    response: page ? page.text : full,
    finish_reason: outcome.finishReason,
    truncated: outcome.truncated,
    response_chars: full.length,
    ...(stored
      ? {
          response_id: stored.id,
          response_paged: true,
          next_offset: page?.next_offset ?? null,
        }
      : {}),
    ...metrics,
    max_tokens_used: outcome.maxTokensUsed,
    requests: outcome.requests,
    continuations: outcome.continuations,
    ...(notes.length ? { notes } : {}),
  };

  const footer = [
    `[openrouter] model=${outcome.modelUsed} · finish=${outcome.finishReason}` +
      ` · tokens ${metrics.usage.prompt_tokens} in / ${metrics.usage.completion_tokens} out` +
      (metrics.estimated_cost_usd !== undefined ? ` · ~$${metrics.estimated_cost_usd}` : "") +
      (outcome.continuations > 0 ? ` · ${outcome.continuations} continuation(s)` : ""),
    ...notes.map((n) => `[note] ${n}`),
    ...(stored && page
      ? [
          `[paged] showing characters 0-${page.next_offset ?? full.length} of ` +
            `${full.length}. Get the rest with openrouter_fetch_response(` +
            `response_id="${stored.id}", offset=${page.next_offset}).`,
        ]
      : []),
  ].join("\n");

  return textResult(`${page ? page.text : full}\n\n---\n${footer}`, output);
}
