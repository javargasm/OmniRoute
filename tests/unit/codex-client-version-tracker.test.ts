import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CodexModelsFetch } from "../../src/app/api/providers/[id]/models/discovery/codex.ts";
import type { CodexClientVersionFetch } from "../../src/shared/services/codexClientVersionTracker.ts";

// Persistence goes through the injected seam, so nothing here should touch the
// settings DB — this only guarantees a stray default could never hit the real one.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-client-version-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const codexClient = await import("../../open-sse/config/codexClient.ts");
const tracker = await import("../../src/shared/services/codexClientVersionTracker.ts");
const codexDiscovery = await import("../../src/app/api/providers/[id]/models/discovery/codex.ts");

const REGISTRY_URL = "https://registry.npmjs.org/@openai/codex/latest";
const TTL_MS = tracker.CODEX_CLIENT_VERSION_CHECK_TTL_MS;
const FLOOR = codexClient.DEFAULT_CODEX_CLIENT_VERSION;
// Derived from the built-in floor so a routine floor bump keeps these meaningful.
// Against today's 0.154.0 floor: 0.155.0 gates gpt-6-sol/luna, npm publishes 0.156.0.
const [floorMajor, floorMinor] = FLOOR.split(".").map(Number);
const versionAboveFloor = (minorOffset: number) => `${floorMajor}.${floorMinor + minorOffset}.0`;
const GATED_VERSION = versionAboveFloor(1);
const PUBLISHED_VERSION = versionAboveFloor(2);
const NEWER_PUBLISHED_VERSION = versionAboveFloor(3);
const BELOW_FLOOR_VERSION = "0.1.0";
const userAgentFor = (version: string) => `codex-cli/${version} (Windows 10.0.26200; x64)`;

const ENV_KEYS = ["CODEX_CLIENT_VERSION", "CODEX_USER_AGENT"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

type RegistryCall = Parameters<CodexClientVersionFetch>;

function createRegistryFetch(respond: () => Response | Promise<Response>) {
  const calls: RegistryCall[] = [];
  const fetchImpl: CodexClientVersionFetch = async (url, init) => {
    calls.push([url, init]);
    return respond();
  };
  return { calls, fetchImpl };
}

function createMemoryStore(stored?: unknown) {
  const store = { reads: 0, writes: [] as string[] };
  const deps = {
    readStoredVersion: async () => {
      store.reads += 1;
      return stored;
    },
    writeStoredVersion: async (version: string) => {
      store.writes.push(version);
    },
  };
  return { store, deps };
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const versionGatedCatalog = {
  models: [
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6 Astra",
      visibility: "list",
      supported_in_api: true,
      minimal_client_version: FLOOR,
    },
    {
      slug: "gpt-6-sol",
      display_name: "GPT-6 Sol",
      visibility: "list",
      supported_in_api: true,
      minimal_client_version: GATED_VERSION,
    },
  ],
};

function modelIds(models: Array<{ id: string }> | null) {
  return (models || []).map((model) => model.id);
}

test.beforeEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  tracker.__resetCodexClientVersionTrackerForTests();
  codexDiscovery.clearCodexGithubCatalogCacheForTests();
});

