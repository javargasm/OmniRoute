import { NextResponse } from "next/server";
import { homedir } from "os";
import { join } from "path";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { isNextBuildPhase } from "@/lib/buildPhase";
import {
  createProviderConnection,
  getProviderConnections,
  updateProviderConnection,
  isCloudEnabled,
  resolveProxyForProvider,
} from "@/models";
import { syncToCloud } from "@/lib/cloudSync";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { KiroService } from "@/lib/oauth/services/kiro";
import { AWS_REGION_PATTERN } from "@/lib/oauth/constants/oauth";
import { findKiroConnectionByIdentity } from "@/lib/oauth/kiroConnectionIdentity";
import { runWithProxyContext } from "@omniroute/open-sse/utils/proxyFetch.ts";
import {
  emailFromExternalIdpToken,
  isExternalIdpAuthMethod,
  normalizeScope,
} from "@omniroute/open-sse/services/kiroExternalIdp.ts";

const KIRO_SSO_CACHE_FILE = "kiro-auth-token.json";
const KIRO_CACHED_ACCESS_TOKEN_SKEW_MS = 5 * 60 * 1000;

/**
 * GET /api/oauth/kiro/auto-import
 *
 * Auto-import Kiro credentials from kiro-cli's SQLite database.
 * Supports both personal Builder ID and enterprise SSO (IDC/profileArn).
 *
 * Falls back to ~/.aws/sso/cache if kiro-cli SQLite is not found.
 *
 * 🔒 Auth-guarded: requires JWT cookie or Bearer API key.
 */
export async function GET(request: Request) {
  // GHSA-mg76 / GHSA-gxv4: reading/importing host credentials is a management action.
  const authError = await requireManagementAuth(request, { invalidApiKeyStatus: 401 });
  if (authError) return authError;

  const { searchParams } = new URL(request.url);
  const targetProvider = searchParams.get("targetProvider") === "amazon-q" ? "amazon-q" : "kiro";

  // Try kiro-cli SQLite first
  const sqliteResult = await tryKiroCliSqlite();
  if (sqliteResult.found) {
    return await saveAndRespond(sqliteResult, targetProvider);
  }

  // Fall back to ~/.aws/sso/cache (social auth / manual token)
  const cacheResult = await tryAwsSsoCache(targetProvider);
  if (cacheResult.found) {
    return await saveAndRespond(cacheResult, targetProvider);
  }

  return NextResponse.json({
    found: false,
    error:
      "Kiro credentials not found. " +
      "Run `kiro-cli login --use-device-flow` then retry, " +
      "or use the Import Token option in the dashboard.",
    triedPaths: [...(sqliteResult.triedPaths ?? []), cacheResult.triedPath].filter(Boolean),
  });
}

// ── kiro-cli SQLite reader ────────────────────────────────────────────────────

export function getKiroCliSqliteCandidatePaths(opts: {
  home: string;
  platform?: NodeJS.Platform;
  appData?: string;
  xdgDataHome?: string;
}): string[] {
  const platform = opts.platform ?? process.platform;
  const appData = typeof opts.appData === "string" && opts.appData.trim() ? opts.appData.trim() : null;
  const candidates: string[] = [];

  if (platform === "darwin") {
    // Kiro CLI's canonical macOS data directory. Retain the legacy Unix path below so an
    // existing manually-installed/older CLI remains importable without migrating its data.
    candidates.push(join(opts.home, "Library", "Application Support", "kiro-cli", "data.sqlite3"));
    candidates.push(join(opts.home, ".local", "share", "kiro-cli", "data.sqlite3"));
  } else if (platform === "win32") {
    // Rust kiro-cli and the VS Code-derived Kiro IDE use distinct Windows layouts.
    // Do not guess a Windows data root when APPDATA is absent; the prior import path treated
    // that condition as unavailable, and an unrelated home-relative SQLite file is unsafe to try.
    if (appData) {
      candidates.push(join(appData, "kiro-cli", "data.sqlite3"));
      candidates.push(join(appData, "kiro", "storage.db"));
    }
  } else {
    const xdgDataRoot =
      typeof opts.xdgDataHome === "string" && opts.xdgDataHome.trim()
        ? opts.xdgDataHome.trim()
        : join(opts.home, ".local", "share");
    candidates.push(join(xdgDataRoot, "kiro-cli", "data.sqlite3"));
  }

  // Keep the existing APPDATA probe available when a Kiro IDE storage path is explicitly
  // supplied by the environment (including cross-platform/electron test environments).
  if (appData && platform !== "win32") {
    candidates.push(join(appData, "kiro", "storage.db"));
  }

  return [...new Set(candidates)];
}

