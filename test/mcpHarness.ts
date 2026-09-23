import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../src/config.js";
import { OpenRouterClient } from "../src/openrouter/client.js";
import { createToolContext, registerTools } from "../src/tools/index.js";

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Connects a real MCP client to the tool server over an in-memory transport. */
export async function connectToolServer(cfg: ServerConfig) {
  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerTools(server, createToolContext(new OpenRouterClient(cfg), cfg));
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    client,
    async call(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
      return (await client.callTool({ name, arguments: args })) as ToolCallResult;
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}
