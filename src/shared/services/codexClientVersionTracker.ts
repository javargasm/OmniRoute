/**
 * Codex CLI client-version tracker
 *
 * OpenAI gates new Codex models on `minimal_client_version` (the live
 * chatgpt.com models endpoint and the GitHub models.json alike), so the
 * built-in DEFAULT_CODEX_CLIENT_VERSION is only a floor. This tracks the latest
 * stable `@openai/codex` release on the npm registry, refreshed right before
 * Codex live discovery (at most once per TTL), and persists it in settings so
 * inference keeps the last known version across restarts. An explicit
 * CODEX_CLIENT_VERSION env pin disables tracking entirely.
 */

import { z } from "zod";
import {
  getCodexClientVersion,
  getTrackedCodexClientVersion,
  isCodexClientVersionPinnedByEnv,
  setTrackedCodexClientVersion,
} from "@omniroute/open-sse/config/codexClient.ts";
import { getSettings, updateSettings } from "@/lib/db/settings";

export const CODEX_CLIENT_VERSION_REGISTRY_URL = "https://registry.npmjs.org/@openai/codex/latest";
export const CODEX_CLIENT_VERSION_SETTING_KEY = "codex_client_version_tracked";
export const CODEX_CLIENT_VERSION_CHECK_TTL_MS = 60 * 60 * 1000;

// Stable releases only — prereleases (0.157.0-alpha.1) and build metadata are rejected.
const STABLE_CODEX_CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

const NpmPackageManifestSchema = z.object({ version: z.string() });

export type CodexClientVersionFetch = (
  input: string,
  init: {
    method: "GET";
    headers: Record<string, string>;
  }
) => Promise<Response>;

/** Persistence seam; both default to the settings DB. */
export type CodexClientVersionTrackerDeps = {
  readStoredVersion?: () => Promise<unknown>;
  writeStoredVersion?: (version: string) => Promise<void>;
};

export type CodexClientVersionRefreshResult = {
  version: string;
  changed: boolean;
};

type CodexClientVersionTrackerState = {
  hydration: Promise<void> | null;
  lastCheckedAt: number | null;
  inFlight: Promise<CodexClientVersionRefreshResult> | null;
};

// Route bundles and background schedulers can be separate module instances in
// one process; keeping this on globalThis gives them one shared hydration, TTL
// window and in-flight registry request.
const trackerGlobal = globalThis as typeof globalThis & {
  __omnirouteCodexClientVersionTracker?: CodexClientVersionTrackerState;
};

function getTrackerState(): CodexClientVersionTrackerState {
  trackerGlobal.__omnirouteCodexClientVersionTracker ??= {
    hydration: null,
    lastCheckedAt: null,
    inFlight: null,
  };
  return trackerGlobal.__omnirouteCodexClientVersionTracker;
}

function isStableCodexClientVersion(value: unknown): value is string {
  return typeof value === "string" && STABLE_CODEX_CLIENT_VERSION_PATTERN.test(value);
}

async function readStoredCodexClientVersion(): Promise<unknown> {
  const settings = await getSettings();
  return settings?.[CODEX_CLIENT_VERSION_SETTING_KEY];
}

async function writeStoredCodexClientVersion(version: string): Promise<void> {
  await updateSettings({ [CODEX_CLIENT_VERSION_SETTING_KEY]: version });
}

async function applyStoredCodexClientVersion(
  readStoredVersion: () => Promise<unknown>
): Promise<void> {
  try {
    const stored = await readStoredVersion();
    // A version already learned from the registry in this process is fresher.
    if (isStableCodexClientVersion(stored) && getTrackedCodexClientVersion() === null) {
      setTrackedCodexClientVersion(stored);
    }
  } catch {
    // Non-critical: the next registry check learns the version again.
  }
}

/**
 * Apply the last tracked version from settings, once per process, so inference
 * uses it right after a restart — before any discovery runs. Never throws.
 */
export async function hydrateCodexClientVersionFromSettings(
  deps: CodexClientVersionTrackerDeps = {}
): Promise<void> {
  const state = getTrackerState();
  state.hydration ??= applyStoredCodexClientVersion(
    deps.readStoredVersion ?? readStoredCodexClientVersion
  );
  await state.hydration;
}

async function fetchPublishedCodexClientVersion(
  fetchImpl: CodexClientVersionFetch
): Promise<string | null> {
  try {
    const response = await fetchImpl(CODEX_CLIENT_VERSION_REGISTRY_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return null;

    const manifest = NpmPackageManifestSchema.safeParse(await response.json());
    return manifest.success && isStableCodexClientVersion(manifest.data.version)
      ? manifest.data.version
      : null;
  } catch {
    return null;
  }
}

async function checkPublishedCodexClientVersion(
  state: CodexClientVersionTrackerState,
  fetchImpl: CodexClientVersionFetch,
  now: number,
  writeStoredVersion: (version: string) => Promise<void>
): Promise<CodexClientVersionRefreshResult> {
  const previousVersion = getCodexClientVersion();
  const publishedVersion = await fetchPublishedCodexClientVersion(fetchImpl);
  // Failures back off for the TTL too, so an unreachable registry is not hammered.
  state.lastCheckedAt = now;
  if (!publishedVersion) return { version: previousVersion, changed: false };

  setTrackedCodexClientVersion(publishedVersion);
  const version = getCodexClientVersion();
  if (version === previousVersion) return { version, changed: false };

  try {
    await writeStoredVersion(publishedVersion);
  } catch {
    // Non-critical: the in-memory version already applies to this process.
  }
  console.log(`[CodexClientVersion] Tracking Codex CLI ${version} (was ${previousVersion})`);
  return { version, changed: true };
}

/**
 * Learn the latest published Codex CLI version from the npm registry — at most
 * once per TTL, with concurrent callers sharing one request. Skipped when
 * CODEX_CLIENT_VERSION pins the version. Never throws: on any failure the
 * current version stays in effect.
 */
export async function refreshCodexClientVersion({
  fetchImpl,
  now = Date.now(),
  force = false,
  deps = {},
}: {
  fetchImpl: CodexClientVersionFetch;
  now?: number;
  force?: boolean;
  deps?: CodexClientVersionTrackerDeps;
}): Promise<CodexClientVersionRefreshResult> {
  if (isCodexClientVersionPinnedByEnv()) {
    return { version: getCodexClientVersion(), changed: false };
  }

  await hydrateCodexClientVersionFromSettings(deps);

  const state = getTrackerState();
  if (!state.inFlight) {
    const checkedRecently =
      state.lastCheckedAt !== null && now - state.lastCheckedAt < CODEX_CLIENT_VERSION_CHECK_TTL_MS;
    if (!force && checkedRecently) {
      return { version: getCodexClientVersion(), changed: false };
    }
    state.inFlight = checkPublishedCodexClientVersion(
      state,
      fetchImpl,
      now,
      deps.writeStoredVersion ?? writeStoredCodexClientVersion
    );
  }

  const inFlight = state.inFlight;
  try {
    return await inFlight;
  } finally {
    if (state.inFlight === inFlight) state.inFlight = null;
  }
}

/** Test-only: forget hydration, TTL and in-flight state plus the tracked version. */
export function __resetCodexClientVersionTrackerForTests(): void {
  delete trackerGlobal.__omnirouteCodexClientVersionTracker;
  setTrackedCodexClientVersion(null);
}
