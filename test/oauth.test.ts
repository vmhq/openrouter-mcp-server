import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import express from "express";
import { sha256 } from "../src/crypto.js";
import { errorHandler } from "../src/http.js";
import { PocketIdClient } from "../src/oauth/pocketid.js";
import { createOAuthRouter } from "../src/oauth/router.js";
import { OAuthStore, CODE_TTL_MS } from "../src/oauth/store.js";

const ISSUER = "https://id.example.com";
const pocketIdSettings = {
  issuer: ISSUER,
  clientId: "pid-client",
  clientSecret: "pid-secret",
  scopes: ["openid"],
};

/** Minimal PocketID: discovery + a token endpoint that records its form. */
function fakePocketId() {
  const tokenRequests: URLSearchParams[] = [];
  let tokenStatus = 200;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/api/oidc/token`,
      });
    }
    if (url === `${ISSUER}/api/oidc/token`) {
      tokenRequests.push(new URLSearchParams(String(init?.body)));
      return tokenStatus === 200
        ? Response.json({ access_token: "pid-at", id_token: "pid-idt" })
        : new Response("nope", { status: tokenStatus });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return {
    fetchImpl,
    tokenRequests,
    failTokens: () => {
      tokenStatus = 400;
    },
  };
}

/** Pulls a URL out of an href="…" attribute in the rendered HTML. */
function hrefIn(html: string, pattern: RegExp): URL {
  const m = html.match(pattern);
  assert.ok(m, `no match for ${pattern} in page`);
  return new URL(m[1].replace(/&amp;/g, "&").replace(/&quot;/g, '"'));
}

let dir: string;
let store: OAuthStore;
let idp: ReturnType<typeof fakePocketId>;
let server: ReturnType<express.Express["listen"]>;
let base: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ormcp-oauth-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  server?.close();
  store = new OAuthStore({ path: join(dir, `state-${Date.now()}.json`), tokenTtlS: 3600 });
  idp = fakePocketId();
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(
    createOAuthRouter({
      store,
      idp: new PocketIdClient(pocketIdSettings, idp.fetchImpl),
      publicUrl: "https://mcp.example.com",
    })
  );
  app.use(errorHandler);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server?.close());

const quiet = <T>(fn: () => Promise<T>) => {
  const original = console.error;
  console.error = () => {};
  return fn().finally(() => {
    console.error = original;
  });
};

async function register(redirectUri = "http://127.0.0.1:9999/cb") {
  const res = await fetch(`${base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [redirectUri], client_name: "Test <App>" }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { client_id: string };
}

/** Runs authorize → PocketID → callback and returns the MCP authorization code. */
async function authorize(clientId: string, verifier: string, state = "client-state") {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:5555/cb", // loopback: any port matches
    code_challenge: sha256(verifier),
    code_challenge_method: "S256",
    state,
  });
  const consent = await fetch(`${base}/oauth/authorize?${q}`);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.match(html, /Test &lt;App&gt; wants to connect/);
  const pidUrl = hrefIn(html, /class="btn" href="([^"]+)"/);
  assert.equal(pidUrl.origin + pidUrl.pathname, `${ISSUER}/authorize`);
  assert.equal(pidUrl.searchParams.get("redirect_uri"), "https://mcp.example.com/oauth/callback");

  const cb = await fetch(
    `${base}/oauth/callback?code=pid-code&state=${pidUrl.searchParams.get("state")}`
  );
  assert.equal(cb.status, 200);
  const back = hrefIn(await cb.text(), /<a href="([^"]+)">Continue/);
  assert.equal(back.origin + back.pathname, "http://127.0.0.1:5555/cb");
  assert.equal(back.searchParams.get("state"), state);

  // The PocketID leg used its own PKCE pair, bound to the challenge we sent.
  const form = idp.tokenRequests.at(-1);
  assert.equal(sha256(form?.get("code_verifier") ?? ""), pidUrl.searchParams.get("code_challenge"));
  assert.equal(form?.get("client_secret"), "pid-secret");

  return back.searchParams.get("code") as string;
}

function tokenRequest(fields: Record<string, string>) {
  return fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", ...fields }),
  });
}

