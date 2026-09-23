import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  OpenRouterError,
  isDecisionModel,
  isSystemOneModelId,
  type OpenRouterModel,
} from "../openrouter.js";
import { isAllowedByPolicy, pickModelForTier } from "../selection.js";
import { DelegationError, runDelegation } from "../completion.js";
import {
  DELEGATION_ANNOTATIONS,
  READ_ONLY_ANNOTATIONS,
  type ToolContext,
  type ToolResult,
  buildMessages,
  delegationOptionsSchema,
  errorResult,
  renderDelegation,
  textResult,
  toErrorMessage,
} from "./shared.js";
import { decisionModelRedirect } from "./decide.js";

/** Shared tail of both delegation tool descriptions. */
const BUDGET_NOTE = `Output budget: you do NOT need to size max_tokens. The server derives a budget from the model's own context window and per-request output cap, raises it automatically for reasoning models (whose budget is eaten by hidden chain-of-thought), and if the answer is still cut off it resumes the model and stitches the pieces together (auto_continue, on by default). Pass max_tokens only to deliberately cap length or cost. If the final answer is still incomplete you get truncated=true plus a note saying so — never a silently clipped answer.

Long answers: if the answer is larger than this server's inline limit you get the first page plus a response_id; fetch the remainder with openrouter_fetch_response.`;

