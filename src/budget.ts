import type { ServerConfig } from "./config.js";
import type { OpenRouterModel, ReasoningEffort } from "./openrouter.js";

/**
 * Completion-budget resolution.
 *
 * Callers (AI agents) are bad at guessing `max_tokens`: too low truncates the
 * answer — or, on reasoning models, returns nothing at all — and too high is
 * rejected by providers whose per-request cap is smaller. So the server owns
 * the number: it derives a budget from the model's own limits and only treats
 * the caller's `max_tokens` as a hint that is clamped into what the model can
 * actually accept.
 */

/** Rough chars-per-token ratio for English/code text; only used for headroom. */
const CHARS_PER_TOKEN = 4;

/** Tokens kept free inside the context window for chat/template overhead. */
const CONTEXT_SAFETY_MARGIN = 512;

/** Cheap heuristic; the real count only matters near the context limit. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateMessageTokens(messages: Array<{ role: string; content: string }>): number {
  // ~4 tokens of framing per message on top of the content itself.
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
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

export interface BudgetInput {
  model: OpenRouterModel;
  /** Estimated tokens already spent by the prompt. */
  promptTokens: number;
  /** Caller-provided max_tokens, if any. */
  requested?: number;
  reasoningEffort?: ReasoningEffort;
  /** Completion tokens already produced by earlier continuation rounds. */
  spentTokens?: number;
}

export interface Budget {
  /** max_tokens to send on this request. */
  maxTokens: number;
  /** Largest value this model could accept right now (for retries/growth). */
  hardCap: number;
  /** Where maxTokens came from, for the response notes. */
  source: "requested" | "default" | "reasoning-floor";
  notes: string[];
}

export interface BudgetError {
  error: string;
}

export function resolveBudget(input: BudgetInput, cfg: ServerConfig): Budget | BudgetError {
  const { model, promptTokens, requested, reasoningEffort } = input;
  const spent = input.spentTokens ?? 0;
  const notes: string[] = [];

  const contextLength = model.context_length ?? 0;
  const contextHeadroom =
    contextLength > 0
      ? contextLength - promptTokens - CONTEXT_SAFETY_MARGIN
      : Number.POSITIVE_INFINITY;

  if (contextHeadroom < 256) {
    return {
      error:
        `The prompt (~${promptTokens.toLocaleString("en-US")} tokens) leaves no room for an answer in ` +
        `'${model.id}' (context window ${contextLength.toLocaleString("en-US")} tokens). ` +
        `Shorten the task or pick a model with a larger context (openrouter_list_models with min_context).`,
    };
  }

  const remainingOverall = cfg.maxOutputTokens - spent;
  if (remainingOverall < 1) {
    return {
      error:
        `The overall output budget of ${cfg.maxOutputTokens} tokens (MAX_OUTPUT_TOKENS) ` +
        `is already used up.`,
    };
  }
  const providerCap = modelCompletionCap(model);
  const hardCap = Math.max(
    1,
    Math.floor(Math.min(providerCap ?? Number.POSITIVE_INFINITY, contextHeadroom, remainingOverall))
  );

  let source: Budget["source"] = requested !== undefined ? "requested" : "default";
  let want = requested ?? cfg.defaultMaxTokens;

  // Reasoning models burn the budget on hidden tokens first: a caller asking
  // for 300 tokens of prose gets an empty answer. Raise the floor.
  const reasoningActive = isReasoningModel(model) && reasoningEffort !== "none";
  if (reasoningActive && want < cfg.reasoningMinMaxTokens) {
    notes.push(
      `raised max_tokens from ${want} to ${cfg.reasoningMinMaxTokens} because '${model.id}' ` +
        `spends part of the budget on internal reasoning`
    );
    want = cfg.reasoningMinMaxTokens;
    source = "reasoning-floor";
  }

  const maxTokens = Math.max(1, Math.min(want, hardCap));
  if (maxTokens < want) {
    notes.push(
      `capped max_tokens at ${maxTokens} (model/context/MAX_OUTPUT_TOKENS limit) instead of ${want}`
    );
  }

  return { maxTokens, hardCap, source, notes };
}

/**
 * Next budget to try after a reasoning model burned everything on hidden
 * tokens: grow aggressively, but never past what the model accepts.
 */
export function growBudget(current: number, hardCap: number): number | undefined {
  if (current >= hardCap) return undefined;
  return Math.min(hardCap, Math.max(current * 4, 4096));
}