describe("OAuth flow", () => {
  it("serves discovery metadata for the public URL", async () => {
    const res = await fetch(`${base}/.well-known/oauth-authorization-server`);
    const meta = (await res.json()) as Record<string, unknown>;
    assert.equal(meta.token_endpoint, "https://mcp.example.com/oauth/token");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });

  it("issues, verifies and revokes an access token end to end", async () => {
    await quiet(async () => {
      const { client_id } = await register();
      const code = await authorize(client_id, "verifier-123");

      const res = await tokenRequest({
        code,
        client_id,
        redirect_uri: "http://127.0.0.1:7777/cb",
        code_verifier: "verifier-123",
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { access_token: string; expires_in: number };
      assert.equal(body.expires_in, 3600);
      assert.ok(store.verifyToken(body.access_token));

      // Codes are single-use.
      const replay = await tokenRequest({
        code,
        client_id,
        redirect_uri: "http://127.0.0.1:7777/cb",
        code_verifier: "verifier-123",
      });
      assert.equal(replay.status, 400);

      await fetch(`${base}/oauth/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: body.access_token }),
      });
      assert.equal(store.verifyToken(body.access_token), undefined);
    });
  });

  it("rejects a wrong PKCE verifier and burns the code", async () => {
    await quiet(async () => {
      const { client_id } = await register();
      const code = await authorize(client_id, "right-verifier");
      const bad = await tokenRequest({
        code,
        client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        code_verifier: "wrong",
      });
      assert.deepEqual(await bad.json(), { error: "invalid_grant" });
      const retry = await tokenRequest({
        code,
        client_id,
        redirect_uri: "http://127.0.0.1:9999/cb",
        code_verifier: "right-verifier",
      });
      assert.equal(retry.status, 400);
    });
  });

  it("refuses unknown clients, unregistered redirect URIs and non-S256 PKCE", async () => {
    await quiet(async () => {
      const { client_id } = await register("https://app.example.com/cb");
      const cases = [
        { client_id: "nope", redirect_uri: "https://app.example.com/cb" },
        { client_id, redirect_uri: "https://evil.example.com/cb" },
        { client_id, redirect_uri: "https://app.example.com/cb", method: "plain" },
      ];
      for (const c of cases) {
        const q = new URLSearchParams({
          client_id: c.client_id,
          redirect_uri: c.redirect_uri,
          code_challenge: "x",
          code_challenge_method: c.method ?? "S256",
        });
        const res = await fetch(`${base}/oauth/authorize?${q}`);
        assert.equal(res.status, 400, JSON.stringify(c));
      }
    });
  });

  it("rejects a callback with an unknown transaction", async () => {
    await quiet(async () => {
      const res = await fetch(`${base}/oauth/callback?code=x&state=unknown`);
      assert.equal(res.status, 400);
      assert.match(await res.text(), /expired or is invalid/);
    });
  });

  it("does not issue a code when PocketID rejects the sign-in", async () => {
    await quiet(async () => {
      const { client_id } = await register();
      idp.failTokens();
      await assert.rejects(authorize(client_id, "v"));
    });
  });

  it("rejects registration without a usable redirect URI", async () => {
    const res = await fetch(`${base}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }),
    });
    assert.deepEqual(await res.json(), { error: "invalid_redirect_uris" });
  });
});

describe("OAuthStore", () => {
  it("persists across restarts with owner-only permissions", () => {
    const path = join(dir, "persist.json");
    const first = new OAuthStore({ path, tokenTtlS: 3600 });
    const client = first.registerClient({ redirectUris: ["https://a.example/cb"] });
    const token = first.issueToken({ clientId: client.clientId, scopes: ["mcp"] });
    assert.equal(statSync(path).mode & 0o777, 0o600);

    const second = new OAuthStore({ path, tokenTtlS: 3600 });
    second.load();
    assert.equal(second.getClient(client.clientId)?.redirectUris[0], "https://a.example/cb");
    assert.equal(second.verifyToken(token)?.clientId, client.clientId);
  });

  it("expires codes and tokens by their TTL", () => {
    let now = 1_000_000;
    const s = new OAuthStore({ path: join(dir, "ttl.json"), tokenTtlS: 600, now: () => now });
    const code = s.issueCode({
      clientId: "c",
      redirectUri: "https://a/cb",
      codeChallenge: "x",
      scopes: [],
    });
    const token = s.issueToken({ clientId: "c", scopes: [] });
    now += CODE_TTL_MS + 1;
    assert.equal(s.consumeCode(code), undefined);
    assert.ok(s.verifyToken(token));
    now += 300_000;
    assert.equal(s.verifyToken(token), undefined);
  });

  it("drops expired entries when loading persisted state", () => {
    let now = 1_000_000;
    const path = join(dir, "load.json");
    const s = new OAuthStore({ path, tokenTtlS: 60, now: () => now });
    const token = s.issueToken({ clientId: "c", scopes: [] });
    now += 120_000;
    const reloaded = new OAuthStore({ path, tokenTtlS: 60, now: () => now });
    reloaded.load();
    assert.equal(reloaded.verifyToken(token), undefined);
  });

  it("does not touch the disk until asked to", () => {
    const path = join(dir, "untouched", "state.json");
    new OAuthStore({ path, tokenTtlS: 60 });
    assert.throws(() => statSync(join(dir, "untouched")));
  });
});
