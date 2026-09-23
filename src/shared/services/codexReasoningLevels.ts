/**
 * Codex reasoning-level hydration
 *
 * Codex discovery registers every model's upstream `supported_reasoning_levels` into the
 * executor's in-memory level table (`open-sse/executors/codex/reasoningSuffix.ts`) and
 * persists them as `supportedThinkingEfforts` on the synced Codex rows. After a restart
 * this re-registers them from those rows, once per process, so derived effort variants
 * such as `gpt-6-sol-max` keep resolving before any discovery runs again.
 */

import { registerCodexReasoningLevels } from "@omniroute/open-sse/services/codexReasoningLevelTable.ts";
import { getSyncedAvailableModels } from "@/lib/db/models";

/** Read seam; defaults to the synced Codex catalog unioned across connections. */
export type CodexReasoningLevelsHydrationDeps = {
  readSyncedModels?: () => Promise<unknown>;
};

// Route bundles and background schedulers can be separate module instances in one
// process; keeping the guard on globalThis gives them one shared hydration.
const hydrationGlobal = globalThis as typeof globalThis & {
  __omnirouteCodexReasoningLevelsHydration?: Promise<void>;
};

async function registerStoredCodexReasoningLevels(
  readSyncedModels: () => Promise<unknown>
): Promise<void> {
  try {
    registerCodexReasoningLevels(await readSyncedModels());
  } catch {
    // Non-critical: the next Codex discovery registers the levels again.
  }
}

/**
 * Register the reasoning levels stored on the synced Codex catalog, once per process.
 * Never throws.
 */
export async function hydrateCodexReasoningLevelsFromSyncedModels(
  deps: CodexReasoningLevelsHydrationDeps = {}
): Promise<void> {
  hydrationGlobal.__omnirouteCodexReasoningLevelsHydration ??= registerStoredCodexReasoningLevels(
    deps.readSyncedModels ?? (() => getSyncedAvailableModels("codex"))
  );
  await hydrationGlobal.__omnirouteCodexReasoningLevelsHydration;
}

/** Test-only: allow the next hydration call to read the synced catalog again. */
export function __resetCodexReasoningLevelsHydrationForTests(): void {
  delete hydrationGlobal.__omnirouteCodexReasoningLevelsHydration;
}
