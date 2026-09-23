import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, it } from "node:test";
import { FakeOpenRouter } from "./fakeOpenRouter.js";
import { makeConfig, makeModel } from "./helpers.js";
import { connectToolServer } from "./mcpHarness.js";

const priced = (id: string, prompt: number, completion: number, extra = {}) =>
  makeModel({
    id,
    name: id,
    pricing: { prompt: String(prompt / 1e6), completion: String(completion / 1e6) },
    ...extra,
  });

const catalog = [
  priced("openai/mini", 0.1, 0.4, { supported_parameters: ["tools", "max_tokens"] }),
  priced("google/flash", 0.2, 0.6),
  priced("anthropic/big", 3, 15),
  priced("evil/model", 0.05, 0.05),
  priced("typesafe/jev-latest", 0.01, 0.01, {
    architecture: { output_modalities: ["decision"] },
  }),
];

const cfg = makeConfig({ blockedModels: ["evil/"], maxResponseChars: 1_000 });

let api: FakeOpenRouter;
let conn: Awaited<ReturnType<typeof connectToolServer>>;

beforeEach(async () => {
  api = new FakeOpenRouter(catalog).install();
  conn = await connectToolServer(cfg);
});

afterEach(async () => {
  await conn.close();
  api.restore();
});

describe("tools/list contract", () => {
  const fixture = new URL("./fixtures/tools-list.json", import.meta.url);

  it("matches the recorded tool names, descriptions and schemas", async () => {
    const { tools } = await conn.client.listTools();
    const actual = JSON.parse(JSON.stringify(tools));
    if (process.env.UPDATE_SNAPSHOTS) {
      writeFileSync(fixture, JSON.stringify(actual, null, 2) + "\n");
    }
    const expected = JSON.parse(readFileSync(fixture, "utf-8"));
    assert.deepEqual(actual, expected);
  });
});