async function tryKiroCliSqlite(): Promise<{
  found: boolean;
  triedPaths?: string[];
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: string;
  clientId?: string;
  clientSecret?: string;
  region?: string;
  profileArn?: string;
  authMethod?: "builder-id" | "idc";
  source?: string;
}> {
  // Build the platform-native candidate list without writing or otherwise mutating any CLI data.
  const candidatePaths = getKiroCliSqliteCandidatePaths({
    home: homedir(),
    appData: process.env.APPDATA,
    xdgDataHome: process.env.XDG_DATA_HOME,
  });

  let Database: any;
  try {
    // Never load the native better-sqlite3 addon during the Next.js build:
    // its Statement destructor aborts with SIGABRT at build-worker teardown
    // (node::RemoveEnvironmentCleanupHook). Kiro auto-import never runs during
    // build, so returning "not found" here is safe. (#10060)
    if (isNextBuildPhase()) throw new Error("Skip better-sqlite3 during build");
    Database = (await import("better-sqlite3")).default;
  } catch {
    return { found: false, triedPaths: candidatePaths };
  }

  for (const dbPath of candidatePaths) {
    let db: any;
    try {
      db = new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch {
      // File does not exist or cannot be opened — try next candidate.
      continue;
    }

    try {
      // Read OIDC token (access + refresh token).
      // Try auth_kv table first (kiro-cli Linux/macOS schema), then fallback
      // key-value tables used by the Kiro IDE on Windows (VS Code-style storage).
      // "kiro:auth:token" is the key Kiro IDE writes in its VS Code Extension Storage
      // API-backed SQLite (ItemTable / storage tables) — confirmed from #3363 reporter's
      // %APPDATA%\kiro\storage.db dump where the token starts with "aorAAAAAG".
      const tokenKeys = ["kirocli:odic:token", "kirocli:oidc:token", "kiro:auth:token"];
      let tokenData: any = null;

      for (const key of tokenKeys) {
        for (const table of ["auth_kv", "ItemTable", "storage"]) {
          try {
            const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as
              { value: string } | undefined;
            if (row?.value) {
              try {
                tokenData = JSON.parse(row.value);
                if (tokenData?.refresh_token) break;
              } catch {
                // continue
              }
            }
          } catch {
            // no such table — skip gracefully
          }
        }
        if (tokenData?.refresh_token) break;
      }

      if (!tokenData?.refresh_token) {
        continue;
      }

      // Read device registration (client_id + client_secret).
      const regKeys = ["kirocli:odic:device-registration", "kirocli:oidc:device-registration"];
      let regData: any = null;
      for (const key of regKeys) {
        for (const table of ["auth_kv", "ItemTable", "storage"]) {
          try {
            const row = db.prepare(`SELECT value FROM ${table} WHERE key = ?`).get(key) as
              { value: string } | undefined;
            if (row?.value) {
              try {
                regData = JSON.parse(row.value);
                if (regData?.client_id) break;
              } catch {
                // continue
              }
            }
          } catch {
            // no such table — skip gracefully
          }
        }
        if (regData?.client_id) break;
      }

      // Read profileArn (enterprise SSO / IDC). The kiro-cli Linux schema stores this
      // in the `state` table; the Windows Kiro IDE schema may store it in `ItemTable`
      // or `storage` with the same key. Probe all three so IDC users on Windows also
      // get a valid profileArn and are not silently downgraded to the Builder ID path.
      let profileArn: string | undefined;
      const profileKey = "api.codewhisperer.profile";
      for (const table of ["state", "ItemTable", "storage"]) {
        try {
          const profileRow = db
            .prepare(`SELECT value FROM ${table} WHERE key = ?`)
            .get(profileKey) as { value: string } | undefined;
          if (profileRow?.value) {
            const profileData = JSON.parse(profileRow.value);
            profileArn = profileData.arn || profileData.profileArn;
            if (profileArn) break;
          }
        } catch {
          // table may not exist — skip gracefully
        }
      }

      const region = tokenData.region || regData?.region || "us-east-1";
      const expiresAt = tokenData.expires_at
        ? new Date(tokenData.expires_at).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString();

      return {
        found: true,
        source: "kiro-cli-sqlite",
        refreshToken: tokenData.refresh_token,
        accessToken: tokenData.access_token,
        expiresAt,
        clientId: regData?.client_id,
        clientSecret: regData?.client_secret,
        region,
        profileArn,
        authMethod: resolveKiroCliAuthMethod(profileArn),
      };
    } finally {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }

  return { found: false, triedPaths: candidatePaths };
}

// ── ~/.aws/sso/cache fallback ─────────────────────────────────────────────────

/**
 * Read the Amazon Q Developer profileArn the Kiro IDE persists in its
 * `profile.json`. This is the authoritative source for the profileArn of AWS
 * IAM Identity Center AND External IdP (organization) logins, since neither can
 * enumerate it via ListAvailableProfiles (org tokens get an empty list).
 *
 * The ARN's region segment is preserved verbatim (#2314). #2059 originally
 * forced every ARN's region to us-east-1, which 403s the runtime gateway for
 * IDC accounts that live in a non-us-east-1 region. The OAuth device-code
 * path (src/lib/oauth/providers/kiro.ts) already discovers the correct
 * region-matched ARN, so this fallback now mirrors that behavior instead of
 * rewriting it.
 */
async function readKiroIdeProfileArn(): Promise<string | null> {
  const { readFile } = await import("fs/promises");
  const kiroProfilePaths = [
    join(
      process.env.APPDATA || join(homedir(), "AppData", "Roaming"),
      "Kiro",
      "User",
      "globalStorage",
      "kiro.kiroagent",
      "profile.json"
    ),
    join(homedir(), ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent", "profile.json"),
    join(
      homedir(),
      "Library",
      "Application Support",
      "Kiro",
      "User",
      "globalStorage",
      "kiro.kiroagent",
      "profile.json"
    ),
  ];
  for (const profilePath of kiroProfilePaths) {
    try {
      const profileContent = await readFile(profilePath, "utf-8");
      const profileData = JSON.parse(profileContent);
      if (profileData.arn) {
        return profileData.arn;
      }
    } catch {
      continue;
    }
  }
  return null;
}

async function tryAwsSsoCache(targetProvider: string): Promise<{
  found: boolean;
  triedPath?: string;
  refreshToken?: string;
  accessToken?: string | null;
  expiresAt?: string | null;
  source?: string;
  clientId?: string | null;
  clientSecret?: string | null;
  region?: string | null;
  authMethod?: string | null;
  profileArn?: string | null;
  tokenEndpoint?: string | null;
  scopes?: string | string[] | null;
}> {
  const { readFile, readdir } = await import("fs/promises");
  const cachePath = join(homedir(), ".aws/sso/cache");
  const preferredFile =
    targetProvider === "amazon-q" ? "amazon-q-auth-token.json" : KIRO_SSO_CACHE_FILE;

  let files: string[];
  try {
    files = await readdir(cachePath);
  } catch {
    return { found: false, triedPath: cachePath };
  }

  // Kiro IDE owns one canonical cache file. Do not accidentally import an unrelated AWS SSO
  // token merely because it has a refreshToken-shaped field. Keep Amazon Q's legacy fallback
  // scan unchanged because it is a separate import flow with its own canonical filename.
  const ordered =
    targetProvider === "kiro"
      ? [preferredFile]
      : [preferredFile, ...files.filter((f) => f !== preferredFile && f.endsWith(".json"))];

  for (const file of ordered) {
    try {
      const content = await readFile(join(cachePath, file), "utf-8");
      const data = JSON.parse(content);

      // Enterprise / Microsoft Entra "Your organization" (external_idp) tokens are NOT AWS SSO
      // tokens — their refresh token does not start with `aorAAAAAG`. Detect them by authMethod/
      // provider and take the dedicated external_idp branch (org IdP tokenEndpoint refresh +
      // profileArn read from the Kiro IDE profile.json).
      const isExternalIdp =
        !!data.refreshToken &&
        (isExternalIdpAuthMethod(data.authMethod) ||
          String(data.provider || "").toLowerCase() === "externalidp");

      if (isExternalIdp) {
        const region: string | null = data.region || null;
        const profileArn = await readKiroIdeProfileArn();
        return {
          found: true,
          source: file,
          refreshToken: data.refreshToken,
          accessToken: data.accessToken || null,
          clientId: data.clientId || null,
          clientSecret: null,
          region,
          authMethod: "external_idp",
          profileArn,
          tokenEndpoint: data.tokenEndpoint || null,
          scopes: data.scopes || null,
        };
      }

      if (data.refreshToken?.startsWith("aorAAAAAG")) {
        const region: string | null = data.region || null;
        const authMethod: string | null = data.authMethod || null;

        // For IDC/organization tokens, resolve clientId and clientSecret from
        // the linked client registration file (referenced by clientIdHash).
        let clientId: string | null = null;
        let clientSecret: string | null = null;
        if (data.clientIdHash) {
          const clientFile = `${data.clientIdHash}.json`;
          try {
            const clientContent = await readFile(join(cachePath, clientFile), "utf-8");
            const clientData = JSON.parse(clientContent);
            if (clientData.clientId && clientData.clientSecret) {
              clientId = clientData.clientId;
              clientSecret = clientData.clientSecret;
            }
          } catch {
            // Client registration file not found — continue without it
          }
        }

        // Newer kiro-auth-token.json files omit `clientIdHash` and instead carry
        // the OIDC `clientId` directly on the token object (#1253). In that case
        // find the client-registration file whose own `clientId` matches the
        // token's `clientId`, rather than leaving clientId/clientSecret unset.
        // Matching by exact clientId (not region/latest-expiry) avoids picking
        // an unrelated stale registration on hosts with multiple cached SSO
        // client registrations.
        if (!clientId && data.clientId) {
          for (const candidateFile of files) {
            if (candidateFile === file || !candidateFile.endsWith(".json")) continue;
            try {
              const candidateContent = await readFile(join(cachePath, candidateFile), "utf-8");
              const candidateData = JSON.parse(candidateContent);
              if (
                candidateData.clientId === data.clientId &&
                typeof candidateData.clientSecret === "string" &&
                candidateData.clientSecret
              ) {
                clientId = candidateData.clientId;
                clientSecret = candidateData.clientSecret;
                break;
              }
            } catch {
              // Skip unreadable/malformed candidate files.
            }
          }
        }

        // Read profileArn from Kiro IDE's profile.json. The region is preserved
        // verbatim by readKiroIdeProfileArn() (#2314) — see its docstring for why.
        const profileArn: string | null = await readKiroIdeProfileArn();

        return {
          found: true,
          refreshToken: data.refreshToken,
          accessToken: typeof data.accessToken === "string" ? data.accessToken : null,
          expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : null,
          source: file,
          clientId,
          clientSecret,
          region,
          authMethod,
          profileArn,
        };
      }
    } catch {
      // skip
    }
  }

  return { found: false, triedPath: cachePath };
}

// ── Helpers (exported for unit-testing) ──────────────────────────────────────

/**
 * Derives a human-readable display name for a Kiro/AWS connection when the
 * OAuth token carries no email claim (social-auth / AWS SSO tokens). Falls
 * back through: email → profileArn-based label → provider+region label.
 *
 * Exported for unit tests (#3615).
 */
export function deriveKiroConnectionName(opts: {
  email: string | null | undefined;
  profileArn: string | undefined;
  region: string | undefined;
  targetProvider: string;
}): string {
  const { email, profileArn, region, targetProvider } = opts;
  if (email) return email;
  const r = region || "us-east-1";
  if (profileArn) return `AWS CodeWhisperer (${r})`;
  if (targetProvider === "amazon-q") return `Amazon Q (${r})`;
  return `Kiro (${r})`;
}

export function resolveKiroCliAuthMethod(
  profileArn: string | null | undefined
): "builder-id" | "idc" {
  return profileArn ? "idc" : "builder-id";
}

type ProviderConnectionLike = {
  id?: unknown;
  providerSpecificData?: unknown;
  [key: string]: unknown;
};

/**
 * Scans a list of existing provider connections and returns the first one
 * whose stored `providerSpecificData.profileArn` matches the given ARN.
 * Returns null when profileArn is undefined/null or no match is found.
 *
 * #10815 hardened `findKiroConnectionByIdentity` to require an account-level
 * identifier (email or clientId) alongside a matching profileArn before
 * trusting the match — distinct Builder ID accounts (Google/GitHub social
 * login) can share the same CodeWhisperer profile ARN, and matching on ARN
 * alone let a second social login silently overwrite the first connection.
 * `email`/`clientId` here let a caller supply that account identifier; the
 * real `saveAndRespond()` call sites already do (see below).
 *
 * Exported for unit tests (#3615).
 */
export function findKiroConnectionByProfileArn(
  connections: ProviderConnectionLike[],
  profileArn: string | undefined,
  accountIdentity?: { email?: string | null; clientId?: string | null }
): ProviderConnectionLike | null {
  return findKiroConnectionByIdentity(connections, { profileArn, ...accountIdentity });
}

// ── Save to OmniRoute DB ──────────────────────────────────────────────────────

type SaveAndRespondResult = Awaited<ReturnType<typeof tryKiroCliSqlite>> & {
  // Fields added by tryAwsSsoCache for IDC tokens (#2059)
  authMethod?: string | null;
  // Fields added by tryAwsSsoCache for External IdP (organization) tokens
  tokenEndpoint?: string | null;
  scopes?: string | string[] | null;
};

type ReusableKiroSsoCacheAccessToken = {
  accessToken: string;
  expiresAt: string;
  region: string;
};

function reusableKiroSsoCacheAccessToken(
  result: SaveAndRespondResult,
  targetProvider: string,
  now = Date.now()
): ReusableKiroSsoCacheAccessToken | null {
  if (targetProvider !== "kiro" || result.source !== KIRO_SSO_CACHE_FILE) return null;
  if (typeof result.authMethod !== "string" || result.authMethod.trim().toLowerCase() !== "idc") {
    return null;
  }
  if (typeof result.clientId !== "string" || !result.clientId) return null;
  if (typeof result.clientSecret !== "string" || !result.clientSecret) return null;
  if (typeof result.accessToken !== "string" || !result.accessToken.trim()) return null;
  if (typeof result.expiresAt !== "string" || !result.expiresAt.trim()) return null;

  const expiryMs = Date.parse(result.expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs <= now + KIRO_CACHED_ACCESS_TOKEN_SKEW_MS) {
    return null;
  }

  const region = result.region || "us-east-1";
  if (typeof region !== "string" || !AWS_REGION_PATTERN.test(region)) return null;

  return {
    accessToken: result.accessToken.trim(),
    expiresAt: new Date(expiryMs - KIRO_CACHED_ACCESS_TOKEN_SKEW_MS).toISOString(),
    region,
  };
}

async function saveAndRespond(
  result: SaveAndRespondResult,
  targetProvider: string
) {
  try {
    const kiroService = new KiroService();
    const proxy = await resolveProxyForProvider(targetProvider);

    // Enterprise / Microsoft Entra "Your organization" (external_idp) tokens: refresh via the
    // org IdP tokenEndpoint (public-client OAuth2), persist the Kiro IDE profileArn, and mark
    // the connection so the runtime executor sends `TokenType: EXTERNAL_IDP` and the quota
    // fetch works. These tokens can't refresh via AWS OIDC / Kiro social and have no client
    // secret, so they get their own path.
    if (isExternalIdpAuthMethod(result.authMethod)) {
      const region = result.region || "us-east-1";
      const scope = normalizeScope(result.scopes);
      const externalIdpPsd = {
        authMethod: "external_idp",
        clientId: result.clientId || undefined,
        tokenEndpoint: result.tokenEndpoint || undefined,
        scope,
        region,
      };
      const refreshed = await runWithProxyContext(proxy, () =>
        kiroService.refreshToken(result.refreshToken!, externalIdpPsd)
      );
      const email =
        emailFromExternalIdpToken(refreshed.accessToken) ||
        kiroService.extractEmailFromJWT(refreshed.accessToken);
      const profileArn = result.profileArn || null;
      const connectionName = deriveKiroConnectionName({
        email,
        profileArn: profileArn || undefined,
        region,
        targetProvider,
      });
      const providerSpecificData: Record<string, any> = {
        authMethod: "external_idp",
        provider: "ExternalIdp",
        clientId: result.clientId || null,
        tokenEndpoint: result.tokenEndpoint || null,
        scope,
        region,
      };
      if (profileArn) providerSpecificData.profileArn = profileArn;

      const existingConnections = await getProviderConnections({ provider: targetProvider });
      const existingByArn = findKiroConnectionByIdentity(existingConnections, {
        authType: "oauth",
        profileArn,
        clientId: result.clientId,
        email,
      });
      const record = {
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || result.refreshToken!,
        expiresAt: new Date(Date.now() + (refreshed.expiresIn || 3600) * 1000).toISOString(),
        email: email || null,
        name: connectionName,
        providerSpecificData,
        testStatus: "active",
      };
      if (existingByArn && typeof existingByArn.id === "string") {
        await updateProviderConnection(existingByArn.id, record);
      } else {
        await createProviderConnection({
          provider: targetProvider,
          authType: "oauth",
          ...record,
        } as any);
      }
      if (await isCloudEnabled()) {
        const machineId = await getConsistentMachineId();
        await syncToCloud(machineId).catch(() => {});
      }
      return NextResponse.json({
        found: true,
        source: result.source,
        email: email || null,
        profileArn: profileArn || null,
        region,
        message: "Kiro credentials imported successfully.",
      });
    }

    // If we have a refresh token but no valid access token, refresh now
    let accessToken = result.accessToken;
    let refreshToken = result.refreshToken!;
    let expiresAt = result.expiresAt;
    let profileArn = result.profileArn;

    // `kiro-cli` identifies where credentials came from, not the account type. Persist
    // the actual auth method so IdC accounts still use their profile ARN and Builder ID
    // accounts keep the profile-less flow.
    const resolvedAuthMethod =
      result.source === "kiro-cli-sqlite"
        ? result.authMethod || resolveKiroCliAuthMethod(profileArn)
        : result.clientId
          ? result.authMethod || "idc"
          : "imported";

    const providerSpecificData: Record<string, any> = {
      authMethod: resolvedAuthMethod,
      provider: result.source === "kiro-cli-sqlite" ? "kiro-cli SQLite" : "AWS SSO Cache",
    };

    if (result.clientId) providerSpecificData.clientId = result.clientId;
    if (result.clientSecret) providerSpecificData.clientSecret = result.clientSecret;
    if (result.region) providerSpecificData.region = result.region;
    if (profileArn) providerSpecificData.profileArn = profileArn;

    const reusableCacheToken = reusableKiroSsoCacheAccessToken(result, targetProvider);
    if (reusableCacheToken) {
      // The canonical Kiro IDE cache already provides a verified IdC client and a token with
      // enough remaining lifetime. Reuse it without mutating the CLI-owned cache or contacting
      // AWS; persist five minutes early so normal refresh keeps the safety margin.
      accessToken = reusableCacheToken.accessToken;
      expiresAt = reusableCacheToken.expiresAt;
      providerSpecificData.authMethod = "idc";
      providerSpecificData.region = reusableCacheToken.region;
    } else {
      // For the SSO-cache fallback path the token came from ~/.aws/sso/cache and has no
      // per-connection OIDC client. Register one now so this connection gets an isolated
      // refresh session (#2328). The SQLite path already sets result.clientId.
      if (!result.clientId) {
        try {
          // registerClient validates this cache-derived region before it can affect the OIDC host.
          // Keep the same validated region for the isolated client and its future refreshes.
          const registrationRegion = result.region || "us-east-1";
          const reg = await runWithProxyContext(proxy, () =>
            kiroService.registerClient(registrationRegion)
          );
          providerSpecificData.clientId = reg.clientId;
          providerSpecificData.clientSecret = reg.clientSecret;
          providerSpecificData.region = registrationRegion;
          if (reg.clientSecretExpiresAt) {
            providerSpecificData.clientSecretExpiresAt = reg.clientSecretExpiresAt;
          }
        } catch (err) {
          console.warn(
            "[kiro auto-import] registerClient failed, continuing without isolated client:",
            err
          );
        }
      }

      // Refresh token to get a fresh access token and confirm it works.
      const refreshed = await runWithProxyContext(proxy, () =>
        kiroService.refreshToken(refreshToken, providerSpecificData)
      );

      accessToken = refreshed.accessToken;
      refreshToken = refreshed.refreshToken || refreshToken;
      expiresAt = new Date(Date.now() + (refreshed.expiresIn || 3600) * 1000).toISOString();

      // profileArn may come back from social auth refresh
      if (refreshed.profileArn && !profileArn) {
        profileArn = refreshed.profileArn;
        providerSpecificData.profileArn = profileArn;
      }
    }

    const email = kiroService.extractEmailFromJWT(accessToken);

    // Derive a descriptive name so the UI never shows a blank "OAuth Account"
    // when the token carries no email claim (Kiro social-auth / AWS SSO).
    const connectionName = deriveKiroConnectionName({
      email,
      profileArn,
      region: result.region,
      targetProvider,
    });

    // Dedup by profileArn: if an existing connection already has the same ARN
    // just refresh its tokens instead of inserting a new row. This prevents the
    // duplicate-row accumulation reported in #3615 (4 rows after 6 days).
    const existingConnections = await getProviderConnections({ provider: targetProvider });
    const existingByArn = findKiroConnectionByIdentity(existingConnections, {
      authType: "oauth",
      profileArn,
      clientId: providerSpecificData.clientId,
      email,
    });

    if (existingByArn && typeof existingByArn.id === "string") {
      await updateProviderConnection(existingByArn.id, {
        accessToken,
        refreshToken,
        expiresAt,
        email: email || null,
        name: connectionName,
        providerSpecificData,
        testStatus: "active",
      });
    } else {
      await createProviderConnection({
        provider: targetProvider,
        authType: "oauth",
        accessToken,
        refreshToken,
        expiresAt,
        email: email || null,
        name: connectionName,
        providerSpecificData,
        testStatus: "active",
      } as any);
    }

    if (await isCloudEnabled()) {
      const machineId = await getConsistentMachineId();
      await syncToCloud(machineId).catch(() => {});
    }

    return NextResponse.json({
      found: true,
      source: result.source,
      email: email || null,
      profileArn: profileArn || null,
      region: result.region || null,
      message: "Kiro credentials imported successfully.",
    });
  } catch (error: any) {
    console.error("[kiro auto-import] save error:", error);
    return NextResponse.json({ found: false, error: "Internal server error" }, { status: 500 });
  }
}
