import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";

import {
  parseKiroModels,
  resolveKiroRegion,
  buildKiroModelsEndpoints,
  fetchKiroAvailableModels,
  clearKiroModelCache,
  isObsoleteKiroModelAlias,
} from "../../open-sse/services/kiroModels.ts";

const FALLBACK = [{ id: "claude-sonnet-4.5" }, { id: "deepseek-3.2" }];

beforeEach(() => {
  clearKiroModelCache();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("parseKiroModels reads CodeWhisperer ListAvailableModels shape", () => {
  const models = parseKiroModels({
    models: [
      { modelId: "auto", modelName: "Auto" },
      { modelId: "claude-sonnet-4.6", modelName: "Claude Sonnet 4.6" },
      { modelId: "claude-sonnet-4.6" }, // duplicate id is ignored
      { modelName: "no id" }, // missing id is skipped
    ],
  });

  assert.deepEqual(
    models.map((m) => m.id),
    ["claude-sonnet-4.6"]
  );
  assert.equal(models[0].name, "Claude Sonnet 4.6");
  assert.equal(models[0].owned_by, "kiro");
});

test("parseKiroModels preserves live prompt-caching capability metadata", () => {
  const [model] = parseKiroModels({
    models: [
      {
        modelId: "claude-sonnet-4.5",
        modelName: "Claude Sonnet 4.5",
        promptCaching: {
          supportsPromptCaching: true,
          minimumTokensPerCacheCheckpoint: 1024,
          maximumCacheCheckpointsPerRequest: 4,
        },
      },
    ],
  });

  assert.deepEqual(model.promptCaching, {
    supportsPromptCaching: true,
    minimumTokensPerCacheCheckpoint: 1024,
    maximumCacheCheckpointsPerRequest: 4,
  });
});

test("parseKiroModels keeps nonnumeric prompt-caching limits unknown", () => {
  const [model] = parseKiroModels({
    models: [
      {
        modelId: "claude-sonnet-4.5",
        promptCaching: {
          supportsPromptCaching: true,
          minimumTokensPerCacheCheckpoint: null,
          maximumCacheCheckpointsPerRequest: false,
        },
      },
    ],
  });

  assert.deepEqual(model.promptCaching, {
    supportsPromptCaching: true,
    minimumTokensPerCacheCheckpoint: null,
    maximumCacheCheckpointsPerRequest: null,
  });
});

test("fetchKiroAvailableModels carries upstream prompt-caching metadata to model variants", async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      models: [
        {
          modelId: "claude-sonnet-4.5",
          promptCaching: {
            supportsPromptCaching: true,
            minimumTokensPerCacheCheckpoint: 1024,
            maximumCacheCheckpointsPerRequest: 4,
          },
        },
      ],
    })) as unknown as typeof fetch;

  const result = await fetchKiroAvailableModels({
    accessToken: "tok",
    providerSpecificData: {},
    fetchImpl,
    fallbackModels: FALLBACK,
  });

  assert.ok(result.models.length >= 1);
  for (const model of result.models) {
    assert.equal(model.upstreamModelId, "claude-sonnet-4.5");
    assert.deepEqual(model.promptCaching, {
      supportsPromptCaching: true,
      minimumTokensPerCacheCheckpoint: 1024,
      maximumCacheCheckpointsPerRequest: 4,
    });
  }
});

test("resolveKiroRegion prefers stored region, then profileArn, else us-east-1", () => {
  assert.equal(resolveKiroRegion({ region: "eu-central-1" }), "eu-central-1");
  assert.equal(
    resolveKiroRegion({ profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/X" }),
    "eu-central-1"
  );
  assert.equal(resolveKiroRegion({}), "us-east-1");
  assert.equal(resolveKiroRegion(null), "us-east-1");
});

test("buildKiroModelsEndpoints is region-matched with a us-east-1 fallback", () => {
  assert.deepEqual(buildKiroModelsEndpoints("us-east-1"), [
    "https://management.us-east-1.kiro.dev",
  ]);
  assert.deepEqual(buildKiroModelsEndpoints("eu-central-1"), [
    "https://management.eu-central-1.kiro.dev",
    "https://management.us-east-1.kiro.dev",
  ]);
});

test("fetchKiroAvailableModels: simple (Builder ID) account, us-east-1, origin KIRO_CLI", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    return jsonResponse({ models: [{ modelId: "claude-sonnet-4.6" }, { modelId: "auto" }] });
  }) as unknown as typeof fetch;

  const result = await fetchKiroAvailableModels({
    accessToken: "tok",
    providerSpecificData: {}, // no region, no profileArn → us-east-1, origin KIRO_CLI
    fetchImpl,
    fallbackModels: FALLBACK,
  });

  assert.equal(result.source, "api");
  assert.deepEqual(result.models.map((m) => m.id).sort(), [
    "claude-sonnet-4.6",
    "claude-sonnet-4.6-thinking",
  ]);
  assert.ok(calls.some((c) => c.startsWith("https://management.us-east-1.kiro.dev/?origin=KIRO_CLI&profileArn=")));
});

