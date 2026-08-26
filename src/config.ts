import { config as loadEnv } from "dotenv";

loadEnv();

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const n = Number(value);
  if (Number.isNaN(n) || n < 0) return undefined;
  return n;
}

export interface ServerConfig {
  openRouterApiKey: string;
  port: number;
  mcpAuthToken?: string;
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
}

export function loadConfig(): ServerConfig {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "ERROR: OPENROUTER_API_KEY is required. Copy .env.example to .env and set your key."
    );
    process.exit(1);
  }

  return {
    openRouterApiKey: apiKey,
    port: parseOptionalNumber(process.env.PORT) ?? 3000,
    mcpAuthToken: process.env.MCP_AUTH_TOKEN || undefined,
    appUrl: process.env.APP_URL || undefined,
    appTitle: process.env.APP_TITLE || undefined,
    defaultModel: process.env.DEFAULT_MODEL || undefined,
    maxPromptPricePerM: parseOptionalNumber(process.env.MAX_PROMPT_PRICE_PER_M),
    maxCompletionPricePerM: parseOptionalNumber(
      process.env.MAX_COMPLETION_PRICE_PER_M
    ),
    allowedModels: parseList(process.env.ALLOWED_MODELS),
    blockedModels: parseList(process.env.BLOCKED_MODELS),
    allowFreeModels:
      (process.env.ALLOW_FREE_MODELS ?? "true").toLowerCase() !== "false",
    preferredProviders: parseList(
      process.env.PREFERRED_PROVIDERS ??
        "openai,anthropic,google,meta-llama,mistralai,deepseek,qwen,x-ai,amazon"
    ),
    tierEconomyMaxPrice:
      parseOptionalNumber(process.env.TIER_ECONOMY_MAX_PRICE) ?? 0.5,
    tierBalancedMaxPrice:
      parseOptionalNumber(process.env.TIER_BALANCED_MAX_PRICE) ?? 3,
    tierQualityMaxPrice:
      parseOptionalNumber(process.env.TIER_QUALITY_MAX_PRICE) ?? 15,
    modelsCacheTtlMs:
      (parseOptionalNumber(process.env.MODELS_CACHE_TTL_SECONDS) ?? 300) * 1000,
  };
}
