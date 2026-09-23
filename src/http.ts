import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { constantTimeEqual } from "./crypto.js";

/**
 * Express 4 ignores the promise an async handler returns, so a rejection
 * becomes an unhandled rejection — which terminates the process on Node 15+.
 * This forwards it to Express's error handling instead.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}

export interface BearerAuthOptions {
  /** Static MCP_AUTH_TOKEN, if configured. */
  staticToken?: string;
  /** Verifies OAuth-issued tokens; omit when OAuth is disabled. */
  verifyToken?: (token: string) => boolean;
  onUnauthorized: (req: Request, res: Response) => void;
}

/**
 * Bearer protection: accepts the static token or an OAuth-issued one. With
 * neither mechanism configured the endpoint stays open (local use). OAuth
 * tokens are only honoured while OAuth is enabled, so turning it off also
 * revokes every token issued before.
 */
export function bearerAuth(opts: BearerAuthOptions): RequestHandler {
  const { staticToken, verifyToken, onUnauthorized } = opts;
  return (req, res, next) => {
    if (!staticToken && !verifyToken) return next();
    const auth = req.headers.authorization ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (token !== "") {
      if (staticToken && constantTimeEqual(token, staticToken)) return next();
      if (verifyToken?.(token)) return next();
    }
    onUnauthorized(req, res);
  };
}

/**
 * Last-resort error handler: keeps client errors raised by the body parsers
 * (malformed JSON, oversized body) and hides everything else behind a
 * generic 500 instead of Express's default HTML stack trace.
 */
export const errorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  if (res.headersSent) return next(err);
  const status = (err as { status?: unknown })?.status;
  if (typeof status === "number" && status >= 400 && status < 500) {
    res.status(status).json({ error: "invalid_request" });
    return;
  }
  console.error("unhandled_request_error:", err instanceof Error ? err.stack : String(err));
  res.status(500).json({ error: "internal_error" });
};
