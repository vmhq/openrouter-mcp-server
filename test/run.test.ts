import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DelegationError, runDelegation } from "../src/delegation/run.js";
import { FakeClient, makeConfig, makeModel } from "./helpers.js";

const cfg = makeConfig();
const model = makeModel();
const base = { model, messages: [{ role: "user" as const, content: "hi" }] };

describe("runDelegation", () => {
  it("returns a complete answer in one request", async () => {
    const client = new FakeClient([{ content: "done" }]);
    const out = await runDelegation(client, base, cfg);
    assert.equal(out.content, "done");
    assert.equal(out.truncated, false);
    assert.equal(out.requests, 1);
    assert.equal(out.continuations, 0);
  });

  it("stitches together an answer cut off by the token limit", async () => {
    const client = new FakeClient([
      { content: "part one ", finishReason: "length" },
      { content: "part two", finishReason: "stop" },
    ]);
    const out = await runDelegation(client, base, cfg);
    assert.equal(out.content, "part one part two");
    assert.equal(out.truncated, false);
    assert.equal(out.continuations, 1);
    assert.match(out.notes.join(" "), /1 extra continuation round/);
  });

  it("feeds the partial answer back so the model resumes", async () => {
    const client = new FakeClient([{ content: "abc", finishReason: "length" }, { content: "def" }]);
    await runDelegation(client, base, cfg);
    const second = client.calls[1].messages;
    assert.equal(second[0].content, "hi");
    assert.equal(second[1].role, "assistant");
    assert.equal(second[1].content, "abc");
    assert.equal(second[2].role, "user");
    assert.match(second[2].content, /Continue from exactly where it stopped/);
  });

  it("stops after MAX_CONTINUATIONS and reports the answer as truncated", async () => {
    const turns = Array.from({ length: 6 }, () => ({
      content: "x",
      finishReason: "length",
    }));
    const out = await runDelegation(
      new FakeClient(turns),
      base,
      makeConfig({ maxContinuations: 2 })
    );
    assert.equal(out.requests, 3);
    assert.equal(out.continuations, 2);
    assert.equal(out.truncated, true);
    assert.match(out.notes.join(" "), /MAX_CONTINUATIONS/);
  });

  it("respects auto_continue=false", async () => {
    const client = new FakeClient([{ content: "cut", finishReason: "length" }]);
    const out = await runDelegation(client, { ...base, autoContinue: false }, cfg);
    assert.equal(out.requests, 1);
    assert.equal(out.truncated, true);
    assert.match(out.notes.join(" "), /auto_continue is disabled/);
  });

  it("does not auto-continue in json_mode", async () => {
    const client = new FakeClient([{ content: '{"a":', finishReason: "length" }]);
    const out = await runDelegation(client, { ...base, jsonMode: true }, cfg);
    assert.equal(out.requests, 1);
    assert.equal(out.truncated, true);
    assert.match(out.notes.join(" "), /json_mode/);
  });

  it("retries with a bigger budget when reasoning ate the whole budget", async () => {
    const reasoning = makeModel({ supported_parameters: ["reasoning"] });
    const client = new FakeClient([
      { content: "", finishReason: "length", reasoningTokens: 2000 },
      { content: "the answer" },
    ]);
    const out = await runDelegation(
      client,
      { model: reasoning, messages: base.messages, maxTokens: 200 },
      cfg
    );
    assert.equal(out.content, "the answer");
    assert.equal(client.calls[0].maxTokens, 2000); // reasoning floor
    assert.equal(client.calls[1].maxTokens, 8000); // grown after empty answer
    assert.match(out.notes.join(" "), /retried with max_tokens=8000/);
  });

  it("errors clearly when a reasoning model never produces text", async () => {
    const reasoning = makeModel({
      supported_parameters: ["reasoning"],
      top_provider: { max_completion_tokens: 2000 },
    });
    const client = new FakeClient([{ content: "", finishReason: "length", reasoningTokens: 2000 }]);
    await assert.rejects(
      runDelegation(client, { model: reasoning, messages: base.messages }, cfg),
      (err: unknown) => {
        assert.ok(err instanceof DelegationError);
        assert.match(err.message, /no visible text/);
        assert.match(err.message, /reasoning_effort/);
        return true;
      }
    );
  });

  it("adds up usage across continuations", async () => {
    const client = new FakeClient([
      { content: "a", finishReason: "length", completionTokens: 100, reasoningTokens: 10 },
      { content: "b", completionTokens: 50, reasoningTokens: 5 },
    ]);
    const out = await runDelegation(client, base, cfg);
    assert.equal(out.usage.completion_tokens, 150);
    assert.equal(out.usage.prompt_tokens, 20);
    assert.equal(out.usage.completion_tokens_details?.reasoning_tokens, 15);
  });

  it("stops continuing once MAX_OUTPUT_TOKENS is reached", async () => {
    const client = new FakeClient([
      { content: "a", finishReason: "length", completionTokens: 1000 },
    ]);
    const out = await runDelegation(client, base, makeConfig({ maxOutputTokens: 900 }));
    assert.equal(out.requests, 1);
    assert.equal(out.truncated, true);
    assert.match(out.notes.join(" "), /MAX_OUTPUT_TOKENS/);
  });

  it("surfaces a prompt that does not fit the model's context", async () => {
    const small = makeModel({ context_length: 1000 });
    await assert.rejects(
      runDelegation(
        new FakeClient([]),
        { model: small, messages: [{ role: "user", content: "x".repeat(8000) }] },
        cfg
      ),
      DelegationError
    );
  });
});

describe("explicit max_tokens", () => {
  const cfgLocal = makeConfig();

  it("is treated as the budget for the whole delegation", async () => {
    const client = new FakeClient([
      { content: "aa", finishReason: "length", completionTokens: 60 },
      { content: "bb", finishReason: "stop", completionTokens: 30 },
    ]);
    const out = await runDelegation(client, { ...base, maxTokens: 100 }, cfgLocal);
    assert.equal(client.calls[0].maxTokens, 100);
    assert.equal(client.calls[1].maxTokens, 40); // 100 - 60 already produced
    assert.equal(out.content, "aabb");
  });

  it("stops once the caller's budget is spent", async () => {
    const client = new FakeClient([
      { content: "aa", finishReason: "length", completionTokens: 100 },
    ]);
    const out = await runDelegation(client, { ...base, maxTokens: 100 }, cfgLocal);
    assert.equal(out.requests, 1);
    assert.equal(out.truncated, true);
    assert.match(out.notes.join(" "), /raise max_tokens or leave it unset/);
  });
});
