import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Compares two secrets without leaking their length or content through timing. */
export function constantTimeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** URL-safe random token with `bytes` bytes of entropy. */
export function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}
