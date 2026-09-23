import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isReasoningModel, supportsTools } from "../models/capabilities.js";
import { isAllowedByPolicy } from "../models/policy.js";
import { blendedPricePerM, isFreeModel } from "../models/pricing.js";
import type { ToolContext } from "./context.js";
import { modelSummary, summariesToMarkdown } from "./render.js";
import {
  READ_ONLY_ANNOTATIONS,
  errorResult,
  jsonResult,
  textResult,
  withErrors,
} from "./result.js";

export function registerModelTools(server: McpServer, ctx: ToolContext): void {
  const { client, cfg } = ctx;

  server.registerTool(
    "openrouter_list_models",
    {
      title: "List OpenRouter Models",
      description: `List the models currently available on OpenRouter with LIVE pricing (USD per 1M tokens), context window, per-request output cap, and tool-calling support. Use this to find cheap models before delegating with openrouter_delegate_task.

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

Returns: total/count/offset plus rows of {id, name, context_length, max_completion_tokens, prompt_price_per_m, completion_price_per_m, blended_price_per_m, supports_tools, free, modality}.`,
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
        include_free: z.boolean().default(true).describe("Include free ($0) models"),
        sort: z
          .enum(["price", "context", "newest"])
          .default("price")
          .describe("Sort order: price (cheapest first), context (largest first), newest"),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).default(0),
        response_format: z.enum(["markdown", "json"]).default("markdown"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrors(async (params) => {
      const all = await client.listModels();
      let models = all.filter((m) => isAllowedByPolicy(m, cfg).allowed);

      if (params.search) {
        const q = params.search.toLowerCase();
        models = models.filter(
          (m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
        );
      }
      if (!params.include_free) models = models.filter((m) => !isFreeModel(m));
      if (params.require_tools) models = models.filter(supportsTools);
      const { min_context: minContext, max_blended_price_per_m: maxPrice } = params;
      if (minContext !== undefined) {
        models = models.filter((m) => (m.context_length ?? 0) >= minContext);
      }
      if (maxPrice !== undefined) {
        models = models.filter((m) => blendedPricePerM(m) <= maxPrice);
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
      const hasMore = total > params.offset + rows.length;
      const output = {
        total,
        count: rows.length,
        offset: params.offset,
        has_more: hasMore,
        ...(hasMore ? { next_offset: params.offset + rows.length } : {}),
        models: rows,
      };

      let text =
        params.response_format === "markdown"
          ? `Found ${total} models (showing ${rows.length} from offset ${params.offset}, sorted by ${params.sort}).\n\n` +
            summariesToMarkdown(rows)
          : JSON.stringify(output, null, 2);
      if (text.length > cfg.maxResponseChars) {
        text =
          text.slice(0, cfg.maxResponseChars) +
          "\n\n[Truncated. Use 'limit'/'offset' or add filters to narrow results.]";
      }
      return textResult(text, output);
    })
  );

  server.registerTool(
    "openrouter_get_model",
    {
      title: "Get OpenRouter Model Details",
      description: `Get full details for one OpenRouter model by exact id (e.g. "openai/gpt-4.1-mini"): description, live pricing per 1M tokens, context window, per-request output cap, whether it is a reasoning model, and whether this server's .env policy allows delegating to it.

Args:
  - model (string): exact model id as returned by openrouter_list_models.

Returns: the model record plus {is_reasoning_model, allowed_by_policy, policy_reason}.`,
      inputSchema: {
        model: z.string().min(1).max(200).describe("Exact model id, e.g. 'deepseek/deepseek-chat'"),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    withErrors(async (params) => {
      const model = await client.getModel(params.model);
      if (!model) {
        return errorResult(
          `Model '${params.model}' not found in the OpenRouter catalog. Use openrouter_list_models with a 'search' filter to find the right id.`
        );
      }
      const policy = isAllowedByPolicy(model, cfg);
      return jsonResult({
        ...modelSummary(model),
        description: model.description ?? "",
        input_modalities: model.architecture?.input_modalities ?? ["text"],
        output_modalities: model.architecture?.output_modalities ?? ["text"],
        is_reasoning_model: isReasoningModel(model),
        supported_parameters: model.supported_parameters ?? [],
        allowed_by_policy: policy.allowed,
        policy_reason: policy.reason ?? "allowed",
      });
    })
  );
}
