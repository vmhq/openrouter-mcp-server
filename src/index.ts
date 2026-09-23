#!/usr/bin/env node
/**
 * OpenRouter MCP Server
 *
 * Remote MCP server (streamable HTTP, stateless JSON) that lets AI agents
 * delegate tasks to cheaper models through the OpenRouter API, with live
 * pricing and a .env-driven cost policy.
 *
 * This is the only module with process-level side effects: it reads the
 * environment, touches the OAuth state file, starts timers and listens.
 */
import { config as loadEnv } from "dotenv";
import { createApp, type AppDeps } from "./app.js";
import { ConfigError, loadConfig, type ServerConfig } from "./config.js";
import { PocketIdClient } from "./oauth/pocketid.js";
import { OAuthStore } from "./oauth/store.js";
import { OpenRouterClient } from "./openrouter/client.js";

function readConfig(): ServerConfig {
  loadEnv();
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`ERROR: ${err.message}\nSee .env.example for the supported variables.`);
      process.exit(1);
    }
    throw err;
  }
}

/** OAuth is on only when PocketID is configured. */
function startOAuth(cfg: ServerConfig): AppDeps["oauth"] {
  if (!cfg.pocketId) return undefined;
  const store = new OAuthStore({ path: cfg.oauthStatePath, tokenTtlS: cfg.oauthTokenTtlS });
  store.load();
  store.checkWritable();
  store.startPruning();
  return { store, idp: new PocketIdClient(cfg.pocketId) };
}

function main(): void {
  const cfg = readConfig();
  const app = createApp({
    cfg,
    openRouter: new OpenRouterClient(cfg),
    oauth: startOAuth(cfg),
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
}

main();
