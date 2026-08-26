# OpenRouter MCP Server

Remote MCP server (streamable HTTP, stateless JSON) that lets AI agents **delegate tasks to cheaper models** via the OpenRouter API, querying the catalog and **live prices**, with a cost policy configurable through a `.env` file.

## What it does

- **Live catalog**: queries OpenRouter's `GET /api/v1/models` (with a 5-minute cache) and exposes prices in USD per million tokens, context window, and tool-calling support.
- **Explicit delegation**: the agent picks the model by looking at prices and delegates the task.
- **Automatic price-based delegation**: the server picks the model based on a tier (`economy` / `balanced` / `quality`) using configurable price bands.
- **Policy via `.env`**: max price caps, allowed/blocked model lists, default model, preferred providers.
- **Real cost**: every delegation returns tokens used and estimated cost in USD.

## Installation

```bash
npm install
cp .env.example .env   # edit and set your OPENROUTER_API_KEY
npm run build
npm start              # listens on http://localhost:3000/mcp
```

For development with auto-reload: `npm run dev`.

## Docker

A multi-arch image (`linux/amd64`, `linux/arm64`) is built automatically by GitHub Actions and published to GHCR:

```
ghcr.io/vmhq/openrouter-mcp-server
```

Available tags: `latest` (main branch), `vX.Y.Z` / `X.Y` (releases), `main`, and `sha-<commit>`.

### Docker Compose

```yaml
services:
  openrouter-mcp:
    image: ghcr.io/vmhq/openrouter-mcp-server:latest
    container_name: openrouter-mcp
    restart: unless-stopped
    ports:
      - "3000:3000"
    env_file:
      - .env
    volumes:
      # Persists OAuth state (registered clients, token hashes)
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://localhost:3000/health"]
      interval: 30s
      timeout: 5s
      retries: 3
```

```bash
docker compose up -d
```

> **Note**: the container runs as the unprivileged `node` user. Make sure the mounted `./data` directory is writable by UID 1000 (`chown -R 1000:1000 ./data`), otherwise OAuth state cannot be persisted.

### Example `.env`

```bash
# --- Required ---
# Your OpenRouter API key (https://openrouter.ai/keys)
OPENROUTER_API_KEY=sk-or-v1-...

# --- HTTP server ---
# Port where the MCP endpoint is exposed (http://host:PORT/mcp)
PORT=3000
# Optional static bearer token. If set, MCP clients must send
# "Authorization: Bearer <token>". Strongly recommended if the server
# is reachable outside localhost.
MCP_AUTH_TOKEN=

# --- Interactive OAuth with PocketID (for AI agents like Claude) ---
# Public URL of this server (e.g. https://mcp.example.com). Required so the
# OAuth metadata and callback point to the right URL behind a reverse proxy.
MCP_PUBLIC_URL=
# When all three POCKETID_* variables are set, the /oauth/authorize flow
# delegates the human login to your PocketID instance (passkey).
# In PocketID: create an OIDC client and register this callback:
#   <MCP_PUBLIC_URL>/oauth/callback
POCKETID_ISSUER=
POCKETID_CLIENT_ID=
POCKETID_CLIENT_SECRET=
# Optional OIDC scopes (space-separated). Default: "openid profile email".
# POCKETID_SCOPES=openid profile email
# Path of the file where OAuth state is persisted (registered clients,
# one-time codes, and token hashes). Default: ./data/oauth-state.json
# MCP_OAUTH_STATE_PATH=./data/oauth-state.json
# OAuth access token lifetime, in seconds. Default: 2592000 (30 days).
# MCP_OAUTH_TOKEN_TTL_S=2592000

# --- Optional OpenRouter attribution (rankings) ---
APP_URL=
APP_TITLE=OpenRouter MCP Server

# --- Delegation policy ---
# Default model when the agent doesn't specify one in openrouter_delegate_task
DEFAULT_MODEL=

# Price caps (USD per million tokens). Models above them are rejected
# with an explanatory error. Empty = no limit.
MAX_PROMPT_PRICE_PER_M=
MAX_COMPLETION_PRICE_PER_M=

# Comma-separated control lists. Accept exact ids ("openai/gpt-4.1-mini")
# or provider prefixes ("openai/"). Empty ALLOWED_MODELS = all allowed
# (except blocked ones).
ALLOWED_MODELS=
BLOCKED_MODELS=

# Allow free models (price 0)? They usually have strict rate limits.
ALLOW_FREE_MODELS=true

# Preferred providers for automatic selection (openrouter_auto_delegate)
PREFERRED_PROVIDERS=openai,anthropic,google,meta-llama,mistralai,deepseek,qwen,x-ai,amazon

# "Combined" price caps (70% prompt + 30% completion, USD/M tokens)
# for each tier of the automatic selection.
TIER_ECONOMY_MAX_PRICE=0.5
TIER_BALANCED_MAX_PRICE=3
TIER_QUALITY_MAX_PRICE=15

# Model catalog cache, in seconds
MODELS_CACHE_TTL_SECONDS=300
```

## Environment variables

