import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ServerConfig } from "./config.js";
import {
  OpenRouterClient,
  OpenRouterError,
  OpenRouterModel,
  blendedPricePerM,
  estimateCostUsd,
  isFreeModel,
  pricePerM,
  round,
  supportsTools,
} from "./openrouter.js";
import {
  isAllowedByPolicy,
  meetsRequirements,
  pickModelForTier,
} from "./selection.js";

const CHARACTER_LIMIT = 25_000;

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

function toErrorMessage(err: unknown): string {
  if (err instanceof OpenRouterError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function modelSummary(m: OpenRouterModel) {
  return {
    id: m.id,
    name: m.name,
    context_length: m.context_length ?? 0,
    prompt_price_per_m: round(pricePerM(m.pricing.prompt), 4),
    completion_price_per_m: round(pricePerM(m.pricing.completion), 4),
    blended_price_per_m: round(blendedPricePerM(m), 4),
    supports_tools: supportsTools(m),
    free: isFreeModel(m),
    modality: m.architecture?.modality ?? "text->text",
  };
}

type ModelSummary = ReturnType<typeof modelSummary>;

function summariesToMarkdown(rows: ModelSummary[]): string {
  const lines = [
    "| Model | $/M in | $/M out | Context | Tools | Modality |",
    "|---|---|---|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id}${r.free ? " (free)" : ""} | ${r.prompt_price_per_m} | ${
        r.completion_price_per_m
      } | ${r.context_length.toLocaleString("en-US")} | ${
        r.supports_tools ? "yes" : "no"
      } | ${r.modality} |`
    );
  }
  return lines.join("\n");
}

function usageAndCost(
  model: OpenRouterModel,
  result: { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } }
) {
  const cost = estimateCostUsd(model, result.usage);
  return {
    usage: {
      prompt_tokens: result.usage?.prompt_tokens ?? 0,
      completion_tokens: result.usage?.completion_tokens ?? 0,
      total_tokens: result.usage?.total_tokens ?? 0,
    },
    estimated_cost_usd: cost !== undefined ? round(cost, 6) : undefined,
  };
}

export function registerTools(
  server: McpServer,
  client: OpenRouterClient,
  cfg: ServerConfig
): void {
  // ------------------------------------------------------------------
  // openrouter_list_models
  // ------------------------------------------------------------------
  server.registerTool(
    "openrouter_list_models",
    {
      title: "List OpenRouter Models",
      description: `List the models currently available on OpenRouter with LIVE pricing (USD per 1M tokens), context window, and tool-calling support. Use this to find cheap models before delegating with openrouter_delegate_task.

Prices come straight from the OpenRouter catalog (cached for a few minutes). "blended_price_per_m" = 0.7*input + 0.3*output price, used for ranking. Models excluded by this server's .env policy (allow/block lists, price caps) are filtered out by default.

Args:
  - search (string, optional): case-insensitive substring matched against model id and name (e.g. "mini", "deepseek", "google/").
  - max_blended_price_per_m (number, optional): only models at or under this blended USD/M price.
  - min_context (integer, optional): minimum context window in tokens.
  - require_tools (boolean, default false): only models that support tool/function calling.
  - include_free (boolean, default true): include $0 models (they often have strict rate limits).
  - sort (enum, default "price"): "price" (cheapest first), "context" (largest first), or "newest".
  - limit (1-100, default 20) / offset (default 0): pagination.
  - response_format ("markdown" | "json", default "markdown").

Returns: total/count/offset plus rows of {id, name, context_length, prompt_price_per_m, completion_price_per_m, blended_price_per_m, supports_tools, free, modality}.`,
      inputSchema: {
        search: z
          .string()
          .max(200)
          .optional()
          .describe("Substring filter on model id/name, e.g. 'deepseek' or 'openai/'"),
        max_blended_price_per_m: z
          .number()
          .min(0)
          .optional()
          .describe("Max blended price in USD per 1M tokens (0.7*input + 0.3*output)"),
        min_context: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Minimum context window in tokens, e.g. 128000"),
        require_tools: z
          .boolean()
          .default(false)
          .describe("Only models supporting tool/function calling"),
        include_free: z
          .boolean()
          .default(true)
          .describe("Include free ($0) models"),
        sort: z
          .enum(["price", "context", "newest"])
          .default("price")
          .describe("Sort order: price (cheapest first), context (largest first), newest"),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const all = await client.listModels();
        let models = all.filter((m) => isAllowedByPolicy(m, cfg).allowed);

        if (params.search) {
          const q = params.search.toLowerCase();
          models = models.filter(
            (m) =>
              m.id.toLowerCase().includes(q) ||
              m.name.toLowerCase().includes(q)
          );
        }
        if (!params.include_free) models = models.filter((m) => !isFreeModel(m));
        if (params.require_tools) models = models.filter(supportsTools);
        if (params.min_context !== undefined) {
          models = models.filter(
            (m) => (m.context_length ?? 0) >= (params.min_context ?? 0)
          );
        }
        if (params.max_blended_price_per_m !== undefined) {
          models = models.filter(
            (m) => blendedPricePerM(m) <= (params.max_blended_price_per_m ?? 0)
          );
        }

        models.sort((a, b) => {
          switch (params.sort) {
            case "context":
              return (b.context_length ?? 0) - (a.context_length ?? 0);
            case "newest":
              return (b.created ?? 0) - (a.created ?? 0);
            default:
              return blendedPricePerM(a) - blendedPricePerM(b);
          }
        });

        const total = models.length;
        const page = models.slice(params.offset, params.offset + params.limit);
        const rows = page.map(modelSummary);
        const output = {
          total,
          count: rows.length,
          offset: params.offset,
          has_more: total > params.offset + rows.length,
          ...(total > params.offset + rows.length
            ? { next_offset: params.offset + rows.length }
            : {}),
          models: rows,
        };

        let text =
          params.response_format === "markdown"
            ? `Found ${total} models (showing ${rows.length} from offset ${params.offset}, sorted by ${params.sort}).\n\n` +
              summariesToMarkdown(rows)
            : JSON.stringify(output, null, 2);
        if (text.length > CHARACTER_LIMIT) {
          text =
            text.slice(0, CHARACTER_LIMIT) +
            "\n\n[Truncated. Use 'limit'/'offset' or add filters to narrow results.]";
        }
        return {
          content: [{ type: "text" as const, text }],
          structuredContent: output,
        };
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    }
  );

  // ------------------------------------------------------------------
  // openrouter_get_model
  // ------------------------------------------------------------------
  server.registerTool(
    "openrouter_get_model",
    {
      title: "Get OpenRouter Model Details",
      description: `Get full details for one OpenRouter model by exact id (e.g. "openai/gpt-4.1-mini"): description, live pricing per 1M tokens, context window, modalities, supported parameters, and whether this server's .env policy allows delegating to it.

Args:
  - model (string): exact model id as returned by openrouter_list_models.

Returns: the model record plus {allowed_by_policy, policy_reason}.`,
      inputSchema: {
        model: z
          .string()
          .min(1)
          .max(200)
          .describe("Exact model id, e.g. 'deepseek/deepseek-chat'"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const model = await client.getModel(params.model);
        if (!model) {
          return errorResult(
            `Model '${params.model}' not found in the OpenRouter catalog. Use openrouter_list_models with a 'search' filter to find the right id.`
          );
        }
        const policy = isAllowedByPolicy(model, cfg);
        const output = {
          ...modelSummary(model),
          description: model.description ?? "",
          input_modalities: model.architecture?.input_modalities ?? ["text"],
          output_modalities: model.architecture?.output_modalities ?? ["text"],
          max_completion_tokens:
            model.top_provider?.max_completion_tokens ?? null,
          supported_parameters: model.supported_parameters ?? [],
          allowed_by_policy: policy.allowed,
          policy_reason: policy.reason ?? "allowed",
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    }
  );

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
  - max_tokens (integer, optional): completion token cap (also caps cost).
  - temperature (0-2, optional).
  - json_mode (boolean, default false): request a JSON-object response (only for models supporting response_format).

Returns: {model_used, response, finish_reason, usage:{prompt_tokens, completion_tokens, total_tokens}, estimated_cost_usd}.`,
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
        system_prompt: z.string().max(50_000).optional(),
        max_tokens: z.number().int().min(1).max(200_000).optional(),
        temperature: z.number().min(0).max(2).optional(),
        json_mode: z.boolean().default(false),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const modelId = params.model ?? cfg.defaultModel;
        if (!modelId) {
          return errorResult(
            "No model specified and DEFAULT_MODEL is not set in .env. Pass 'model' explicitly (use openrouter_list_models to choose one)."
          );
        }
        const model = await client.getModel(modelId);
        if (!model) {
          return errorResult(
            `Model '${modelId}' not found on OpenRouter. Use openrouter_list_models to find a valid id.`
          );
        }
        const policy = isAllowedByPolicy(model, cfg);
        if (!policy.allowed) {
          return errorResult(
            `Model '${modelId}' is not allowed: ${policy.reason}. Pick another model with openrouter_list_models.`
          );
        }

        const messages: Array<{
          role: "system" | "user" | "assistant";
          content: string;
        }> = [];
        if (params.system_prompt) {
          messages.push({ role: "system", content: params.system_prompt });
        }
        messages.push({ role: "user", content: params.task });

        const result = await client.chatCompletion({
          model: modelId,
          messages,
          maxTokens: params.max_tokens,
          temperature: params.temperature,
          jsonMode: params.json_mode,
        });

        const output = {
          model_used: result.model || modelId,
          response: result.content,
          finish_reason: result.finishReason ?? "unknown",
          ...usageAndCost(model, result),
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
          structuredContent: output,
        };
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
  - system_prompt, max_tokens, temperature: same as openrouter_delegate_task.

Returns: {model_used, selection_reason, runners_up, response, finish_reason, usage, estimated_cost_usd}.`,
      inputSchema: {
        task: z.string().min(1).max(200_000),
        tier: z.enum(["economy", "balanced", "quality"]).default("economy"),
        require_tools: z.boolean().default(false),
        min_context: z.number().int().min(0).default(16_000),
        system_prompt: z.string().max(50_000).optional(),
        max_tokens: z.number().int().min(1).max(200_000).optional(),
        temperature: z.number().min(0).max(2).optional(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
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

        const messages: Array<{
          role: "system" | "user" | "assistant";
          content: string;
        }> = [];
        if (params.system_prompt) {
          messages.push({ role: "system", content: params.system_prompt });
        }
        messages.push({ role: "user", content: params.task });

        // A 404 here means the model has no endpoints compatible with the
        // account's data policy (e.g. ZDR); try the runners-up before failing.
        const candidateIds = [
          pick.model.id,
          ...pick.runnersUp.map((r) => r.id),
        ];
        let result;
        let usedModel = pick.model;
        let fallbackNote = "";
        for (let i = 0; i < candidateIds.length; i++) {
          const id = candidateIds[i];
          try {
            result = await client.chatCompletion({
              model: id,
              messages,
              maxTokens: params.max_tokens,
              temperature: params.temperature,
            });
            usedModel = models.find((m) => m.id === id) ?? pick.model;
            if (i > 0) {
              fallbackNote = `; '${candidateIds[0]}' had no endpoints matching the account's data policy, fell back to runner-up '${id}'`;
            }
            break;
          } catch (err) {
            const retriable =
              err instanceof OpenRouterError &&
              err.status === 404 &&
              i < candidateIds.length - 1;
            if (!retriable) throw err;
          }
        }
        if (!result) {
          return errorResult(
            "No candidate model has endpoints matching your OpenRouter data policy (see openrouter.ai/settings/privacy)."
          );
        }

        const output = {
          model_used: usedModel.id,
          selection_reason: pick.reason + fallbackNote,
          candidates_considered: pick.candidatesConsidered,
          runners_up: pick.runnersUp,
          response: result.content,
          finish_reason: result.finishReason ?? "unknown",
          ...usageAndCost(usedModel, result),
        };
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(output, null, 2) },
          ],
          structuredContent: output,
        };
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    }
  );

  // ------------------------------------------------------------------
  // openrouter_check_credits
  // ------------------------------------------------------------------
  server.registerTool(
    "openrouter_check_credits",
    {
      title: "Check OpenRouter Key Usage",
      description: `Check the OpenRouter API key configured on this server: label, accumulated usage in USD, spending limit (if any), and whether it's on the free tier. Useful before delegating large batches of work.

Args: none.

Returns: the key info object from OpenRouter (fields like label, usage, limit, limit_remaining, is_free_tier).`,
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const info = await client.keyInfo();
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(info, null, 2) },
          ],
          structuredContent: { key: info },
        };
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    }
  );
}
