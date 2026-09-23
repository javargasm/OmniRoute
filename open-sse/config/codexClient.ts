import {
  CODEX_CLI_RS_ORIGINATOR,
  DEFAULT_CODEX_CLIENT_VERSION,
  getCodexCliRsHeaders as buildCodexCliRsHeaders,
} from "@/shared/constants/codexClient";

export {
  DEFAULT_CODEX_CLIENT_VERSION,
  CODEX_CLI_RS_ORIGINATOR,
} from "@/shared/constants/codexClient";
const DEFAULT_CODEX_USER_AGENT_PLATFORM = "Windows 10.0.26200";
const DEFAULT_CODEX_USER_AGENT_ARCH = "x64";
const CODEX_VERSION_OVERRIDE_ENV = "CODEX_CLIENT_VERSION";
const CODEX_USER_AGENT_OVERRIDE_ENV = "CODEX_USER_AGENT";
const SAFE_HEADER_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SAFE_HEADER_VALUE_PATTERN = /^[\x20-\x7E]{1,200}$/;
const SAFE_CODEX_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/;
const TRACKED_CODEX_CLIENT_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// Next.js route bundles, executors and background schedulers can load this
// module as separate instances in one process, so the tracked version lives on
// globalThis where every instance reads the same value.
const codexClientVersionState = globalThis as typeof globalThis & {
  __omnirouteCodexTrackedClientVersion?: string | null;
};

function getSafeEnvValue(name: string, pattern: RegExp): string | null {
  const raw = process.env[name];
  if (typeof raw !== "string") return null;
  const normalized = raw.trim();
  if (!normalized || !pattern.test(normalized)) {
    return null;
  }
  return normalized;
}

function parseVersionParts(version: string): number[] | null {
  const parts = version
    .trim()
    .split(".")
    .map((part) => Number(part));
  return parts.length > 0 && parts.every((part) => Number.isInteger(part) && part >= 0)
    ? parts
    : null;
}

/** Numeric dot-separated comparison; 0 when either side is unparsable. */
export function compareCodexClientVersions(left: string, right: string): number {
  const leftParts = parseVersionParts(left);
  const rightParts = parseVersionParts(right);
  if (!leftParts || !rightParts) return 0;

  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftParts[index] || 0;
    const b = rightParts[index] || 0;
    if (a !== b) return a - b;
  }
  return 0;
}

function toTrackedCodexClientVersion(value: unknown): string | null {
  return typeof value === "string" &&
    TRACKED_CODEX_CLIENT_VERSION_PATTERN.test(value) &&
    SAFE_HEADER_TOKEN_PATTERN.test(value)
    ? value
    : null;
}

/**
 * Record the latest published Codex CLI version (x.y.z only; anything else is
 * ignored). `null` clears it.
 */
export function setTrackedCodexClientVersion(version: string | null): void {
  if (version === null) {
    codexClientVersionState.__omnirouteCodexTrackedClientVersion = null;
    return;
  }
  const tracked = toTrackedCodexClientVersion(version);
  if (tracked) codexClientVersionState.__omnirouteCodexTrackedClientVersion = tracked;
}

export function getTrackedCodexClientVersion(): string | null {
  return toTrackedCodexClientVersion(codexClientVersionState.__omnirouteCodexTrackedClientVersion);
}

/** True when CODEX_CLIENT_VERSION pins the version (tracking is then disabled). */
export function isCodexClientVersionPinnedByEnv(): boolean {
  return getSafeEnvValue(CODEX_VERSION_OVERRIDE_ENV, SAFE_HEADER_TOKEN_PATTERN) !== null;
}

/**
 * Effective Codex client version: an explicit CODEX_CLIENT_VERSION pin wins
 * (even when lower); otherwise the higher of the built-in floor and the
 * tracked published CLI version.
 */
export function getCodexClientVersion(): string {
  const pinned = getSafeEnvValue(CODEX_VERSION_OVERRIDE_ENV, SAFE_HEADER_TOKEN_PATTERN);
  if (pinned) return pinned;

  const tracked = getTrackedCodexClientVersion();
  return tracked && compareCodexClientVersions(tracked, DEFAULT_CODEX_CLIENT_VERSION) > 0
    ? tracked
    : DEFAULT_CODEX_CLIENT_VERSION;
}

export function getCodexUserAgent(): string {
  const override = getSafeEnvValue(CODEX_USER_AGENT_OVERRIDE_ENV, SAFE_HEADER_VALUE_PATTERN);
  if (override) {
    return override;
  }

  return `codex-cli/${getCodexClientVersion()} (${DEFAULT_CODEX_USER_AGENT_PLATFORM}; ${DEFAULT_CODEX_USER_AGENT_ARCH})`;
}

export function getCodexDefaultHeaders(): Record<string, string> {
  return {
    Version: getCodexClientVersion(),
    "Openai-Beta": "responses=experimental",
    "X-Codex-Beta-Features": "responses_websockets",
    "User-Agent": getCodexUserAgent(),
  };
}

export function getCodexCliRsHeaders(): Record<string, string> {
  return buildCodexCliRsHeaders(getCodexClientVersion());
}

/**
 * Identity for the credential face (auth.openai.com: token exchange / refresh).
 * The real Codex client sends only `originator` + `User-Agent` on that face
 * (codex-rs login/default_client.rs default_headers()); the `Version` header
 * gate exists only on the chatgpt.com/backend-api inference face, so it is
 * deliberately omitted here. Mirrors sub2api v0.1.178
 * ApplyCodexCanonicalAuthIdentity.
 */
export function getCodexAuthIdentityHeaders(): Record<string, string> {
  return {
    "User-Agent": getCodexUserAgent(),
    originator: CODEX_CLI_RS_ORIGINATOR,
  };
}

/**
 * Canonical Codex CLI identity for server-initiated calls against the
 * chatgpt.com/backend-api face that are not tied to one end-client request
 * (usage / quota / models manifest / reset-credits). Same UA/version chain as
 * inference so these calls do not show up upstream as anonymous half-identities.
 */
export function getCodexBackendIdentityHeaders(): Record<string, string> {
  return {
    "User-Agent": getCodexUserAgent(),
    originator: CODEX_CLI_RS_ORIGINATOR,
    Version: getCodexClientVersion(),
  };
}

export function normalizeCodexSessionId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return SAFE_CODEX_SESSION_ID_PATTERN.test(normalized) ? normalized : null;
}
