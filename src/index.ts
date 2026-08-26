#!/usr/bin/env node
/**
 * OpenRouter MCP Server
 *
 * Remote MCP server (streamable HTTP, stateless JSON) that lets AI agents
 * delegate tasks to cheaper models through the OpenRouter API, with live
 * pricing and a .env-driven cost policy.
 */

import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig } from "./config.js";
import { OPENROUTER_ICON_CDN_URL, OPENROUTER_ICON_DATA_URI } from "./icon.js";
import { OpenRouterClient } from "./openrouter.js";
import { registerTools } from "./tools.js";

const cfg = loadConfig();
const client = new OpenRouterClient(cfg);

function buildServer(): McpServer {
  const server = new McpServer({
    name: "openrouter-mcp-server",
    title: "OpenRouter",
    version: "1.0.0",
    websiteUrl: "https://openrouter.ai",
    // MCP standard `icons` on serverInfo: data URI first (always loadable by
    // the client), CDN URL as an alternate for clients that prefer https.
    icons: [
      {
        src: OPENROUTER_ICON_DATA_URI,
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
      {
        src: OPENROUTER_ICON_CDN_URL,
        mimeType: "image/svg+xml",
        sizes: ["any"],
      },
    ],
  });
  registerTools(server, client, cfg);
  return server;
}

const app = express();
app.use(express.json({ limit: "10mb" }));

// Optional bearer-token protection for remote exposure.
app.use("/mcp", (req, res, next) => {
  if (!cfg.mcpAuthToken) return next();
  const auth = req.headers.authorization;
  if (auth === `Bearer ${cfg.mcpAuthToken}`) return next();
  res.status(401).json({
    jsonrpc: "2.0",
    error: { code: -32001, message: "Unauthorized: missing or invalid bearer token" },
    id: null,
  });
});

app.post("/mcp", async (req, res) => {
  // Stateless: fresh server+transport per request avoids request-id collisions.
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless server: no SSE stream or sessions to manage.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. Use POST /mcp." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.get("/health", (_req, res) => {
  res.json({ status: "ok", server: "openrouter-mcp-server" });
});

app.listen(cfg.port, () => {
  console.error(
    `openrouter-mcp-server listening on http://localhost:${cfg.port}/mcp` +
      (cfg.mcpAuthToken ? " (bearer auth enabled)" : " (no auth — local use only)")
  );
});
