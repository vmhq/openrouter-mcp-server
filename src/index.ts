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
import { createToolContext, registerTools } from "./tools/index.js";
import { OAUTH_CORS_HEADERS, sendUnauthorized } from "./oauth/handlers.js";
import { PocketIdClient } from "./oauth/pocketid.js";
import { createOAuthRouter } from "./oauth/router.js";
import { OAuthStore } from "./oauth/store.js";
import { bearerAuth, errorHandler } from "./http.js";

const cfg = loadConfig();
const client = new OpenRouterClient(cfg);
// Shared across requests: the model cache and paged responses must outlive the
// per-request McpServer instances built below.
const toolContext = createToolContext(client, cfg);

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
  registerTools(server, toolContext);
  return server;
}

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: false, limit: "1mb" }));

// CORS preflight for /mcp and the OAuth endpoints (browser-based clients).
app.options(["/mcp", "/.well-known/*", "/oauth/*"], (_req, res) => {
  res.status(204).set(OAUTH_CORS_HEADERS).end();
});

// Interactive OAuth sign-in via PocketID, only when it is configured. The
// static MCP_AUTH_TOKEN bearer keeps working alongside it for
// machine-to-machine access.
let oauthStore: OAuthStore | undefined;
if (cfg.pocketId) {
  oauthStore = new OAuthStore({ path: cfg.oauthStatePath, tokenTtlS: cfg.oauthTokenTtlS });
  oauthStore.load();
  oauthStore.checkWritable();
  oauthStore.startPruning();
  app.use(
    createOAuthRouter({
      store: oauthStore,
      idp: new PocketIdClient(cfg.pocketId),
      publicUrl: cfg.publicUrl,
      iconUrl: OPENROUTER_ICON_CDN_URL,
    })
  );
}
const store = oauthStore;

// Bearer protection for /mcp: the static MCP_AUTH_TOKEN and/or OAuth tokens.
app.use(
  "/mcp",
  bearerAuth({
    staticToken: cfg.mcpAuthToken,
    verifyToken: store ? (token) => store.verifyToken(token) !== undefined : undefined,
    onUnauthorized: (req, res) =>
      sendUnauthorized({ publicUrl: cfg.publicUrl, oauthEnabled: Boolean(store) }, req, res),
  })
);

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

app.use(errorHandler);

app.listen(cfg.port, () => {
  const authModes = [
    cfg.mcpAuthToken ? "static bearer" : null,
    cfg.pocketId ? "OAuth via PocketID" : null,
  ].filter(Boolean);
  console.error(
    `openrouter-mcp-server listening on http://localhost:${cfg.port}/mcp` +
      (authModes.length ? ` (auth: ${authModes.join(" + ")})` : " (no auth — local use only)")
  );
});
