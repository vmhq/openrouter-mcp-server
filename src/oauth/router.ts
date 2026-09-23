import { Router } from "express";
import { asyncHandler } from "../http.js";
import {
  authorizationServerMetadata,
  beginAuthorize,
  exchangeToken,
  oauthCallback,
  protectedResourceMetadata,
  registerClient,
  revokeToken,
  type OAuthDeps,
} from "./handlers.js";

/**
 * OAuth authorization server + PocketID identity provider.
 *
 * This server is the OAuth 2.1 authorization server toward MCP clients
 * (dynamic client registration + PKCE + token issuance); PocketID is the
 * upstream OIDC identity provider for the human login step.
 */
export function createOAuthRouter(deps: OAuthDeps): Router {
  const router = Router();

  // RFC 9728 – protected resource metadata (also under /mcp path suffix,
  // which some clients request per the MCP authorization spec).
  router.get(
    ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"],
    (req, res) => protectedResourceMetadata(deps, req, res)
  );

  // RFC 8414 – authorization server metadata (+ OIDC alias some clients probe).
  router.get(
    [
      "/.well-known/oauth-authorization-server",
      "/.well-known/oauth-authorization-server/mcp",
      "/.well-known/openid-configuration",
    ],
    (req, res) => authorizationServerMetadata(deps, req, res)
  );

  // RFC 7591 – public dynamic client registration.
  router.post("/oauth/register", (req, res) => registerClient(deps, req, res));

  // Interactive authorization: validates the MCP client request, then bounces
  // the browser to PocketID for passkey sign-in.
  router.get(
    "/oauth/authorize",
    asyncHandler((req, res) => beginAuthorize(deps, req, res))
  );

  // PocketID returns here; we issue our own code back to the MCP client.
  router.get(
    "/oauth/callback",
    asyncHandler((req, res) => oauthCallback(deps, req, res))
  );

  // Code → access token exchange (PKCE-verified) and revocation.
  router.post("/oauth/token", (req, res) => exchangeToken(deps, req, res));
  router.post("/oauth/revoke", (req, res) => revokeToken(deps, req, res));

  return router;
}
