/** Message of any thrown value. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function round(n: number, decimals = 4): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "~author/model-latest" aliases compare like "author/model-latest". */
export function stripAlias(modelId: string): string {
  return modelId.replace(/^~/, "");
}
