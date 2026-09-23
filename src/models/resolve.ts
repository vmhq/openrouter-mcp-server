/**
 * Turns a model id from a tool call into a model the server may use,
 * applying the .env policy — one place for the rules both delegation and
 * decision tools rely on.
 */
import type { ServerConfig } from "../config.js";
import type { OpenRouterModel } from "../openrouter/types.js";
import { stripAlias } from "../util.js";
import { isDecisionModel, isSystemOneModelId } from "./capabilities.js";
import { isAllowedByPolicy, isIdAllowedByLists } from "./policy.js";

export type Resolution<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ModelCatalog {
  listModels(): Promise<OpenRouterModel[]>;
}

export const DEFAULT_DECISION_MODEL = "~typesafe/jev-latest";

export function decisionModelRedirect(modelId: string): string {
  return (
    `Model '${modelId}' is a decision (System One) model: it does not generate text, ` +
    `it answers typed questions about a state. Use openrouter_decide instead.`
  );
}

const fail = (error: string): { ok: false; error: string } => ({ ok: false, error });

/** A text-generating model from the catalog that the policy allows. */
export async function resolveTextModel(
  requestedId: string | undefined,
  catalog: ModelCatalog,
  cfg: ServerConfig
): Promise<Resolution<OpenRouterModel>> {
  const modelId = requestedId ?? cfg.defaultModel;
  if (!modelId) {
    return fail(
      "No model specified and DEFAULT_MODEL is not set in .env. Pass 'model' explicitly (use openrouter_list_models to choose one)."
    );
  }
  if (isSystemOneModelId(modelId)) return fail(decisionModelRedirect(modelId));

  const model = (await catalog.listModels()).find((m) => m.id === modelId);
  if (!model) {
    return fail(
      `Model '${modelId}' not found on OpenRouter. Use openrouter_list_models to find a valid id.`
    );
  }
  if (isDecisionModel(model)) return fail(decisionModelRedirect(modelId));

  const policy = isAllowedByPolicy(model, cfg);
  if (!policy.allowed) {
    return fail(
      `Model '${modelId}' is not allowed: ${policy.reason}. Pick another model with openrouter_list_models.`
    );
  }
  return { ok: true, value: model };
}

export interface DecisionModel {
  /** Id to send to /systemone, as the caller gave it. */
  id: string;
  /** Namespaced id ("typesafe/…"), used when OpenRouter reports none. */
  canonicalId: string;
}

/**
 * A decision (System One) model the policy allows. These are usually absent
 * from /models; when one is listed, the full policy (price caps included)
 * applies, otherwise only the allow/block lists can.
 */
export async function resolveDecisionModel(
  requestedId: string | undefined,
  catalog: ModelCatalog,
  cfg: ServerConfig
): Promise<Resolution<DecisionModel>> {
  const id = requestedId ?? DEFAULT_DECISION_MODEL;
  // Bare TypeSafe ids ("jev-latest") live under typesafe/ on OpenRouter.
  const canonicalId = id.includes("/") ? id : `typesafe/${id}`;

  const model = (await catalog.listModels()).find(
    (m) => stripAlias(m.id) === stripAlias(canonicalId)
  );
  const policy = model ? isAllowedByPolicy(model, cfg) : isIdAllowedByLists(canonicalId, cfg);
  if (!policy.allowed) return fail(`Model '${id}' is not allowed: ${policy.reason}.`);
  if (model && !isDecisionModel(model)) {
    return fail(
      `Model '${id}' is a text model, not a decision model. Use openrouter_delegate_task for it.`
    );
  }
  return { ok: true, value: { id, canonicalId } };
}
