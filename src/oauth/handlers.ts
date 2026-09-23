/**
 * OAuth 2.1 HTTP endpoint handlers (Express).
 *
 * Standards implemented:
 *   RFC 6749  – OAuth 2.0
 *   RFC 7591  – Dynamic Client Registration
 *   RFC 7636  – PKCE
 *   RFC 8414  – Authorization Server Metadata
 *   RFC 8707  – Resource Indicators
 *   RFC 9728  – OAuth 2.0 Protected Resource Metadata
 */
import type { Request, Response } from "express";
import { randomToken, sha256 } from "../crypto.js";
import { errorMessage } from "../util.js";
import type { PocketIdClient } from "./pocketid.js";
import { expandRedirectUris, isRegistrableRedirectUri, redirectUriMatches } from "./redirectUri.js";
import type { OAuthStore } from "./store.js";
import {
  buildAuthorizationRedirectUrl,
  renderAuthorizeConsent,
  renderAuthorizeError,
  renderAuthorizeSuccess,
} from "./views.js";

export interface OAuthDeps {
  store: OAuthStore;
  /** Upstream identity provider for the human sign-in step. */
  idp: PocketIdClient;
  /** Public base URL of this server; derived from the request when unset. */
  publicUrl?: string;
  iconUrl?: string;
}

// ─── CORS headers (required for browser-based OAuth discovery) ────────────────

export const OAUTH_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
} as const;

function oauthError(res: Response, error: string, status = 400): void {
  res.status(status).set(OAUTH_CORS_HEADERS).json({ error });
}

// ─── Request helpers ──────────────────────────────────────────────────────────

function bodyOf(req: Request): Record<string, unknown> {
  return typeof req.body === "object" && req.body !== null
    ? (req.body as Record<string, unknown>)
    : {};
}

function queryParam(req: Request, key: string): string {
  const v = req.query[key];
  return typeof v === "string" ? v : "";
}

export function baseUrl(publicUrl: string | undefined, req: Request): string {
  if (publicUrl) return publicUrl.replace(/\/$/, "");
  return `${req.protocol}://${req.get("host") ?? "localhost"}`;
}

/** Redirect URI registered with PocketID for this server (the OIDC callback). */
function callbackUri(deps: OAuthDeps, req: Request): string {
  return `${baseUrl(deps.publicUrl, req)}/oauth/callback`;
}

// ─── Discovery metadata ───────────────────────────────────────────────────────

/**
 * 401 for /mcp. With OAuth enabled the RFC 9728 WWW-Authenticate header
 * points clients at the protected-resource metadata; without it there is
 * nothing to discover, so only the static bearer scheme is announced.
 */
export function sendUnauthorized(
  opts: { publicUrl?: string; oauthEnabled: boolean },
  req: Request,
  res: Response
): void {
  const root = baseUrl(opts.publicUrl, req);
  const challenge = opts.oauthEnabled
    ? `Bearer realm="${root}", resource_metadata="${root}/.well-known/oauth-protected-resource"`
    : `Bearer realm="${root}"`;
  res
    .status(401)
    .set({ "WWW-Authenticate": challenge, ...OAUTH_CORS_HEADERS })
    .json({ error: "unauthorized" });
}

/** RFC 9728 – /.well-known/oauth-protected-resource */
export function protectedResourceMetadata(deps: OAuthDeps, req: Request, res: Response): void {
  const root = baseUrl(deps.publicUrl, req);
  res.set(OAUTH_CORS_HEADERS).json({
    resource: `${root}/mcp`,
    authorization_servers: [root],
    bearer_methods_supported: ["header"],
    scopes_supported: ["mcp"],
  });
}

/** RFC 8414 – /.well-known/oauth-authorization-server */
export function authorizationServerMetadata(deps: OAuthDeps, req: Request, res: Response): void {
  const root = baseUrl(deps.publicUrl, req);
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
    ...(deps.iconUrl ? { logo_uri: deps.iconUrl } : {}),
  });
}

// ─── RFC 7591 – dynamic client registration ───────────────────────────────────

