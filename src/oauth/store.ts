/**
 * OAuth state: registered clients, single-use authorization codes, pending
 * PocketID transactions and access-token hashes, with atomic JSON
 * persistence.
 *
 * Nothing happens at import time: the server creates a store only when OAuth
 * is enabled, then calls load(), checkWritable() and startPruning()
 * explicitly. Every mutation persists itself.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomToken, sha256 } from "../crypto.js";
import { errorMessage } from "../util.js";

export type RegisteredClient = {
  clientId: string;
  clientIdIssuedAt: number;
  redirectUris: string[];
  clientName?: string;
};

export type AuthorizationCode = {
  clientId: string;
  /** Exact redirect URI used in the authorize request (stored for validation) */
  redirectUri: string;
  codeChallenge: string;
  scopes: string[];
  /** RFC 8707 resource indicator (optional) */
  resource?: string;
  expiresAt: number;
};

export type StoredToken = {
  clientId: string;
  scopes: string[];
  resource?: string;
  expiresAt: number;
};

/**
 * A pending authorization while the user is being redirected through PocketID.
 * Created at GET /oauth/authorize, consumed at GET /oauth/callback. Keyed by an
 * opaque transaction id that is passed to PocketID as its `state` parameter.
 */
export type PendingAuth = {
  /** The MCP client (Claude.ai, Cursor, …) that initiated the authorization. */
  clientId: string;
  /** Redirect URI the MCP client expects the final code on. */
  redirectUri: string;
  /** The MCP client's PKCE S256 challenge (verified at token exchange). */
  codeChallenge: string;
  /** The MCP client's opaque `state`, echoed back on the final redirect. */
  state: string;
  scopes: string[];
  /** RFC 8707 resource indicator (optional) */
  resource?: string;
  /** PKCE verifier for the PocketID leg of the flow. */
  pkceVerifier: string;
  expiresAt: number;
};

/** On-disk format; kept stable so existing sign-ins survive upgrades. */
type PersistedState = {
  clients?: Array<[string, RegisteredClient]>;
  authorizationCodes?: Array<[string, AuthorizationCode]>;
  pendingAuth?: Array<[string, PendingAuth]>;
  accessTokens?: Array<[string, StoredToken]>;
};

export const CODE_TTL_MS = 5 * 60 * 1000; // 5 min
export const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min (PocketID round-trip)
export const DEFAULT_TOKEN_TTL_S = 60 * 60 * 24 * 30; // 30 days
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export interface OAuthStoreOptions {
  /** JSON file the state is persisted to. */
  path: string;
  /** Access-token lifetime in seconds. */
  tokenTtlS: number;
  now?: () => number;
}

export class OAuthStore {
  readonly tokenTtlS: number;
  private readonly path: string;
  private readonly now: () => number;
  private readonly clients = new Map<string, RegisteredClient>();
  private readonly codes = new Map<string, AuthorizationCode>();
  /** transaction id → PendingAuth (PocketID round-trip) */
  private readonly pending = new Map<string, PendingAuth>();
  /** token SHA-256 hash → StoredToken */
  private readonly tokens = new Map<string, StoredToken>();

  constructor(opts: OAuthStoreOptions) {
    this.path = opts.path;
    this.tokenTtlS = opts.tokenTtlS;
    this.now = opts.now ?? Date.now;
  }

  /** Clients outlive their tokens: prune TOKEN_TTL + 30 days after issuance. */
  private get clientTtlMs(): number {
    return (this.tokenTtlS + 30 * 24 * 60 * 60) * 1000;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /** Loads persisted state, dropping anything already expired. */
  load(): void {
    let saved: PersistedState;
    try {
      saved = JSON.parse(readFileSync(this.path, "utf-8")) as PersistedState;
    } catch {
      return; // Fresh start — no persisted state yet
    }
    const now = this.now();
    for (const [id, c] of saved.clients ?? []) {
      if (typeof c.clientIdIssuedAt !== "number" || !Number.isFinite(c.clientIdIssuedAt)) {
        c.clientIdIssuedAt = Math.floor(now / 1000);
      }
      this.clients.set(id, c);
    }
    for (const [code, ac] of saved.authorizationCodes ?? []) {
      if (ac.expiresAt > now) this.codes.set(code, ac);
    }
    for (const [txn, p] of saved.pendingAuth ?? []) {
      if (p.expiresAt > now) this.pending.set(txn, p);
    }
    for (const [hash, data] of saved.accessTokens ?? []) {
      if (typeof data === "object" && data !== null && data.expiresAt > now) {
        this.tokens.set(hash, data);
      }
    }
  }

  /** Without a writable state dir every restart logs users out: say so loudly. */
  checkWritable(): boolean {
    const probe = `${this.path}.probe`;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(probe, "", { mode: 0o600 });
      unlinkSync(probe);
      return true;
    } catch (err) {
      console.error(
        `oauth_state_not_writable: ${dirname(this.path)} (${errorMessage(err)}). ` +
          "OAuth tokens will be lost on every restart and clients will have to sign in again."
      );
      return false;
    }
  }

