import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  READ_ONLY_ANNOTATIONS,
  type ToolContext,
  errorResult,
  jsonResult,
  toErrorMessage,
} from "./shared.js";

export function registerCreditTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "openrouter_check_credits",
    {
      title: "Check OpenRouter Key Usage",
      description: `Check the OpenRouter API key configured on this server: label, accumulated usage in USD, spending limit (if any), and whether it's on the free tier. Useful before delegating large batches of work.

Args: none.

Returns: the key info object from OpenRouter (fields like label, usage, limit, limit_remaining, is_free_tier).`,
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const info = await ctx.client.keyInfo();
        return jsonResult({ key: info });
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    }
  );
}
