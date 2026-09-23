import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  estimateTokens,
  growBudget,
  isReasoningModel,
  modelCompletionCap,
  resolveBudget,
} from "../src/budget.js";
import { makeConfig, makeModel } from "./helpers.js";

const cfg = makeConfig();

describe("resolveBudget", () => {
  it("reports an exhausted overall output budget instead of resetting it", () => {
    const budget = resolveBudget(
      { model: makeModel(), promptTokens: 100, spentTokens: cfg.maxOutputTokens },
      cfg
    );
    assert.ok("error" in budget);
    assert.match(budget.error, /MAX_OUTPUT_TOKENS/);
  });

  it("caps continuation rounds at what is left of the overall budget", () => {
    const budget = resolveBudget(
      { model: makeModel(), promptTokens: 100, spentTokens: cfg.maxOutputTokens - 300 },
      cfg
    );
    assert.ok(!("error" in budget));
    assert.equal(budget.hardCap, 300);
    assert.equal(budget.maxTokens, 300);
  });

  it("uses DEFAULT_MAX_TOKENS when the caller passes nothing", () => {
    const budget = resolveBudget({ model: makeModel(), promptTokens: 100 }, cfg);
    assert.ok(!("error" in budget));
    assert.equal(budget.maxTokens, 4096);
    assert.equal(budget.source, "default");
  });

  it("honours an explicit max_tokens that fits", () => {
    const budget = resolveBudget({ model: makeModel(), promptTokens: 100, requested: 500 }, cfg);
    assert.ok(!("error" in budget));
    assert.equal(budget.maxTokens, 500);
    assert.equal(budget.source, "requested");
  });

  it("raises a too-small budget on reasoning models", () => {
    const model = makeModel({
      supported_parameters: ["reasoning", "max_tokens"],
    });
    const budget = resolveBudget({ model, promptTokens: 100, requested: 300 }, cfg);
    assert.ok(!("error" in budget));
    assert.equal(budget.maxTokens, 2000);
    assert.equal(budget.source, "reasoning-floor");
    assert.match(budget.notes[0], /internal reasoning/);
  });

  it("does not raise the budget when reasoning is disabled", () => {
    const model = makeModel({ supported_parameters: ["reasoning"] });
    const budget = resolveBudget(
      { model, promptTokens: 100, requested: 300, reasoningEffort: "none" },
      cfg
    );
    assert.ok(!("error" in budget));
    assert.equal(budget.maxTokens, 300);
  });

  it("clamps to the provider's per-request output cap", () => {
    const model = makeModel({ top_provider: { max_completion_tokens: 1024 } });
    const budget = resolveBudget({ model, promptTokens: 100, requested: 50_000 }, cfg);
    assert.ok(!("error" in budget));
    assert.equal(budget.maxTokens, 1024);
    assert.equal(budget.hardCap, 1024);
    assert.match(budget.notes[0], /capped max_tokens/);
  });

  it("clamps to the context window left after the prompt", () => {
    const model = makeModel({ context_length: 8000 });
    const budget = resolveBudget({ model, promptTokens: 6000, requested: 8000 }, cfg);
    assert.ok(!("error" in budget));
    assert.equal(budget.maxTokens, 8000 - 6000 - 512);
  });

  it("errors when the prompt leaves no room for an answer", () => {
    const model = makeModel({ context_length: 4000 });
    const budget = resolveBudget({ model, promptTokens: 3900 }, cfg);
    assert.ok("error" in budget);
    assert.match(budget.error, /leaves no room/);
  });

  it("accounts for tokens already spent by earlier continuations", () => {
    const budget = resolveBudget(
      { model: makeModel(), promptTokens: 100, requested: 30_000, spentTokens: 30_000 },
      cfg
    );
    assert.ok(!("error" in budget));
    assert.equal(budget.hardCap, 2000);
  });
});

describe("helpers", () => {
  it("detects reasoning models from supported_parameters", () => {
    assert.equal(isReasoningModel(makeModel()), false);
    assert.equal(
      isReasoningModel(makeModel({ supported_parameters: ["include_reasoning"] })),
      true
    );
  });

  it("ignores a null or zero provider cap", () => {
    assert.equal(modelCompletionCap(makeModel()), undefined);
    assert.equal(
      modelCompletionCap(makeModel({ top_provider: { max_completion_tokens: 0 } })),
      undefined
    );
    assert.equal(
      modelCompletionCap(makeModel({ top_provider: { max_completion_tokens: 8192 } })),
      8192
    );
  });

  it("estimates tokens from text length", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a".repeat(400)), 100);
  });

  it("grows a budget up to the hard cap only", () => {
    assert.equal(growBudget(1000, 100_000), 4096);
    assert.equal(growBudget(2000, 100_000), 8000);
    assert.equal(growBudget(3000, 5000), 5000);
    assert.equal(growBudget(5000, 5000), undefined);
  });
});
