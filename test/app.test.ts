import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { createApp, type AppDeps } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { PocketIdClient } from "../src/oauth/pocketid.js";
import { OAuthStore } from "../src/oauth/store.js";
import { OpenRouterClient } from "../src/openrouter.js";
import { FakeOpenRouter } from "./fakeOpenRouter.js";
import { makeConfig, makeModel } from "./helpers.js";

let dir: string;
let api: FakeOpenRouter;
let closeServer: (() => void) | undefined;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "ormcp-app-"));
  api = new FakeOpenRouter([makeModel()]).install();
});

after(() => {
  api.restore();
  rmSync(dir, { recursive: true, force: true });
});

afterEach(() => closeServer?.());

async function start(cfg: ServerConfig, oauth?: AppDeps["oauth"]): Promise<string> {
  const app = createApp({ cfg, openRouter: new OpenRouterClient(cfg), oauth });
  const server = await new Promise<ReturnType<typeof app.listen>>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  closeServer = () => server.close();
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function mcp(base: string, method: string, token?: string) {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params:
        method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "t", version: "0" },
            }
          : {},
    }),
  });
}

function oauthDeps(): NonNullable<AppDeps["oauth"]> {
  const store = new OAuthStore({ path: join(dir, `s-${Math.random()}.json`), tokenTtlS: 3600 });
  const idp = new PocketIdClient({
    issuer: "https://id.invalid",
    clientId: "a",
    clientSecret: "b",
    scopes: [],
  });
  return { store, idp };
}

describe("createApp", () => {
  it("serves MCP over POST, stays open without auth, and rejects GET", async () => {
    const base = await start(makeConfig());
    const res = await mcp(base, "tools/list");
    assert.equal(res.status, 200);
    const body = (await res.json()) as { result: { tools: unknown[] } };
    assert.equal(body.result.tools.length, 7);
    assert.equal((await fetch(`${base}/mcp`)).status, 405);
    assert.deepEqual(await (await fetch(`${base}/health`)).json(), {
      status: "ok",
      server: "openrouter-mcp-server",
    });
  });

  it("reports the package.json version in serverInfo", async () => {
    const base = await start(makeConfig());
    const body = (await (await mcp(base, "initialize")).json()) as {
      result: { serverInfo: { version: string } };
    };
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
    assert.equal(body.result.serverInfo.version, pkg.version);
  });

  it("requires the static token when configured, without advertising OAuth", async () => {
    const base = await start(makeConfig({ mcpAuthToken: "tok" }));
    const denied = await mcp(base, "tools/list");
    assert.equal(denied.status, 401);
    assert.doesNotMatch(denied.headers.get("www-authenticate") ?? "", /resource_metadata/);
    assert.equal((await mcp(base, "tools/list", "tok")).status, 200);
    assert.equal((await fetch(`${base}/.well-known/oauth-authorization-server`)).status, 404);
  });

  it("accepts OAuth tokens alongside the static token when OAuth is on", async () => {
    const oauth = oauthDeps();
    const token = oauth.store.issueToken({ clientId: "c", scopes: ["mcp"] });
    const base = await start(makeConfig({ mcpAuthToken: "tok" }), oauth);
    assert.equal((await mcp(base, "tools/list", token)).status, 200);
    assert.equal((await mcp(base, "tools/list", "tok")).status, 200);
    const denied = await mcp(base, "tools/list", "nope");
    assert.equal(denied.status, 401);
    assert.match(denied.headers.get("www-authenticate") ?? "", /resource_metadata=/);
  });

  it("stops honouring OAuth tokens once OAuth is turned off", async () => {
    const oauth = oauthDeps();
    const token = oauth.store.issueToken({ clientId: "c", scopes: ["mcp"] });
    const base = await start(makeConfig({ mcpAuthToken: "tok" })); // OAuth off
    assert.equal((await mcp(base, "tools/list", token)).status, 401);
  });
});
