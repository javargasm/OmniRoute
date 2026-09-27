/**
 * Per-model request capabilities learned from Kiro's live `ListAvailableModels`
 * catalog (`additionalModelRequestFieldsSchema`). Process-local and best effort:
 * empty until a discovery call runs, in which case callers keep their static
 * allowlists.
 */

export const KIRO_EFFORT_ORDER = ["none", "low", "medium", "high", "xhigh", "max"] as const;

export type KiroEffortRequestField = "reasoning" | "output_config";

export type KiroModelCapabilities = {
  /** Which `additionalModelRequestFields` key carries `effort`, if any. */
  effortField?: KiroEffortRequestField;
  /** Effort values the schema enum accepts, in canonical order. */
  efforts?: string[];
  /** Whether the schema accepts `additionalModelRequestFields.max_tokens`. */
  supportsMaxTokens?: boolean;
};

const capabilities = new Map<string, KiroModelCapabilities>();

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {};
}

function readEffortEnum(property: unknown): string[] | undefined {
  const effort = asRecord(asRecord(asRecord(property).properties).effort);
  if (!Array.isArray(effort.enum)) return undefined;
  const values = new Set(
    effort.enum.filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase())
  );
  const ordered = KIRO_EFFORT_ORDER.filter((tier) => values.has(tier));
  return ordered.length > 0 ? [...ordered] : undefined;
}

/** Parse one catalog entry's `additionalModelRequestFieldsSchema`. */
export function parseKiroModelCapabilities(item: unknown): KiroModelCapabilities | undefined {
  const schema = asRecord(asRecord(item).additionalModelRequestFieldsSchema);
  const properties = asRecord(schema.properties);
  if (Object.keys(properties).length === 0) return undefined;

  const reasoningEfforts = readEffortEnum(properties.reasoning);
  const outputEfforts = reasoningEfforts ? undefined : readEffortEnum(properties.output_config);
  const result: KiroModelCapabilities = {
    supportsMaxTokens: "max_tokens" in properties,
  };
  if (reasoningEfforts) {
    result.effortField = "reasoning";
    result.efforts = reasoningEfforts;
  } else if (outputEfforts) {
    result.effortField = "output_config";
    result.efforts = outputEfforts;
  }
  return result;
}

export function recordKiroModelCapabilities(modelId: string, caps: KiroModelCapabilities): void {
  capabilities.set(modelId, caps);
}

export function getKiroModelCapabilities(modelId: string): KiroModelCapabilities | undefined {
  return capabilities.get(modelId);
}

export function clearKiroModelCapabilities(): void {
  capabilities.clear();
}

/**
 * Clamp a requested effort to what the catalog advertises: the highest
 * supported tier at or below the request. Returns the request unchanged when
 * the model's efforts are unknown, and undefined when nothing fits.
 */
export function clampKiroEffort(modelId: string, effort: string): string | undefined {
  const supported = capabilities.get(modelId)?.efforts;
  if (!supported || supported.length === 0) return effort;
  if (supported.includes(effort)) return effort;
  const index = KIRO_EFFORT_ORDER.indexOf(effort as (typeof KIRO_EFFORT_ORDER)[number]);
  if (index < 0) return undefined;
  for (let i = index - 1; i >= 0; i--) {
    if (supported.includes(KIRO_EFFORT_ORDER[i])) return KIRO_EFFORT_ORDER[i];
  }
  return undefined;
}
