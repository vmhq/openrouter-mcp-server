import { z } from "zod";
import { REASONING_EFFORTS } from "../openrouter/types.js";

/**
 * Options shared by openrouter_delegate_task and openrouter_auto_delegate.
 * `max_tokens` is deliberately described as a cost cap rather than a required
 * knob: the server derives its own budget and stitches truncated answers back
 * together, so callers should normally leave it unset.
 */
export const delegationOptionsSchema = {
  system_prompt: z
    .string()
    .max(50_000)
    .optional()
    .describe("System instructions for the delegated model"),
  max_tokens: z
    .number()
    .int()
    .min(1)
    .max(200_000)
    .optional()
    .describe(
      "OPTIONAL hard cap on completion tokens. Leave it unset unless you need to " +
        "limit cost: the server picks a budget from the model's own limits and " +
        "auto-continues answers cut off by it. A low value here is the usual cause " +
        "of truncated answers."
    ),
  auto_continue: z
    .boolean()
    .default(true)
    .describe("Automatically resume and stitch together answers cut off by the token limit"),
  reasoning_effort: z
    .enum(REASONING_EFFORTS)
    .optional()
    .describe(
      "Reasoning budget on reasoning-capable models ('none' disables it). Ignored otherwise."
    ),
  temperature: z.number().min(0).max(2).optional(),
  web_search: z
    .boolean()
    .default(false)
    .describe("Let OpenRouter inject web search results into the prompt (extra cost)"),
  web_max_results: z.number().int().min(1).max(10).optional(),
};

/** Parsed delegation options, as a tool handler receives them. */
export type DelegationOptions = z.infer<z.ZodObject<typeof delegationOptionsSchema>> & {
  json_mode?: boolean;
};
