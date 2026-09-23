import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolContext } from "./context.js";
import { READ_ONLY_ANNOTATIONS, jsonResult, withErrors } from "./result.js";

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
    withErrors(async () => jsonResult({ key: await ctx.client.keyInfo() }))
  );
}
