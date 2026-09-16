/**
 * Inline `<thinking>` splitter for Claude on Kiro.
 *
 * Background:
 *   When `<thinking_mode>enabled</thinking_mode>` is in the system prompt,
 *   Claude on Kiro emits its reasoning **inline** as `<thinking>…</thinking>`
 *   blocks inside `assistantResponseEvent.content`, rather than as separate
 *   `reasoningContentEvent` frames. To match the OpenAI streaming shape that
 *   downstream translators (Anthropic /thinking_blocks, Claude SSE, etc.)
 *   expect, we split that inline reasoning back out and route it to the
 *   `delta.reasoning_content` channel instead of `delta.content`.
 *
 * The implementation is split into pure functions so it can be unit-tested
 * without dragging in the rest of the executor stack (proxy-agent, AWS
 * EventStream parser, etc.). The KiroExecutor wires these helpers into its
 * TransformStream by passing controller-bound emit callbacks.
 *
 * Ported from decolua/9router#1273 (kiroThinking.js) by Amin Fathullah.
 */

/** Mutable state carried across `splitInlineThinking` calls. */
export type KiroThinkingState = {
  /** True while the cursor is inside a `<thinking>` block. */
  thinkingMode: boolean;
  /**
   * Characters held back because they might be the start of a tag we'll
   * complete on the next slice (e.g. `<thi`).
   */
  pendingTag: string;
  /** Active closing tag when inside thinkingMode, e.g. "</thinking>" or "</think>". */
  activeCloseTag?: string;
};

export const THINKING_TAG_VARIANTS: Array<{ open: string; close: string }> = [
  { open: "<thinking>", close: "</thinking>" },
  { open: "<think>", close: "</think>" },
  { open: "<reasoning>", close: "</reasoning>" },
  { open: "<thought>", close: "</thought>" },
  { open: "<internal_thinking>", close: "</internal_thinking>" },
];

const OPEN_TAGS = THINKING_TAG_VARIANTS.map((v) => v.open);
const CLOSE_TAGS = THINKING_TAG_VARIANTS.map((v) => v.close);
const MAX_TAG_LENGTH = Math.max(...[...OPEN_TAGS, ...CLOSE_TAGS].map((t) => t.length));

/**
 * Stream-safe splitter. Walks one slice of upstream content at a time and
 * routes characters to either the content channel or the reasoning channel
 * based on the current `<thinking>` state. Supports multiple tag variants.
 *
 * State is mutated on `state` so a tag split between frames (e.g. `…</think`
 * followed by `ing>foo`) is still recognised.
 *
 * @param state   Mutable state carried across calls. Initialise with
 *                `{ thinkingMode: false, pendingTag: "" }`.
 * @param raw     Next slice from `assistantResponseEvent.content`. May be empty
 *                or null/undefined (no-op).
 * @param onContent   Called with text that should land in `delta.content`.
 * @param onReasoning Called with text that should land in `delta.reasoning_content`.
 */
export function splitInlineThinking(
  state: KiroThinkingState,
  raw: string | null | undefined,
  onContent: (s: string) => void,
  onReasoning: (s: string) => void
): void {
  let text = (state.pendingTag || "") + (raw || "");
  state.pendingTag = "";

  while (text.length > 0) {
    if (!state.thinkingMode) {
      // Find the earliest opening tag among all variants
      let earliestIdx = -1;
      let matchedVariant: (typeof THINKING_TAG_VARIANTS)[number] | null = null;

      for (const variant of THINKING_TAG_VARIANTS) {
        const idx = text.indexOf(variant.open);
        if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
          earliestIdx = idx;
          matchedVariant = variant;
        }
      }

      if (earliestIdx === -1) {
        // No full opening tag in `text`. Check for trailing partial of ANY open tag.
        let holdFrom = text.length;
        for (let i = Math.max(0, text.length - MAX_TAG_LENGTH); i < text.length; i++) {
          const tail = text.slice(i);
          if (tail.length > 0 && OPEN_TAGS.some((open) => open.startsWith(tail))) {
            holdFrom = i;
            break;
          }
        }
        const flushable = text.slice(0, holdFrom);
        if (flushable) {
          onContent(flushable);
        }
        state.pendingTag = text.slice(holdFrom);
        return;
      }

      // Found a complete opening tag. Flush everything before it to content,
      // flip mode to thinking, store the expected close tag, and advance.
      const before = text.slice(0, earliestIdx);
      if (before) onContent(before);
      state.thinkingMode = true;
      state.activeCloseTag = matchedVariant?.close ?? "</thinking>";
      text = text.slice(earliestIdx + (matchedVariant?.open.length ?? "<thinking>".length));
    } else {
      // Inside thinking mode: look for the closing tag.
      // Prefer activeCloseTag, or fall back to any close tag.
      const targetClose = state.activeCloseTag || "</thinking>";
      const idx = text.indexOf(targetClose);

      if (idx === -1) {
        // Look for trailing partial of the closing tag
        let holdFrom = text.length;
        for (let i = Math.max(0, text.length - targetClose.length); i < text.length; i++) {
          const tail = text.slice(i);
          if (targetClose.startsWith(tail) && tail.length > 0) {
            holdFrom = i;
            break;
          }
        }
        const flushable = text.slice(0, holdFrom);
        if (flushable) {
          onReasoning(flushable);
        }
        state.pendingTag = text.slice(holdFrom);
        return;
      }

      // Found closing tag
      const before = text.slice(0, idx);
      if (before) onReasoning(before);
      state.thinkingMode = false;
      state.activeCloseTag = undefined;
      text = text.slice(idx + targetClose.length);
    }
  }
}

/**
 * Drain whatever is left in `state.pendingTag` at end-of-stream. Routes the
 * leftover characters to whichever channel matches the current
 * `state.thinkingMode` so we don't silently lose data when the stream ends
 * mid-tag (e.g. `<thi`).
 *
 * @param state       Mutable state shared with `splitInlineThinking`.
 * @param onContent   Called with text that should land in `delta.content`.
 * @param onReasoning Called with text that should land in `delta.reasoning_content`.
 */
export function flushPendingThinking(
  state: KiroThinkingState,
  onContent: (s: string) => void,
  onReasoning: (s: string) => void
): void {
  if (!state.pendingTag) return;
  const leftover = state.pendingTag;
  state.pendingTag = "";
  if (state.thinkingMode) onReasoning(leftover);
  else onContent(leftover);
}
