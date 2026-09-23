import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import { ResponseStore } from "../delegation/responseStore.js";
import type { OpenRouterClient } from "../openrouter/client.js";
import type { ToolContext } from "./context.js";
import { registerCreditTools } from "./credits.js";
import { registerDecisionTools } from "./decide.js";
import { registerDelegationTools } from "./delegate.js";
import { registerModelTools } from "./models.js";

export type { ToolContext } from "./context.js";

/**
 * The response store outlives a single MCP request on purpose: the server is
 * stateless per HTTP request, but paged answers must survive until the agent
 * fetches them.
 */
export function createToolContext(client: OpenRouterClient, cfg: ServerConfig): ToolContext {
  return { client, cfg, responses: new ResponseStore() };
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  registerModelTools(server, ctx);
  registerDelegationTools(server, ctx);
  registerDecisionTools(server, ctx);
  registerCreditTools(server, ctx);
}