test.after(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  tracker.__resetCodexClientVersionTrackerForTests();
  codexDiscovery.clearCodexGithubCatalogCacheForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── effective version ───────────────────────────────────────────────────────

test("getCodexClientVersion uses the built-in floor when nothing is tracked", () => {
  assert.equal(codexClient.getTrackedCodexClientVersion(), null);
  assert.equal(codexClient.isCodexClientVersionPinnedByEnv(), false);
  assert.equal(codexClient.getCodexClientVersion(), FLOOR);
});

test("a tracked version above the floor wins and one below never lowers it", () => {
  codexClient.setTrackedCodexClientVersion(PUBLISHED_VERSION);
  assert.equal(codexClient.getCodexClientVersion(), PUBLISHED_VERSION);

  codexClient.setTrackedCodexClientVersion(BELOW_FLOOR_VERSION);
  assert.equal(codexClient.getTrackedCodexClientVersion(), BELOW_FLOOR_VERSION);
  assert.equal(codexClient.getCodexClientVersion(), FLOOR);

  codexClient.setTrackedCodexClientVersion(null);
  assert.equal(codexClient.getTrackedCodexClientVersion(), null);
  assert.equal(codexClient.getCodexClientVersion(), FLOOR);
});

test("a valid CODEX_CLIENT_VERSION pin wins even when lower; an invalid one is ignored", () => {
  codexClient.setTrackedCodexClientVersion(PUBLISHED_VERSION);

  process.env.CODEX_CLIENT_VERSION = "0.99.0";
  assert.equal(codexClient.isCodexClientVersionPinnedByEnv(), true);
  assert.equal(codexClient.getCodexClientVersion(), "0.99.0");
  assert.equal(codexClient.getCodexUserAgent(), userAgentFor("0.99.0"));

  process.env.CODEX_CLIENT_VERSION = "bad version value";
  assert.equal(codexClient.isCodexClientVersionPinnedByEnv(), false);
  assert.equal(codexClient.getCodexClientVersion(), PUBLISHED_VERSION);
});

test("setTrackedCodexClientVersion ignores prereleases, garbage and header injection", () => {
  codexClient.setTrackedCodexClientVersion(PUBLISHED_VERSION);

  for (const candidate of [
    `${NEWER_PUBLISHED_VERSION}-alpha.1`,
    `${NEWER_PUBLISHED_VERSION}+build.7`,
    `v${NEWER_PUBLISHED_VERSION}`,
    `${NEWER_PUBLISHED_VERSION} `,
    "0.157",
    "latest",
    "",
    `${NEWER_PUBLISHED_VERSION}\r\nX-Injected: 1`,
    `${"9".repeat(40)}.0.0`,
  ]) {
    codexClient.setTrackedCodexClientVersion(candidate);
    assert.equal(
      codexClient.getTrackedCodexClientVersion(),
      PUBLISHED_VERSION,
      `rejects ${JSON.stringify(candidate)}`
    );
  }
});

test("compareCodexClientVersions compares numerically and treats unparsable input as equal", () => {
  assert.ok(codexClient.compareCodexClientVersions("0.155.0", "0.154.0") > 0);
  assert.ok(codexClient.compareCodexClientVersions("0.99.0", "0.154.0") < 0);
  assert.equal(codexClient.compareCodexClientVersions("0.154", "0.154.0"), 0);
  assert.equal(codexClient.compareCodexClientVersions("0.155.0-alpha.1", "0.154.0"), 0);
  assert.equal(codexClient.compareCodexClientVersions("0.154.0", "garbage"), 0);
});

// ── registry refresh ────────────────────────────────────────────────────────

test("refresh applies a newer published Codex CLI version, persists it and logs once", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const { store, deps } = createMemoryStore();
  const { calls, fetchImpl } = createRegistryFetch(() =>
    Response.json({ name: "@openai/codex", version: PUBLISHED_VERSION })
  );

  const result = await tracker.refreshCodexClientVersion({ fetchImpl, deps });

  assert.deepEqual(result, { version: PUBLISHED_VERSION, changed: true });
  assert.equal(tracker.CODEX_CLIENT_VERSION_REGISTRY_URL, REGISTRY_URL);
  assert.deepEqual(calls, [
    [REGISTRY_URL, { method: "GET", headers: { Accept: "application/json" } }],
  ]);
  assert.equal(codexClient.getTrackedCodexClientVersion(), PUBLISHED_VERSION);
  assert.equal(codexClient.getCodexClientVersion(), PUBLISHED_VERSION);
  assert.deepEqual(store.writes, [PUBLISHED_VERSION]);
  assert.equal(codexClient.getCodexUserAgent(), userAgentFor(PUBLISHED_VERSION));
  assert.equal(codexClient.getCodexDefaultHeaders().Version, PUBLISHED_VERSION);
  assert.equal(codexClient.getCodexDefaultHeaders()["User-Agent"], userAgentFor(PUBLISHED_VERSION));
  assert.equal(
    codexClient.getCodexCliRsHeaders()["User-Agent"],
    `codex_cli_rs/${PUBLISHED_VERSION}`
  );
  assert.deepEqual(
    log.mock.calls.map((call) => call.arguments),
    [[`[CodexClientVersion] Tracking Codex CLI ${PUBLISHED_VERSION} (was ${FLOOR})`]]
  );
});

