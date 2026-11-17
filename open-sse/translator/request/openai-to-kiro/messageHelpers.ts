// Pure message/tool helpers for the OpenAI -> Kiro request translator.
// Extracted verbatim from openai-to-kiro.ts (no host imports).
import { createHash } from "node:crypto";

export function parseToolInput(value: unknown) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return {};
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Recursively sanitize JSON Schema for Kiro API.
 * Kiro returns 400 "Improperly formed request" if:
 * - `required` is an empty array []
 * - `additionalProperties` is present anywhere
 */
export function normalizeKiroToolSchema(schema: unknown): Record<string, unknown> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }

  const result: Record<string, unknown> = {};
  const src = schema as Record<string, unknown>;

  for (const [key, value] of Object.entries(src)) {
    // Skip empty required arrays — Kiro rejects them
    if (key === "required" && Array.isArray(value) && value.length === 0) {
      continue;
    }
    // Skip additionalProperties — Kiro doesn't support it
    if (key === "additionalProperties") {
      continue;
    }
    // Recursively process nested objects
    if (
      key === "properties" &&
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      const sanitizedProps: Record<string, unknown> = {};
      for (const [propName, propValue] of Object.entries(value as Record<string, unknown>)) {
        sanitizedProps[propName] = normalizeKiroToolSchema(propValue);
      }
      result[key] = sanitizedProps;
    } else if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result[key] = normalizeKiroToolSchema(value);
    } else if (Array.isArray(value)) {
      result[key] = value.map((item) =>
        typeof item === "object" && item !== null && !Array.isArray(item)
          ? normalizeKiroToolSchema(item)
          : item
      );
    } else {
      result[key] = value;
    }
  }

  return result;
}

export function serializeToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content || "(no output)";
  }
  if (!Array.isArray(content)) {
    if (content !== null && content !== undefined) {
      try {
        return JSON.stringify(content);
      } catch {
        return "(no output)";
      }
    }
    return "(no output)";
  }
  const parts: string[] = [];
  for (const block of content as Array<Record<string, unknown>>) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text) parts.push(block.text);
    } else if (block.type === "image" || block.type === "image_url") {
      const src = block.source as Record<string, unknown> | undefined;
      const mediaType = src?.media_type ?? block.media_type ?? "image";
      parts.push(`[image: ${mediaType}]`);
    } else {
      try {
        const str = JSON.stringify(block);
        if (str && str !== "{}") parts.push(str);
      } catch {
        // skip unserializable block
      }
    }
  }
  return parts.join("\n") || "(no output)";
}

export const KIRO_TOOL_USE_ID_RE = /^tooluse_[A-Za-z0-9]+$/;

/**
 * Format tool use ID into a valid Bedrock/Kiro identifier.
 * Kiro accepts its own compact `tooluse_*` IDs in replayed history. Other
 * providers / harness layers produce IDs such as `call_*`, `fc_*`, or containing
 * '|', which Kiro rejects as `Invalid tool use format`. Canonicalize only the wire-format
 * ID while preserving deterministic toolUse/toolResult matching.
 */
export function toKiroToolUseId(id: string): string {
  if (id && KIRO_TOOL_USE_ID_RE.test(id)) return id;
  const raw = id || "tool-call";
  const digest = createHash("sha256").update(raw).digest("hex").slice(0, 22);
  return `tooluse_${digest}`;
}

/**
 * Minimal placeholder tool injected when replayed history contains tool blocks
 * but current request supplies no tools. Prevents Bedrock TOOL_CONFIG_MISSING.
 */
export const KIRO_PLACEHOLDER_TOOL = {
  toolSpecification: {
    name: "noop",
    description:
      "Placeholder tool. Do not call it. Present only to satisfy the toolConfig requirement when replayed history contains tool blocks.",
    inputSchema: { json: { type: "object", properties: {} } },
  },
};

/**
 * True when any history entry carries assistant toolUses or user toolResults.
 */
export function historyHasToolBlocks(history: unknown[]): boolean {
  if (!Array.isArray(history)) return false;
  for (const entry of history as Array<Record<string, unknown>>) {
    const assistant = entry?.assistantResponseMessage as Record<string, unknown> | undefined;
    if (Array.isArray(assistant?.toolUses) && assistant.toolUses.length > 0) return true;
    const user = entry?.userInputMessage as Record<string, unknown> | undefined;
    const ctx = user?.userInputMessageContext as Record<string, unknown> | undefined;
    if (Array.isArray(ctx?.toolResults) && ctx.toolResults.length > 0) return true;
  }
  return false;
}

const KIRO_MESSAGE_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function normalizeKiroAssistantMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("msg_") ? trimmed.slice(4) : trimmed;
  return candidate && KIRO_MESSAGE_ID_RE.test(candidate) ? candidate.toLowerCase() : null;
}

/**
 * Resolve the UUID required by Kiro for replayed assistant turns.
 */
export function resolveKiroAssistantMessageId(
  message: Record<string, unknown>,
  indexFallback?: number
): string {
  // Kiro replay uses `messageId`, while upstream/client histories commonly use
  // `responseId` or `id`. Preserve any authentic UUID instead of replacing it
  // with the deterministic fallback, so signed/redacted reasoning remains
  // linked to the assistant turn that generated it.
  for (const value of [message.responseId, message.messageId, message.id, message.message_id]) {
    const candidate = normalizeKiroAssistantMessageId(value);
    if (candidate) return candidate;
  }

  const rawContent = message.content ? JSON.stringify(message.content) : "";
  const suffix = typeof indexFallback === "number" ? `:${indexFallback}` : "";
  const digest = createHash("sha256")
    .update(`kiro-assistant-message\0${rawContent}${suffix}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