export function registerDelegationTools(server: McpServer, ctx: ToolContext): void {
  const { client, cfg, responses } = ctx;

  async function delegate(
    model: OpenRouterModel,
    task: string,
    params: {
      system_prompt?: string;
      max_tokens?: number;
      auto_continue?: boolean;
      reasoning_effort?: "none" | "low" | "medium" | "high";
      temperature?: number;
      json_mode?: boolean;
      web_search?: boolean;
      web_max_results?: number;
    },
    extra: Record<string, unknown> = {}
  ): Promise<ToolResult> {
    const outcome = await runDelegation(
      client,
      {
        model,
        messages: buildMessages(task, params.system_prompt),
        maxTokens: params.max_tokens,
        temperature: params.temperature,
        jsonMode: params.json_mode,
        reasoningEffort: params.reasoning_effort,
        webSearch: params.web_search,
        webMaxResults: params.web_max_results,
        autoContinue: params.auto_continue,
      },
      cfg
    );
    return renderDelegation(outcome, model, ctx, extra);
  }

  // ------------------------------------------------------------------
  // openrouter_delegate_task
  // ------------------------------------------------------------------
  server.registerTool(
    "openrouter_delegate_task",
    {
      title: "Delegate Task to a Specific Model",
      description: `Delegate a task to a SPECIFIC OpenRouter model and get back its answer plus token usage and estimated cost in USD. Use openrouter_list_models first to pick a cheap model that fits the task, then delegate here.

The server enforces its .env policy: blocked models or models above the configured price caps are rejected with an explanation.

Args:
  - model (string, optional): exact model id. Falls back to DEFAULT_MODEL from .env; errors if neither is set.
  - task (string): the prompt for the delegated model. Include ALL context it needs — it does not see this conversation.
  - system_prompt (string, optional): system instructions for the delegated model.
  - max_tokens (integer, optional): see "Output budget" below.
  - auto_continue (boolean, default true): resume and stitch together answers cut off by the token limit.
  - reasoning_effort ("none" | "low" | "medium" | "high", optional): reasoning budget for reasoning-capable models ("none" disables it). Ignored by models without reasoning support.
  - temperature (0-2, optional).
  - json_mode (boolean, default false): request a JSON-object response (only for models supporting response_format). Disables auto-continue, since a continuation would start a second JSON object.
  - web_search (boolean, default false): let OpenRouter run a web search and inject the results into the prompt (works with any model). Costs ~$4 per 1000 results EXTRA, billed separately and NOT included in estimated_cost_usd; injected results also add prompt tokens.
  - web_max_results (1-10, default 5): number of search results when web_search is on.

${BUDGET_NOTE}

Returns: the answer as text, plus {model_used, finish_reason, truncated, usage:{prompt_tokens, completion_tokens, total_tokens, reasoning_tokens?}, estimated_cost_usd, continuations, notes?}.`,
      inputSchema: {
        model: z
          .string()
          .max(200)
          .optional()
          .describe("Exact model id; defaults to DEFAULT_MODEL from .env"),
        task: z
          .string()
          .min(1)
          .max(200_000)
          .describe("Self-contained prompt for the delegated model"),
        json_mode: z.boolean().default(false),
        ...delegationOptionsSchema,
      },
      annotations: DELEGATION_ANNOTATIONS,
    },
    async (params) => {
      try {
        const modelId = params.model ?? cfg.defaultModel;
        if (!modelId) {
          return errorResult(
            "No model specified and DEFAULT_MODEL is not set in .env. Pass 'model' explicitly (use openrouter_list_models to choose one)."
          );
        }
        if (isSystemOneModelId(modelId)) {
          return errorResult(decisionModelRedirect(modelId));
        }
        const model = await client.getModel(modelId);
        if (!model) {
          return errorResult(
            `Model '${modelId}' not found on OpenRouter. Use openrouter_list_models to find a valid id.`
          );
        }
        if (isDecisionModel(model)) {
          return errorResult(decisionModelRedirect(modelId));
        }
        const policy = isAllowedByPolicy(model, cfg);
        if (!policy.allowed) {
          return errorResult(
            `Model '${modelId}' is not allowed: ${policy.reason}. Pick another model with openrouter_list_models.`
          );
        }
        return await delegate(model, params.task, params);
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    }
  );

  // ------------------------------------------------------------------
  // openrouter_auto_delegate
  // ------------------------------------------------------------------
  server.registerTool(
    "openrouter_auto_delegate",
    {
      title: "Auto-Delegate Task by Price Tier",
      description: `Delegate a task letting the SERVER pick the model automatically by price tier, using live OpenRouter pricing and the .env policy. Ideal for saving tokens/cost without browsing the catalog yourself.

Tiers (blended USD per 1M tokens = 0.7*input + 0.3*output; ceilings configurable in .env):
  - "economy" (default): cheapest capable model — bulk/simple work (summaries, extraction, classification).
  - "balanced": mid-price band — general drafting and reasoning.
  - "quality": highest-priced model within the quality cap — harder tasks that still shouldn't use a flagship model.

Args:
  - task (string): self-contained prompt for the delegated model (it does not see this conversation).
  - tier ("economy" | "balanced" | "quality", default "economy").
  - require_tools (boolean, default false): restrict to models with tool/function calling.
  - min_context (integer, default 16000): minimum context window in tokens.
  - system_prompt, max_tokens, auto_continue, reasoning_effort, temperature, web_search, web_max_results: same as openrouter_delegate_task. web_search costs extra (~$4/1000 results, not in estimated_cost_usd).

${BUDGET_NOTE}

Returns: the answer as text, plus {model_used, selection_reason, runners_up, finish_reason, truncated, usage, estimated_cost_usd, continuations, notes?}.`,
      inputSchema: {
        task: z.string().min(1).max(200_000),
        tier: z.enum(["economy", "balanced", "quality"]).default("economy"),
        require_tools: z.boolean().default(false),
        min_context: z.number().int().min(0).default(16_000),
        ...delegationOptionsSchema,
      },
      annotations: DELEGATION_ANNOTATIONS,
    },
    async (params) => {
      try {
        const models = await client.listModels();
        const pick = pickModelForTier(
          models,
          params.tier,
          {
            requireTools: params.require_tools,
            minContext: params.min_context,
            textOutputOnly: true,
          },
          cfg
        );
        if ("error" in pick) return errorResult(pick.error);

        // A 404 here means the model has no endpoints compatible with the
        // account's data policy (e.g. ZDR); try the runners-up before failing.
        const candidates = [
          pick.model,
          ...pick.runnersUp
            .map((r) => models.find((m) => m.id === r.id))
            .filter((m): m is OpenRouterModel => m !== undefined),
        ];
        let lastError: unknown;
        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i];
          try {
            const fallbackNote =
              i > 0
                ? `; '${candidates[0].id}' had no endpoints matching the account's data policy, fell back to runner-up '${candidate.id}'`
                : "";
            return await delegate(candidate, params.task, params, {
              selection_reason: pick.reason + fallbackNote,
              candidates_considered: pick.candidatesConsidered,
              runners_up: pick.runnersUp,
            });
          } catch (err) {
            lastError = err;
            const retriable =
              err instanceof OpenRouterError && err.status === 404 && i < candidates.length - 1;
            if (!retriable) throw err;
          }
        }
        throw (
          lastError ??
          new Error(
            "No candidate model has endpoints matching your OpenRouter data policy (see openrouter.ai/settings/privacy)."
          )
        );
      } catch (err) {
        if (err instanceof DelegationError) return errorResult(err.message);
        return errorResult(toErrorMessage(err));
      }
    }
  );

  // ------------------------------------------------------------------
  // openrouter_fetch_response
  // ------------------------------------------------------------------
  server.registerTool(
    "openrouter_fetch_response",
    {
      title: "Fetch a Paged Delegation Response",
      description: `Read the remainder of a delegated answer that was too large to return inline. When a delegation tool reports "response_paged": true it also returns a response_id; call this tool with that id and the offset it reported to get the next chunk, repeating while has_more is true.

Args:
  - response_id (string): id returned by openrouter_delegate_task / openrouter_auto_delegate.
  - offset (integer, default 0): character offset to read from.
  - length (integer, optional): characters to read; defaults to the server's inline limit.

Returns: {text, offset, next_offset, total_chars, has_more}.

Responses are kept in memory for 30 minutes and are lost on server restart; re-run the delegation if the id has expired.`,
      inputSchema: {
        response_id: z.string().min(1).max(100),
        offset: z.number().int().min(0).default(0),
        length: z.number().int().min(1).max(200_000).optional(),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params) => {
      const page = responses.page(
        params.response_id,
        params.offset,
        params.length ?? cfg.maxResponseChars
      );
      if (!page) {
        return errorResult(
          `Response '${params.response_id}' is not available any more (responses expire after 30 minutes and are lost on restart). Re-run the delegation.`
        );
      }
      const footer = page.has_more
        ? `\n\n---\n[paged] characters ${page.offset}-${page.next_offset} of ${page.total_chars}. Continue with offset=${page.next_offset}.`
        : `\n\n---\n[paged] characters ${page.offset}-${page.total_chars} of ${page.total_chars} (end of response).`;
      return textResult(page.text + footer, { ...page });
    }
  );
}
