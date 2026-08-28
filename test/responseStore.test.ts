import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ResponseStore, pageOf } from "../src/responseStore.js";

describe("pageOf", () => {
  it("returns the whole text when it fits", () => {
    const page = pageOf("hello", 0, 100);
    assert.deepEqual(page, {
      text: "hello",
      offset: 0,
      next_offset: null,
      total_chars: 5,
      has_more: false,
    });
  });

  it("pages through a longer text", () => {
    const first = pageOf("abcdefghij", 0, 4);
    assert.equal(first.text, "abcd");
    assert.equal(first.next_offset, 4);
    assert.equal(first.has_more, true);

    const last = pageOf("abcdefghij", 8, 4);
    assert.equal(last.text, "ij");
    assert.equal(last.next_offset, null);
    assert.equal(last.has_more, false);
  });

  it("clamps an out-of-range offset", () => {
    const page = pageOf("abc", 99, 10);
    assert.equal(page.text, "");
    assert.equal(page.offset, 3);
    assert.equal(page.has_more, false);
  });
});

describe("ResponseStore", () => {
  it("stores and pages a response", () => {
    const store = new ResponseStore();
    const entry = store.put("abcdef", "test/model");
    assert.equal(store.page(entry.id, 2, 2)?.text, "cd");
  });

  it("returns undefined for unknown ids", () => {
    assert.equal(new ResponseStore().page("nope", 0, 10), undefined);
  });

  it("evicts the oldest entries past the size limit", () => {
    const store = new ResponseStore(2);
    const first = store.put("one", "m");
    store.put("two", "m");
    store.put("three", "m");
    assert.equal(store.size, 2);
    assert.equal(store.get(first.id), undefined);
  });

  it("expires entries after the TTL", () => {
    let now = 1_000;
    const store = new ResponseStore(10, 5_000, () => now);
    const entry = store.put("text", "m");
    now += 4_000;
    assert.ok(store.get(entry.id));
    now += 2_000;
    assert.equal(store.get(entry.id), undefined);
  });
});
