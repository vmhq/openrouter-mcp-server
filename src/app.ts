import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import type { ServerConfig } from "./config.js";
import { bearerAuth, errorHandler } from "./http.js";
import { OPENROUTER_ICON_CDN_URL, OPENROUTER_ICON_DATA_URI } from "./icon.js";
import { OAUTH_CORS_HEADERS, sendUnauthorized } from "./oauth/handlers.js";
import type { PocketIdClient } from "./oauth/pocketid.js";
import { createOAuthRouter } from "./oauth/router.js";
import type { OAuthStore } from "./oauth/store.js";
import type { OpenRouterClient } from "./openrouter.js";
import { createToolContext, registerTools, type ToolContext } from "./tools/index.js";
import { SERVER_VERSION } from "./version.js";

export interface AppDeps {
  cfg: ServerConfig;
  openRouter: OpenRouterClient;
  /** Present only when OAuth (PocketID) is enabled. */
  oauth?: { store: OAuthStore; idp: PocketIdClient };
}

function buildMcpServer(toolContext: ToolContext): McpServer {
  const server = new McpServer({
    name: "openrouter-mcp-server",
    title: "OpenRouter",
    version: SERVER_VERSION,
    websiteUrl: "https://openrouter.ai",
    // MCP standard `icons` on serverInfo: data URI first (always loadable by
    // the client), CDN URL as an alternate for clients that prefer https.
    icons: [
      { src: OPENROUTER_ICON_DATA_URI, mimeType: "image/svg+xml", sizes: ["any"] },
      { src: OPENROUTER_ICON_CDN_URL, mimeType: "image/svg+xml", sizes: ["any"] },
    ],
  });
  registerTools(server, toolContext);
  return server;
}

/**
 * Builds the HTTP app. Pure wiring: no listening socket, timers or disk
 * access, so tests can drive it directly.
 */
export function createApp({ cfg, openRouter, oauth }: AppDeps): express.Express {
  // Shared across requests: the model cache and paged responses must outlive
  // the per-request McpServer instances.
  const toolContext = createToolContext(openRouter, cfg);

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  // CORS preflight for /mcp and the OAuth endpoints (browser-based clients).
  app.options(["/mcp", "/.well-known/*", "/oauth/*"], (_req, res) => {
    res.status(204).set(OAUTH_CORS_HEADERS).end();
  });

  // Interactive OAuth sign-in via PocketID. The static MCP_AUTH_TOKEN bearer
  // keeps working alongside it for machine-to-machine access.
  if (oauth) {
    app.use(
      createOAuthRouter({
        ...oauth,
        publicUrl: cfg.publicUrl,
        iconUrl: OPENROUTER_ICON_CDN_URL,
      })
    );
  }

  // Bearer protection for /mcp: the static MCP_AUTH_TOKEN and/or OAuth tokens.
  app.use(
    "/mcp",
    bearerAuth({
      staticToken: cfg.mcpAuthToken,
      verifyToken: oauth ? (token) => oauth.store.verifyToken(token) !== undefined : undefined,
      onUnauthorized: (req, res) =>
        sendUnauthorized({ publicUrl: cfg.publicUrl, oauthEnabled: Boolean(oauth) }, req, res),
    })
  );

  app.post("/mcp", async (req, res) => {
    // Stateless: fresh server+transport per request avoids request-id collisions.
    const server = buildMcpServer(toolContext);
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
  return app;
}
