import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "../src/config.js";

const base = { OPENROUTER_API_KEY: "sk-test" };

function issuesOf(env: Record<string, string>): string[] {
  try {
    loadConfig({ ...base, ...env });
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.issues;
  }
  assert.fail("expected a ConfigError");
}

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const cfg = loadConfig(base);
    assert.deepEqual(cfg, {
      openRouterApiKey: "sk-test",
      openRouterBaseUrl: "https://openrouter.ai/api/v1",
      port: 3000,
      mcpAuthToken: undefined,
      publicUrl: undefined,
      pocketId: undefined,
      oauthStatePath: "./data/oauth-state.json",
      oauthTokenTtlS: 2_592_000,
      appUrl: undefined,
      appTitle: undefined,
      defaultModel: undefined,
      maxPromptPricePerM: undefined,
      maxCompletionPricePerM: undefined,
      allowedModels: [],
      blockedModels: [],
      allowFreeModels: true,
      preferredProviders: [
        "openai",
        "anthropic",
        "google",
        "meta-llama",
        "mistralai",
        "deepseek",
        "qwen",
        "x-ai",
        "amazon",
      ],
      tierEconomyMaxPrice: 0.5,
      tierBalancedMaxPrice: 3,
      tierQualityMaxPrice: 15,
      modelsCacheTtlMs: 300_000,
      defaultMaxTokens: 4096,
      reasoningMinMaxTokens: 2000,
      maxOutputTokens: 32_000,
      maxContinuations: 3,
      maxResponseChars: 25_000,
    });
  });

  it("treats empty variables as unset", () => {
    const cfg = loadConfig({ ...base, PORT: "", MAX_CONTINUATIONS: " ", MCP_AUTH_TOKEN: "" });
    assert.equal(cfg.port, 3000);
    assert.equal(cfg.maxContinuations, 3);
    assert.equal(cfg.mcpAuthToken, undefined);
  });

  it("lets an empty PREFERRED_PROVIDERS disable provider preference", () => {
    assert.deepEqual(loadConfig({ ...base, PREFERRED_PROVIDERS: "" }).preferredProviders, []);
  });

  it("parses lists, numbers and URLs", () => {
    const cfg = loadConfig({
      ...base,
      ALLOWED_MODELS: " openai/ , google/gemini ,",
      MAX_PROMPT_PRICE_PER_M: "1.5",
      MODELS_CACHE_TTL_SECONDS: "60",
      MCP_PUBLIC_URL: "mcp.example.com/",
      OPENROUTER_BASE_URL: "https://gw.example.com/v1/",
    });
    assert.deepEqual(cfg.allowedModels, ["openai/", "google/gemini"]);
    assert.equal(cfg.maxPromptPricePerM, 1.5);
    assert.equal(cfg.modelsCacheTtlMs, 60_000);
    assert.equal(cfg.publicUrl, "https://mcp.example.com");
    assert.equal(cfg.openRouterBaseUrl, "https://gw.example.com/v1");
  });

  it("accepts common boolean spellings", () => {
    for (const [value, expected] of [
      ["false", false],
      ["FALSE", false],
      ["0", false],
      ["no", false],
      ["true", true],
      ["1", true],
      ["On", true],
    ] as const) {
      assert.equal(loadConfig({ ...base, ALLOW_FREE_MODELS: value }).allowFreeModels, expected);
    }
  });

  it("enables PocketID only with all three variables", () => {
    const cfg = loadConfig({
      ...base,
      POCKETID_ISSUER: "https://id.example.com/",
      POCKETID_CLIENT_ID: "id",
      POCKETID_CLIENT_SECRET: "secret",
    });
    assert.deepEqual(cfg.pocketId, {
      issuer: "https://id.example.com",
      clientId: "id",
      clientSecret: "secret",
      scopes: ["openid", "profile", "email"],
    });
  });

  it("reports every invalid variable by name", () => {
    const issues = issuesOf({
      PORT: "3000.5",
      MAX_CONTINUATIONS: "abc",
      MAX_OUTPUT_TOKENS: "0",
      ALLOW_FREE_MODELS: "maybe",
      MAX_PROMPT_PRICE_PER_M: "-1",
      MCP_OAUTH_TOKEN_TTL_S: "-5",
    });
    for (const name of [
      "PORT",
      "MAX_CONTINUATIONS",
      "MAX_OUTPUT_TOKENS",
      "ALLOW_FREE_MODELS",
      "MAX_PROMPT_PRICE_PER_M",
      "MCP_OAUTH_TOKEN_TTL_S",
    ]) {
      assert.ok(
        issues.some((i) => i.startsWith(name)),
        `${name} missing from ${issues.join("; ")}`
      );
    }
  });

  it("requires the API key", () => {
    assert.throws(() => loadConfig({}), /OPENROUTER_API_KEY is required/);
  });

  it("rejects a partial PocketID configuration", () => {
    const issues = issuesOf({ POCKETID_ISSUER: "https://id.example.com" });
    assert.match(issues.join(), /missing: POCKETID_CLIENT_ID, POCKETID_CLIENT_SECRET/);
  });

  it("rejects tier ceilings out of order", () => {
    const issues = issuesOf({ TIER_ECONOMY_MAX_PRICE: "5", TIER_BALANCED_MAX_PRICE: "3" });
    assert.match(issues.join(), /TIER_ECONOMY_MAX_PRICE <= TIER_BALANCED_MAX_PRICE/);
  });
});
