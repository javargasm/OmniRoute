/**
 * Kiro (AWS CodeWhisperer / Amazon Q) live model discovery.
 *
 * Kiro's model catalog is per-account / per-tier — the free tier, Pro, Pro+ and
 * Power plans expose different model sets, and AWS IAM Identity Center (enterprise)
 * orgs further restrict it to an admin-curated "approved models" list. The Kiro
 * IDE / CLI populates its model picker by calling the CodeWhisperer
 * `ListAvailableModels` operation:
 *
 *   GET https://q.{region}.amazonaws.com/ListAvailableModels?origin=AI_EDITOR
 *   Authorization: Bearer <accessToken>
 *   → { models: [ { modelId, modelName?, tokenLimits?: { maxInputTokens } }, ... ] }
 *
 * This works for both "simple" Builder ID / social logins and AWS IAM Identity
 * Center accounts:
 *   - `origin=AI_EDITOR` alone is the universal call (Builder ID / IdC).
 *   - `profileArn` is only sent for desktop-style accounts that have one, and only
 *     as a retry, because sending it for Builder ID can yield 403.
 *   - The endpoint is region-matched (IdC tokens are region-bound, e.g.
 *     eu-central-1) with a us-east-1 fallback (the legacy CodeWhisperer home region).
 *
 * A safe fallback to the static registry catalog is preserved so model import
 * never breaks when the account is offline / unauthenticated / token-expired.
 */

import { createHash } from "node:crypto";

import {
  isExternalIdpAuthMethod,
  KIRO_EXTERNAL_IDP_TOKEN_TYPE_HEADER,
  KIRO_EXTERNAL_IDP_TOKEN_TYPE_VALUE,
} from "./kiroExternalIdp.ts";
import { DEFAULT_PROFILE_ARN, resolveKiroRuntimeRegion } from "./kiroRegion.ts";
import { supportsKiroAdaptiveThinking } from "../translator/request/openai-to-kiro/adaptiveThinking.ts";

type RawRecord = Record<string, unknown>;

export const KIRO_CLI_ORIGIN = "KIRO_CLI";
export const KIRO_CLI_USER_AGENT =
  process.env.KIRO_CUSTOM_USER_AGENT ||
  "aws-sdk-rust/1.3.15 ua/2.1 api/codewhispererruntime/0.1.17975 os/macos lang/rust/1.92.0 md/appVersion-2.20.0 app/AmazonQ-For-CLI";
export const KIRO_CLI_X_AMZ_USER_AGENT = `${KIRO_CLI_USER_AGENT} m/F,C`;

export const KIRO_MANAGEMENT_TARGET = {
  listAvailableProfiles: "AmazonCodeWhispererService.ListAvailableProfiles",
  listAvailableModels: "AmazonCodeWhispererService.ListAvailableModels",
} as const;

export const KIRO_MANAGEMENT_BASE_HEADERS = {
  "Content-Type": "application/x-amz-json-1.0",
  "user-agent": KIRO_CLI_USER_AGENT,
  "x-amz-user-agent": KIRO_CLI_X_AMZ_USER_AGENT,
  "x-amzn-codewhisperer-optout": "true",
  Accept: "*/*",
  "accept-encoding": "gzip",
  "amz-sdk-request": "attempt=1; max=3",
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
} as const;

const CACHE_TTL_MS = 5 * 60 * 1000;

const catalogCache = new Map<string, { expiresAt: number; models: KiroModel[] }>();

/**
 * `ListAvailableModels` advertises this pseudo-model, but Kiro rejects it on
 * GenerateAssistantResponse with INVALID_MODEL_ID. Also filter out disabled/invalid
 * models like fable.
 */
function isUnusableKiroCatalogModelId(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return lower === "auto" || lower.includes("fable");
}

function asRecord(value: unknown): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {};
}

function toNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export type KiroPromptCaching = {
  supportsPromptCaching: boolean;
  minimumTokensPerCacheCheckpoint: number | null;
  maximumCacheCheckpointsPerRequest: number | null;
};

