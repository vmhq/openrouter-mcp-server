import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { withDataPolicyFallback } from "../src/delegation/fallback.js";
import { resolveDecisionModel, resolveTextModel } from "../src/models/resolve.js";
import { OpenRouterError } from "../src/openrouter/client.js";
import type { OpenRouterModel } from "../src/openrouter/types.js";
import { makeConfig, makeModel } from "./helpers.js";

const catalogOf = (...models: OpenRouterModel[]) => ({ listModels: async () => models });
const text = makeModel({ id: "openai/mini" });
const decision = makeModel({ id: "typesafe/jev-latest" });
const pricey = makeModel({ id: "big/model", pricing: { prompt: "0.00001", completion: "0" } });

describe("resolveTextModel", () => {
  const catalog = catalogOf(text, decision, pricey);

  it("resolves an allowed model, falling back to DEFAULT_MODEL", async () => {
    const res = await resolveTextModel(
      undefined,
      catalog,
      makeConfig({ defaultModel: "openai/mini" })
    );
    assert.deepEqual(res, { ok: true, value: text });
  });

  it("explains each rejection", async () => {
    const cfg = makeConfig({ maxPromptPricePerM: 1 });
    const cases: Array<[string | undefined, RegExp]> = [
      [undefined, /DEFAULT_MODEL is not set/],
      ["jev-latest", /Use openrouter_decide instead/],
      ["typesafe/jev-latest", /Use openrouter_decide instead/],
      ["nope/x", /not found on OpenRouter/],
      ["big/model", /not allowed: prompt price \$10\.00\/M exceeds MAX_PROMPT_PRICE_PER_M/],
    ];
    for (const [id, pattern] of cases) {
      const res = await resolveTextModel(id, catalog, cfg);
      assert.ok(!res.ok, String(id));
      assert.match(res.error, pattern);
    }
  });
});

describe("resolveDecisionModel", () => {
  it("defaults to Jev and canonicalizes bare ids", async () => {
    const res = await resolveDecisionModel(undefined, catalogOf(), makeConfig());
    assert.deepEqual(res, {
      ok: true,
      value: { id: "~typesafe/jev-latest", canonicalId: "~typesafe/jev-latest" },
    });
    const bare = await resolveDecisionModel("jev-preview", catalogOf(), makeConfig());
    assert.ok(bare.ok);
    assert.equal(bare.value.canonicalId, "typesafe/jev-preview");
  });

  it("applies the full policy, price caps included, when the model is listed", async () => {
    const capped = makeConfig({ maxPromptPricePerM: 0.05 });
    const listed = await resolveDecisionModel("jev-latest", catalogOf(decision), capped);
    assert.ok(!listed.ok);
    assert.match(listed.error, /exceeds MAX_PROMPT_PRICE_PER_M/);
    // Unlisted: only the allow/block lists can apply.
    assert.ok((await resolveDecisionModel("jev-latest", catalogOf(), capped)).ok);
  });

  it("rejects text models", async () => {
    const res = await resolveDecisionModel("openai/mini", catalogOf(text), makeConfig());
    assert.ok(!res.ok);
    assert.match(res.error, /is a text model/);
  });
});

describe("withDataPolicyFallback", () => {
  const a = makeModel({ id: "a/1" });
  const b = makeModel({ id: "b/2" });
  const c = makeModel({ id: "c/3" });

  it("moves to the next candidate only on a 404", async () => {
    const tried: string[] = [];
    const result = await withDataPolicyFallback([a, b, c], async (m, from) => {
      tried.push(m.id);
      if (m.id !== "c/3") throw new OpenRouterError("no endpoints", 404);
      return `${m.id} after ${from?.id}`;
    });
    assert.deepEqual(tried, ["a/1", "b/2", "c/3"]);
    assert.equal(result, "c/3 after a/1");
  });

  it("rethrows other errors and the last 404", async () => {
    await assert.rejects(
      withDataPolicyFallback([a, b], async () => {
        throw new OpenRouterError("bad key", 401);
      }),
      /bad key/
    );
    await assert.rejects(
      withDataPolicyFallback([a, b], async () => {
        throw new OpenRouterError("gone", 404);
      }),
      /gone/
    );
  });
});
