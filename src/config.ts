import { z } from "zod";

/**
 * Server configuration, parsed and validated from environment variables.
 *
 * An invalid value is a startup error that names the variable, instead of
 * being silently replaced by its default. An empty variable counts as unset
 * (docker-compose often passes `VAR=`), except for EMPTY_IS_A_VALUE.
 */

export interface PocketIdSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
}

export interface ServerConfig {
  openRouterApiKey: string;
  /** OpenRouter API base; override to point at a proxy or gateway. */
  openRouterBaseUrl: string;
  port: number;
  mcpAuthToken?: string;
  /** Public base URL of this server (e.g. https://mcp.example.com). */
  publicUrl?: string;
  /** PocketID OIDC identity provider for the interactive OAuth flow. */
  pocketId?: PocketIdSettings;
  /** Where OAuth state (clients, codes, token hashes) is persisted. */
  oauthStatePath: string;
  /** Lifetime of OAuth-issued access tokens, in seconds. */
  oauthTokenTtlS: number;
  appUrl?: string;
  appTitle?: string;
  defaultModel?: string;
  maxPromptPricePerM?: number;
  maxCompletionPricePerM?: number;
  allowedModels: string[];
  blockedModels: string[];
  allowFreeModels: boolean;
  preferredProviders: string[];
  tierEconomyMaxPrice: number;
  tierBalancedMaxPrice: number;
  tierQualityMaxPrice: number;
  modelsCacheTtlMs: number;
  /** Completion budget used when the caller does not pass max_tokens. */
  defaultMaxTokens: number;
  /** Floor applied to reasoning models, whose budget is eaten by CoT first. */
  reasoningMinMaxTokens: number;
  /** Hard ceiling for one delegation, summed across auto-continuations. */
  maxOutputTokens: number;
  /** How many times a truncated answer may be auto-continued. */
  maxContinuations: number;
  /** Max characters returned inline in a tool result before paging kicks in. */
  maxResponseChars: number;
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}

// ─── Field parsers ────────────────────────────────────────────────────────────

const withoutTrailingSlash = (s: string) => s.replace(/\/$/, "");

const optionalString = z.string().trim().optional();
const number = <T extends z.ZodTypeAny>(schema: T) => z.coerce.number().pipe(schema);
const nonNegative = z.number().finite().min(0);
const count = z.number().int().min(0);
const positiveInt = z.number().int().min(1);

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );

const TRUE = ["true", "1", "yes", "on"];
const FALSE = ["false", "0", "no", "off"];
const boolean = z
  .string()
  .trim()
  .toLowerCase()
  .refine((v) => TRUE.includes(v) || FALSE.includes(v), {
    message: `expected one of ${[...TRUE, ...FALSE].join(", ")}`,
  })
  .transform((v) => TRUE.includes(v));

/** OAuth discovery URLs must be absolute; assume https when no scheme given. */
const publicUrl = optionalString.transform((v) => {
  if (!v) return undefined;
  const trimmed = withoutTrailingSlash(v);
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
});

const DEFAULT_PREFERRED_PROVIDERS =
  "openai,anthropic,google,meta-llama,mistralai,deepseek,qwen,x-ai,amazon";

/** Variables where an explicitly empty value is meaningful rather than "unset". */
const EMPTY_IS_A_VALUE = new Set(["PREFERRED_PROVIDERS"]);