export type KiroModel = {
  id: string;
  name: string;
  owned_by: string;
  capabilities?: {
    thinking: boolean;
    agentic: boolean;
  };
  contextLength?: number;
  rateMultiplier?: number;
  upstreamModelId?: string;
  description?: string;
  promptCaching?: KiroPromptCaching;
};

function toNonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parsePromptCaching(value: unknown): KiroPromptCaching | undefined {
  const promptCaching = asRecord(value);
  if (typeof promptCaching.supportsPromptCaching !== "boolean") return undefined;

  return {
    supportsPromptCaching: promptCaching.supportsPromptCaching,
    minimumTokensPerCacheCheckpoint: toNonNegativeInteger(
      promptCaching.minimumTokensPerCacheCheckpoint
    ),
    maximumCacheCheckpointsPerRequest: toNonNegativeInteger(
      promptCaching.maximumCacheCheckpointsPerRequest
    ),
  };
}

export type KiroModelsResult = {
  models: KiroModel[];
  /** "api" = live discovery; "fallback" = static catalog (offline/unauthed/error). */
  source: "api" | "fallback";
};

/**
 * Parse a CodeWhisperer `ListAvailableModels` response into managed model rows.
 * Only ids present in the live response are returned, which gives the exact
 * per-account / per-tier entitlement filtering.
 */
export function parseKiroModels(data: unknown): KiroModel[] {
  const payload = asRecord(data);
  const items = Array.isArray(payload.models)
    ? (payload.models as unknown[])
    : Array.isArray(payload.availableModels)
      ? (payload.availableModels as unknown[])
      : [];

  const seen = new Set<string>();
  const models: KiroModel[] = [];

  for (const value of items) {
    const item = asRecord(value);
    const id = toNonEmptyString(item.modelId) || toNonEmptyString(item.id);
    if (!id || isUnusableKiroCatalogModelId(id) || seen.has(id)) continue;
    seen.add(id);
    const name = toNonEmptyString(item.modelName) || toNonEmptyString(item.name) || id;
    const promptCaching = parsePromptCaching(item.promptCaching);
    models.push({ id, name, owned_by: "kiro", ...(promptCaching && { promptCaching }) });
  }

  return models;
}

function formatDisplayName(modelName: unknown, modelId: string, rateMultiplier: unknown): string {
  const base = toNonEmptyString(modelName) || modelId;
  const rate = Number(rateMultiplier);
  if (!Number.isFinite(rate) || Math.abs(rate - 1.0) < 1e-9 || rate <= 0) {
    return `Kiro ${base}`;
  }
  return `Kiro ${base} (${rate.toFixed(1)}x credit)`;
}

function buildVariants(upstream: string, displayName: string): KiroModel[] {
  const display = displayName || `Kiro ${upstream}`;
  const variants: KiroModel[] = [
    {
      id: upstream,
      name: display,
      owned_by: "kiro",
      capabilities: { thinking: false, agentic: false },
    },
  ];

  if (supportsKiroAdaptiveThinking(upstream)) {
    variants.push({
      id: `${upstream}-thinking`,
      name: `${display} (Thinking)`,
      owned_by: "kiro",
      capabilities: { thinking: true, agentic: false },
    });
  }

  return variants;
}

export function isObsoleteKiroModelAlias(modelId: unknown): boolean {
  if (typeof modelId !== "string") return false;
  if (isUnusableKiroCatalogModelId(modelId) || modelId === "auto-kiro" || modelId.endsWith("-agentic")) {
    return true;
  }
  if (!modelId.endsWith("-thinking")) return false;
  const upstream = modelId.slice(0, -"-thinking".length);
  return !supportsKiroAdaptiveThinking(upstream);
}

