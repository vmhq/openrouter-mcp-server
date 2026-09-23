import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedByPolicy } from "../src/models/policy.js";
import {
  blendedPricePerM,
  estimateCostUsd,
  isFreeModel,
  pricePerM,
} from "../src/models/pricing.js";
import { pickModelForTier } from "../src/models/selection.js";
import { makeConfig, makeModel } from "./helpers.js";

const priced = (id: string, prompt: number, completion: number) =>
  makeModel({
    id,
    pricing: { prompt: String(prompt / 1e6), completion: String(completion / 1e6) },
  });

describe("pricing helpers", () => {
  it("converts per-token prices to $/M", () => {
    assert.equal(pricePerM("0.0000005"), 0.5);
    assert.equal(pricePerM(undefined), 0);
    assert.equal(pricePerM("not-a-number"), 0);
  });

  it("blends input and output prices 70/30", () => {
    assert.equal(round(blendedPricePerM(priced("a", 1, 2))), 1.3);
  });

  it("detects free models", () => {
    assert.equal(isFreeModel(priced("free", 0, 0)), true);
    assert.equal(isFreeModel(priced("paid", 0, 1)), false);
  });

  it("estimates cost from usage", () => {
    const cost = estimateCostUsd(priced("a", 1, 2), {
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
    });
    assert.equal(round(cost ?? 0), 2);
    assert.equal(estimateCostUsd(priced("a", 1, 2), undefined), undefined);
  });
});

const round = (n: number) => Math.round(n * 1e6) / 1e6;

describe("isAllowedByPolicy", () => {
  it("blocks models matching BLOCKED_MODELS, including prefixes", () => {
    const cfg = makeConfig({ blockedModels: ["openai/"] });
    assert.equal(isAllowedByPolicy(priced("openai/gpt", 1, 1), cfg).allowed, false);
    assert.equal(isAllowedByPolicy(priced("google/gem", 1, 1), cfg).allowed, true);
  });

  it("restricts to ALLOWED_MODELS when set", () => {
    const cfg = makeConfig({ allowedModels: ["google/gem"] });
    assert.equal(isAllowedByPolicy(priced("google/gem", 1, 1), cfg).allowed, true);
    assert.equal(isAllowedByPolicy(priced("openai/gpt", 1, 1), cfg).allowed, false);
  });

  it("enforces the price caps", () => {
    const cfg = makeConfig({ maxPromptPricePerM: 1 });
    const denied = isAllowedByPolicy(priced("x/y", 5, 1), cfg);
    assert.equal(denied.allowed, false);
    assert.match(denied.reason ?? "", /MAX_PROMPT_PRICE_PER_M/);
  });

  it("can exclude free models", () => {
    const cfg = makeConfig({ allowFreeModels: false });
    assert.equal(isAllowedByPolicy(priced("x/free", 0, 0), cfg).allowed, false);
  });
});

describe("pickModelForTier", () => {
  const catalog = [priced("cheap/a", 0.1, 0.2), priced("mid/b", 1, 2), priced("pricey/c", 8, 10)];

  it("picks the cheapest model for the economy tier", () => {
    const pick = pickModelForTier(catalog, "economy", {}, makeConfig());
    assert.ok(!("error" in pick));
    assert.equal(pick.model.id, "cheap/a");
  });

  it("picks inside the balanced band", () => {
    const pick = pickModelForTier(catalog, "balanced", {}, makeConfig());
    assert.ok(!("error" in pick));
    assert.equal(pick.model.id, "mid/b");
  });

  it("picks the priciest within the quality cap", () => {
    const pick = pickModelForTier(catalog, "quality", {}, makeConfig());
    assert.ok(!("error" in pick));
    assert.equal(pick.model.id, "pricey/c");
  });

  it("prefers PREFERRED_PROVIDERS inside a band", () => {
    const pick = pickModelForTier(
      [priced("other/x", 0.1, 0.1), priced("google/y", 0.2, 0.2)],
      "economy",
      {},
      makeConfig({ preferredProviders: ["google"] })
    );
    assert.ok(!("error" in pick));
    assert.equal(pick.model.id, "google/y");
  });

  it("reports when requirements exclude everything", () => {
    const pick = pickModelForTier(catalog, "economy", { minContext: 10_000_000 }, makeConfig());
    assert.ok("error" in pick);
  });

  it("falls back to a neighbouring band when the tier is empty", () => {
    const pick = pickModelForTier([priced("cheap/a", 0.1, 0.1)], "quality", {}, makeConfig());
    assert.ok(!("error" in pick));
    assert.equal(pick.model.id, "cheap/a");
    assert.match(pick.reason, /fell back/);
  });
});
