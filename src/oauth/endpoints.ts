/**
 * OAuth 2.1 HTTP endpoint handlers and token verification (Express).
 *
 * Standards implemented:
 *   RFC 6749  – OAuth 2.0
 *   RFC 7591  – Dynamic Client Registration
 *   RFC 7636  – PKCE
 *   RFC 8414  – Authorization Server Metadata
 *   RFC 8707  – Resource Indicators
 *   RFC 9728  – OAuth 2.0 Protected Resource Metadata
 */
import { randomBytes } from "node:crypto";
import type { Request, Response } from "express";
import {
  accessTokens,
  clients,
  codes,
  CODE_TTL_MS,
  pendingAuth,
  PENDING_TTL_MS,
  pruneExpiredOAuthState,
  saveState,
  sha256,
  TOKEN_TTL_S,
  type RegisteredClient,
} from "./state.js";
import {
  expandRedirectUris,
  isRegistrableRedirectUri,
  redirectUriMatches,
} from "./redirectUri.js";
import {
  buildAuthorizationRedirectUrl,
  renderAuthorizeConsent,
  renderAuthorizeError,
  renderAuthorizeSuccess,
} from "./views.js";
import {
  buildPocketIdAuthUrl,
  exchangePocketIdCode,
  type PocketIdConfig,
} from "./pocketid.js";

export type OAuthConfig = {
  publicUrl?: string;
  iconUrl?: string;
  /** PocketID identity provider. When unset, interactive authorization is disabled. */
  pocketId?: PocketIdConfig;
};

export type AuthInfo = {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
};

// ─── CORS headers (required for browser-based OAuth discovery) ────────────────

export const OAUTH_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
} as const;

