/**
 * Service boundary for the Codex runtime reasoning-level table.
 *
 * Codex discovery registers every model's upstream `supported_reasoning_levels` and
 * synthesizes the matching effort variants, while the table itself lives in the leaf
 * `executors/codex/reasoningSuffix.ts`, next to the suffix parser the executor uses. App
 * routes must not import from `open-sse/executors/**` (G14 import boundary — see
 * EXECUTOR_IMPORT_RESTRICTION in eslint.config.mjs), so they go through this service.
 */
export {
  normalizeCodexEffortLevels,
  registerCodexReasoningLevels,
  splitCodexReasoningSuffix,
  type CodexEffortLevel,
} from "../executors/codex/reasoningSuffix.ts";