describe("openrouter_delegate_task", () => {
  it("returns the answer as text with metadata", async () => {
    const res = await conn.call("openrouter_delegate_task", {
      model: "openai/mini",
      task: "say hi",
      system_prompt: "be brief",
    });
    assert.equal(res.isError, undefined);
    assert.match(res.content[0].text, /^fake answer\n\n---\n\[openrouter\] model=openai\/mini/);
    assert.equal(res.structuredContent?.model_used, "openai/mini");
    const [body] = api.chatBodies();
    assert.deepEqual(body.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "say hi" },
    ]);
  });

  it("rejects a model blocked by policy", async () => {
    const res = await conn.call("openrouter_delegate_task", { model: "evil/model", task: "x" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not allowed: blocked by BLOCKED_MODELS/);
    assert.equal(api.chatBodies().length, 0);
  });

  it("rejects an unknown model", async () => {
    const res = await conn.call("openrouter_delegate_task", { model: "nope/x", task: "x" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not found on OpenRouter/);
  });

  it("redirects decision models to openrouter_decide", async () => {
    for (const model of ["jev-latest", "typesafe/jev-latest"]) {
      const res = await conn.call("openrouter_delegate_task", { model, task: "x" });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /Use openrouter_decide instead/);
    }
  });

  it("requires a model when DEFAULT_MODEL is unset", async () => {
    const res = await conn.call("openrouter_delegate_task", { task: "x" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /DEFAULT_MODEL is not set/);
  });

  it("surfaces OpenRouter API errors", async () => {
    api.chat = () => ({ status: 402, body: { error: { message: "no credits" } } });
    const res = await conn.call("openrouter_delegate_task", { model: "openai/mini", task: "x" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /OpenRouter API error 402: no credits/);
  });
});

describe("openrouter_auto_delegate", () => {
  it("picks the cheapest eligible model for the economy tier", async () => {
    const res = await conn.call("openrouter_auto_delegate", { task: "x" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent?.model_used, "openai/mini");
    assert.match(String(res.structuredContent?.selection_reason), /tier 'economy'/);
  });

  it("falls back to a runner-up when the pick has no compatible endpoints", async () => {
    const base = api.chat;
    api.chat = (body, call) =>
      body.model === "openai/mini"
        ? { status: 404, body: { error: { message: "No endpoints found" } } }
        : base(body, call);
    const res = await conn.call("openrouter_auto_delegate", { task: "x" });
    assert.equal(res.isError, undefined);
    assert.equal(res.structuredContent?.model_used, "google/flash");
    assert.match(String(res.structuredContent?.selection_reason), /fell back to runner-up/);
  });

  it("does not fall back on errors other than 404", async () => {
    api.chat = () => ({ status: 401, body: { error: { message: "bad key" } } });
    const res = await conn.call("openrouter_auto_delegate", { task: "x" });
    assert.equal(res.isError, true);
    assert.equal(api.chatBodies().length, 1);
  });
});

describe("openrouter_fetch_response", () => {
  it("pages through an answer larger than the inline limit", async () => {
    const long = "y".repeat(2_500);
    api.chat = (body) => ({
      body: {
        id: "g",
        model: body.model,
        choices: [{ message: { content: long }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const first = await conn.call("openrouter_delegate_task", { model: "openai/mini", task: "x" });
    const id = first.structuredContent?.response_id as string;
    assert.equal(first.structuredContent?.response_paged, true);

    const page = await conn.call("openrouter_fetch_response", { response_id: id, offset: 2_000 });
    assert.equal(page.structuredContent?.text, "y".repeat(500));
    assert.equal(page.structuredContent?.has_more, false);
    assert.match(page.content[0].text, /end of response/);
  });

  it("reports an expired or unknown id", async () => {
    const res = await conn.call("openrouter_fetch_response", { response_id: "resp_missing" });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not available any more/);
  });
});

describe("openrouter_decide", () => {
  const questions = { q: { type: "noul", instructions: "Is it spam?" } };

  it("sends typed questions to /systemone and reports cost", async () => {
    const res = await conn.call("openrouter_decide", { state: "buy now!!!", questions });
    assert.equal(res.isError, undefined);
    assert.deepEqual(res.structuredContent?.answers, { q: { noul: 0.9 } });
    assert.equal(res.structuredContent?.cost_usd, 0.000012);
    const req = api.requests.find((r) => r.path === "/systemone");
    assert.deepEqual(req?.body, { model: "~typesafe/jev-latest", state: "buy now!!!", questions });
  });

  it("rejects text models", async () => {
    const res = await conn.call("openrouter_decide", {
      model: "openai/mini",
      state: "x",
      questions,
    });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /is a text model/);
  });

  it("applies the allow/block lists to models missing from the catalog", async () => {
    const strict = makeConfig({ blockedModels: ["typesafe/"] });
    const other = await connectToolServer(strict);
    try {
      const res = await other.call("openrouter_decide", {
        model: "jev-preview",
        state: "x",
        questions,
      });
      assert.equal(res.isError, true);
      assert.match(res.content[0].text, /not allowed: blocked by BLOCKED_MODELS/);
    } finally {
      await other.close();
    }
  });
});

describe("model catalog tools", () => {
  it("lists models allowed by policy, cheapest first", async () => {
    const res = await conn.call("openrouter_list_models", { response_format: "json" });
    const ids = (res.structuredContent?.models as Array<{ id: string }>).map((m) => m.id);
    assert.deepEqual(ids, ["typesafe/jev-latest", "openai/mini", "google/flash", "anthropic/big"]);
  });

  it("filters by search and tool support", async () => {
    const res = await conn.call("openrouter_list_models", { search: "o", require_tools: true });
    const ids = (res.structuredContent?.models as Array<{ id: string }>).map((m) => m.id);
    assert.deepEqual(ids, ["openai/mini"]);
    assert.match(res.content[0].text, /^Found 1 models/);
  });

  it("describes one model including its policy verdict", async () => {
    const res = await conn.call("openrouter_get_model", { model: "evil/model" });
    assert.equal(res.structuredContent?.allowed_by_policy, false);
    assert.equal(res.structuredContent?.policy_reason, "blocked by BLOCKED_MODELS in .env");
  });

  it("returns the key info", async () => {
    const res = await conn.call("openrouter_check_credits");
    assert.deepEqual(res.structuredContent, { key: { label: "test", usage: 1.5, limit: null } });
  });
});
