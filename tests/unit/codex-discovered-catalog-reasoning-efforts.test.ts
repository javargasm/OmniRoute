// Codex keeps discovered reasoning levels off synced catalog capabilities (#7694), so a
// model without a registry entry (gpt-6.1-sol) reached /v1/models with no effort selector
// for catalog clients such as Grok Build. The catalog must publish the levels Codex
// discovery declared and stored for that model.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-catalog-efforts-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "catalog-test-secret";

const core = await import("../../src/lib/db/core.ts");
const apiKeysDb = await import("../../src/lib/db/apiKeys.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const v1ModelsCatalog = await import("../../src/app/api/v1/models/catalog.ts");
const reasoningSuffix = await import("../../open-sse/executors/codex/reasoningSuffix.ts");
const reasoningLevelsHydration = await import("../../src/shared/services/codexReasoningLevels.ts");

const SOL_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];

type CatalogEntry = {
  id: string;
  supports_reasoning_effort?: boolean;
  reasoning_efforts?: string[];
};

function resetStorage() {
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

test.beforeEach(() => {
  resetStorage();
  v1ModelsCatalog.__resetCatalogBuilderRunsForTest();
  reasoningSuffix.__resetCodexReasoningLevelsForTests();
  reasoningLevelsHydration.__resetCodexReasoningLevelsHydrationForTests();
});

test.after(() => {
  reasoningSuffix.__resetCodexReasoningLevelsForTests();
  reasoningLevelsHydration.__resetCodexReasoningLevelsHydrationForTests();
  core.resetDbInstance();
  apiKeysDb.resetApiKeyState();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Mirrors the rows Codex discovery persists: the base model carries its declared levels and
// the synthesized fixed-effort variants do not.
async function seedCodexCatalog() {
  const connection = await providersDb.createProviderConnection({
    provider: "codex",
    authType: "oauth",
    name: "codex-discovered-efforts",
    accessToken: "codex-access-token",
    isActive: true,
    testStatus: "active",
  });
  const responsesModel = {
    source: "imported",
    apiFormat: "responses",
    supportedEndpoints: ["responses"],
    supportsThinking: true,
  };
  await modelsDb.replaceSyncedAvailableModelsForConnection("codex", connection.id, [
    {
      ...responsesModel,
      id: "gpt-6.1-sol",
      name: "GPT-6.1-Sol",
      supportsVision: true,
      supportedThinkingEfforts: SOL_LEVELS,
    },
    { ...responsesModel, id: "gpt-6.1-sol-max", name: "GPT-6.1-Sol (Max)" },
    { ...responsesModel, id: "future-codex-model", name: "Future Codex Model" },
  ]);
}

async function getCatalog(): Promise<Map<string, CatalogEntry>> {
  const response = await v1ModelsCatalog.getUnifiedModelsResponse(
    new Request("http://localhost/api/v1/models")
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { data?: CatalogEntry[] };
  return new Map((body.data || []).map((entry) => [entry.id, entry]));
}

test("/v1/models publishes stored Codex reasoning levels for a model without a registry entry", async () => {
  await seedCodexCatalog();

  const base = (await getCatalog()).get("cx/gpt-6.1-sol");

  assert.ok(base, "cx/gpt-6.1-sol must be listed");
  assert.equal(base.supports_reasoning_effort, true);
  assert.deepEqual(base.reasoning_efforts, SOL_LEVELS);
});

test("fixed-effort variants and models without declared levels get no effort selector", async () => {
  await seedCodexCatalog();

  const catalog = await getCatalog();
  const variant = catalog.get("cx/gpt-6.1-sol-max");
  const undeclared = catalog.get("cx/future-codex-model");

  assert.ok(variant, "cx/gpt-6.1-sol-max must be listed");
  assert.equal(variant.supports_reasoning_effort, undefined);
  assert.ok(undeclared, "cx/future-codex-model must be listed");
  assert.equal(undeclared.supports_reasoning_effort, undefined);
});