function expandKiroModels(data: unknown): KiroModel[] {
  const payload = asRecord(data);
  const items = Array.isArray(payload.models)
    ? (payload.models as unknown[])
    : Array.isArray(payload.availableModels)
      ? (payload.availableModels as unknown[])
      : [];
  const expanded: KiroModel[] = [];
  const seen = new Set<string>();

  for (const value of items) {
    const item = asRecord(value);
    const upstreamId = toNonEmptyString(item.modelId) || toNonEmptyString(item.id);
    if (!upstreamId || isUnusableKiroCatalogModelId(upstreamId)) continue;
    const display = formatDisplayName(item.modelName || item.name, upstreamId, item.rateMultiplier);
    const tokenLimits = asRecord(item.tokenLimits);
    const contextLength = Number(tokenLimits.maxInputTokens) || 200000;
    const rateMultiplier = Number(item.rateMultiplier);
    const promptCaching = parsePromptCaching(item.promptCaching);

    for (const variant of buildVariants(upstreamId, display)) {
      if (seen.has(variant.id)) continue;
      seen.add(variant.id);
      expanded.push({
        ...variant,
        contextLength,
        rateMultiplier: Number.isFinite(rateMultiplier) ? rateMultiplier : 1.0,
        upstreamModelId: upstreamId,
        description: toNonEmptyString(item.description) || "",
        ...(promptCaching && { promptCaching }),
      });
    }
  }

  return expanded;
}

/**
 * Derive the RUNTIME AWS region for a Kiro connection's model discovery. Delegates to the shared
 * resolver: the profileArn region wins (that is where the Q Developer profile + ListAvailableModels
 * live — us-east-1 / eu-central-1), then a valid stored profile region, else us-east-1. The IdC
 * token region (e.g. eu-north-1) is deliberately not used as a runtime region.
 */
export function resolveKiroRegion(providerSpecificData: unknown): string {
  return resolveKiroRuntimeRegion(
    asRecord(providerSpecificData) as { region?: unknown; profileArn?: unknown }
  );
}

/**
 * Build the ordered list of Kiro management base URLs to try: the
 * region-matched host first, then the us-east-1 home region as a
 * fallback.
 */
export function buildKiroModelsEndpoints(region: string): string[] {
  const normalized = (toNonEmptyString(region) || "us-east-1").toLowerCase();
  const urls: string[] = [`https://management.${normalized}.kiro.dev`];
  if (normalized !== "us-east-1") {
    urls.push("https://management.us-east-1.kiro.dev");
  }
  return urls;
}

export type FetchKiroModelsOptions = {
  /** Stored Kiro access token (Bearer). */
  accessToken: string | null | undefined;
  /** Connection providerSpecificData (region, profileArn). */
  providerSpecificData?: unknown;
  /** Injectable fetch (defaults to global fetch). */
  fetchImpl?: typeof fetch;
  /** Static catalog to fall back to when live discovery is unavailable. */
  fallbackModels?: Array<{ id: string; name?: string }>;
};

function toFallbackResult(
  fallbackModels: Array<{ id: string; name?: string }> | undefined
): KiroModelsResult {
  const models = (fallbackModels || [])
    .map((model) => {
      const id = toNonEmptyString(model.id);
      if (!id || isUnusableKiroCatalogModelId(id)) return null;
      return {
        id,
        name: toNonEmptyString(model.name) || id,
        owned_by: "kiro",
      };
    })
    .filter((model): model is KiroModel => Boolean(model));
  return { models, source: "fallback" };
}

/**
 * Resolve the Kiro profile ARN by calling ListAvailableProfiles on the management endpoint.
 * Builder ID accounts get AccessDenied on ListAvailableProfiles, falling back to DEFAULT_PROFILE_ARN.
 */
