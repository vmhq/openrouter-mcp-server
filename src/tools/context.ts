import type { ServerConfig } from "../config.js";
import type { ResponseStore } from "../delegation/responseStore.js";
import type { OpenRouterClient } from "../openrouter/client.js";

/** Everything the tool handlers need, assembled once at registration. */
export interface ToolContext {
  client: OpenRouterClient;
  cfg: ServerConfig;
  responses: ResponseStore;
}
