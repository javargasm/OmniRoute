type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function asEffort(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getWireEffort(payload: JsonRecord | null): string | null {
  const additionalFields = asRecord(payload?.additionalModelRequestFields);
  const nativeReasoning = asRecord(additionalFields?.reasoning);
  const outputConfig = asRecord(additionalFields?.output_config);
  return asEffort(nativeReasoning?.effort) ?? asEffort(outputConfig?.effort);
}

/** Reads Kiro's final native reasoning field from a request or capture envelope. */
export function getKiroWireReasoningEffort(payload: unknown): string | null {
  const record = asRecord(payload);
  return getWireEffort(asRecord(record?.body)) ?? getWireEffort(record);
}

/** Reads the normalized OpenAI-shaped request effort used before Kiro translation. */
export function getNormalizedReasoningEffort(payload: unknown): string | null {
  const record = asRecord(payload);
  return asEffort(record?.reasoning_effort) ?? asEffort(asRecord(record?.reasoning)?.effort);
}
