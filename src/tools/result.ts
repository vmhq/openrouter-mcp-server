/** Building blocks for MCP tool results and handlers. */
import { errorMessage } from "../util.js";

/** Shape of an MCP tool result; the index signature matches the SDK's type. */
export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export function textResult(text: string, structuredContent?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

export function jsonResult(output: Record<string, unknown>): ToolResult {
  return textResult(JSON.stringify(output, null, 2), output);
}

export function errorResult(message: string): ToolResult {
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

/** Wraps a tool handler so any thrown error becomes an error result. */
export function withErrors<A>(
  handler: (args: A) => Promise<ToolResult>
): (args: A) => Promise<ToolResult> {
  return async (args) => {
    try {
      return await handler(args);
    } catch (err) {
      return errorResult(errorMessage(err));
    }
  };
}

export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export const DELEGATION_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: true,
} as const;
