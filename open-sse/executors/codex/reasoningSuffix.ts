export const CODEX_EFFORT_ORDER = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;
export type CodexEffortLevel = (typeof CODEX_EFFORT_ORDER)[number];
export const CODEX_MAX_ALIAS_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-6-astra",
  "gpt-6-sol",
  "gpt-6-luna",
]);
export const CODEX_ULTRA_ALIAS_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-sol",
]);

/** Highest effort a max/ultra-tier base model accepts, or null for other models. */
export function getCodexAliasEffortCap(model: string): CodexEffortLevel | null {
  if (CODEX_ULTRA_ALIAS_MODELS.has(model)) return "ultra";
  if (CODEX_MAX_ALIAS_MODELS.has(model)) return "max";
  return null;
}

type CodexReasoningLevelLookup = (baseModel: string) => readonly CodexEffortLevel[] | null;

// Per-model reasoning levels declared by Codex discovery (`supported_reasoning_levels`), so
// models without hand-written registry variants get the same -max/-ultra aliases, effort
// clamp and delegation tier. Route bundles register them while executors and translators
// read them, and those can be separate module instances in one process — so the table
// lives on globalThis where every instance sees the same levels.
const codexReasoningLevelsState = globalThis as typeof globalThis & {
  __omnirouteCodexReasoningLevels?: Map<string, readonly CodexEffortLevel[]>;
};

/** Known Codex effort levels in `values`: lowercased, deduped, in CODEX_EFFORT_ORDER order. */
export function normalizeCodexEffortLevels(values: unknown): CodexEffortLevel[] {
  if (!Array.isArray(values)) return [];
  const declared = new Set(
    values.flatMap((value) => (typeof value === "string" ? [value.trim().toLowerCase()] : []))
  );
  return CODEX_EFFORT_ORDER.filter((level) => declared.has(level));
}

/** Reasoning levels discovery declared for a Codex base model, or null when none. */
export function getCodexReasoningLevels(baseModel: unknown): readonly CodexEffortLevel[] | null {
  if (typeof baseModel !== "string") return null;
  return codexReasoningLevelsState.__omnirouteCodexReasoningLevels?.get(baseModel) ?? null;
}

/** Highest reasoning level discovery declared for a Codex base model, or null when none. */
export function getCodexMaxEffort(baseModel: unknown): CodexEffortLevel | null {
  const levels = getCodexReasoningLevels(baseModel);
  return levels && levels.length > 0 ? levels[levels.length - 1] : null;
}

/**
 * Codex clients coordinate sub-agent delegation (parallel tool calls) at a model's top tier
 * when that tier is Max or Ultra: Astra/Sol/Terra at "ultra", Luna at "max". Statically known
 * models keep those fixed tiers; discovered models use their highest declared level.
 */
export function isCodexDelegationEffort(baseModel: string, effort: unknown): boolean {
  if (effort !== "max" && effort !== "ultra") return false;
  const topTier = CODEX_ULTRA_ALIAS_MODELS.has(baseModel)
    ? "ultra"
    : CODEX_MAX_ALIAS_MODELS.has(baseModel)
      ? "max"
      : getCodexMaxEffort(baseModel);
  return topTier === effort;
}

// A discovered model accepts `-max`/`-ultra` only for a tier it declares. A parenthesized
// override mirrors the static rule: any model reaching Max accepts both, and the executor
// clamps Ultra down to the model's top tier.
function isDiscoveredTopTierAlias(
  levels: readonly CodexEffortLevel[] | null,
  effort: CodexEffortLevel,
  parenthesized: boolean
): boolean {
  if (!levels) return false;
  return parenthesized
    ? levels.includes("max") || levels.includes("ultra")
    : levels.includes(effort);
}

function splitCodexReasoningSuffixWith(
  model: unknown,
  lookup: CodexReasoningLevelLookup
): {
  baseModel: string;
  effort: CodexEffortLevel | null;
} {
  const modelId = typeof model === "string" ? model : "";
  const maxTierMatch = /^(.+?)(?:-(max|ultra)|\((max|ultra)\))$/.exec(modelId);
  if (maxTierMatch) {
    const [, baseModel, hyphenEffort, parenthesizedEffort] = maxTierMatch;
    const effort = (hyphenEffort ?? parenthesizedEffort) as CodexEffortLevel;
    const supportedModels = parenthesizedEffort
      ? CODEX_MAX_ALIAS_MODELS
      : effort === "ultra"
        ? CODEX_ULTRA_ALIAS_MODELS
        : CODEX_MAX_ALIAS_MODELS;
    if (
      supportedModels.has(baseModel) ||
      isDiscoveredTopTierAlias(lookup(baseModel), effort, Boolean(parenthesizedEffort))
    ) {
      return { baseModel, effort };
    }
  }

  for (const effort of ["none", "low", "medium", "high", "xhigh"] as const) {
    if (modelId.endsWith(`-${effort}`)) {
      return { baseModel: modelId.slice(0, -`-${effort}`.length), effort };
    }
  }
  return { baseModel: modelId, effort: null };
}

export function splitCodexReasoningSuffix(model: unknown): {
  baseModel: string;
  effort: CodexEffortLevel | null;
} {
  return splitCodexReasoningSuffixWith(model, getCodexReasoningLevels);
}

/**
 * Record the reasoning levels Codex discovery declares per model — items shaped
 * `{ id, supportedThinkingEfforts }`. Sets or replaces each listed id and never clears
 * the others; ids that are themselves effort variants (`gpt-6-sol-max`), unknown levels
 * and malformed items are ignored. Never throws.
 */
export function registerCodexReasoningLevels(models: unknown): void {
  try {
    if (!Array.isArray(models)) return;
    const declared = new Map<string, CodexEffortLevel[]>();
    for (const item of models) {
      if (!item || typeof item !== "object") continue;
      const { id, supportedThinkingEfforts } = item as Record<string, unknown>;
      const levels = normalizeCodexEffortLevels(supportedThinkingEfforts);
      if (typeof id === "string" && id.length > 0 && levels.length > 0) declared.set(id, levels);
    }

    codexReasoningLevelsState.__omnirouteCodexReasoningLevels ??= new Map();
    const table = codexReasoningLevelsState.__omnirouteCodexReasoningLevels;
    // Judge variants against this batch too, so declaration order never matters.
    const lookup = (baseModel: string) => declared.get(baseModel) ?? table.get(baseModel) ?? null;
    for (const [id, levels] of declared) {
      if (splitCodexReasoningSuffixWith(id, lookup).effort === null) table.set(id, levels);
    }
  } catch {
    // Discovery metadata is best-effort: a malformed catalog must never break its caller.
  }
}

/** Test-only: forget every discovered reasoning level. */
export function __resetCodexReasoningLevelsForTests(): void {
  delete codexReasoningLevelsState.__omnirouteCodexReasoningLevels;
}