export function registerClient(deps: OAuthDeps, req: Request, res: Response): void {
  const body = bodyOf(req);

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

  const client = deps.store.registerClient({
    redirectUris,
    clientName: typeof body.client_name === "string" ? body.client_name.slice(0, 256) : undefined,
  });

  console.error(
    `oauth_client_registered: ${client.clientId} (${redirectUris.length} redirect URIs)`
  );

  res
    .status(201)
    .set(OAUTH_CORS_HEADERS)
    .json({
      client_id: client.clientId,
      client_id_issued_at: client.clientIdIssuedAt,
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
 * redirect URI, and PKCE, stores a pending transaction, then shows a page that
 * sends the browser to PocketID for the actual user authentication. PocketID
 * returns to GET /oauth/callback once the user signs in.
 */
export async function beginAuthorize(deps: OAuthDeps, req: Request, res: Response): Promise<void> {
  const clientId = queryParam(req, "client_id");
  const redirectUri = queryParam(req, "redirect_uri");
  const codeChallenge = queryParam(req, "code_challenge");
  const codeChallengeMethod = queryParam(req, "code_challenge_method");
  const state = queryParam(req, "state");
  const scope = queryParam(req, "scope") || "mcp";
  const resource = queryParam(req, "resource");

  // RFC 8707 §2.1: the resource parameter must be an absolute URI.
  if (resource && !URL.canParse(resource)) {
    renderAuthorizeError(res, "The resource indicator must be a valid absolute URL.");
    return;
  }

  // 1. Client must exist and redirect URI must be registered (port-agnostic for loopback)
  const client = deps.store.getClient(clientId);
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
    renderAuthorizeError(
      res,
      "PKCE validation failed. The client must use the S256 code challenge method."
    );
    return;
  }

  // 3. Stash the pending request and send the user to PocketID
  const pkceVerifier = randomToken(32);
  const txn = deps.store.beginPending({
    clientId,
    redirectUri,
    codeChallenge,
    state,
    scopes: scope.split(/\s+/).filter(Boolean),
    resource: resource || undefined,
    pkceVerifier,
  });

  let authUrl: string;
  try {
    authUrl = await deps.idp.authorizationUrl(callbackUri(deps, req), {
      state: txn,
      codeChallenge: sha256(pkceVerifier),
    });
  } catch (err) {
    deps.store.cancelPending(txn);
    console.error("oauth_pocketid_discovery_failed:", errorMessage(err));
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
export async function oauthCallback(deps: OAuthDeps, req: Request, res: Response): Promise<void> {
  const code = queryParam(req, "code");
  const txn = queryParam(req, "state");
  const providerError = queryParam(req, "error");

  if (providerError) {
    console.error(`oauth_pocketid_returned_error: ${providerError}`);
    renderAuthorizeError(res, "The identity provider denied the sign-in request.");
    return;
  }

  // Single-use: consume the pending transaction immediately
  const pending = deps.store.consumePending(txn);
  if (!pending) {
    console.error("oauth_callback_unknown_transaction");
    renderAuthorizeError(
      res,
      "Your sign-in session expired or is invalid. Please try connecting again."
    );
    return;
  }
  if (!code) {
    renderAuthorizeError(res, "Missing authorization code from the identity provider.");
    return;
  }

  const result = await deps.idp.exchangeCode(callbackUri(deps, req), code, pending.pkceVerifier);
  if (!result.ok) {
    console.error(`oauth_pocketid_exchange_failed: ${result.error}`);
    renderAuthorizeError(res, "Sign-in with the identity provider failed. Please try again.");
    return;
  }

  // Issue our own authorization code bound to the original MCP client request
  const mcpCode = deps.store.issueCode({
    clientId: pending.clientId,
    redirectUri: pending.redirectUri,
    codeChallenge: pending.codeChallenge,
    scopes: pending.scopes.length ? pending.scopes : ["mcp"],
    resource: pending.resource,
  });

  const redirectUrl = buildAuthorizationRedirectUrl(pending.redirectUri, mcpCode, pending.state);

  console.error(`oauth_authorization_code_issued: ${pending.clientId}`);
  renderAuthorizeSuccess(res, redirectUrl);
}

// ─── POST /oauth/token ────────────────────────────────────────────────────────

export function exchangeToken(deps: OAuthDeps, req: Request, res: Response): void {
  const body = bodyOf(req);
  const param = (k: string) => (body[k] !== undefined && body[k] !== null ? String(body[k]) : "");

  const grantType = param("grant_type");
  const clientId = param("client_id");
  const resource = param("resource");

  if (grantType !== "authorization_code") {
    oauthError(res, "unsupported_grant_type");
    return;
  }

  // Single-use: consumed immediately (even if rejected below)
  const ac = deps.store.consumeCode(param("code"));
  if (!ac || ac.clientId !== clientId) {
    oauthError(res, "invalid_grant");
    return;
  }
  // RFC 8252 §7.3: match redirect URI port-agnostic for loopback
  if (!redirectUriMatches(param("redirect_uri"), ac.redirectUri)) {
    oauthError(res, "invalid_grant");
    return;
  }
  // PKCE S256 verification
  if (sha256(param("code_verifier")) !== ac.codeChallenge) {
    oauthError(res, "invalid_grant");
    return;
  }
  // RFC 8707: if resource was bound at authorize time it must match token request
  if (ac.resource && resource && ac.resource !== resource) {
    oauthError(res, "invalid_target");
    return;
  }

  const accessToken = deps.store.issueToken({
    clientId,
    scopes: ac.scopes,
    resource: ac.resource,
  });
  const ttl = deps.store.tokenTtlS;

  console.error(`oauth_access_token_issued: ${clientId} (expires in ${ttl}s)`);

  res.set(OAUTH_CORS_HEADERS).json({
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ttl,
    scope: ac.scopes.join(" "),
  });
}

// ─── POST /oauth/revoke ───────────────────────────────────────────────────────

export function revokeToken(deps: OAuthDeps, req: Request, res: Response): void {
  const token = bodyOf(req).token;
  if (typeof token !== "string" || !token) {
    oauthError(res, "invalid_request");
    return;
  }
  deps.store.revokeToken(token);
  res.set(OAUTH_CORS_HEADERS).json({});
}
