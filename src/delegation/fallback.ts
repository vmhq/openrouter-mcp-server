import { OpenRouterError } from "../openrouter/client.js";
import type { OpenRouterModel } from "../openrouter/types.js";

/**
 * Tries each candidate in order, moving on only when OpenRouter answers 404:
 * for a model present in the catalog that means it has no endpoints
 * compatible with the account's data policy (e.g. ZDR). Any other error is
 * final. `attempt` receives the first candidate when it is a fallback.
 */
export async function withDataPolicyFallback<T>(
  candidates: OpenRouterModel[],
  attempt: (model: OpenRouterModel, fellBackFrom?: OpenRouterModel) => Promise<T>
): Promise<T> {
  if (candidates.length === 0) {
    throw new Error("No candidate models to delegate to.");
  }
  for (let i = 0; ; i++) {
    try {
      return await attempt(candidates[i], i > 0 ? candidates[0] : undefined);
    } catch (err) {
      const canFallBack =
        err instanceof OpenRouterError && err.status === 404 && i < candidates.length - 1;
      if (!canFallBack) throw err;
    }
  }
}
