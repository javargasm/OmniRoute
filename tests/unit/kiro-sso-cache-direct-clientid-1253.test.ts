/**
 * TDD for upstream 9router#1253 — Kiro auto-import "Bad credentials" when the
 * cached AWS SSO token carries a direct `clientId` field (no `clientIdHash`).
 *
 * Newer kiro-auth-token.json files omit `clientIdHash` and instead store the
 * OIDC `clientId` directly on the token object. Two related bugs combined to
 * break refresh for these tokens:
 *
 * 1. `tryAwsSsoCache()` (auto-import/route.ts) only ever resolved
 *    clientId/clientSecret via `data.clientIdHash` -> `<hash>.json`. When the
 *    token instead carries a top-level `clientId`, this lookup silently does
 *    nothing, so the auto-import response comes back with clientId/clientSecret
 *    both null even though a matching client-registration file exists in the
 *    same cache dir.
 * 2. Because auto-import lost the clientId/clientSecret pair, the dashboard's
 *    "Import Token" POST is sent as a plain (non-IDC) import, which routes
 *    through `KiroService.validateImportToken()` ->
 *    `readCachedClientCredentials()`. That helper scans *all* client
 *    registration files in `~/.aws/sso/cache` and picks one by
 *    region + latest-expiry, ignoring the token's own `clientId` entirely. On
 *    a machine with multiple stale SSO client registrations this can return a
 *    clientId/clientSecret pair that does not match the token's actual
 *    clientId, producing "Bad credentials" on refresh.
 *
 * Fix: both resolution paths must prefer the client-registration file whose
 * `clientId` matches the token's own `clientId`, instead of a
 * latest-expiry/region heuristic.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ── Hermetic DATA_DIR so DB setup / requireLogin does not hit real disk ──────

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-kiro-1253-data-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-1253";
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "test-api-key-secret-1253";

const core = await import("../../src/lib/db/core.ts");

const { GET } = await import("../../src/app/api/oauth/kiro/auto-import/route.ts");
const { KiroService } = await import("../../src/lib/oauth/services/kiro.ts");
const providersDb = await import("../../src/lib/db/providers.ts");

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_APPDATA = process.env.APPDATA;
const ORIGINAL_FETCH = globalThis.fetch;

let tmpHome: string;

test.beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-kiro-1253-"));
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  process.env.HOME = tmpHome;
  delete process.env.APPDATA;
  globalThis.fetch = ORIGINAL_FETCH;
});

test.afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_APPDATA !== undefined) {
    process.env.APPDATA = ORIGINAL_APPDATA;
  } else {
    delete process.env.APPDATA;
  }
  globalThis.fetch = ORIGINAL_FETCH;
  if (tmpHome) fs.rmSync(tmpHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function cacheDirFor(home: string) {
  return path.join(home, ".aws/sso/cache");
}

function writeJson(dir: string, file: string, data: Record<string, unknown>) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), JSON.stringify(data));
}

async function callGet(): Promise<{ status: number; body: Record<string, unknown> }> {
  const request = new Request("http://localhost/api/oauth/kiro/auto-import");
  const response = await GET(request);
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

// ── tryAwsSsoCache() (auto-import route) ─────────────────────────────────────

test("auto-import: resolves clientId/clientSecret from a direct `clientId` field (no clientIdHash) via matching registration file", async () => {
  const cacheDir = cacheDirFor(tmpHome);

  // The token file itself: no clientIdHash, only a direct `clientId`.
  writeJson(cacheDir, "kiro-auth-token.json", {
    accessToken: "aoa-access",
    refreshToken: "aorAAAAAGrefresh-token",
    clientId: "correct-client-id",
    region: "us-east-1",
    provider: "BuilderId",
    authMethod: "IdC",
  });

  // Two STALE client registration files with a LATER expiresAt than the correct one —
  // the old latest-expiry heuristic would wrongly prefer these.
  writeJson(cacheDir, "stale-registration-1.json", {
    clientId: "stale-client-id-1",
    clientSecret: "stale-secret-1",
    region: "us-east-1",
    expiresAt: "2099-01-01T00:00:00Z",
  });
  writeJson(cacheDir, "stale-registration-2.json", {
    clientId: "stale-client-id-2",
    clientSecret: "stale-secret-2",
    region: "us-east-1",
    expiresAt: "2098-01-01T00:00:00Z",
  });

  // The registration file that actually matches the token's own clientId,
  // deliberately given the OLDEST expiry so the heuristic must lose to the match.
  writeJson(cacheDir, "correct-registration.json", {
    clientId: "correct-client-id",
    clientSecret: "correct-secret",
    region: "us-east-1",
    expiresAt: "2020-01-01T00:00:00Z",
  });

  const fetchedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    fetchedUrls.push(u);
    if (u.includes("oidc.") && u.endsWith("/token")) {
      const bodyStr = String(init?.body || "{}");
      const parsed = JSON.parse(bodyStr);
      // Refresh must be attempted with the CORRECT client credentials.
      assert.equal(parsed.clientId, "correct-client-id");
      assert.equal(parsed.clientSecret, "correct-secret");
      return new Response(
        JSON.stringify({
          accessToken: "access-refreshed",
          refreshToken: "aorAAAAAGrefreshed",
          expiresIn: 3600,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    throw new Error(`[kiro-1253 test] unexpected fetch to ${u}`);
  }) as typeof fetch;

  const { body } = await callGet();

  assert.equal(body.found, true, `expected found:true, got: ${JSON.stringify(body)}`);
  assert.equal(
    fetchedUrls.some((u) => u.includes("oidc.") && u.endsWith("/token")),
    true,
    `expected OIDC refresh to be attempted with resolved client creds, fetched: ${JSON.stringify(fetchedUrls)}`
  );
});

test("auto-import: reuses a fresh canonical IdC cache token without a network refresh", async () => {
  const cacheDir = cacheDirFor(tmpHome);
  const cacheExpiry = "2099-01-01T00:00:00.000Z";

  writeJson(cacheDir, "kiro-auth-token.json", {
    accessToken: "cached-access-token",
    refreshToken: "aorAAAAAGcached-refresh-token",
    clientId: "cached-client-id",
    region: "ap-southeast-1",
    provider: "BuilderId",
    authMethod: "IdC",
    expiresAt: cacheExpiry,
  });
  writeJson(cacheDir, "cached-client-registration.json", {
    clientId: "cached-client-id",
    clientSecret: "cached-client-secret",
    region: "ap-southeast-1",
  });

  globalThis.fetch = (async () => {
    throw new Error("a fresh canonical cache token must not trigger network I/O");
  }) as typeof fetch;

  const { body } = await callGet();
  assert.equal(body.found, true, `expected found:true, got: ${JSON.stringify(body)}`);

  const rows = await providersDb.getProviderConnections({ provider: "kiro" });
  assert.equal(rows.length, 1);
  const connection = rows[0]!;
  assert.equal(connection.accessToken, "cached-access-token");
  assert.equal(connection.refreshToken, "aorAAAAAGcached-refresh-token");
  assert.equal(
    connection.expiresAt,
    new Date(Date.parse(cacheExpiry) - 5 * 60 * 1000).toISOString(),
    "persisted expiry must retain the five-minute refresh safety margin"
  );
  assert.deepEqual(connection.providerSpecificData, {
    authMethod: "idc",
    provider: "AWS SSO Cache",
    clientId: "cached-client-id",
    clientSecret: "cached-client-secret",
    region: "ap-southeast-1",
  });
});

for (const [label, expiresAt, authMethod] of [
  ["malformed", "not-a-date", "IdC"],
  [
    "within the five-minute safety margin",
    new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    "IdC",
  ],
  ["unknown-auth", "2099-01-01T00:00:00.000Z", "unrecognized"],
] as const) {
  test(`auto-import: refreshes instead of reusing a ${label} canonical cache entry`, async () => {
    const cacheDir = cacheDirFor(tmpHome);
    writeJson(cacheDir, "kiro-auth-token.json", {
      accessToken: "stale-cached-access-token",
      refreshToken: "aorAAAAAGcache-refresh-token",
      clientId: "refresh-client-id",
      region: "us-east-1",
      provider: "BuilderId",
      authMethod,
      expiresAt,
    });
    writeJson(cacheDir, "refresh-client-registration.json", {
      clientId: "refresh-client-id",
      clientSecret: "refresh-client-secret",
      region: "us-east-1",
    });

    const fetchedUrls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchedUrls.push(url);
      if (url === "https://oidc.us-east-1.amazonaws.com/token") {
        return new Response(
          JSON.stringify({
            accessToken: "refreshed-access-token",
            refreshToken: "aorAAAAAGrefreshed-token",
            expiresIn: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`[kiro-1253 test] unexpected fetch to ${url}`);
    }) as typeof fetch;

    const { body } = await callGet();
    assert.equal(body.found, true, `expected found:true, got: ${JSON.stringify(body)}`);
    assert.deepEqual(fetchedUrls, ["https://oidc.us-east-1.amazonaws.com/token"]);

    const [connection] = await providersDb.getProviderConnections({ provider: "kiro" });
    assert.equal(connection?.accessToken, "refreshed-access-token");
  });
}

test("auto-import: does not import a noncanonical AWS SSO cache file as Kiro credentials", async () => {
  const cacheDir = cacheDirFor(tmpHome);
  writeJson(cacheDir, "amazon-q-auth-token.json", {
    accessToken: "other-provider-access-token",
    refreshToken: "aorAAAAAGother-provider-refresh-token",
    clientId: "other-provider-client-id",
    region: "us-east-1",
    authMethod: "IdC",
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  writeJson(cacheDir, "other-provider-client-registration.json", {
    clientId: "other-provider-client-id",
    clientSecret: "other-provider-client-secret",
    region: "us-east-1",
  });

  globalThis.fetch = (async () => {
    throw new Error("a noncanonical Kiro cache candidate must not trigger network I/O");
  }) as typeof fetch;

  const { body } = await callGet();
  assert.equal(body.found, false, `expected found:false, got: ${JSON.stringify(body)}`);
  assert.equal((await providersDb.getProviderConnections({ provider: "kiro" })).length, 0);
});

// ── KiroService.readCachedClientCredentials() (via validateImportToken) ─────

test("KiroService.validateImportToken: prefers the client registration matching the token's own clientId over the latest-expiry heuristic", async () => {
  const cacheDir = cacheDirFor(tmpHome);

  writeJson(cacheDir, "stale-registration-1.json", {
    clientId: "stale-client-id-1",
    clientSecret: "stale-secret-1",
    region: "us-east-1",
    expiresAt: "2099-01-01T00:00:00Z",
  });
  writeJson(cacheDir, "correct-registration.json", {
    clientId: "correct-client-id",
    clientSecret: "correct-secret",
    region: "us-east-1",
    expiresAt: "2020-01-01T00:00:00Z",
  });

  const fetchedBodies: Record<string, unknown>[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (u.includes("oidc.") && u.endsWith("/token")) {
      const parsed = JSON.parse(String(init?.body || "{}"));
      fetchedBodies.push(parsed);
      if (parsed.clientId === "correct-client-id" && parsed.clientSecret === "correct-secret") {
        return new Response(
          JSON.stringify({
            accessToken: "ok-access",
            refreshToken: "aorAAAAAGok",
            expiresIn: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ message: "Bad credentials" }), { status: 400 });
    }
    throw new Error(`[kiro-1253 test] unexpected fetch to ${u}`);
  }) as typeof fetch;

  const kiroService = new KiroService();
  const result = await kiroService.validateImportToken(
    "aorAAAAAGrefresh-token",
    "us-east-1",
    "correct-client-id"
  );

  assert.equal(result.accessToken, "ok-access");
  assert.ok(
    fetchedBodies.some(
      (b) => b.clientId === "correct-client-id" && b.clientSecret === "correct-secret"
    ),
    `expected a refresh attempt using the matching client credentials, got: ${JSON.stringify(fetchedBodies)}`
  );
});