test("refresh re-checks the registry only after the TTL unless forced", async (t) => {
  t.mock.method(console, "log", () => {});
  const { deps } = createMemoryStore();
  let published = PUBLISHED_VERSION;
  const { calls, fetchImpl } = createRegistryFetch(() => Response.json({ version: published }));
  const start = 1_000_000;

  await tracker.refreshCodexClientVersion({ fetchImpl, now: start, deps });
  published = NEWER_PUBLISHED_VERSION;
  const withinTtl = await tracker.refreshCodexClientVersion({
    fetchImpl,
    now: start + TTL_MS - 1,
    deps,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(withinTtl, { version: PUBLISHED_VERSION, changed: false });

  const afterTtl = await tracker.refreshCodexClientVersion({
    fetchImpl,
    now: start + TTL_MS,
    deps,
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(afterTtl, { version: NEWER_PUBLISHED_VERSION, changed: true });

  await tracker.refreshCodexClientVersion({
    fetchImpl,
    now: start + TTL_MS + 1,
    force: true,
    deps,
  });
  assert.equal(calls.length, 3);
});

test("concurrent refresh calls share one registry request", async (t) => {
  t.mock.method(console, "log", () => {});
  const { store, deps } = createMemoryStore();
  const registry = createDeferred<Response>();
  const { calls, fetchImpl } = createRegistryFetch(() => registry.promise);

  const pending = Array.from({ length: 6 }, () =>
    tracker.refreshCodexClientVersion({ fetchImpl, now: 1_000, deps })
  );
  // Let every caller reach the shared in-flight check before the registry answers.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);

  registry.resolve(Response.json({ version: PUBLISHED_VERSION }));
  const results = await Promise.all(pending);

  assert.equal(calls.length, 1);
  for (const result of results) {
    assert.deepEqual(result, { version: PUBLISHED_VERSION, changed: true });
  }
  assert.deepEqual(store.writes, [PUBLISHED_VERSION]);
});

const REGISTRY_FAILURES: Array<[label: string, respond: () => Promise<Response>]> = [
  ["HTTP 500", async () => new Response("registry unavailable", { status: 500 })],
  [
    "fetch throws",
    async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    },
  ],
  [
    "invalid JSON body",
    async () =>
      new Response("<html>not json</html>", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ],
  ["manifest without a version", async () => Response.json({ name: "@openai/codex" })],
  [
    "prerelease version",
    async () => Response.json({ version: `${NEWER_PUBLISHED_VERSION}-alpha.1` }),
  ],
];

for (const [label, respond] of REGISTRY_FAILURES) {
  test(`refresh keeps the current version when the registry check fails (${label})`, async () => {
    codexClient.setTrackedCodexClientVersion(PUBLISHED_VERSION);
    const { store, deps } = createMemoryStore();
    const { calls, fetchImpl } = createRegistryFetch(respond);

    const result = await tracker.refreshCodexClientVersion({ fetchImpl, now: 5_000, deps });

    assert.deepEqual(result, { version: PUBLISHED_VERSION, changed: false });
    assert.equal(codexClient.getTrackedCodexClientVersion(), PUBLISHED_VERSION);
    assert.deepEqual(store.writes, []);
    // A failed check still backs off for the TTL instead of hammering the registry.
    await tracker.refreshCodexClientVersion({ fetchImpl, now: 5_000 + TTL_MS - 1, deps });
    assert.equal(calls.length, 1);
  });
}

test("refresh tracks a published version below the floor without changing or persisting anything", async () => {
  const { store, deps } = createMemoryStore();
  const { fetchImpl } = createRegistryFetch(() => Response.json({ version: BELOW_FLOOR_VERSION }));

  const result = await tracker.refreshCodexClientVersion({ fetchImpl, deps });

  assert.deepEqual(result, { version: FLOOR, changed: false });
  assert.equal(codexClient.getTrackedCodexClientVersion(), BELOW_FLOOR_VERSION);
  assert.deepEqual(store.writes, []);
});

test("refresh swallows persistence errors and keeps the new version in memory", async (t) => {
  t.mock.method(console, "log", () => {});
  const { fetchImpl } = createRegistryFetch(() => Response.json({ version: PUBLISHED_VERSION }));

  const result = await tracker.refreshCodexClientVersion({
    fetchImpl,
    deps: {
      readStoredVersion: async () => undefined,
      writeStoredVersion: async () => {
        throw new Error("database is locked");
      },
    },
  });

  assert.deepEqual(result, { version: PUBLISHED_VERSION, changed: true });
  assert.equal(codexClient.getCodexClientVersion(), PUBLISHED_VERSION);
});

test("an explicit CODEX_CLIENT_VERSION pin disables registry tracking entirely", async () => {
  process.env.CODEX_CLIENT_VERSION = "0.99.0";
  const { store, deps } = createMemoryStore(PUBLISHED_VERSION);
  const { calls, fetchImpl } = createRegistryFetch(() =>
    Response.json({ version: NEWER_PUBLISHED_VERSION })
  );

  const result = await tracker.refreshCodexClientVersion({ fetchImpl, force: true, deps });

  assert.deepEqual(result, { version: "0.99.0", changed: false });
  assert.equal(calls.length, 0);
  assert.equal(store.reads, 0);
  assert.deepEqual(store.writes, []);
});

// ── hydration ───────────────────────────────────────────────────────────────

test("hydrate applies a valid stored version and runs only once per process", async () => {
  const first = createMemoryStore(PUBLISHED_VERSION);
  await tracker.hydrateCodexClientVersionFromSettings(first.deps);
  assert.equal(codexClient.getTrackedCodexClientVersion(), PUBLISHED_VERSION);
  assert.equal(codexClient.getCodexClientVersion(), PUBLISHED_VERSION);

  const second = createMemoryStore(NEWER_PUBLISHED_VERSION);
  await tracker.hydrateCodexClientVersionFromSettings(second.deps);
  assert.equal(first.store.reads, 1);
  assert.equal(second.store.reads, 0);
  assert.equal(codexClient.getTrackedCodexClientVersion(), PUBLISHED_VERSION);
});

test("hydrate ignores invalid stored values and read failures", async () => {
  for (const stored of [`${PUBLISHED_VERSION}-beta.1`, "latest", 157, null, undefined, {}]) {
    tracker.__resetCodexClientVersionTrackerForTests();
    await tracker.hydrateCodexClientVersionFromSettings(createMemoryStore(stored).deps);
    assert.equal(codexClient.getTrackedCodexClientVersion(), null, `ignores ${String(stored)}`);
    assert.equal(codexClient.getCodexClientVersion(), FLOOR);
  }

  tracker.__resetCodexClientVersionTrackerForTests();
  await assert.doesNotReject(
    tracker.hydrateCodexClientVersionFromSettings({
      readStoredVersion: async () => {
        throw new Error("settings table unavailable");
      },
    })
  );
  assert.equal(codexClient.getTrackedCodexClientVersion(), null);
});

test("hydrate never overrides a version already learned in this process", async () => {
  codexClient.setTrackedCodexClientVersion(NEWER_PUBLISHED_VERSION);
  await tracker.hydrateCodexClientVersionFromSettings(createMemoryStore(PUBLISHED_VERSION).deps);
  assert.equal(codexClient.getTrackedCodexClientVersion(), NEWER_PUBLISHED_VERSION);
});

test("refresh hydrates first, so an unchanged version is not re-persisted after a restart", async (t) => {
  const log = t.mock.method(console, "log", () => {});
  const { store, deps } = createMemoryStore(PUBLISHED_VERSION);
  const { calls, fetchImpl } = createRegistryFetch(() =>
    Response.json({ version: PUBLISHED_VERSION })
  );

  const result = await tracker.refreshCodexClientVersion({ fetchImpl, deps });

  assert.deepEqual(result, { version: PUBLISHED_VERSION, changed: false });
  assert.equal(calls.length, 1);
  assert.equal(store.reads, 1);
  assert.deepEqual(store.writes, []);
  assert.equal(log.mock.callCount(), 0);
});

// ── Codex discovery ─────────────────────────────────────────────────────────

test("Codex discovery imports a version-gated model once a newer CLI version is tracked", () => {
  assert.deepEqual(modelIds(codexDiscovery.normalizeCodexModelsResponse(versionGatedCatalog)), [
    "gpt-6-astra",
  ]);

  codexClient.setTrackedCodexClientVersion(PUBLISHED_VERSION);

  assert.deepEqual(modelIds(codexDiscovery.normalizeCodexModelsResponse(versionGatedCatalog)), [
    "gpt-6-astra",
    "gpt-6-sol",
  ]);
  assert.equal(
    codexDiscovery.buildCodexModelsUrl(),
    `https://chatgpt.com/backend-api/codex/models?client_version=${PUBLISHED_VERSION}`
  );
});

test("Codex GitHub catalog cache is a miss once the tracked client version moves", async () => {
  const ifNoneMatch: Array<string | undefined> = [];
  const fetchImpl: CodexModelsFetch = async (_url, init) => {
    ifNoneMatch.push(init.headers["If-None-Match"]);
    return Response.json(versionGatedCatalog, { headers: { etag: "catalog-v1" } });
  };

  const atFloor = await codexDiscovery.fetchCodexGithubCatalogModels({
    fetchImpl,
    now: 1_000,
    cacheTtlMs: 60_000,
  });
  assert.deepEqual(modelIds(atFloor), ["gpt-6-astra"]);

  codexClient.setTrackedCodexClientVersion(PUBLISHED_VERSION);
  const afterTracking = await codexDiscovery.fetchCodexGithubCatalogModels({
    fetchImpl,
    now: 2_000,
    cacheTtlMs: 60_000,
  });
  assert.deepEqual(modelIds(afterTracking), ["gpt-6-astra", "gpt-6-sol"]);
  // Unconditional re-fetch: no If-None-Match that could revive the stale list.
  assert.deepEqual(ifNoneMatch, [undefined, undefined]);

  let cacheMisses = 0;
  const cached = await codexDiscovery.fetchCodexGithubCatalogModels({
    fetchImpl: async () => {
      cacheMisses += 1;
      throw new Error("cache hit should not fetch");
    },
    now: 3_000,
    cacheTtlMs: 60_000,
  });
  assert.equal(cacheMisses, 0);
  assert.deepEqual(modelIds(cached), ["gpt-6-astra", "gpt-6-sol"]);
});

test("a 304 cannot revive a GitHub catalog filtered for an older client version", async () => {
  await codexDiscovery.fetchCodexGithubCatalogModels({
    fetchImpl: async () => Response.json(versionGatedCatalog, { headers: { etag: "catalog-v1" } }),
    now: 1_000,
    cacheTtlMs: 60_000,
  });

  codexClient.setTrackedCodexClientVersion(PUBLISHED_VERSION);
  const notModified = await codexDiscovery.fetchCodexGithubCatalogModels({
    fetchImpl: async () => new Response(null, { status: 304 }),
    now: 2_000,
    cacheTtlMs: 60_000,
  });

  assert.equal(notModified, null);
});
