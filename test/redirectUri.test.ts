import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CLAUDE_WEB_AUTH_CALLBACK,
  expandRedirectUris,
  isRegistrableRedirectUri,
  redirectUriMatches,
} from "../src/oauth/redirectUri.js";

describe("isRegistrableRedirectUri", () => {
  it("accepts https, loopback http and native-app schemes", () => {
    assert.equal(isRegistrableRedirectUri("https://claude.ai/api/mcp/auth_callback"), true);
    assert.equal(isRegistrableRedirectUri("http://127.0.0.1:33418/callback"), true);
    assert.equal(isRegistrableRedirectUri("http://localhost/cb"), true);
    assert.equal(isRegistrableRedirectUri("cursor://anysphere.cursor-retrieval/oauth"), true);
  });

  it("rejects script, local-resource and malformed URIs", () => {
    for (const uri of [
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "vbscript:x",
      "not a url",
      "https://user:pass@example.com/cb",
      "https://example.com/cb#frag",
      "https://0.0.0.0/cb",
    ]) {
      assert.equal(isRegistrableRedirectUri(uri), false, uri);
    }
  });

  it("requires plain http on loopback and https elsewhere", () => {
    assert.equal(isRegistrableRedirectUri("https://localhost/cb"), false);
    assert.equal(isRegistrableRedirectUri("http://example.com/cb"), false);
  });
});

describe("redirectUriMatches", () => {
  it("ignores the port on loopback only", () => {
    assert.equal(redirectUriMatches("http://127.0.0.1:5000/cb", "http://127.0.0.1:4000/cb"), true);
    assert.equal(redirectUriMatches("http://127.0.0.1:5000/x", "http://127.0.0.1:4000/cb"), false);
    assert.equal(
      redirectUriMatches("https://example.com:8443/cb", "https://example.com/cb"),
      false
    );
  });

  it("treats Claude's legacy callback as an alias", () => {
    assert.equal(redirectUriMatches("https://claude.ai/callback", CLAUDE_WEB_AUTH_CALLBACK), true);
  });
});

describe("expandRedirectUris", () => {
  it("registers both the alias and the canonical callback", () => {
    assert.deepEqual(expandRedirectUris(["https://claude.ai/callback"]).sort(), [
      CLAUDE_WEB_AUTH_CALLBACK,
      "https://claude.ai/callback",
    ]);
    assert.deepEqual(expandRedirectUris([CLAUDE_WEB_AUTH_CALLBACK]).sort(), [
      CLAUDE_WEB_AUTH_CALLBACK,
      "https://claude.ai/callback",
    ]);
  });
});
