/**
 * Kiro request-level recovery helpers: oversized-context trimming and
 * transient-failure backoff. Pure functions so KiroExecutor.execute stays thin.
 */

type JsonRecord = Record<string, unknown>;

const CONTEXT_TOO_LONG_PATTERN = /content_length_exceeds_threshold|input is too long/i;
const CAPACITY_PATTERN = /insufficient_model_capacity|model_temporarily_unavailable/i;
/** Quota/entitlement failures: waiting on the same account never helps. */
const NON_RETRYABLE_PATTERN =
  /monthly_request_count|improperly formed|quota|credits? exhausted|input is too long|content_length_exceeds_threshold/i;
const RETRYABLE_5XX = new Set([500, 502, 503, 504]);

export const KIRO_MAX_CONTEXT_TRIM_ATTEMPTS = 3;
export const KIRO_TRIM_HISTORY_FRACTION = 0.3;
export const KIRO_TOOL_RESULT_MIN_CHARS = 512;

export type KiroRetryConfig = {
  maxAttempts: number;
  capacityBaseMs: number;
  capacityMaxMs: number;
  transientBaseMs: number;
  transientMaxMs: number;
  jitterMs: number;
};

export const KIRO_RETRY_CONFIG: KiroRetryConfig = {
  maxAttempts: 3,
  capacityBaseMs: 5000,
  capacityMaxMs: 30000,
  transientBaseMs: 2000,
  transientMaxMs: 15000,
  jitterMs: 1000,
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isKiroContextTooLong(status: number, errorText: string): boolean {
  if (status === 413) return true;
  return status === 400 && CONTEXT_TOO_LONG_PATTERN.test(errorText);
}

/** Retry-After in seconds or HTTP-date, capped by `maxMs`. */
function parseRetryAfterMs(value: string | null, maxMs: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(Date.parse(value))
      ? Date.parse(value) - Date.now()
      : NaN;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, maxMs) : null;
}

/**
 * Backoff before retrying the same account, or null when the failure is not
 * transient (auth, quota, malformed or oversized requests).
 */
export function kiroRetryDelayMs(
  status: number,
  errorText: string,
  attempt: number,
  retryAfter: string | null,
  config: KiroRetryConfig = KIRO_RETRY_CONFIG,
  random: () => number = Math.random
): number | null {
  if (attempt >= config.maxAttempts) return null;
  const capacity = CAPACITY_PATTERN.test(errorText);
  if (!capacity) {
    if (NON_RETRYABLE_PATTERN.test(errorText)) return null;
    if (status !== 429 && !RETRYABLE_5XX.has(status)) return null;
  }
  const base = capacity ? config.capacityBaseMs : config.transientBaseMs;
  const max = capacity ? config.capacityMaxMs : config.transientMaxMs;
  const hinted = parseRetryAfterMs(retryAfter, max);
  if (hinted !== null) return hinted;
  const jitter = capacity ? 0 : Math.round(config.jitterMs * Math.min(Math.max(random(), 0), 1));
  return Math.min(base * 2 ** attempt, max) + jitter;
}

function shrinkText(text: string): string {
  if (text.length <= KIRO_TOOL_RESULT_MIN_CHARS) return text;
  const target = Math.max(KIRO_TOOL_RESULT_MIN_CHARS, Math.floor(text.length / 2));
  const head = Math.ceil(target / 2);
  const tail = target - head;
  return `${text.slice(0, head)}\n…[truncated ${text.length - target} chars]…\n${text.slice(-tail)}`;
}

/** Halve every text tool result on a user turn; returns true when anything shrank. */
function shrinkToolResults(userInputMessage: unknown): boolean {
  if (!isRecord(userInputMessage)) return false;
  const context = userInputMessage.userInputMessageContext;
  if (!isRecord(context) || !Array.isArray(context.toolResults)) return false;
  let changed = false;
  for (const result of context.toolResults) {
    if (!isRecord(result) || !Array.isArray(result.content)) continue;
    for (const part of result.content) {
      if (isRecord(part) && typeof part.text === "string") {
        const next = shrinkText(part.text);
        if (next !== part.text) {
          part.text = next;
          changed = true;
        }
      }
    }
  }
  return changed;
}

function toolUseIds(entry: unknown): Set<string> {
  const ids = new Set<string>();
  const message = isRecord(entry) ? entry.assistantResponseMessage : undefined;
  if (isRecord(message) && Array.isArray(message.toolUses)) {
    for (const use of message.toolUses) {
      if (isRecord(use) && typeof use.toolUseId === "string") ids.add(use.toolUseId);
    }
  }
  return ids;
}

/**
 * Drop ~30% of the oldest complete history turns (always keeping the last two
 * entries) and halve current tool results. Returns a new body, or null when
 * nothing is left to trim. History stays user-first, and tool results whose
 * tool use was dropped are removed so Kiro does not reject orphans.
 */
export function trimKiroConversationForRetry(body: unknown): JsonRecord | null {
  if (!isRecord(body) || !isRecord(body.conversationState)) return null;
  const next = structuredClone(body) as JsonRecord;
  const state = next.conversationState as JsonRecord;
  const history = Array.isArray(state.history) ? (state.history as unknown[]) : [];
  let changed = false;

  const removable = Math.max(0, history.length - 2);
  if (removable > 0) {
    let drop = Math.min(
      removable,
      Math.max(2, Math.ceil(history.length * KIRO_TRIM_HISTORY_FRACTION))
    );
    // Advance to a user turn so the kept history still starts with userInputMessage.
    while (drop < removable && !isRecord((history[drop] as JsonRecord)?.userInputMessage)) drop++;
    if (drop <= removable && isRecord((history[drop] as JsonRecord)?.userInputMessage)) {
      const kept = history.slice(drop);
      const first = (kept[0] as JsonRecord).userInputMessage as JsonRecord;
      const context = first.userInputMessageContext;
      if (isRecord(context) && Array.isArray(context.toolResults)) {
        delete context.toolResults;
        if (Object.keys(context).length === 0) delete first.userInputMessageContext;
        if (typeof first.content !== "string" || !first.content.trim()) {
          first.content = "(earlier conversation trimmed to fit the context window)";
        }
      }
      state.history = kept;
      changed = true;
    }
  }

  const current = isRecord(state.currentMessage) ? state.currentMessage.userInputMessage : null;
  if (shrinkToolResults(current)) changed = true;

  // Results on the current turn must still reference the last kept assistant turn.
  const kept = Array.isArray(state.history) ? (state.history as unknown[]) : [];
  const lastIds = toolUseIds(kept[kept.length - 1]);
  if (isRecord(current) && isRecord(current.userInputMessageContext)) {
    const context = current.userInputMessageContext as JsonRecord;
    if (Array.isArray(context.toolResults)) {
      context.toolResults = context.toolResults.filter(
        (r) => isRecord(r) && typeof r.toolUseId === "string" && lastIds.has(r.toolUseId)
      );
      if ((context.toolResults as unknown[]).length === 0) delete context.toolResults;
    }
  }

  return changed ? next : null;
}

export function sleepWithSignal(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
