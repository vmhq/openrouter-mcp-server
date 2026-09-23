# Propuesta de refactorización — openrouter-mcp-server

> Estado de partida: `main` @ `84e6424`. `npm test` → 50/50 en verde, `tsc --strict` sin errores.

## Estado: implementada

Las seis fases están implementadas, una por commit (`Phase 0` … `Phase 5`), más dos
commits previos que solo añaden ESLint/Prettier y aplican el formato. Resultado:
119 tests en verde (antes 50), lint limpio, y el snapshot de `tools/list` intacto
desde la Fase 0 (nombres, descripciones y esquemas de las tools sin cambios).

Cambios de comportamiento visibles, todos intencionales:

- **A1:** con PocketID desactivado ya no se aceptan tokens OAuth persistidos.
- **OAuth apagado = sin endpoints OAuth:** sin `POCKETID_*` ya no se sirven
  `/.well-known/oauth-*` ni `/oauth/*` (antes respondían con una página de error), no
  se crea `./data`, y el 401 de `/mcp` deja de anunciar `resource_metadata`.
- **Config estricta (A4):** un valor inválido detiene el arranque con un mensaje que
  nombra la variable. Además, configurar solo algunas `POCKETID_*` o poner topes de
  tier desordenados ahora es un error (antes se ignoraba en silencio). Los valores por
  defecto no cambian y hay un test que los fija.
- **Presupuesto (A5):** con `MAX_OUTPUT_TOKENS` agotado, `resolveBudget` devuelve un
  error en vez de volver al techo completo.
- **`openrouter_list_models`:** un tope de salida de 0 se muestra como `null`, igual
  que ya hacía `openrouter_get_model`.
- **Node ≥ 20** en `engines` (CI y Docker ya usaban 22).

El resto de este documento es la propuesta original, que se conserva como contexto.

## 1. Diagnóstico general

El código está en buen estado: tipado estricto, comentarios que explican el *porqué*,
lógica de dominio pura (`budget.ts`, `completion.ts`, `selection.ts`) con tests, y un
cliente HTTP con reintentos y caché bien pensado. Los problemas no son de calidad
línea a línea, sino de **estructura**, y se concentran en cuatro frentes:

1. **Efectos secundarios al importar** (OAuth y config): el servidor no se puede
   instanciar ni testear sin tocar disco, `process.env` y timers globales. Esto
   además produce un fallo de seguridad real (ver A1).
2. **Módulos con responsabilidades mezcladas**: `openrouter.ts` y `tools/shared.ts`
   hacen de "cajón de sastre"; las capacidades de un modelo están repartidas en tres
   archivos.
3. **Lógica de dominio dentro de los handlers MCP** (resolución de modelo, política,
   fallback de runners-up), que es precisamente la parte sin tests.
4. **Duplicación y código muerto** de bajo impacto pero que se acumula.

## 2. Hallazgos

### A. Con impacto en comportamiento (priorizar)

| # | Hallazgo | Dónde | Severidad |
|---|---|---|---|
| A1 | **Tokens OAuth siguen siendo válidos aunque se desactive PocketID.** `state.ts` carga `data/oauth-state.json` al importarse, siempre. Si quitas `POCKETID_*` pero mantienes `MCP_AUTH_TOKEN`, el middleware sigue llamando a `verifyAccessToken()` y acepta cualquier token emitido antes (TTL por defecto: 30 días). Desactivar OAuth no revoca el acceso. | `src/index.ts:118-126`, `src/oauth/state.ts:199` | Alta |
| A2 | **`oauth/state.ts` ejecuta código al importarse aunque OAuth esté apagado**: crea `./data`, puede loguear `oauth_state_not_writable` (engañoso sin OAuth), arranca un `setInterval`, y **lanza excepción en el import** si `MCP_OAUTH_TOKEN_TTL_S` es inválido — fuera de `loadConfig()`. Se importa siempre vía `index.ts:30` (`constantTimeEqual`) y `endpoints.ts`. | `src/oauth/state.ts:71-83, 195-201` | Media |
| A3 | **Handlers async con `void` en Express 4.** Si algo lanza dentro de `beginAuthorize`/`oauthCallback`, la promesa rechazada queda sin manejar → en Node ≥ 15 eso **termina el proceso**. Hoy no hay un disparador conocido (los `fetch` están envueltos), pero es una mina para cualquier cambio futuro. | `src/index.ts:107, 110` | Media |
| A4 | **La config ignora valores inválidos en silencio**: `MAX_CONTINUATIONS=abc` o `-1` → valor por defecto sin aviso; `PORT=3000.5` se acepta; `loadConfig()` hace `process.exit(1)` internamente, lo que impide testearla. | `src/config.ts:13-18, 71-76` | Media |
| A5 | `resolveBudget` usa `remainingOverall \|\| cfg.maxOutputTokens`: cuando el presupuesto global está agotado (0), el `hardCap` vuelve al techo completo. Hoy lo tapa el chequeo previo en `completion.ts:181-188`, pero la función es incorrecta por sí sola. | `src/budget.ts:111` | Baja |

