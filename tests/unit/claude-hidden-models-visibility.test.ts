import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-claude-hidden-"));
process.env.DATA_DIR = TEST_DATA_DIR;
process.env.API_KEY_SECRET = process.env.API_KEY_SECRET || "claude-hidden-models-test-secret";

const core = await import("../../src/lib/db/core.ts");
const modelsDb = await import("../../src/lib/db/models.ts");
const providersDb = await import("../../src/lib/db/providers.ts");
const modelsRoute = await import("../../src/app/api/models/route.ts");
const v1betaModelsRoute = await import("../../src/app/api/v1beta/models/route.ts");
const catalog = await import("../../src/app/api/v1/models/catalog.ts");
const { isProviderModelHidden, parseHiddenModelsByProvider } =
  await import("../../src/shared/components/modelSelectModalHelpers.ts");

test.beforeEach(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
  catalog.__resetCatalogBuilderRunsForTest();
});

test.after(() => {
  core.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("hiding models on claude excludes them from /api/models, /v1beta/models, and /v1/models", async () => {
  const conn = await providersDb.createProviderConnection({
    provider: "claude",
    authType: "oauth",
    name: "claude-main",
    accessToken: "sk-ant-oat01-test",
    isActive: true,
  });

  await modelsDb.replaceSyncedAvailableModelsForConnection("claude", conn.id, [
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", source: "imported" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", source: "imported" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7", source: "imported" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1", source: "imported" },
  ]);

  modelsDb.setModelIsHidden("claude", "claude-opus-4-7", true, "chat");
  modelsDb.setModelIsHidden("claude", "claude-fable-5-1", true, "chat");

  const apiModelsRes = await modelsRoute.GET(new Request("http://localhost/api/models"));
  assert.equal(apiModelsRes.status, 200);
  const apiModelsBody = (await apiModelsRes.json()) as {
    models: Array<{ provider: string; model: string; fullModel: string; available: boolean }>;
  };
  const ccModels = apiModelsBody.models.filter((m) => m.provider === "cc");
  assert.equal(
    ccModels.some((m) => m.model === "claude-opus-4-7"),
    false,
    "/api/models must exclude hidden claude-opus-4-7"
  );
  assert.equal(
    ccModels.some((m) => m.model === "claude-fable-5-1"),
    false,
    "/api/models must exclude hidden claude-fable-5-1"
  );
  assert.equal(
    ccModels.some((m) => m.model === "claude-opus-5-5" && m.available),
    true,
    "/api/models must keep visible claude-opus-5-5"
  );

  const includeHiddenRes = await modelsRoute.GET(
    new Request("http://localhost/api/models?includeHidden=1")
  );
  assert.equal(includeHiddenRes.status, 200);
  const includeHiddenBody = (await includeHiddenRes.json()) as {
    models: Array<{ provider: string; model: string }>;
  };
  assert.equal(
    includeHiddenBody.models.some((m) => m.provider === "cc" && m.model === "claude-opus-4-7"),
    true,
    "/api/models?includeHidden=1 retains hidden rows when explicitly requested"
  );

  const v1betaRes = await v1betaModelsRoute.GET(new Request("http://localhost/v1beta/models"));
  assert.equal(v1betaRes.status, 200);
  const v1betaBody = (await v1betaRes.json()) as { models: Array<{ name: string }> };
  const v1betaNames = v1betaBody.models.map((m) => m.name);
  assert.equal(
    v1betaNames.some((n) => n.endsWith("/claude-opus-4-7")),
    false,
    "/v1beta/models must exclude hidden claude-opus-4-7"
  );
  assert.equal(
    v1betaNames.some((n) => n.endsWith("/claude-fable-5-1")),
    false,
    "/v1beta/models must exclude hidden claude-fable-5-1"
  );
  assert.equal(
    v1betaNames.some((n) => n.endsWith("/claude-opus-5-5")),
    true,
    "/v1beta/models must retain visible claude-opus-5-5"
  );

  const v1Res = await catalog.getUnifiedModelsResponse(new Request("http://localhost/v1/models"));
  assert.equal(v1Res.status, 200);
  const v1Body = (await v1Res.json()) as { data: Array<{ id: string; owned_by?: string }> };
  const v1ClaudeIds = v1Body.data.filter((m) => m.owned_by === "claude").map((m) => m.id);
  assert.equal(
    v1ClaudeIds.some((id) => id.includes("claude-opus-4-7") || id.includes("claude-fable-5-1")),
    false,
    "/v1/models must exclude hidden claude models"
  );
  assert.equal(v1ClaudeIds.includes("cc/claude-opus-5-5"), true);
});

test("isProviderModelHidden matches both canonical provider id and alias", () => {
  const hiddenMap = parseHiddenModelsByProvider({
    claude: ["claude-opus-4-7"],
    cx: ["gpt-5.6-sol"],
  });
  assert.equal(isProviderModelHidden(hiddenMap, "claude", "claude-opus-4-7", "cc"), true);
  assert.equal(isProviderModelHidden(hiddenMap, "cc", "claude-opus-4-7", "cc"), false);
  assert.equal(isProviderModelHidden(hiddenMap, "codex", "gpt-5.6-sol", "cx"), true);
  assert.equal(isProviderModelHidden(hiddenMap, "claude", "claude-opus-5-5", "cc"), false);
});