See [.env.example](.env.example) — the main ones:

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | **Required.** Your key from https://openrouter.ai/keys |
| `PORT` | HTTP port (default 3000) |
| `MCP_AUTH_TOKEN` | If set, clients must send `Authorization: Bearer <token>`. **Effectively mandatory if you expose the server outside localhost.** |
| `MCP_PUBLIC_URL` | Public URL of the server (e.g. `https://mcp.example.com`); required for the OAuth flow behind a reverse proxy |
| `POCKETID_ISSUER` / `POCKETID_CLIENT_ID` / `POCKETID_CLIENT_SECRET` | Enable interactive OAuth login by delegating authentication to your [PocketID](https://pocket-id.org) instance (see below) |
| `DEFAULT_MODEL` | Model used by `openrouter_delegate_task` when the agent doesn't specify one |
| `MAX_PROMPT_PRICE_PER_M` / `MAX_COMPLETION_PRICE_PER_M` | Price ceiling (USD/M tokens); more expensive models are rejected |
| `ALLOWED_MODELS` / `BLOCKED_MODELS` | Comma-separated lists: exact ids or prefixes (`openai/`) |
| `ALLOW_FREE_MODELS` | Allow free models (default `true`) |
| `TIER_*_MAX_PRICE` | Combined price ceilings (0.7·input + 0.3·output) for each tier of the automatic selection |

## Exposed tools

| Tool | Description |
|---|---|
| `openrouter_list_models` | Lists models with live prices; filters by text, price, context, tool-calling; sort by price/context/recency; paginated |
| `openrouter_get_model` | Full detail of a model + whether the `.env` policy allows it |
| `openrouter_delegate_task` | Delegates a task to a specific model; returns response, tokens, and estimated cost |
| `openrouter_auto_delegate` | The server picks the model by price tier (`economy`/`balanced`/`quality`) and delegates |
| `openrouter_check_credits` | Usage and limits of the configured API key |

Typical agent flow: `openrouter_list_models` (or directly `openrouter_auto_delegate` with the `economy` tier) → delegate the task → use the response, knowing how much it cost.

**Important**: the delegated model **does not see the agent's conversation**; the task (`task`) must be self-contained, with all the necessary context.

## Connecting an agent

**Claude Code:**

```bash
claude mcp add --transport http openrouter http://localhost:3000/mcp
```

With an auth token:

```bash
claude mcp add --transport http openrouter http://YOUR_HOST:3000/mcp --header "Authorization: Bearer YOUR_TOKEN"
```

**Any MCP client**: point it at the `POST /mcp` endpoint with the "streamable HTTP" transport. There's a `GET /health` endpoint for monitoring.

**claude.ai (remote connector)**: requires a public HTTPS URL — deploy the server on a VPS behind a reverse proxy (Caddy/nginx) or use a tunnel (e.g. `cloudflared tunnel`). With OAuth enabled (see below), add the connector pointing to `https://YOUR_HOST/mcp` and leave the advanced OAuth Client ID/Secret fields empty: the server publishes OAuth metadata and supports Dynamic Client Registration, so Claude registers itself and obtains its token automatically when you click **Authorize**.

## OAuth with PocketID

The server implements full OAuth 2.1 for AI agents (Claude, Cursor, …): it acts as the **authorization server** towards MCP clients (RFC 7591 Dynamic Client Registration + PKCE S256 + issuing its own tokens, with RFC 8414/9728 metadata) and delegates the **human login** to your [PocketID](https://pocket-id.org) instance via OIDC (passkey).

Flow: the MCP client receives a `401` with `WWW-Authenticate` → discovers the metadata at `/.well-known/oauth-protected-resource` → registers at `/oauth/register` → opens `/oauth/authorize` in the browser → the user signs in to PocketID with their passkey → PocketID returns to `/oauth/callback` → the server issues its own code and the client exchanges it at `/oauth/token` for an access token (30 days by default).

Setup:

1. In PocketID, create a new **OIDC client**.
2. Register the callback: `<MCP_PUBLIC_URL>/oauth/callback`.
3. Restrict who can sign in using the OIDC client's **allowed groups** in PocketID.
4. Copy the Client ID and Client Secret into `POCKETID_CLIENT_ID` / `POCKETID_CLIENT_SECRET`, and set the PocketID base URL in `POCKETID_ISSUER`.
5. Set `MCP_PUBLIC_URL` to the server's public HTTPS URL.

If the `POCKETID_*` variables are not set, the interactive `/oauth/authorize` flow shows an error; the static `MCP_AUTH_TOKEN` bearer keeps working in parallel for machine-to-machine access (curl, Codex, etc.).

OAuth state (registered clients, one-time codes, and SHA-256 hashes of the tokens — never the plaintext tokens) is persisted to `./data/oauth-state.json` (configurable via `MCP_OAUTH_STATE_PATH`). If the connector fails after a restart with wiped state, remove it in Claude and add it again so it re-registers.

## How `openrouter_auto_delegate` picks a model

1. Filters the catalog by the `.env` policy and the call's requirements (`require_tools`, `min_context`, text output).
2. Computes the combined price per model: `0.7·input_price + 0.3·output_price` (USD/M tokens).
3. Depending on the tier, searches within its price band (falling back to the neighboring band if empty):
   - `economy` (≤ $0.5/M by default): the **cheapest**.
   - `balanced` ($0.5–$3/M): the cheapest in the middle band.
   - `quality` ($3–$15/M): the highest-priced within the ceiling (price as a proxy for capability, without reaching flagship models).
4. Prefers providers from `PREFERRED_PROVIDERS`, and reports in the response the chosen model, the reasoning, and the discarded alternatives.

## Security

- The OpenRouter API key lives **only** in the server's `.env`; it is never exposed to agents.
- The `.env` file is in `.gitignore`.
- If the port is reachable from outside, set `MCP_AUTH_TOKEN` and serve behind HTTPS.