### B. Estructura y cohesión

- **B1 — `openrouter.ts` mezcla 5 cosas**: tipos de la API, cliente HTTP con reintentos,
  precios, clasificación de modelos (`isDecisionModel`, `isSystemOneModelId`,
  `supportsTools`) y una utilidad genérica (`round`). A la vez, otras capacidades del
  modelo viven en `budget.ts` (`isReasoningModel`, `modelCompletionCap`) y en
  `tools/shared.ts` (`modelSummary`). No hay un único lugar que responda
  "¿qué sabe hacer este modelo?".
- **B2 — `tools/shared.ts` (265 líneas)** mezcla helpers de resultado MCP, anotaciones,
  esquemas zod, la tabla markdown de modelos y el renderizado de delegaciones.
- **B3 — Dependencia cruzada entre tools**: `delegate.ts` importa
  `decisionModelRedirect` de `decide.ts`.
- **B4 — Resolución de modelo + política duplicada con reglas distintas** en
  `delegate.ts:113-136` y `decide.ts:87-109` (uno canonicaliza `jev-latest` →
  `typesafe/…` y quita `~`, el otro no). El bucle de fallback a runners-up ante 404
  (`delegate.ts:192-225`) es lógica de dominio dentro del handler y **no tiene tests**.
- **B5 — `index.ts` es un script de nivel superior**: config, cliente, app Express,
  rutas y `listen()` ocurren al importarse. No hay forma de levantar la app en un test.
- **B6 — Estado OAuth como `Map`s globales mutables exportados**: los handlers mutan
  los mapas y llaman a `saveState()` a mano en ~10 sitios (fácil olvidar uno:
  `verifyAccessToken` borra tokens expirados sin persistir). `PocketIdConfig`
  (`pocketid.ts:15`) es idéntico a `PocketIdSettings` (`config.ts:27`), y la caché de
  discovery es una variable de módulo.

### C. Duplicación y código muerto

| Qué | Dónde |
|---|---|
| `DelegationOptions` no se usa; `delegate.ts` redeclara el mismo tipo inline. Debería salir de `z.infer` del esquema. | `tools/shared.ts:158-167`, `tools/delegate.ts:39-48` |
| Unión `"none" \| "low" \| "medium" \| "high"` repetida 4 veces | `openrouter.ts:37`, `shared.ts:145, 162`, `delegate.ts:43` |
| `buildMessages` devuelve un tipo inline en vez de `ChatMessage[]` | `tools/shared.ts:169-177` |
| Quitar el prefijo `~` de alias, en 4 sitios | `openrouter.ts:80`, `selection.ts:22-23`, `decide.ts:92` |
| `err instanceof Error ? err.message : String(err)` ×7; `toErrorMessage` tiene una rama `OpenRouterError` redundante; la rama `DelegationError` de auto-delegate también lo es | `tools/shared.ts:55-58`, `delegate.ts:227`, `oauth/*` |
| `try { … } catch { return errorResult(toErrorMessage(err)) }` en cada handler | `tools/*.ts` |
| Normalización de `req.body` ×3 y helper `get()` de query ×2 | `oauth/endpoints.ts:128, 187, 278, 343, 406` |
| `resetPocketIdDiscoveryCache` ("usado por tests") y `AuthInfo`: ningún test ni llamador los usa | `oauth/pocketid.ts:61-64`, `endpoints.ts:51-56, 426-441` |
| Versión `"1.0.0"` duplicada respecto a `package.json` | `index.ts:42` |
| "30 minutes" escrito a mano en descripción y error, en vez de derivar de `TTL_MS` | `tools/delegate.ts:249, 265` |
| Redondeo manual `Math.round(x*100)/100` en vez de `round(x, 2)` | `selection.ts:189` |
| `modelSummary.max_completion_tokens` duplica `modelCompletionCap` | `tools/shared.ts:81` |
| Tres páginas HTML con el mismo esqueleto y dos juegos de cabeceras casi iguales | `oauth/views.ts:9-23` |
| `(params.min_context ?? 0)` redundante tras el `if` | `tools/models.ts:94` |

