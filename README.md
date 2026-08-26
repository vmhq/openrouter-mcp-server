# OpenRouter MCP Server

Servidor MCP remoto (HTTP streamable, JSON stateless) que permite a agentes de IA **delegar tareas a modelos más económicos** vía la API de OpenRouter, consultando el catálogo y los **precios en vivo**, con una política de costos configurable por archivo `.env`.

## Qué hace

- **Catálogo en vivo**: consulta `GET /api/v1/models` de OpenRouter (con caché de 5 min) y expone precios en USD por millón de tokens, ventana de contexto y soporte de tool-calling.
- **Delegación explícita**: el agente elige el modelo viendo los precios y delega la tarea.
- **Delegación automática por precio**: el servidor elige el modelo según un tier (`economy` / `balanced` / `quality`) usando bandas de precio configurables.
- **Política en `.env`**: límites de precio máximo, listas de modelos permitidos/bloqueados, modelo por defecto, proveedores preferidos.
- **Costo real**: cada delegación devuelve tokens usados y costo estimado en USD.

## Instalación

```bash
npm install
cp .env.example .env   # edita y pon tu OPENROUTER_API_KEY
npm run build
npm start              # queda en http://localhost:3000/mcp
```

Para desarrollo con recarga automática: `npm run dev`.

## Variables de entorno

Ver [.env.example](.env.example) — las principales:

