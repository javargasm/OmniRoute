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
import type { AgentId, DetectionResult } from "../types.js";
import { detectAntigravity } from "./antigravity.js";
import { detectKiro } from "./kiro.js";
import { detectCopilot } from "./copilot.js";
import { detectCodex } from "./codex.js";
import { detectCursor } from "./cursor.js";
import { detectZed } from "./zed.js";
import { detectClaudeCode } from "./claudeCode.js";
import { detectOpenCode } from "./openCode.js";

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
