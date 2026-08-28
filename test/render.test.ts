import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DelegationOutcome } from "../src/completion.js";
import { ResponseStore } from "../src/responseStore.js";
import { renderDelegation } from "../src/tools/shared.js";
import type { ToolContext } from "../src/tools/shared.js";
import { makeConfig, makeModel } from "./helpers.js";

const model = makeModel();

function outcome(over: Partial<DelegationOutcome> = {}): DelegationOutcome {
  return {
    modelUsed: model.id,
    content: "the answer",
    finishReason: "stop",
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    requests: 1,
    continuations: 0,
    truncated: false,
    maxTokensUsed: 4096,
    notes: [],
    ...over,
  };
}

function context(maxResponseChars = 25_000): ToolContext {
  return {
    client: {} as ToolContext["client"],
    cfg: makeConfig({ maxResponseChars }),
    responses: new ResponseStore(),
  };
}

describe("renderDelegation", () => {
  it("returns the answer as plain text with a metadata footer", () => {
    const result = renderDelegation(outcome(), model, context());
    const text = result.content[0].text;
    assert.ok(text.startsWith("the answer"));
    assert.match(text, /\[openrouter\] model=test\/model · finish=stop/);
    assert.equal(result.structuredContent?.response, "the answer");
    assert.equal(result.structuredContent?.truncated, false);
    assert.equal(result.isError, undefined);
  });

  it("warns loudly when the answer is still incomplete", () => {
    const result = renderDelegation(
      outcome({ truncated: true, finishReason: "length" }),
      model,
      context()
    );
    assert.match(result.content[0].text, /INCOMPLETE/);
    assert.equal(result.structuredContent?.truncated, true);
  });

  it("pages an oversized answer instead of clipping it", () => {
    const ctx = context(100);
    const long = "x".repeat(250);
    const result = renderDelegation(outcome({ content: long }), model, ctx);
    const text = result.content[0].text;
    const id = result.structuredContent?.response_id as string;

    assert.equal(result.structuredContent?.response_paged, true);
    assert.equal(result.structuredContent?.response_chars, 250);
    assert.equal(result.structuredContent?.next_offset, 100);
    assert.match(text, /openrouter_fetch_response/);
    assert.equal((result.structuredContent?.response as string).length, 100);

    // the remainder is retrievable, not lost
    assert.equal(ctx.responses.page(id, 100, 100)?.text, "x".repeat(100));
    assert.equal(ctx.responses.page(id, 200, 100)?.has_more, false);
  });

  it("reports estimated cost and continuation count", () => {
    const result = renderDelegation(
      outcome({ continuations: 2, usage: { prompt_tokens: 1_000_000, completion_tokens: 0 } }),
      model,
      context()
    );
    assert.equal(result.structuredContent?.estimated_cost_usd, 0.1);
    assert.match(result.content[0].text, /2 continuation\(s\)/);
  });
});