function oauthError(res: Response, error: string, status = 400): void {
  res.status(status).set(OAUTH_CORS_HEADERS).json({ error });
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function baseUrl(config: OAuthConfig, req: Request): string {
  if (config.publicUrl) return config.publicUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

/** Redirect URI registered with PocketID for this server (the OIDC callback). */
function callbackUri(config: OAuthConfig, req: Request): string {
  return `${baseUrl(config, req)}/oauth/callback`;
}

// ─── Discovery metadata ───────────────────────────────────────────────────────

/** 401 response with RFC 9728 WWW-Authenticate header */
export function sendUnauthorized(config: OAuthConfig, req: Request, res: Response): void {
  const root = baseUrl(config, req);
  res
    .status(401)
    .set({
      "WWW-Authenticate": `Bearer realm="${root}", resource_metadata="${root}/.well-known/oauth-protected-resource"`,
      ...OAUTH_CORS_HEADERS,
    })
    .json({ error: "unauthorized" });
}

/** RFC 9728 – /.well-known/oauth-protected-resource */
export function protectedResourceMetadata(config: OAuthConfig, req: Request, res: Response): void {
  const root = baseUrl(config, req);
  res.set(OAUTH_CORS_HEADERS).json({
    resource: `${root}/mcp`,
    authorization_servers: [root],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
}

/** RFC 8414 – /.well-known/oauth-authorization-server */
export function authorizationServerMetadata(config: OAuthConfig, req: Request, res: Response): void {
  const root = baseUrl(config, req);
  res.set(OAUTH_CORS_HEADERS).json({
    issuer: root,
    authorization_endpoint: `${root}/oauth/authorize`,
    token_endpoint: `${root}/oauth/token`,
    registration_endpoint: `${root}/oauth/register`,
    revocation_endpoint: `${root}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    ...(config.iconUrl ? { logo_uri: config.iconUrl } : {}),
  });
}

// ─── RFC 7591 – dynamic client registration ───────────────────────────────────

export function registerClient(req: Request, res: Response): void {
  const body: Record<string, unknown> =
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};

  const redirectUris = expandRedirectUris(
    Array.isArray(body.redirect_uris)
      ? (body.redirect_uris as unknown[]).filter(
          (u): u is string => typeof u === "string" && isRegistrableRedirectUri(u)
        )
      : []
  );

  if (redirectUris.length === 0) {
    oauthError(res, "invalid_redirect_uris");
    return;
  }

  const clientId = `ormcp_${randomBytes(18).toString("base64url")}`;
  const clientIdIssuedAt = Math.floor(Date.now() / 1000);
  const client: RegisteredClient = {
    clientId,
    clientIdIssuedAt,
    redirectUris,
    clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 256) : undefined,
  };
  clients.set(clientId, client);
  saveState();

  console.error(`oauth_client_registered: ${clientId} (${redirectUris.length} redirect URIs)`);

  res.status(201).set(OAUTH_CORS_HEADERS).json({
    client_id: clientId,
    client_id_issued_at: clientIdIssuedAt,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code"],
    response_types: ["code"],
    scope: "mcp",
    ...(client.clientName ? { client_name: client.clientName } : {}),
  });
}

// ─── GET /oauth/authorize ─────────────────────────────────────────────────────

/**
 * Entry point for the MCP client's authorization request. Validates the client,
 * redirect URI, and PKCE, stores a pending transaction, then redirects the
 * browser to PocketID for the actual user authentication. PocketID returns to
 * GET /oauth/callback once the user signs in.
 */
export async function beginAuthorize(req: Request, res: Response, config: OAuthConfig): Promise<void> {
  if (!config.pocketId) {
    console.error("oauth_pocketid_not_configured");
    renderAuthorizeError(
      res,
      "Identity provider is not configured. Set POCKETID_ISSUER, POCKETID_CLIENT_ID and POCKETID_CLIENT_SECRET."
    );
    return;
  }

  const get = (k: string) => {
    const v = req.query[k];
    return typeof v === "string" ? v : "";
  };
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  const codeChallenge = get("code_challenge");
  const codeChallengeMethod = get("code_challenge_method");
  const state = get("state");
  const scope = get("scope") || "mcp";
  const resource = get("resource");

  // RFC 8707 §2.1: the resource parameter must be an absolute URI.
  if (resource) {
    try {
      new URL(resource);
    } catch {
      renderAuthorizeError(res, "The resource indicator must be a valid absolute URL.");
      return;
    }
  }

  // 1. Client must exist and redirect URI must be registered (port-agnostic for loopback)
  const client = clients.get(clientId);
  if (!client) {
    console.error(`oauth_authorize_client_not_found: ${clientId}`);
    renderAuthorizeError(
      res,
      "This client is no longer registered. Please remove this MCP server from your client and re-add it to trigger fresh registration."
    );
    return;
  }
  const matchedUri = client.redirectUris.find((r) => redirectUriMatches(redirectUri, r));
  if (!matchedUri || !isRegistrableRedirectUri(redirectUri)) {
    console.error(`oauth_authorize_invalid_redirect_uri: ${clientId} ${redirectUri}`);
    renderAuthorizeError(res, "The redirect URI is not registered for this client.");
    return;
  }

  // 2. PKCE: must be S256
  if (!codeChallenge || codeChallengeMethod !== "S256") {
    console.error(`oauth_authorize_invalid_pkce: ${clientId}`);
    renderAuthorizeError(res, "PKCE validation failed. The client must use the S256 code challenge method.");
    return;
  }

  // 3. Stash the pending request and redirect the user to PocketID
  pruneExpiredOAuthState();

  const txn = randomBytes(24).toString("base64url");
  const pkceVerifier = randomBytes(32).toString("base64url");
  pendingAuth.set(txn, {
    clientId,
    redirectUri,
    codeChallenge,
    state,
    scopes: scope.split(/\s+/).filter(Boolean),
    resource: resource || undefined,
    pkceVerifier,
    expiresAt: Date.now() + PENDING_TTL_MS,
  });
  saveState();

  let authUrl: string;
  try {
    authUrl = await buildPocketIdAuthUrl(config.pocketId, callbackUri(config, req), {
      state: txn,
      codeChallenge: sha256(pkceVerifier),
    });
  } catch (err) {
    pendingAuth.delete(txn);
    saveState();
    console.error(
      "oauth_pocketid_discovery_failed:",
      err instanceof Error ? err.message : String(err)
    );
    renderAuthorizeError(res, "Could not reach the identity provider. Please try again later.");
    return;
  }

  renderAuthorizeConsent(res, authUrl, { clientName: client.clientName });
}

// ─── GET /oauth/callback ──────────────────────────────────────────────────────

/**
 * PocketID redirects here after the user authenticates. Exchanges the PocketID
 * code, then issues our own authorization code bound to the original MCP client
 * request and redirects the browser back to the MCP client's redirect URI.
 */
export async function oauthCallback(req: Request, res: Response, config: OAuthConfig): Promise<void> {
  const get = (k: string) => {
    const v = req.query[k];
    return typeof v === "string" ? v : "";
  };
  const code = get("code");
  const txn = get("state");
  const providerError = get("error");

  if (providerError) {
    console.error(`oauth_pocketid_returned_error: ${providerError}`);
    renderAuthorizeError(res, "The identity provider denied the sign-in request.");
    return;
  }

  // Single-use: consume the pending transaction immediately
  const pending = pendingAuth.get(txn);
  if (pending) { pendingAuth.delete(txn); saveState(); }

  if (!pending || pending.expiresAt < Date.now()) {
    console.error("oauth_callback_unknown_transaction");
    renderAuthorizeError(res, "Your sign-in session expired or is invalid. Please try connecting again.");
    return;
  }
  if (!code) {
    renderAuthorizeError(res, "Missing authorization code from the identity provider.");
    return;
  }
  if (!config.pocketId) {
    renderAuthorizeError(res, "Identity provider is not configured.");
    return;
  }

  const result = await exchangePocketIdCode(
    config.pocketId,
    callbackUri(config, req),
    code,
    pending.pkceVerifier
  );
  if (!result.ok) {
    console.error(`oauth_pocketid_exchange_failed: ${result.error}`);
    renderAuthorizeError(res, "Sign-in with the identity provider failed. Please try again.");
    return;
  }

  // Issue our own authorization code bound to the original MCP client request
  const mcpCode = randomBytes(24).toString("base64url");
  codes.set(mcpCode, {
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    scopes: pending.scopes.length ? pending.scopes : ["mcp"],
    resource: pending.resource,
    expiresAt: Date.now() + CODE_TTL_MS,
  });
  saveState();

  const redirectUrl = buildAuthorizationRedirectUrl(pending.redirectUri, mcpCode, pending.state);

  console.error(`oauth_authorization_code_issued: ${pending.clientId}`);
  renderAuthorizeSuccess(res, redirectUrl);
}

// ─── POST /oauth/token ────────────────────────────────────────────────────────

export function exchangeToken(req: Request, res: Response): void {
  const body: Record<string, unknown> =
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const param = (k: string) => (body[k] !== undefined && body[k] !== null ? String(body[k]) : "");

  const grantType = param("grant_type");
  const code = param("code");
  const redirectUri = param("redirect_uri");
  const clientId = param("client_id");
  const codeVerifier = param("code_verifier");
  const resource = param("resource");

  if (grantType !== "authorization_code") {
    oauthError(res, "unsupported_grant_type");
    return;
  }

  const ac = codes.get(code);
  // Single-use: delete immediately (even on failure)
  if (codes.delete(code)) saveState();

  if (!ac || ac.expiresAt < Date.now() || ac.clientId !== clientId) {
    oauthError(res, "invalid_grant");
    return;
  }
  // RFC 8252 §7.3: match redirect URI port-agnostic for loopback
  if (!redirectUriMatches(redirectUri, ac.redirectUri)) {
    oauthError(res, "invalid_grant");
    return;
  }
  // PKCE S256 verification
  if (sha256(codeVerifier) !== ac.codeChallenge) {
    oauthError(res, "invalid_grant");
    return;
  }
  // RFC 8707: if resource was bound at authorize time it must match token request
  if (ac.resource && resource && ac.resource !== resource) {
    oauthError(res, "invalid_target");
    return;
  }

  const accessToken = `ormcp_at_${randomBytes(32).toString("base64url")}`;
  const expiresAt = Date.now() + TOKEN_TTL_S * 1000;
  accessTokens.set(sha256(accessToken), {
    clientId,
    scopes: ac.scopes,
    resource: ac.resource,
    expiresAt,
  });
  saveState();

  console.error(`oauth_access_token_issued: ${clientId} (expires in ${TOKEN_TTL_S}s)`);

  res.set(OAUTH_CORS_HEADERS).json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: TOKEN_TTL_S,
    scope: ac.scopes.join(" "),
  });
}

// ─── POST /oauth/revoke ───────────────────────────────────────────────────────

export function revokeToken(req: Request, res: Response): void {
  const body: Record<string, unknown> =
    typeof req.body === "object" && req.body !== null ? (req.body as Record<string, unknown>) : {};
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) {
    oauthError(res, "invalid_request");
    return;
  }

  const existed = accessTokens.delete(sha256(token));
  if (existed) saveState();

  res.set(OAUTH_CORS_HEADERS).json({});
}

// ─── Token verification ───────────────────────────────────────────────────────

/**
 * Verifies an OAuth access token and returns structured AuthInfo.
 * Returns undefined if the token is invalid or expired.
 */
export function verifyAccessToken(token: string): AuthInfo | undefined {
  if (!token) return undefined;
  const hash = sha256(token);
  const stored = accessTokens.get(hash);
  if (!stored) return undefined;
  if (stored.expiresAt <= Date.now()) {
    accessTokens.delete(hash);
    return undefined;
  }
  return {
    token,
    clientId: stored.clientId,
    scopes: stored.scopes,
    expiresAt: Math.floor(stored.expiresAt / 1000),
  };
}
