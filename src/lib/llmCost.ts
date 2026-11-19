/** Gemini's token counts (`usageMetadata`). The prompt count includes cached tokens; thoughts bill as output. */
export interface LlmUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
  thoughtsTokenCount?: number;
}


/** USD per million tokens. */
export interface LlmPrices {
  input: number;
  output: number;
}

/** What a call cost, in millionths of a dollar: cached prompt tokens at a quarter of the input price. */
export function costMicros(prices: LlmPrices, u: LlmUsage): number {
  const cached = u.cachedContentTokenCount ?? 0;
  const prompt = Math.max(0, (u.promptTokenCount ?? 0) - cached);
  return Math.ceil(prices.input * (prompt + 0.25 * cached) + prices.output * ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)));
}

