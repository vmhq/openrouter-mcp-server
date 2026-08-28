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
import {
  authorizationServerMetadata,
  beginAuthorize,
  exchangeToken,
  oauthCallback,
  OAUTH_CORS_HEADERS,
  protectedResourceMetadata,
  registerClient,
  revokeToken,
  sendUnauthorized,
  verifyAccessToken,
  type OAuthConfig,
} from "./oauth/endpoints.js";
import { constantTimeEqual } from "./oauth/state.js";

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

// OAuth authorization server + PocketID identity provider.
//
// This server is the OAuth 2.1 authorization server toward MCP clients
// (dynamic client registration + PKCE + token issuance); PocketID is the
// upstream OIDC identity provider for the human login step. The static
// MCP_AUTH_TOKEN bearer keeps working for machine-to-machine access.
const oauthCfg: OAuthConfig = {
  publicUrl: cfg.publicUrl,
  iconUrl: OPENROUTER_ICON_CDN_URL,
  pocketId: cfg.pocketId,
};
const oauthEnabled = Boolean(cfg.pocketId);

// CORS preflight for OAuth discovery and endpoints (browser-based clients).
app.options(["/mcp", "/.well-known/*", "/oauth/*"], (_req, res) => {
  res.status(204).set(OAUTH_CORS_HEADERS).end();
});

// RFC 9728 – protected resource metadata (also under /mcp path suffix,
// which some clients request per the MCP authorization spec).
app.get(
  ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
  (req, res) => protectedResourceMetadata(oauthCfg, req, res)
);

// RFC 8414 – authorization server metadata (+ OIDC alias some clients probe).
app.get(
  [
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
    "/.well-known/openid-configuration",
  ],
  (req, res) => authorizationServerMetadata(oauthCfg, req, res)
);

// RFC 7591 – public dynamic client registration.
app.post("/oauth/register", (req, res) => registerClient(req, res));

// Interactive authorization: validates the MCP client request, then bounces
// the browser to PocketID for passkey sign-in.
app.get("/oauth/authorize", (req, res) => void beginAuthorize(req, res, oauthCfg));

// PocketID returns here; we issue our own code back to the MCP client.
app.get("/oauth/callback", (req, res) => void oauthCallback(req, res, oauthCfg));

// Code → access token exchange (PKCE-verified) and revocation.
app.post("/oauth/token", (req, res) => exchangeToken(req, res));
app.post("/oauth/revoke", (req, res) => revokeToken(req, res));

// Bearer protection for /mcp: accepts the static MCP_AUTH_TOKEN (if set) or
// an OAuth-issued access token. With neither configured, stays open (local use).
app.use("/mcp", (req, res, next) => {
  if (!cfg.mcpAuthToken && !oauthEnabled) return next();
  const auth = req.headers.authorization ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const isStaticToken = Boolean(cfg.mcpAuthToken) && token !== "" &&
    constantTimeEqual(token, cfg.mcpAuthToken as string);
  if (isStaticToken || verifyAccessToken(token)) return next();
  sendUnauthorized(oauthCfg, req, res);
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
  const authModes = [
    cfg.mcpAuthToken ? "static bearer" : null,
    cfg.pocketId ? "OAuth via PocketID" : null,
  ].filter(Boolean);
  console.error(
    `openrouter-mcp-server listening on http://localhost:${cfg.port}/mcp` +
      (authModes.length ? ` (auth: ${authModes.join(" + ")})` : " (no auth — local use only)")
  );
});