### D. Tooling

- Sin ESLint/Prettier → formato inconsistente (p. ej. `if (x) { a(); b(); }` en una línea en `state.ts`/`endpoints.ts`).
- Sin tests para `tools/`, `oauth/` ni `config.ts` — justo donde están A1–A4 y B4.
- `engines.node >= 18`, pero CI y Docker usan 22 y Node 18 está EOL desde abril de 2025 → subir a `>= 20`.

## 3. Arquitectura objetivo

```
src/
  index.ts              main(): loadConfig → createApp → listen (único punto con side effects)
  app.ts                createApp(deps): express.Express — testeable sin red ni disco
  config.ts             esquema zod del entorno → ServerConfig | ConfigError (incluye oauth.statePath, oauth.tokenTtlS)
  util.ts               round, errorMessage, stripAlias, delay
  openrouter/
    types.ts            tipos de la API
    client.ts           OpenRouterClient (HTTP, reintentos, caché de catálogo)
  models/
    capabilities.ts     isDecisionModel, isReasoningModel, supportsTools, completionCap, isSystemOneModelId
    pricing.ts          pricePerM, blendedPricePerM, isFreeModel, estimateCostUsd
    policy.ts           isAllowedByPolicy, isIdAllowedByLists
    selection.ts        pickModelForTier
    resolve.ts          resolveTextModel / resolveDecisionModel → Result<Model, string>
  delegation/
    budget.ts
    run.ts              runDelegation (ex completion.ts)
    fallback.ts         delegateWithFallback (ex bucle de auto-delegate)
    responseStore.ts
  tools/
    index.ts
    result.ts           textResult, jsonResult, errorResult, withErrors, anotaciones
    schemas.ts          delegationOptionsSchema + tipos inferidos
    render.ts           modelSummary, tabla markdown, renderDelegation
    models.ts  delegate.ts  decide.ts  credits.ts   ← solo wiring MCP
  oauth/
    router.ts           createOAuthRouter(...) + bearer middleware
    store.ts            class OAuthStore (mapas + persistencia + prune), sin side effects al importar
    handlers.ts         ex endpoints.ts, reciben store e idp por parámetro
    pocketid.ts         class PocketIdClient (caché de discovery por instancia)
    redirectUri.ts  views.ts
```

Regla de dependencias: `tools/` y `oauth/` → `delegation/` → `models/` → `openrouter/` → `util`.
Nada fuera de `index.ts` lee `process.env`, toca disco al importarse ni arranca timers.

### Bocetos de las piezas clave

**Handlers sin try/catch repetido** (`tools/result.ts`):

```ts
export function withErrors<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  };
}
```

**Resolución de modelo única** (`models/resolve.ts`) — reemplaza `delegate.ts:113-136` y `decide.ts:87-109`:

```ts
export type Resolved<T> = { ok: true; model: T } | { ok: false; error: string };

export async function resolveTextModel(
  id: string | undefined,
  catalog: Pick<OpenRouterClient, "listModels">,
  cfg: ServerConfig
): Promise<Resolved<OpenRouterModel>>;

export async function resolveDecisionModel(
  id: string | undefined,
  catalog: Pick<OpenRouterClient, "listModels">,
  cfg: ServerConfig
): Promise<Resolved<{ id: string; canonicalId: string; entry?: OpenRouterModel }>>;
```

**Estado OAuth explícito** (`oauth/store.ts`) — resuelve A1, A2 y B6:

