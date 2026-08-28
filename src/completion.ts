import type { ServerConfig } from "./config.js";
import { growBudget, estimateMessageTokens, resolveBudget } from "./budget.js";
import type {
  ChatCompletionParams,
  ChatCompletionResult,
  ChatMessage,
  ChatUsage,
  OpenRouterModel,
  ReasoningEffort,
} from "./openrouter.js";

/**
 * Runs one delegation to completion — including the parts the calling agent
 * should not have to think about:
 *
 *  - the completion budget is derived from the model (see budget.ts);
 *  - an answer cut off by the budget (finish_reason "length") is automatically
 *    continued and stitched back together;
 *  - a reasoning model that spent everything on hidden tokens and returned no
 *    visible text is retried once with a much larger budget.
 */

const CONTINUE_INSTRUCTION =
  "Your previous message was cut off because it reached the output token limit. " +
  "Continue from exactly where it stopped, mid-sentence or mid-word if necessary. " +
  "Do not repeat any text you already wrote, do not summarize it, and do not add " +
  "any preamble, apology or closing remark — output only the continuation.";

export interface DelegationParams {
  model: OpenRouterModel;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  reasoningEffort?: ReasoningEffort;
  webSearch?: boolean;
  webMaxResults?: number;
  /** Stitch truncated answers back together (default true). */
  autoContinue?: boolean;
}

export interface DelegationOutcome {
  modelUsed: string;
  content: string;
  finishReason: string;
  usage: ChatUsage;
  /** Number of HTTP calls made (1 = no continuation, no retry). */
  requests: number;
  /** Continuation rounds actually used. */
  continuations: number;
  /** True when the answer is still incomplete after all rounds. */
  truncated: boolean;
  /** Budget sent on the last request. */
  maxTokensUsed: number;
  notes: string[];
}

export class DelegationError extends Error {}

export interface CompletionCaller {
  chatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult>;
}

function addUsage(total: ChatUsage, next: ChatUsage | undefined): ChatUsage {
  if (!next) return total;
  const reasoning =
    (total.completion_tokens_details?.reasoning_tokens ?? 0) +
    (next.completion_tokens_details?.reasoning_tokens ?? 0);
  return {
    prompt_tokens: (total.prompt_tokens ?? 0) + (next.prompt_tokens ?? 0),
    completion_tokens:
      (total.completion_tokens ?? 0) + (next.completion_tokens ?? 0),
    total_tokens: (total.total_tokens ?? 0) + (next.total_tokens ?? 0),
    ...(reasoning > 0
      ? { completion_tokens_details: { reasoning_tokens: reasoning } }
      : {}),
  };
}

