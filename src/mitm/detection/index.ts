/**
 * Detection dispatcher.
 *
 * `detectAgent(id)` returns whether the given AgentBridge target is installed
 * on the current machine. All detection probes are filesystem-only — they
 * never spawn shells or interpolate runtime paths (Hard Rule #13).
 *
 * Trae is intentionally absent from the dispatch table: its viability is still
 * under investigation, so callers receive `{ installed: false }` until the
 * upstream surface is confirmed (see `targets/trae.ts`).
 */
import type { AgentId, DetectionResult } from "../types.ts";
import { detectAntigravity } from "./antigravity.ts";
import { detectKiro } from "./kiro.ts";
import { detectCopilot } from "./copilot.ts";
import { detectCodex } from "./codex.ts";
import { detectCursor } from "./cursor.ts";
import { detectZed } from "./zed.ts";
import { detectClaudeCode } from "./claudeCode.ts";
import { detectOpenCode } from "./openCode.ts";

export const DETECTORS: Record<AgentId, () => DetectionResult> = {
  antigravity: detectAntigravity,
  kiro: detectKiro,
  copilot: detectCopilot,
  codex: detectCodex,
  cursor: detectCursor,
  zed: detectZed,
  "claude-code": detectClaudeCode,
  "open-code": detectOpenCode,
  trae: () => ({ installed: false }),
  "ghe-copilot": detectCopilot,
};

export function detectAgent(id: AgentId): DetectionResult {
  const fn = DETECTORS[id];
  if (!fn) return { installed: false };
  try {
    return fn();
  } catch {
    return { installed: false };
  }
}

export {
  detectAntigravity,
  detectKiro,
  detectCopilot,
  detectCodex,
  detectCursor,
  detectZed,
  detectClaudeCode,
  detectOpenCode,
};
