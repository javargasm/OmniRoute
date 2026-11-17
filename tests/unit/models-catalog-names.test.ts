import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-catalog-names-"));
process.env.DATA_DIR = DATA_DIR;
process.env.API_KEY_SECRET = "catalog-names-test-secret";
process.env.CATALOG_BUILD_TIMEOUT_MS = "60000";

const core = await import("../../src/lib/db/core.ts");
const providers = await import("../../src/lib/db/providers.ts");
const models = await import("../../src/lib/db/models.ts");
const combos = await import("../../src/lib/db/combos.ts");
const flags = await import("../../src/lib/db/featureFlags.ts");
const settings = await import("../../src/lib/db/settings.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");
const kiro = await import("../../open-sse/services/kiroModels.ts");

const NODE_ID = "openai-compatible-chat-550e8400-e29b-41d4-a716-446655440001";
type Entry = { id: string; name?: string; display_name?: string };

async function seed() {
  await settings.updateSettings({ hideAutoCombos: true });
  const connection = await providers.createProviderConnection({
    provider: "kiro",
    authType: "oauth",
    name: "Kiro",
    accessToken: "test",
    isActive: true,
    testStatus: "active",
  });
  await models.replaceSyncedAvailableModelsForConnection("kiro", connection.id, [
    {
      id: "claude-opus-5.5",
      name: "Kiro claude-opus-5.5 (2.0x credit)",
      supportsThinking: true,
      supportedThinkingEfforts: ["low", "max"],
    },
    { id: "claude-sonnet-4.6", name: "Kiro Claude Sonnet 4.6" },
  ]);
  await models.setModelAlias("claude-opus-5.5", "kr/claude-opus-5.5");
  await providers.createProviderNode({
    id: NODE_ID,
    type: "openai-compatible",
    name: "Gemini",
    prefix: "tx",
    baseUrl: "https://example.com",
    chatPath: "/v1/chat/completions",
    modelsPath: "/v1/models",
  });
  const gemini = await providers.createProviderConnection({
    provider: NODE_ID,
    authType: "apikey",
    name: "Gemini",
    apiKey: "test",
    isActive: true,
    testStatus: "active",
  });
  await models.replaceSyncedAvailableModelsForConnection(NODE_ID, gemini.id, [
    { id: "gemini-3.1-pro-high", name: "upstream-id" },
    {
      id: "future-model",
      name: "Discovered Future Model",
      supportsThinking: true,
      supportedThinkingEfforts: ["low", "high"],
    },
  ]);
  await models.setModelAlias("Gemini 3.1 Pro High", `${NODE_ID}/gemini-3.1-pro-high`);
  await models.setModelAlias("generated-future", `${NODE_ID}/future-model`);
  await models.markManagedModelAlias("generated-future");
  await models.addCustomModel(NODE_ID, "custom-model", "Custom Model");
  await combos.createCombo({
    name: "combo-test",
    displayName: "Friendly Combo",
    models: [{ model: "kr/claude-opus-5.5", providerId: "kiro" }],
  });
}