| Variable | Descripción |
|---|---|
| `OPENROUTER_API_KEY` | **Requerida.** Tu key de https://openrouter.ai/keys |
| `PORT` | Puerto HTTP (default 3000) |
| `MCP_AUTH_TOKEN` | Si se define, los clientes deben enviar `Authorization: Bearer <token>`. **Obligatorio en la práctica si expones el servidor fuera de localhost.** |
| `MCP_PUBLIC_URL` | URL pública del servidor (ej. `https://mcp.example.com`); necesaria para el flujo OAuth detrás de un reverse proxy |
| `POCKETID_ISSUER` / `POCKETID_CLIENT_ID` / `POCKETID_CLIENT_SECRET` | Habilitan el login OAuth interactivo delegando la autenticación a tu instancia [PocketID](https://pocket-id.org) (ver más abajo) |
| `DEFAULT_MODEL` | Modelo usado por `openrouter_delegate_task` si el agente no especifica uno |
| `MAX_PROMPT_PRICE_PER_M` / `MAX_COMPLETION_PRICE_PER_M` | Techo de precio (USD/M tokens); modelos más caros se rechazan |
| `ALLOWED_MODELS` / `BLOCKED_MODELS` | Listas separadas por comas: ids exactos o prefijos (`openai/`) |
| `ALLOW_FREE_MODELS` | Permitir modelos gratis (default `true`) |
| `TIER_*_MAX_PRICE` | Techos de precio combinado (0.7·input + 0.3·output) de cada tier de la selección automática |

## Tools expuestas

| Tool | Descripción |
|---|---|
| `openrouter_list_models` | Lista modelos con precios en vivo; filtros por texto, precio, contexto, tool-calling; orden por precio/contexto/novedad; paginada |
| `openrouter_get_model` | Detalle completo de un modelo + si la política del `.env` lo permite |
| `openrouter_delegate_task` | Delega una tarea a un modelo específico; devuelve respuesta, tokens y costo estimado |
| `openrouter_auto_delegate` | El servidor elige el modelo por tier de precio (`economy`/`balanced`/`quality`) y delega |
| `openrouter_check_credits` | Uso y límites de la API key configurada |

Flujo típico de un agente: `openrouter_list_models` (o directamente `openrouter_auto_delegate` con tier `economy`) → delegar la tarea → usar la respuesta, sabiendo cuánto costó.

**Importante**: el modelo delegado **no ve la conversación del agente**; la tarea (`task`) debe ser autocontenida, con todo el contexto necesario.

## Conectar un agente

**Claude Code:**

```bash
claude mcp add --transport http openrouter http://localhost:3000/mcp
```

Con token de auth:

```bash
claude mcp add --transport http openrouter http://TU_HOST:3000/mcp --header "Authorization: Bearer TU_TOKEN"
```

**Cualquier cliente MCP**: apunta al endpoint `POST /mcp` con transporte "streamable HTTP". Hay un endpoint `GET /health` para monitoreo.

**claude.ai (conector remoto)**: necesita una URL pública HTTPS — despliega el servidor en un VPS detrás de un reverse proxy (Caddy/nginx) o usa un túnel (p. ej. `cloudflared tunnel`). Con OAuth habilitado (ver abajo), agrega el conector apuntando a `https://TU_HOST/mcp` y deja vacíos los campos avanzados de OAuth Client ID/Secret: el servidor publica metadatos OAuth y soporta Dynamic Client Registration, así que Claude se registra y obtiene su token automáticamente al pulsar **Authorize**.

## OAuth con PocketID

El servidor implementa OAuth 2.1 completo para agentes de IA (Claude, Cursor, …): actúa como **authorization server** hacia los clientes MCP (RFC 7591 Dynamic Client Registration + PKCE S256 + emisión de tokens propios, con metadatos RFC 8414/9728) y delega el **login humano** a tu instancia [PocketID](https://pocket-id.org) vía OIDC (passkey).

Flujo: el cliente MCP recibe un `401` con `WWW-Authenticate` → descubre los metadatos en `/.well-known/oauth-protected-resource` → se registra en `/oauth/register` → abre `/oauth/authorize` en el navegador → el usuario inicia sesión en PocketID con su passkey → PocketID vuelve a `/oauth/callback` → el servidor emite su propio código y el cliente lo canjea en `/oauth/token` por un access token (30 días por defecto).

Configuración:

1. En PocketID, crea un **cliente OIDC** nuevo.
2. Registra el callback: `<MCP_PUBLIC_URL>/oauth/callback`.
3. Restringe quién puede iniciar sesión con los **grupos permitidos** del cliente OIDC en PocketID.
4. Copia el Client ID y el Client Secret a `POCKETID_CLIENT_ID` / `POCKETID_CLIENT_SECRET`, y pon la URL base de PocketID en `POCKETID_ISSUER`.
5. Define `MCP_PUBLIC_URL` con la URL pública HTTPS del servidor.

Si las variables `POCKETID_*` no están definidas, el flujo interactivo `/oauth/authorize` muestra un error; el bearer estático `MCP_AUTH_TOKEN` sigue funcionando en paralelo para acceso máquina-a-máquina (curl, Codex, etc.).

El estado OAuth (clientes registrados, códigos de un solo uso y hashes SHA-256 de los tokens — nunca los tokens en claro) se persiste en `./data/oauth-state.json` (configurable con `MCP_OAUTH_STATE_PATH`). Si tras un reinicio con estado borrado el conector falla, elimínalo en Claude y agrégalo de nuevo para que se re-registre.

## Cómo elige modelo `openrouter_auto_delegate`

1. Filtra el catálogo por la política del `.env` y los requisitos de la llamada (`require_tools`, `min_context`, salida de texto).
2. Calcula el precio combinado por modelo: `0.7·precio_input + 0.3·precio_output` (USD/M tokens).
3. Según el tier, busca en su banda de precio (con fallback a la banda vecina si queda vacía):
   - `economy` (≤ $0.5/M por defecto): el **más barato**.
   - `balanced` ($0.5–$3/M): el más barato de la banda media.
   - `quality` ($3–$15/M): el de mayor precio dentro del techo (precio como proxy de capacidad, sin llegar a modelos flagship).
4. Prefiere proveedores de `PREFERRED_PROVIDERS`, y reporta en la respuesta el modelo elegido, el porqué y las alternativas descartadas.

## Seguridad

- La API key de OpenRouter vive **solo** en el `.env` del servidor; nunca se expone a los agentes.
- El `.env` está en `.gitignore`.
- Si el puerto es accesible desde fuera, define `MCP_AUTH_TOKEN` y sirve detrás de HTTPS.