  /** Periodically drops expired entries; returns a function that stops it. */
  startPruning(intervalMs = PRUNE_INTERVAL_MS): () => void {
    const timer = setInterval(() => this.prune(), intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  prune(): void {
    const now = this.now();
    let dirty = false;
    const drop = <V>(map: Map<string, V>, expired: (v: V) => boolean) => {
      for (const [key, value] of map) {
        if (expired(value)) {
          map.delete(key);
          dirty = true;
        }
      }
    };
    drop(this.codes, (ac) => ac.expiresAt <= now);
    drop(this.pending, (p) => p.expiresAt <= now);
    drop(this.tokens, (t) => t.expiresAt <= now);
    // Guard against a non-finite timestamp so the comparison can't silently
    // evaluate to false and keep a client alive forever.
    drop(this.clients, (c) => {
      const issuedAtMs = Number.isFinite(c.clientIdIssuedAt) ? c.clientIdIssuedAt * 1000 : 0;
      return issuedAtMs + this.clientTtlMs <= now;
    });
    if (dirty) this.save();
  }

  // ─── Clients (RFC 7591) ─────────────────────────────────────────────────────

  registerClient(input: { redirectUris: string[]; clientName?: string }): RegisteredClient {
    const client: RegisteredClient = {
      clientId: `ormcp_${randomToken(18)}`,
      clientIdIssuedAt: Math.floor(this.now() / 1000),
      redirectUris: input.redirectUris,
      clientName: input.clientName,
    };
    this.clients.set(client.clientId, client);
    this.save();
    return client;
  }

  getClient(clientId: string): RegisteredClient | undefined {
    return this.clients.get(clientId);
  }

  // ─── Pending PocketID transactions ──────────────────────────────────────────

  /** Stores a pending authorization and returns its transaction id. */
  beginPending(input: Omit<PendingAuth, "expiresAt">): string {
    this.prune();
    const txn = randomToken(24);
    this.pending.set(txn, { ...input, expiresAt: this.now() + PENDING_TTL_MS });
    this.save();
    return txn;
  }

  cancelPending(txn: string): void {
    if (this.pending.delete(txn)) this.save();
  }

  /** Single-use: removes the transaction and returns it unless it expired. */
  consumePending(txn: string): PendingAuth | undefined {
    const p = this.pending.get(txn);
    if (!p) return undefined;
    this.pending.delete(txn);
    this.save();
    return p.expiresAt < this.now() ? undefined : p;
  }

  // ─── Authorization codes ────────────────────────────────────────────────────

  issueCode(input: Omit<AuthorizationCode, "expiresAt">): string {
    const code = randomToken(24);
    this.codes.set(code, { ...input, expiresAt: this.now() + CODE_TTL_MS });
    this.save();
    return code;
  }

  /** Single-use: removes the code (even if it is then rejected) and returns it unless expired. */
  consumeCode(code: string): AuthorizationCode | undefined {
    const ac = this.codes.get(code);
    if (!ac) return undefined;
    this.codes.delete(code);
    this.save();
    return ac.expiresAt < this.now() ? undefined : ac;
  }

  // ─── Access tokens ──────────────────────────────────────────────────────────

  /** Issues a token; only its hash is kept. */
  issueToken(input: Omit<StoredToken, "expiresAt">): string {
    const token = `ormcp_at_${randomToken(32)}`;
    this.tokens.set(sha256(token), { ...input, expiresAt: this.now() + this.tokenTtlS * 1000 });
    this.save();
    return token;
  }

  verifyToken(token: string): StoredToken | undefined {
    if (!token) return undefined;
    const hash = sha256(token);
    const stored = this.tokens.get(hash);
    if (!stored) return undefined;
    if (stored.expiresAt <= this.now()) {
      this.tokens.delete(hash);
      this.save();
      return undefined;
    }
    return stored;
  }

  revokeToken(token: string): void {
    if (this.tokens.delete(sha256(token))) this.save();
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const payload: PersistedState = {
        clients: [...this.clients.entries()],
        authorizationCodes: [...this.codes.entries()],
        pendingAuth: [...this.pending.entries()],
        accessTokens: [...this.tokens.entries()],
      };
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(payload), { encoding: "utf-8", mode: 0o600 });
      chmodSync(tmp, 0o600); // covers the case where a loose tmp file already existed
      renameSync(tmp, this.path);
    } catch (err) {
      console.error("oauth_state_persist_failed:", errorMessage(err));
    }
  }
}