```ts
export class OAuthStore {
  constructor(private opts: { path: string; tokenTtlS: number; now?: () => number }) {}
  load(): void;                       // lectura explícita, no al importar
  startPruning(intervalMs: number): () => void; // devuelve stop()
  registerClient(c: NewClient): RegisteredClient;
  getClient(id: string): RegisteredClient | undefined;
  beginPending(p: PendingAuth): string;          // devuelve txn
  consumePending(txn: string): PendingAuth | undefined;
  issueCode(c: AuthorizationCode): string;
  consumeCode(code: string): AuthorizationCode | undefined;
  issueToken(clientId: string, scopes: string[], resource?: string): string;
  verifyToken(token: string): StoredToken | undefined;
  revokeToken(token: string): void;
  // cada mutación persiste internamente → no más saveState() sueltos
}
```

En `createApp`, el store y el router OAuth **solo se instancian si PocketID está
configurado**; el middleware de `/mcp` recibe `verifyToken` opcional. Con OAuth
apagado no existe camino para aceptar tokens persistidos (A1) ni se toca `./data` (A2).

**Config validada** (`config.ts`): un `z.object` sobre `process.env` con
`z.coerce.number().int().min(…)`, defaults y mensajes claros; `loadConfig(env)`
devuelve o lanza `ConfigError` listando todas las variables inválidas, y solo
`main()` decide hacer `process.exit(1)`.

## 4. Plan por fases

Cada fase es un PR pequeño, con `npm test` en verde y **sin cambios en el contrato
público de las tools** (nombres, esquemas de entrada, descripciones y forma de la
salida), salvo los bugs señalados. Para garantizarlo, la Fase 0 añade un snapshot de
`tools/list`.

| Fase | Contenido | Resuelve | Esfuerzo | Riesgo |
|---|---|---|---|---|
| 0. Red de seguridad | ESLint + Prettier (formateo en un commit aparte). Tests de handlers con `InMemoryTransport` del SDK de MCP (delegate, auto-delegate con fallback 404, decide, fetch_response). Snapshot de `tools/list`. Tests de `redirectUri.ts`. | D | M | Bajo |
| 1. Arreglos puntuales | Verificar tokens OAuth solo si `oauthEnabled`. `asyncHandler` para las rutas async. `remainingOverall` explícito en `resolveBudget`. Subir `engines` a `>=20`. | A1, A3, A5 | S | Bajo |
| 2. OAuth sin side effects | `OAuthStore`, `PocketIdClient`, `createOAuthRouter`; mover `MCP_OAUTH_*` a `ServerConfig`; tests de endpoints (register → authorize → callback → token → revoke) con PocketID falso. | A2, B6 | M | Medio (tocar auth: probar a mano con Claude.ai antes de desplegar) |
| 3. Config + composición | Config con zod; `createApp(deps)` + `main()`; versión leída de `package.json`. Tests de config. | A4, B5 | S–M | Bajo |
| 4. Dominio | Carpetas `models/` y `delegation/`; `resolve.ts` y `fallback.ts` extraídos de los handlers; partir `tools/shared.ts`; `withErrors`. | B1–B4 | M | Bajo (movimientos mecánicos + tests de la Fase 0) |
| 5. Limpieza | Todo lo de la tabla C: código muerto, tipos inferidos de zod, `stripAlias`, constantes derivadas, plantilla HTML común en `views.ts`. | C | S | Muy bajo |

Orden recomendado: 0 → 1 → 2 → 3 → 4 → 5. La Fase 1 puede ir antes que la 0 si se
quiere cerrar A1 de inmediato: es un cambio de pocas líneas.

## 5. Fuera de alcance (a propósito)

- **Base de datos para el estado OAuth**: el JSON atómico basta para una instancia
  única en un homelab; `OAuthStore` deja la puerta abierta a cambiarlo después.
- **Sesiones MCP con estado**: el diseño stateless por request es correcto y simple.
- **Migrar a Express 5**: resolvería A3 de forma nativa, pero es independiente;
  `asyncHandler` cubre el riesgo con menos superficie de cambio.
- **Cambiar las heurísticas** (blended 0.7/0.3, bandas de tiers, `CHARS_PER_TOKEN`):
  son decisiones de producto, no de estructura.
