/**
 * PocketID (OIDC) client used as the upstream identity provider.
 *
 * The MCP server acts as an OAuth bridge: it remains the authorization server
 * toward MCP clients (DCR + PKCE + token issuance) but delegates the actual
 * user authentication step to a PocketID instance via the standard OIDC
 * authorization-code + PKCE flow.
 *
 * PocketID is a standard OIDC provider:
 *   - Discovery:  {issuer}/.well-known/openid-configuration
 *   - PKCE (S256) supported on the authorization endpoint
 *   - Token endpoint auth: client_secret_post (credentials in the form body)
 */
import type { PocketIdSettings } from "../config.js";
import { errorMessage } from "../util.js";

type Discovery = {
  authorization_endpoint: string;
  token_endpoint: string;
};

const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

export type ExchangeResult = { ok: true } | { ok: false; error: string };

export class PocketIdClient {
  private discoveryCache: { data: Discovery; expiresAt: number } | undefined;

  constructor(
    private readonly cfg: PocketIdSettings,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly now: () => number = Date.now
  ) {}

  /** Fetch (and cache) the OIDC discovery document for the configured issuer. */
  private async discover(): Promise<Discovery> {
    if (this.discoveryCache && this.discoveryCache.expiresAt > this.now()) {
      return this.discoveryCache.data;
    }

    const url = `${this.cfg.issuer}/.well-known/openid-configuration`;
    const res = await this.fetchImpl(url, { headers: { accept: "application/json" } });
    if (!res.ok) {
      throw new Error(`pocketid_discovery_http_${res.status}`);
    }

    const json = (await res.json()) as Partial<Discovery>;
    if (!json.authorization_endpoint || !json.token_endpoint) {
      throw new Error("pocketid_discovery_incomplete");
    }

    const data: Discovery = {
      authorization_endpoint: json.authorization_endpoint,
      token_endpoint: json.token_endpoint,
    };
    this.discoveryCache = { data, expiresAt: this.now() + DISCOVERY_TTL_MS };
    return data;
  }

  /**
   * Build the PocketID authorization URL the browser is redirected to.
   * `state` carries our pending-transaction id; `codeChallenge` is the S256
   * challenge for the PocketID leg of the flow.
   */
  async authorizationUrl(
    callbackUri: string,
    params: { state: string; codeChallenge: string }
  ): Promise<string> {
    const { authorization_endpoint } = await this.discover();
    const u = new URL(authorization_endpoint);
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", this.cfg.clientId);
    u.searchParams.set("redirect_uri", callbackUri);
    u.searchParams.set("scope", this.cfg.scopes.join(" "));
    u.searchParams.set("state", params.state);
    u.searchParams.set("code_challenge", params.codeChallenge);
    u.searchParams.set("code_challenge_method", "S256");
    return u.toString();
  }

  /**
   * Exchange the PocketID authorization code for tokens (client_secret_post).
   * Returns ok=true when PocketID confirms a successful authentication. We trust
   * PocketID's client-level group restriction, so the tokens themselves are not
   * propagated downstream — only the success signal matters.
   */
  async exchangeCode(
    callbackUri: string,
    code: string,
    codeVerifier: string
  ): Promise<ExchangeResult> {
    let tokenEndpoint: string;
    try {
      ({ token_endpoint: tokenEndpoint } = await this.discover());
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }

    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUri,
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code_verifier: codeVerifier,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(tokenEndpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
        },
        body,
      });
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }

    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      console.error("pocketid_token_exchange_http_error:", res.status, detail);
      return { ok: false, error: `pocketid_token_http_${res.status}` };
    }

    const tokens = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (typeof tokens.access_token !== "string" && typeof tokens.id_token !== "string") {
      return { ok: false, error: "pocketid_token_missing" };
    }

    return { ok: true };
  }
}
