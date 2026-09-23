import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NextFunction, Request, Response } from "express";
import { asyncHandler, bearerAuth, errorHandler } from "../src/http.js";

function run(
  handler: (req: Request, res: Response, next: NextFunction) => void,
  authorization?: string
) {
  let passed = false;
  const req = { headers: authorization ? { authorization } : {} } as Request;
  handler(req, {} as Response, () => {
    passed = true;
  });
  return { passed };
}

describe("bearerAuth", () => {
  const onUnauthorized = () => {};

  it("stays open when no auth mechanism is configured", () => {
    assert.equal(run(bearerAuth({ onUnauthorized })).passed, true);
  });

  it("accepts the static token and rejects anything else", () => {
    const mw = bearerAuth({ staticToken: "s3cret", onUnauthorized });
    assert.equal(run(mw, "Bearer s3cret").passed, true);
    assert.equal(run(mw, "Bearer wrong").passed, false);
    assert.equal(run(mw).passed, false);
    assert.equal(run(mw, "s3cret").passed, false);
  });

  it("accepts OAuth tokens only through the verifier", () => {
    const mw = bearerAuth({ verifyToken: (t) => t === "oauth-ok", onUnauthorized });
    assert.equal(run(mw, "Bearer oauth-ok").passed, true);
    assert.equal(run(mw, "Bearer other").passed, false);
  });

  it("does not honour OAuth tokens when OAuth is disabled (static token only)", () => {
    // Regression: tokens persisted while OAuth was on used to stay valid.
    const mw = bearerAuth({ staticToken: "s3cret", verifyToken: undefined, onUnauthorized });
    assert.equal(run(mw, "Bearer persisted-oauth-token").passed, false);
  });

  it("calls onUnauthorized on rejection", () => {
    let called = 0;
    const mw = bearerAuth({ staticToken: "s3cret", onUnauthorized: () => void called++ });
    run(mw, "Bearer nope");
    assert.equal(called, 1);
  });
});

describe("asyncHandler", () => {
  it("forwards a rejection to next() instead of leaving it unhandled", async () => {
    const boom = new Error("boom");
    const handler = asyncHandler(async () => {
      throw boom;
    });
    const forwarded = await new Promise((resolve) =>
      handler({} as Request, {} as Response, resolve as NextFunction)
    );
    assert.equal(forwarded, boom);
  });
});

describe("errorHandler", () => {
  function fakeRes() {
    const res = {
      headersSent: false,
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        res.statusCode = code;
        return res;
      },
      json(body: unknown) {
        res.body = body;
        return res;
      },
    };
    return res;
  }

  it("keeps body-parser client errors as 4xx", () => {
    const res = fakeRes();
    errorHandler({ status: 400 }, {} as Request, res as unknown as Response, () => {});
    assert.equal(res.statusCode, 400);
  });

  it("hides unexpected errors behind a generic 500", () => {
    const res = fakeRes();
    const original = console.error;
    console.error = () => {};
    try {
      errorHandler(new Error("secret detail"), {} as Request, res as unknown as Response, () => {});
    } finally {
      console.error = original;
    }
    assert.equal(res.statusCode, 500);
    assert.deepEqual(res.body, { error: "internal_error" });
  });
});