export async function resolveProfileArn(
  accessToken: string,
  apiRegion: string,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal
): Promise<string> {
  try {
    const endpoint = `https://management.${apiRegion}.kiro.dev/`;
    const resp = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...KIRO_MANAGEMENT_BASE_HEADERS,
        "X-Amz-Target": KIRO_MANAGEMENT_TARGET.listAvailableProfiles,
      },
      body: "{}",
      ...(signal ? { signal } : {}),
    });
    if (resp && resp.ok) {
      const data = (await resp.json()) as {
        profiles?: { arn?: string; profileType?: string; status?: string }[];
      };
      const profiles = data.profiles ?? [];
      const kiroProfile = profiles.find((p) => p.profileType === "KIRO" && p.status === "ACTIVE");
      const arn = kiroProfile?.arn ?? profiles[0]?.arn ?? DEFAULT_PROFILE_ARN;
      return arn;
    }
  } catch {
    // Best-effort; fall through to DEFAULT_PROFILE_ARN
  }
  return DEFAULT_PROFILE_ARN;
}

function buildKiroManagementHeaders(
  providerSpecificData: unknown,
  accessToken: string,
  target: string
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    ...KIRO_MANAGEMENT_BASE_HEADERS,
    "X-Amz-Target": target,
  };
  const psd = asRecord(providerSpecificData);
  if (psd.authMethod === "api_key") {
    headers.tokentype = "API_KEY";
  }
  if (isExternalIdpAuthMethod(psd.authMethod)) {
    headers[KIRO_EXTERNAL_IDP_TOKEN_TYPE_HEADER] = KIRO_EXTERNAL_IDP_TOKEN_TYPE_VALUE;
  }
  return headers;
}

function cacheKey(accessToken: string, providerSpecificData: unknown): string {
  const psd = asRecord(providerSpecificData);
  const seed =
    toNonEmptyString(psd.profileArn) ||
    toNonEmptyString(psd.clientId) ||
    accessToken ||
    "anonymous";
  const authMethod = toNonEmptyString(psd.authMethod) || "unknown";
  return createHash("sha256").update(`kiro:${authMethod}:${seed}`).digest("hex");
}

async function tryFetchModels(
  fetchImpl: typeof fetch,
  baseEndpoint: string,
  accessToken: string,
  profileArn: string,
  providerSpecificData: unknown
): Promise<KiroModel[] | null> {
  const url = `${baseEndpoint}/?origin=${KIRO_CLI_ORIGIN}&profileArn=${encodeURIComponent(profileArn)}`;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: buildKiroManagementHeaders(
        providerSpecificData,
        accessToken,
        KIRO_MANAGEMENT_TARGET.listAvailableModels
      ),
      body: JSON.stringify({ origin: KIRO_CLI_ORIGIN, profileArn }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    const models = expandKiroModels(data);
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/**
 * Discover the Kiro model catalog live via `ListAvailableModels` on the management
 * endpoint, matching opencode-kiro parity. Falls back to static catalog when offline
 * or every attempt fails.
 */
export async function fetchKiroAvailableModels(
  options: FetchKiroModelsOptions
): Promise<KiroModelsResult> {
  const { accessToken, providerSpecificData, fetchImpl = fetch, fallbackModels } = options;

  const token = toNonEmptyString(accessToken);
  if (!token) {
    return toFallbackResult(fallbackModels);
  }

  const key = cacheKey(token, providerSpecificData);
  const cached = catalogCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return { models: cached.models, source: "api" };
  }

  const region = resolveKiroRegion(providerSpecificData);
  const endpoints = buildKiroModelsEndpoints(region);
  const psd = asRecord(providerSpecificData);
  let profileArn = toNonEmptyString(psd.profileArn);

  if (!profileArn && psd.authMethod !== "api_key") {
    profileArn = await resolveProfileArn(token, region, fetchImpl);
  } else if (!profileArn) {
    profileArn = DEFAULT_PROFILE_ARN;
  }

  for (const base of endpoints) {
    const models = await tryFetchModels(
      fetchImpl,
      base,
      token,
      profileArn,
      providerSpecificData
    );
    if (models) {
      catalogCache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, models });
      return { models, source: "api" };
    }
  }

  return toFallbackResult(fallbackModels);
}

export function clearKiroModelCache(): void {
  catalogCache.clear();
}
