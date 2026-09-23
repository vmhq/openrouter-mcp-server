/** Types for the subset of the OpenRouter API this server uses. */

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  created?: number;
  context_length: number | null;
  architecture?: {
    modality?: string;
    input_modalities?: string[];
    output_modalities?: string[];
  };
  pricing: {
    prompt: string;
    completion: string;
    [key: string]: string | undefined;
  };
  top_provider?: {
    context_length?: number | null;
    max_completion_tokens?: number | null;
  };
  supported_parameters?: string[];
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export const REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatCompletionParams {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  reasoningEffort?: ReasoningEffort;
  webSearch?: boolean;
  webMaxResults?: number;
}

export interface ChatCompletionResult {
  id: string;
  model: string;
  content: string;
  finishReason?: string;
  usage?: ChatUsage;
}

// System One (decision) models such as TypeSafe's Jev don't generate text:
// they answer typed questions about a state via POST /v1/systemone.
export type SystemOneQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface SystemOneResult {
  id?: string;
  model: string;
  provider?: string;
  answers: Record<string, Record<string, unknown>>;
  usage?: { input_tokens?: number; output_tokens?: number; cost?: number };
}
