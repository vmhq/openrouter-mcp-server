import { z } from "zod";
import type { ServerConfig } from "../config.js";
import {
  type ChatUsage,
  type OpenRouterClient,
  OpenRouterError,
  type OpenRouterModel,
  blendedPricePerM,
  estimateCostUsd,
  isDecisionModel,
  isFreeModel,
  pricePerM,
  round,
  supportsTools,
} from "../openrouter.js";
import type { DelegationOutcome } from "../completion.js";
import { pageOf, type ResponseStore } from "../responseStore.js";

/** Everything the tool handlers need, assembled once at registration. */
export interface ToolContext {
  client: OpenRouterClient;
  cfg: ServerConfig;
  responses: ResponseStore;
}

/** Shape of an MCP tool result; the index signature matches the SDK's type. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function textResult(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

export function jsonResult(output: Record<string, unknown>): ToolResult {
  return textResult(JSON.stringify(output, null, 2), output);
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

export function toErrorMessage(err: unknown): string {
  if (err instanceof OpenRouterError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const DELEGATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;

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

// ---------- Shared delegation input schema ----------

/**
 * Options shared by openrouter_delegate_task and openrouter_auto_delegate.
 * `max_tokens` is deliberately described as a cost cap rather than a required
 * knob: the server derives its own budget and stitches truncated answers back
 * together, so callers should normally leave it unset.
 */
export const delegationOptionsSchema = {
  system_prompt: z
    .string()
    .max(50_000)
    .optional()
    .describe("System instructions for the delegated model"),
  max_tokens: z
    .number()
    .int()
    .min(1)
    .max(200_000)
    .optional()
    .describe(
      "OPTIONAL hard cap on completion tokens. Leave it unset unless you need to " +
        "limit cost: the server picks a budget from the model's own limits and " +
        "auto-continues answers cut off by it. A low value here is the usual cause " +
        "of truncated answers."
    ),
  auto_continue: z
    .boolean()
    .default(true)
    .describe("Automatically resume and stitch together answers cut off by the token limit"),
  reasoning_effort: z
    .enum(["none", "low", "medium", "high"])
    .optional()
    .describe(
      "Reasoning budget on reasoning-capable models ('none' disables it). Ignored otherwise."
    ),
  temperature: z.number().min(0).max(2).optional(),
  web_search: z
    .boolean()
    .default(false)
    .describe("Let OpenRouter inject web search results into the prompt (extra cost)"),
  web_max_results: z.number().int().min(1).max(10).optional(),
};

export interface DelegationOptions {
  system_prompt?: string;
  max_tokens?: number;
  auto_continue?: boolean;
  reasoning_effort?: "none" | "low" | "medium" | "high";
  temperature?: number;
  json_mode?: boolean;
  web_search?: boolean;
  web_max_results?: number;
}

export function buildMessages(task: string, systemPrompt?: string) {
  const messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }> = [];
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
  messages.push({ role: "user", content: task });
  return messages;
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
