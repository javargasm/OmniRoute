/**
 * Minimal pricing table for cost estimation in Traffic Inspector LlmDetailsTab.
 * Values in USD per 1M tokens. Approximate — providers update prices without notice;
 * users with strict cost requirements should override via env or DB settings.
 *
 * Lookup is a case-insensitive substring match so versioned model IDs
 * (e.g. "claude-3-5-sonnet-20240620") resolve against the canonical short key.
 */

export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const PRICING_TABLE: Record<string, ModelPricing> = {
  "gpt-4o-mini": { inputPerMTok: 0.15, outputPerMTok: 0.6 },
  "gpt-4o": { inputPerMTok: 2.5, outputPerMTok: 10.0 },
  "claude-3-5-sonnet": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-3-5-haiku": { inputPerMTok: 0.8, outputPerMTok: 4.0 },
  "claude-3-opus": { inputPerMTok: 15.0, outputPerMTok: 75.0 },
  "gemini-2.0-flash": { inputPerMTok: 0.1, outputPerMTok: 0.4 },
  "gemini-1.5-flash": { inputPerMTok: 0.075, outputPerMTok: 0.3 },
  "gemini-1.5-pro": { inputPerMTok: 1.25, outputPerMTok: 5.0 },
  "deepseek-reasoner": { inputPerMTok: 0.55, outputPerMTok: 2.19 },
  "deepseek-chat": { inputPerMTok: 0.27, outputPerMTok: 1.1 },
};

/**
 * Lookup pricing for a model id — case-insensitive substring match against
 * the canonical keys (longest-specific-first ordering matters: "gpt-4o-mini"
 * is listed before "gpt-4o" so it matches first). Returns null if no match.
 */
export function lookupPricing(model: string | null): ModelPricing | null {
  if (!model) return null;
  const m = model.toLowerCase();
  for (const [key, price] of Object.entries(PRICING_TABLE)) {
    if (m.includes(key)) return price;
  }
  return null;
}

/**
 * Estimate cost in USD given input/output token counts. Returns null when
 * both token counts are null or the model has no entry in PRICING_TABLE.
 */
export function estimateCost(
  model: string | null,
  tokensIn: number | null,
  tokensOut: number | null
): number | null {
  if (tokensIn == null && tokensOut == null) return null;
  const price = lookupPricing(model);
  if (!price) return null;
  const inCost = ((tokensIn ?? 0) / 1_000_000) * price.inputPerMTok;
  const outCost = ((tokensOut ?? 0) / 1_000_000) * price.outputPerMTok;
  return Number((inCost + outCost).toFixed(6));
}