async function list(prefix = "alias", apiKey?: string): Promise<Map<string, Entry>> {
  const response = await catalog.getUnifiedModelsResponse(
    new Request(`http://localhost/api/v1/models?prefix=${prefix}`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    })
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data: Entry[] };
  assert.equal(new Set(body.data.map((entry) => entry.id)).size, body.data.length);
  return new Map(body.data.map((entry) => [entry.id, entry]));
}

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  catalog.__resetCatalogBuilderRunsForTest();
  kiro.clearKiroModelCache();
});
test.after(() => {
  core.resetDbInstance();
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

test("stored Kiro names normalize before effort and no-thinking variants", async () => {
  await seed();
  const entries = await list();
  assert.equal(entries.get("kr/claude-opus-5.5")?.name, "Claude Opus 5.5 (x2.0)");
  assert.equal(entries.get("kr/claude-opus-5.5-max")?.name, "Claude Opus 5.5 (x2.0) (Max)");
  assert.equal(
    entries.get("no-think/kr/claude-sonnet-4.6")?.name,
    "Claude Sonnet 4.6 (no thinking)"
  );
});

test("Gemini dashboard aliases resolve node UUIDs in every prefix mode", async () => {
  await seed();
  for (const prefix of ["alias", "canonical", "dual"]) {
    const entries = await list(prefix);
    assert.equal(entries.get("tx/gemini-3.1-pro-high")?.name, "Gemini 3.1 Pro High");
    assert.equal(entries.get("tx/future-model")?.name, "Discovered Future Model");
    assert.equal(entries.get("tx/future-model-high")?.name, "Discovered Future Model (High)");
    assert.equal(entries.get("tx/custom-model")?.name, "Custom Model");
    assert.equal(entries.get("combo-test")?.name, "Friendly Combo");
  }
});

test("manual aliases override discovered names and preserve routing IDs", async () => {
  await seed();
  await models.setModelAlias("My Opus", "kiro/claude-opus-5.5");
  const entries = await list();
  assert.equal(entries.get("kr/claude-opus-5.5")?.name, "My Opus");
  assert.equal(entries.get("kr/claude-opus-5.5-max")?.name, "My Opus (Max)");
  assert.equal(entries.has("My Opus"), false);
});

test("names feature flag removes published names without changing IDs", async () => {
  await seed();
  const withNames = await list();
  flags.setFeatureFlagOverride("MODEL_CATALOG_INCLUDE_NAMES", "false");
  const withoutNames = await list();
  assert.deepEqual([...withoutNames.keys()], [...withNames.keys()]);
  for (const entry of withoutNames.values()) assert.equal(entry.name, undefined);
});

test("new Kiro discovery publishes human names with compact credit multipliers", async () => {
  const result = await kiro.fetchKiroAvailableModels({
    accessToken: "test",
    providerSpecificData: {},
    fallbackModels: [],
    fetchImpl: async () =>
      Response.json({
        models: [
          { modelId: "claude-opus-5.5", modelName: "claude-opus-5.5", rateMultiplier: 2 },
          { modelId: "claude-sonnet-4.6", modelName: "Claude Sonnet 4.6", rateMultiplier: 1 },
          { modelId: "gpt-5.6-sol", modelName: "gpt-5.6-sol", rateMultiplier: 1 },
        ],
      }),
  });
  assert.equal(result.models[0].name, "Claude Opus 5.5 (x2.0)");
  assert.equal(result.models[1].name, "Claude Sonnet 4.6");
  assert.equal(result.models[2].name, "GPT-5.6 Sol");
});

test("qualified routing aliases preserve friendly Kiro names", async () => {
  await seed();
  await models.setModelAlias("kr/claude-sonnet-4.6", "kiro/claude-sonnet-4.6");
  assert.equal((await list()).get("kr/claude-sonnet-4.6")?.name, "kr/Claude Sonnet 4.6");
});

test("custom Kiro labels survive registry fallback", async () => {
  await seed();
  await models.addCustomModel("kiro", "claude-sonnet-4.6", "My Custom Sonnet");
  assert.equal((await list()).get("kr/claude-sonnet-4.6")?.name, "My Custom Sonnet");
});

test("aliases match public model IDs when upstream root has a provider path", async () => {
  const { applyCatalogModelNames } = await import("../../src/app/api/v1/models/catalogNames.ts");
  const entries = await applyCatalogModelNames(
    [
      {
        id: "fw/deepseek-v4-flash",
        owned_by: "fireworks",
        root: "accounts/fireworks/models/deepseek-v4-flash",
      },
    ],
    { fw: "fireworks" },
    {},
    { "My DeepSeek": "fireworks/deepseek-v4-flash" }
  );
  assert.equal(entries[0].name, "My DeepSeek");
});

test("manual aliases retain meaningful suffixes after a model ID", async () => {
  await seed();
  await models.setModelAlias("claude-sonnet-4.6-work", "kiro/claude-sonnet-4.6");
  assert.equal((await list()).get("kr/claude-sonnet-4.6")?.name, "claude-sonnet-4.6-work");
});

test("default routing aliases preserve friendly registry labels", async () => {
  const { applyCatalogModelNames } = await import("../../src/app/api/v1/models/catalogNames.ts");
  const entries = await applyCatalogModelNames(
    [
      {
        id: "gemini/gemini-3.1-flash-lite",
        owned_by: "gemini",
        root: "gemini-3.1-flash-lite",
        name: "Gemini 3.1 Flash Lite",
      },
    ],
    {},
    {},
    { "gemini-3.1-flash-lite-preview": "gemini/gemini-3.1-flash-lite" }
  );
  assert.equal(entries[0].name, "Gemini 3.1 Flash Lite");
});

test("raw public labels use registry names when root contains an upstream path", async () => {
  const { applyCatalogModelNames } = await import("../../src/app/api/v1/models/catalogNames.ts");
  const entries = await applyCatalogModelNames(
    [
      {
        id: "fw/deepseek-v4-flash",
        owned_by: "fireworks",
        root: "accounts/fireworks/models/deepseek-v4-flash",
        name: "deepseek-v4-flash",
      },
    ],
    { fw: "fireworks" },
    {},
    {}
  );
  assert.equal(entries[0].name, "DeepSeek V4 Flash");
});

test("combo display names remain identical when provider names collide", async () => {
  await seed();
  await models.addCustomModel(NODE_ID, "collision-model", "Friendly Combo");
  await combos.createCombo({
    name: "team/combo",
    displayName: "Friendly Combo",
    models: [{ model: "kr/claude-opus-5.5", providerId: "kiro" }],
  });
  const entry = (await list()).get("team/combo");
  assert.equal(entry?.name, entry?.display_name);
});

test("dashboard catalog shares friendly names with the public catalog", async () => {
  await seed();
  const { GET } = await import("../../src/app/api/models/catalog/route.ts");
  const response = await GET(new Request("http://localhost/api/models/catalog?prefix=alias"));
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    catalog: Record<string, { models: Entry[] }>;
  };
  const dashboard = new Map(
    Object.values(body.catalog).flatMap((bucket) => bucket.models.map((entry) => [entry.id, entry]))
  );
  const published = await list();
  for (const id of ["kr/claude-opus-5.5", "tx/gemini-3.1-pro-high", "combo-test"]) {
    assert.equal(dashboard.get(id)?.name, published.get(id)?.name);
  }
});

test("friendly names preserve API key model restrictions", async () => {
  await seed();
  const { createApiKey } = await import("../../src/lib/db/apiKeys.ts");
  const key = await createApiKey("names restricted", "catalog-names-test", [], {
    modelAccessMode: "restricted",
    allowedModels: ["tx/gemini-3.1-pro-high"],
    allowedCombos: [],
  });
  const entries = await list("alias", key.key);
  assert.deepEqual([...entries.keys()], ["tx/gemini-3.1-pro-high"]);
  assert.equal(entries.get("tx/gemini-3.1-pro-high")?.name, "Gemini 3.1 Pro High");
});

test("hidden models and variants stay absent after naming", async () => {
  await seed();
  models.setModelIsHidden("kiro", "claude-opus-5.5", true, "chat");
  const entries = await list();
  assert.equal(
    [...entries.keys()].some((id) => id.includes("claude-opus-5.5")),
    false
  );
});
