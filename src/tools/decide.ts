import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isDecisionModel, round } from "../openrouter.js";
import { isAllowedByPolicy, isIdAllowedByLists } from "../selection.js";
import {
  DELEGATION_ANNOTATIONS,
  type ToolContext,
  errorResult,
  jsonResult,
  toErrorMessage,
} from "./shared.js";

const DEFAULT_DECISION_MODEL = "~typesafe/jev-latest";

export function decisionModelRedirect(modelId: string): string {
  return (
    `Model '${modelId}' is a decision (System One) model: it does not generate text, ` +
    `it answers typed questions about a state. Use openrouter_decide instead.`
  );
}

const questionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: z.string().min(1).max(5_000),
  }),
  z.object({
    type: z.literal("choice"),
    instructions: z.string().min(1).max(5_000),
    criteria: z
      .record(z.string().max(2_000))
      .refine(
        (c) => Object.keys(c).length >= 1 && Object.keys(c).length <= 255,
        "choice criteria must have 1-255 options"
      ),
  }),
  z.object({
    type: z.literal("score"),
    instructions: z.string().min(1).max(5_000),
    criteria: z.array(z.string().min(1).max(2_000)).min(2).max(255),
  }),
]);

export function registerDecisionTools(server: McpServer, ctx: ToolContext): void {
  const { client, cfg } = ctx;

  server.registerTool(
    "openrouter_decide",
    {
      title: "Ask a Decision Model (System One)",
      description: `Ask a decision / "System One" model on OpenRouter — e.g. TypeSafe's Jev ("~typesafe/jev-latest") — typed questions about a piece of text. These models do NOT write text: they return a probability, a picked option, or a rubric score per question, with a confidence. They are very cheap and fast; use them for classification, routing, triage, moderation and yes/no checks instead of delegating to a text LLM.

Put ONLY the material being judged in 'state' and the questions in 'questions' — a question written into the state is judged as text, not answered. Ask one simple judgement per question; combine several questions in code rather than asking a compound one. All questions go in a single request.

Args:
  - model (string, default "~typesafe/jev-latest"): decision model id. Also accepts "jev-latest", "jev-preview" or a pinned version like "typesafe/jev-1.13".
  - state (string): the text to judge (ticket, message, command, conversation...).
  - questions (object): map of name -> question, each one of:
      {type: "noul", instructions}: yes/no → answer {noul: probability of yes, 0-1}.
      {type: "choice", instructions, criteria: {option: meaning, ...}} (1-255 options): pick one → {choice, probabilities, confidence}.
      {type: "score", instructions, criteria: [lowest level, ..., highest level]} (ordered, >= 2): → {score, probabilities, confidence}.

Returns: {model_used, provider, answers: {name: answer}, usage: {input_tokens, output_tokens}, cost_usd}.`,
      inputSchema: {
        model: z
          .string()
          .max(200)
          .optional()
          .describe(`Decision model id; defaults to ${DEFAULT_DECISION_MODEL}`),
        state: z
          .string()
          .min(1)
          .max(200_000)
          .describe("The material to judge — no questions in here"),
        questions: z
          .record(questionSchema)
          .refine((q) => Object.keys(q).length >= 1, "provide at least one question")
          .describe("Map of question name -> typed question"),
      },
      annotations: DELEGATION_ANNOTATIONS,
    },
    async (params) => {
      try {
        const modelId = params.model ?? DEFAULT_DECISION_MODEL;
        // Bare TypeSafe ids ("jev-latest") live under typesafe/ on OpenRouter.
        const canonicalId = modelId.includes("/") ? modelId : `typesafe/${modelId}`;
        const bare = (id: string) => id.replace(/^~/, "");
        // System One models are usually absent from /models; when one is
        // listed, the full policy (price caps included) applies.
        const models = await client.listModels();
        const model = models.find((m) => bare(m.id) === bare(canonicalId));
        const policy = model ? isAllowedByPolicy(model, cfg) : isIdAllowedByLists(canonicalId, cfg);
        if (!policy.allowed) {
          return errorResult(`Model '${modelId}' is not allowed: ${policy.reason}.`);
        }
        if (model && !isDecisionModel(model)) {
          return errorResult(
            `Model '${modelId}' is a text model, not a decision model. Use openrouter_delegate_task for it.`
          );
        }

        const result = await client.systemOne({
          model: modelId,
          state: params.state,
          questions: params.questions,
        });

        return jsonResult({
          model_used: result.model || canonicalId,
          provider: result.provider ?? "unknown",
          answers: result.answers ?? {},
          usage: {
            input_tokens: result.usage?.input_tokens ?? 0,
            output_tokens: result.usage?.output_tokens ?? 0,
          },
          cost_usd: result.usage?.cost !== undefined ? round(result.usage.cost, 6) : undefined,
        });
      } catch (err) {
        return errorResult(toErrorMessage(err));
      }
    }
  );
}
