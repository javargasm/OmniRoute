import { resolveOpencodeSessionIdentity } from "./opencodeSessionIdentity.ts";

/** Kiro/Anthropic session headers not covered by the generic session-identity list. */
const KIRO_SESSION_HEADERS = ["x-kiro-session-id", "anthropic-session-id"] as const;

function isUsableIdentity(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 256 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/**
 * Client-supplied session identity used to seed Kiro's `conversationId`.
 * Returns undefined when the client sent none, so the translator keeps its
 * content-derived fallback.
 */
export function resolveKiroSessionKey(
  headers: Record<string, string> | null | undefined,
  body?: unknown
): string | undefined {
  const lower = new Map(
    Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  for (const name of KIRO_SESSION_HEADERS) {
    const value = lower.get(name);
    if (isUsableIdentity(value)) return value.trim();
  }
  return resolveOpencodeSessionIdentity(headers, body);
}