function blanksToUndefined(env: unknown): unknown {
  if (typeof env !== "object" || env === null) return env;
  return Object.fromEntries(
    Object.entries(env).map(([k, v]) => [
      k,
      typeof v === "string" && v.trim() === "" && !EMPTY_IS_A_VALUE.has(k) ? undefined : v,
    ])
  );
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const envSchema = z.preprocess(
  blanksToUndefined,
  z
    .object({
      OPENROUTER_API_KEY: z.string({
        required_error: "is required. Copy .env.example to .env and set your key.",
      }),
      OPENROUTER_BASE_URL: z
        .string()
        .url()
        .default("https://openrouter.ai/api/v1")
        .transform(withoutTrailingSlash),
      PORT: number(z.number().int().min(1).max(65535)).default(3000),
      MCP_AUTH_TOKEN: optionalString,
      MCP_PUBLIC_URL: publicUrl,

      POCKETID_ISSUER: z.string().trim().url().optional(),
      POCKETID_CLIENT_ID: optionalString,
      POCKETID_CLIENT_SECRET: optionalString,
      POCKETID_SCOPES: z
        .string()
        .default("openid profile email")
        .transform((v) => v.split(/\s+/).filter(Boolean)),
      MCP_OAUTH_STATE_PATH: z.string().default("./data/oauth-state.json"),
      MCP_OAUTH_TOKEN_TTL_S: number(positiveInt).default(2_592_000), // 30 days

      APP_URL: optionalString,
      APP_TITLE: optionalString,
      DEFAULT_MODEL: optionalString,
      MAX_PROMPT_PRICE_PER_M: number(nonNegative).optional(),
      MAX_COMPLETION_PRICE_PER_M: number(nonNegative).optional(),
      ALLOWED_MODELS: list,
      BLOCKED_MODELS: list,
      ALLOW_FREE_MODELS: boolean.default("true"),
      // An explicitly empty value disables provider preference.
      PREFERRED_PROVIDERS: z.string().default(DEFAULT_PREFERRED_PROVIDERS).pipe(list),
      TIER_ECONOMY_MAX_PRICE: number(nonNegative).default(0.5),
      TIER_BALANCED_MAX_PRICE: number(nonNegative).default(3),
      TIER_QUALITY_MAX_PRICE: number(nonNegative).default(15),
      MODELS_CACHE_TTL_SECONDS: number(nonNegative).default(300),
      DEFAULT_MAX_TOKENS: number(positiveInt).default(4096),
      REASONING_MIN_MAX_TOKENS: number(count).default(2000),
      MAX_OUTPUT_TOKENS: number(positiveInt).default(32_000),
      MAX_CONTINUATIONS: number(count).default(3),
      MAX_RESPONSE_CHARS: number(positiveInt).default(25_000),
    })
    .superRefine((env, ctx) => {
      const pocketIdVars = [
        "POCKETID_ISSUER",
        "POCKETID_CLIENT_ID",
        "POCKETID_CLIENT_SECRET",
      ] as const;
      const missing = pocketIdVars.filter((k) => !env[k]);
      if (missing.length > 0 && missing.length < pocketIdVars.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [missing[0]],
          message: `is required when any POCKETID_* variable is set (missing: ${missing.join(", ")})`,
        });
      }
      if (
        env.TIER_ECONOMY_MAX_PRICE > env.TIER_BALANCED_MAX_PRICE ||
        env.TIER_BALANCED_MAX_PRICE > env.TIER_QUALITY_MAX_PRICE
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["TIER_ECONOMY_MAX_PRICE"],
          message:
            "tier ceilings must satisfy TIER_ECONOMY_MAX_PRICE <= TIER_BALANCED_MAX_PRICE <= TIER_QUALITY_MAX_PRICE",
        });
      }
    })
);

/**
 * Parses the server configuration from `env` (process.env by default).
 * Throws ConfigError listing every invalid variable.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(
      parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`)
    );
  }
  const e = parsed.data;

  const pocketId: PocketIdSettings | undefined =
    e.POCKETID_ISSUER && e.POCKETID_CLIENT_ID && e.POCKETID_CLIENT_SECRET
      ? {
          issuer: withoutTrailingSlash(e.POCKETID_ISSUER),
          clientId: e.POCKETID_CLIENT_ID,
          clientSecret: e.POCKETID_CLIENT_SECRET,
          scopes: e.POCKETID_SCOPES,
        }
      : undefined;

  return {
    openRouterApiKey: e.OPENROUTER_API_KEY,
    openRouterBaseUrl: e.OPENROUTER_BASE_URL,
    port: e.PORT,
    mcpAuthToken: e.MCP_AUTH_TOKEN,
    publicUrl: e.MCP_PUBLIC_URL,
    pocketId,
    oauthStatePath: e.MCP_OAUTH_STATE_PATH,
    oauthTokenTtlS: e.MCP_OAUTH_TOKEN_TTL_S,
    appUrl: e.APP_URL,
    appTitle: e.APP_TITLE,
    defaultModel: e.DEFAULT_MODEL,
    maxPromptPricePerM: e.MAX_PROMPT_PRICE_PER_M,
    maxCompletionPricePerM: e.MAX_COMPLETION_PRICE_PER_M,
    allowedModels: e.ALLOWED_MODELS,
    blockedModels: e.BLOCKED_MODELS,
    allowFreeModels: e.ALLOW_FREE_MODELS,
    preferredProviders: e.PREFERRED_PROVIDERS,
    tierEconomyMaxPrice: e.TIER_ECONOMY_MAX_PRICE,
    tierBalancedMaxPrice: e.TIER_BALANCED_MAX_PRICE,
    tierQualityMaxPrice: e.TIER_QUALITY_MAX_PRICE,
    modelsCacheTtlMs: e.MODELS_CACHE_TTL_SECONDS * 1000,
    defaultMaxTokens: e.DEFAULT_MAX_TOKENS,
    reasoningMinMaxTokens: e.REASONING_MIN_MAX_TOKENS,
    maxOutputTokens: e.MAX_OUTPUT_TOKENS,
    maxContinuations: e.MAX_CONTINUATIONS,
    maxResponseChars: e.MAX_RESPONSE_CHARS,
  };
}