export async function runDelegation(
  client: CompletionCaller,
  params: DelegationParams,
  cfg: ServerConfig
): Promise<DelegationOutcome> {
  const { model } = params;
  const autoContinue = params.autoContinue !== false;
  const notes: string[] = [];

  let messages = params.messages;
  let budget = resolveBudget(
    {
      model,
      promptTokens: estimateMessageTokens(messages),
      requested: params.maxTokens,
      reasoningEffort: params.reasoningEffort,
    },
    cfg
  );
  if ("error" in budget) throw new DelegationError(budget.error);
  notes.push(...budget.notes);

  const parts: string[] = [];
  let usage: ChatUsage = {};
  let requests = 0;
  let continuations = 0;
  let emptyRetries = 0;
  let maxTokens = budget.maxTokens;
  let hardCap = budget.hardCap;
  let finishReason = "unknown";
  let modelUsed = model.id;

  for (;;) {
    const result = await client.chatCompletion({
      model: model.id,
      messages,
      maxTokens,
      temperature: params.temperature,
      jsonMode: params.jsonMode,
      reasoningEffort: params.reasoningEffort,
      webSearch: params.webSearch,
      webMaxResults: params.webMaxResults,
    });
    requests++;
    usage = addUsage(usage, result.usage);
    finishReason = result.finishReason ?? "unknown";
    if (result.model) modelUsed = result.model;

    const text = result.content;

    // Reasoning model that produced only hidden tokens: retry bigger once
    // instead of handing the agent an empty answer.
    if (
      text.trim() === "" &&
      finishReason === "length" &&
      parts.length === 0 &&
      emptyRetries === 0 &&
      autoContinue
    ) {
      const grown = growBudget(maxTokens, hardCap);
      if (grown !== undefined) {
        emptyRetries++;
        notes.push(
          `first attempt returned no visible text (all ${maxTokens} tokens went to internal ` +
            `reasoning); retried with max_tokens=${grown}`
        );
        maxTokens = grown;
        continue;
      }
    }

    parts.push(text);

    if (finishReason !== "length") break;

    // Nothing visible to resume from (a reasoning model that only produced
    // hidden tokens): continuing would just repeat the same empty round.
    if (parts.join("").trim() === "") break;

    if (!autoContinue) {
      notes.push(
        "answer was cut off by the token limit and auto_continue is disabled"
      );
      break;
    }
    if (params.jsonMode) {
      notes.push(
        "answer was cut off mid-JSON; auto-continue is not applied in json_mode " +
          "because a continuation would start a second JSON object. Retry with a " +
          "higher max_tokens or without json_mode."
      );
      break;
    }
    if (continuations >= cfg.maxContinuations) {
      notes.push(
        `stopped after ${continuations} continuation rounds (MAX_CONTINUATIONS); ` +
          "the answer is still incomplete"
      );
      break;
    }

    const produced = usage.completion_tokens ?? 0;
    if (produced >= cfg.maxOutputTokens) {
      notes.push(
        `reached the overall output ceiling of ${cfg.maxOutputTokens} tokens ` +
          "(MAX_OUTPUT_TOKENS); the answer is still incomplete"
      );
      break;
    }

    // An explicit max_tokens is honoured as the budget for the whole
    // delegation, not per request — otherwise auto-continuation would quietly
    // spend several times the cap the caller asked for.
    const remainingRequested =
      params.maxTokens !== undefined ? params.maxTokens - produced : undefined;
    if (remainingRequested !== undefined && remainingRequested < 1) {
      notes.push(
        `used up the max_tokens budget you set (${params.maxTokens} tokens, counted ` +
          "across continuations); the answer is incomplete — raise max_tokens or " +
          "leave it unset to let the server size the budget"
      );
      break;
    }

    // Feed the partial answer back so the model resumes instead of restarting.
    const soFar = parts.join("");
    messages = [
      ...params.messages,
      { role: "assistant", content: soFar },
      { role: "user", content: CONTINUE_INSTRUCTION },
    ];
    const next = resolveBudget(
      {
        model,
        promptTokens: estimateMessageTokens(messages),
        requested: remainingRequested,
        reasoningEffort: params.reasoningEffort,
        spentTokens: produced,
      },
      cfg
    );
    if ("error" in next) {
      notes.push(
        `could not continue the answer: ${next.error} The text below is incomplete.`
      );
      break;
    }
    maxTokens = next.maxTokens;
    hardCap = next.hardCap;
    continuations++;
  }

  const content = parts.join("");
  const truncated = finishReason === "length";
  if (continuations > 0 && !truncated) {
    notes.push(
      `answer was cut off by the token limit and completed in ${continuations} ` +
        `extra continuation ${continuations === 1 ? "round" : "rounds"}`
    );
  }

  if (content.trim() === "" && truncated) {
    throw new DelegationError(
      `Model '${model.id}' returned no visible text: it spent its whole token budget ` +
        `(${usage.completion_tokens_details?.reasoning_tokens ?? usage.completion_tokens ?? 0} tokens) ` +
        `on internal reasoning before being cut off (finish_reason "length"). ` +
        `Set reasoning_effort to "low" or "none", or pick a non-reasoning model ` +
        `(openrouter_list_models).`
    );
  }

  return {
    modelUsed,
    content,
    finishReason,
    usage,
    requests,
    continuations,
    truncated,
    maxTokensUsed: maxTokens,
    notes,
  };
}