test("fetchKiroAvailableModels: IAM Identity Center account, region-matched endpoint", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    // First (region-matched) endpoint succeeds.
    return jsonResponse({ models: [{ modelId: "claude-opus-4.8", modelName: "Opus 4.8" }] });
  }) as unknown as typeof fetch;

  const result = await fetchKiroAvailableModels({
    accessToken: "tok",
    providerSpecificData: { region: "eu-central-1" },
    fetchImpl,
    fallbackModels: FALLBACK,
  });

  assert.equal(result.source, "api");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["claude-opus-4.8", "claude-opus-4.8-thinking"]
  );
  assert.ok(
    calls.some((c) => c.startsWith("https://management.eu-central-1.kiro.dev/?origin=KIRO_CLI&profileArn="))
  );
});

test("fetchKiroAvailableModels: retries with fallback endpoint when primary fails", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => {
    calls.push(url);
    if (url.includes("management.us-east-1.kiro.dev")) {
      return jsonResponse({ models: [{ modelId: "claude-sonnet-4.6" }] });
    }
    return jsonResponse({ message: "failed" }, 500);
  }) as unknown as typeof fetch;

  const result = await fetchKiroAvailableModels({
    accessToken: "tok",
    providerSpecificData: {
      region: "eu-central-1",
      profileArn: "arn:aws:codewhisperer:eu-central-1:123:profile/ABC",
    },
    fetchImpl,
    fallbackModels: FALLBACK,
  });

  assert.equal(result.source, "api");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["claude-sonnet-4.6", "claude-sonnet-4.6-thinking"]
  );
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes("management.eu-central-1.kiro.dev"));
  assert.ok(calls[1].includes("management.us-east-1.kiro.dev"));
});

test("fetchKiroAvailableModels only exposes a functional Thinking alias and filters fable", async () => {
  const fetchImpl = (async () =>
    jsonResponse({
      models: [
        { modelId: "claude-sonnet-5" },
        { modelId: "claude-sonnet-4.5" },
        { modelId: "deepseek-3.2" },
        { modelId: "gpt-5.6-sol" },
        { modelId: "claude-fable-5" },
      ],
    })) as unknown as typeof fetch;

  const result = await fetchKiroAvailableModels({
    accessToken: "tok",
    providerSpecificData: { authMethod: "builder-id" },
    fetchImpl,
  });

  assert.deepEqual(
    result.models.map((model) => model.id),
    ["claude-sonnet-5", "claude-sonnet-5-thinking", "claude-sonnet-4.5", "deepseek-3.2", "gpt-5.6-sol"]
  );
});

test("isObsoleteKiroModelAlias filters stale cached aliases and fable", () => {
  assert.equal(isObsoleteKiroModelAlias("auto"), true);
  assert.equal(isObsoleteKiroModelAlias("auto-kiro"), true);
  assert.equal(isObsoleteKiroModelAlias("claude-fable-5"), true);
  assert.equal(isObsoleteKiroModelAlias("claude-fable-5-thinking"), true);
  assert.equal(isObsoleteKiroModelAlias("claude-sonnet-5-agentic"), true);
  assert.equal(isObsoleteKiroModelAlias("claude-sonnet-4.5-thinking"), true);
  assert.equal(isObsoleteKiroModelAlias("claude-sonnet-5-thinking"), false);
  assert.equal(isObsoleteKiroModelAlias("claude-sonnet-4.5"), false);
});

test("fetchKiroAvailableModels sends auth-method headers for API key and External IdP", async () => {
  const seen: Array<Headers> = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return jsonResponse({ models: [{ modelId: "claude-sonnet-5" }] });
  }) as unknown as typeof fetch;

  await fetchKiroAvailableModels({
    accessToken: "api-key",
    providerSpecificData: { authMethod: "api_key", clientId: "api-client", profileArn: "arn:test:profile" },
    fetchImpl,
  });
  await fetchKiroAvailableModels({
    accessToken: "external-token",
    providerSpecificData: { authMethod: "external_idp", clientId: "external-client", profileArn: "arn:test:profile" },
    fetchImpl,
  });

  assert.equal(seen[0].get("tokentype"), "API_KEY");
  assert.equal(seen[0].get("X-Amz-Target"), "AmazonCodeWhispererService.ListAvailableModels");
  assert.equal(seen[1].get("tokentype"), "EXTERNAL_IDP");
  assert.equal(seen[1].get("X-Amz-Target"), "AmazonCodeWhispererService.ListAvailableModels");
});

test("fetchKiroAvailableModels: falls back to static catalog when no token", async () => {
  const result = await fetchKiroAvailableModels({
    accessToken: "",
    providerSpecificData: {},
    fallbackModels: FALLBACK,
  });
  assert.equal(result.source, "fallback");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["claude-sonnet-4.5", "deepseek-3.2"]
  );
});

test("fetchKiroAvailableModels: falls back when every upstream attempt fails", async () => {
  const fetchImpl = (async () =>
    jsonResponse({ message: "expired" }, 403)) as unknown as typeof fetch;
  const result = await fetchKiroAvailableModels({
    accessToken: "stale",
    providerSpecificData: { region: "us-east-1" },
    fetchImpl,
    fallbackModels: FALLBACK,
  });
  assert.equal(result.source, "fallback");
  assert.deepEqual(
    result.models.map((m) => m.id),
    ["claude-sonnet-4.5", "deepseek-3.2"]
  );
});
