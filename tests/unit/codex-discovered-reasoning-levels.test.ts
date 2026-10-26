import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CodexDiscoveryModel } from "../../src/app/api/providers/[id]/models/discovery/codex.ts";

// Codex discovery declares per-model reasoning levels (`supported_reasoning_levels`).
// New models (gpt-future-sol, gpt-future-luna) have no hand-written registry variants, so the
// levels they declare must drive the catalog variants AND every request-time rule that
// used to be keyed on fixed model sets: -max/-ultra suffixes, the effort clamp, the
// Responses Lite delegation exemption, native max in translation and the #6354 timeout.

// Hydration reads go through the injected seam; this only guarantees a stray default
// could never touch the real DB.
const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-codex-reasoning-levels-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const reasoningSuffix = await import("../../open-sse/executors/codex/reasoningSuffix.ts");
const { CodexExecutor } = await import("../../open-sse/executors/codex.ts");
const { normalizeResponsesReasoningEffort } =
  await import("../../open-sse/translator/request/openai-responses/helpers.ts");
const { getModelTimeoutMs } = await import("../../open-sse/config/providerModels.ts");
const codexDiscovery = await import("../../src/app/api/providers/[id]/models/discovery/codex.ts");
const reasoningLevelsHydration = await import("../../src/shared/services/codexReasoningLevels.ts");

const {
  getCodexMaxEffort,
  getCodexReasoningLevels,
  isCodexDelegationEffort,
  registerCodexReasoningLevels,
  splitCodexReasoningSuffix,
} = reasoningSuffix;

const SOL_LEVELS = ["low", "medium", "high", "xhigh", "max", "ultra"];
const LUNA_LEVELS = ["low", "medium", "high", "xhigh", "max"];

function registerGpt6Levels(): void {
  registerCodexReasoningLevels([
    { id: "gpt-future-sol", supportedThinkingEfforts: SOL_LEVELS },
    { id: "gpt-future-luna", supportedThinkingEfforts: LUNA_LEVELS },
  ]);
}

function getRecord(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  return value as Record<string, unknown>;
}

function transform(model: string, extraBody: Record<string, unknown> = {}) {
  const result = getRecord(
    new CodexExecutor().transformRequest(model, { model, input: [], ...extraBody }, false, {
      requestEndpointPath: "/responses",
    })
  );
  return { model: result.model, effort: getRecord(result.reasoning).effort };
}

async function runResponsesLiteRequest(model: string): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  const capturedBodies: Record<string, unknown>[] = [];
  globalThis.fetch = async (_url, init) => {
    capturedBodies.push(JSON.parse(String(init?.body || "{}")));
    return new Response(JSON.stringify({ id: "resp_lite", object: "response" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    await new CodexExecutor().execute({
      model,
      body: { _nativeCodexPassthrough: true, model, input: [], parallel_tool_calls: true },
      stream: true,
      credentials: { accessToken: "codex-token" },
      clientHeaders: { "X-OpenAI-Internal-Codex-Responses-Lite": "true" },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(capturedBodies.length, 1, model);
  return capturedBodies[0];
}

function discoveredModel(
  id: string,
  name: string,
  supportedThinkingEfforts: string[],
  extra: Partial<CodexDiscoveryModel> = {}
): CodexDiscoveryModel {
  return {
    id,
    name,
    owned_by: "codex",
    apiFormat: "responses",
    supportedEndpoints: ["responses"],
    supportsThinking: true,
    supportedThinkingEfforts,
    ...extra,
  };
}

test.beforeEach(() => {
  reasoningSuffix.__resetCodexReasoningLevelsForTests();
  reasoningLevelsHydration.__resetCodexReasoningLevelsHydrationForTests();
});

test.after(() => {
  reasoningSuffix.__resetCodexReasoningLevelsForTests();
  reasoningLevelsHydration.__resetCodexReasoningLevelsHydrationForTests();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

test("discovered levels unlock -max/-ultra suffixes only for the tiers a model declares", () => {
  for (const id of [
    "gpt-future-sol-max",
    "gpt-future-sol-ultra",
    "gpt-future-luna-max",
    "gpt-future-sol(max)",
  ]) {
    assert.deepEqual(splitCodexReasoningSuffix(id), { baseModel: id, effort: null }, id);
  }

  registerGpt6Levels();

  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-sol-max"), {
    baseModel: "gpt-future-sol",
    effort: "max",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-sol-ultra"), {
    baseModel: "gpt-future-sol",
    effort: "ultra",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-luna-max"), {
    baseModel: "gpt-future-luna",
    effort: "max",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-luna-ultra"), {
    baseModel: "gpt-future-luna-ultra",
    effort: null,
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-sol(max)"), {
    baseModel: "gpt-future-sol",
    effort: "max",
  });
  // Parenthesized overrides mirror the static rule: any model reaching Max accepts both,
  // and the executor clamps Ultra down to the model's top tier.
  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-luna(ultra)"), {
    baseModel: "gpt-future-luna",
    effort: "ultra",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-sol-xhigh"), {
    baseModel: "gpt-future-sol",
    effort: "xhigh",
  });

  // Statically known models are unchanged.
  assert.deepEqual(splitCodexReasoningSuffix("gpt-5.6-sol-ultra"), {
    baseModel: "gpt-5.6-sol",
    effort: "ultra",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-5.6-luna-max"), {
    baseModel: "gpt-5.6-luna",
    effort: "max",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-5.6-luna-ultra"), {
    baseModel: "gpt-5.6-luna-ultra",
    effort: null,
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-5.1-codex-max"), {
    baseModel: "gpt-5.1-codex-max",
    effort: null,
  });
});

test("registerCodexReasoningLevels keeps known levels in canonical order and merges per id", () => {
  registerCodexReasoningLevels([
    // An effort variant of a model declared in the same batch is never a base model.
    { id: "gpt-future-sol-max", supportedThinkingEfforts: ["low"] },
    {
      id: "gpt-future-sol",
      supportedThinkingEfforts: ["ULTRA", "low", "bogus", " max ", "low", 7, "xhigh"],
    },
    { id: "gpt-5.5-xhigh", supportedThinkingEfforts: ["low"] },
    { id: "no-levels" },
    { id: "only-unknown-levels", supportedThinkingEfforts: ["turbo"] },
    { id: "", supportedThinkingEfforts: ["low"] },
    null,
    "gpt-7",
    42,
  ]);

  assert.deepEqual(getCodexReasoningLevels("gpt-future-sol"), ["low", "xhigh", "max", "ultra"]);
  assert.equal(getCodexMaxEffort("gpt-future-sol"), "ultra");
  for (const id of ["gpt-future-sol-max", "gpt-5.5-xhigh", "no-levels", "only-unknown-levels"]) {
    assert.equal(getCodexReasoningLevels(id), null, id);
    assert.equal(getCodexMaxEffort(id), null, id);
  }

  registerCodexReasoningLevels([{ id: "gpt-future-luna", supportedThinkingEfforts: LUNA_LEVELS }]);
  assert.deepEqual(getCodexReasoningLevels("gpt-future-luna"), LUNA_LEVELS);
  assert.deepEqual(
    getCodexReasoningLevels("gpt-future-sol"),
    ["low", "xhigh", "max", "ultra"],
    "registering one model never clears another"
  );

  registerCodexReasoningLevels([
    { id: "gpt-future-sol", supportedThinkingEfforts: ["high", "low"] },
  ]);
  assert.deepEqual(
    getCodexReasoningLevels("gpt-future-sol"),
    ["low", "high"],
    "a redeclaration wins"
  );

  for (const malformed of [
    undefined,
    null,
    "gpt-future-sol",
    { id: "gpt-future-sol" },
    [{ id: 7 }],
  ]) {
    assert.doesNotThrow(() => registerCodexReasoningLevels(malformed));
  }
  const throwingItem = Object.defineProperty({}, "id", {
    get() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => registerCodexReasoningLevels([throwingItem]));
  assert.deepEqual(getCodexReasoningLevels("gpt-future-sol"), ["low", "high"]);
});

test("isCodexDelegationEffort generalizes the static Ultra/Max delegation tiers", () => {
  // Static models: Astra/Sol/Terra delegate at Ultra, Luna at Max — nothing else.
  for (const model of ["gpt-6-astra", "gpt-5.6-sol", "gpt-5.6-terra"]) {
    assert.equal(isCodexDelegationEffort(model, "ultra"), true, model);
    assert.equal(isCodexDelegationEffort(model, "max"), false, model);
  }
  assert.equal(isCodexDelegationEffort("gpt-5.6-luna", "max"), true);
  assert.equal(isCodexDelegationEffort("gpt-5.6-luna", "ultra"), false);
  assert.equal(isCodexDelegationEffort("gpt-5.5", "max"), false);
  assert.equal(isCodexDelegationEffort("gpt-future-sol", "ultra"), false);

  registerGpt6Levels();

  assert.equal(isCodexDelegationEffort("gpt-future-sol", "ultra"), true);
  assert.equal(isCodexDelegationEffort("gpt-future-sol", "max"), false);
  assert.equal(isCodexDelegationEffort("gpt-future-luna", "max"), true);
  assert.equal(isCodexDelegationEffort("gpt-future-luna", "ultra"), false);
  assert.equal(isCodexDelegationEffort("gpt-future-sol", "xhigh"), false);
  assert.equal(isCodexDelegationEffort("gpt-future-sol", null), false);
});

test("CodexExecutor.transformRequest honors discovered Max/Ultra tiers for new models", () => {
  registerGpt6Levels();

  // Ultra is a Codex-client tier; its upstream wire effort is Max.
  assert.deepEqual(transform("gpt-future-sol-ultra"), { model: "gpt-future-sol", effort: "max" });
  assert.deepEqual(transform("gpt-future-sol-max"), { model: "gpt-future-sol", effort: "max" });
  assert.deepEqual(transform("gpt-future-sol", { reasoning_effort: "max" }), {
    model: "gpt-future-sol",
    effort: "max",
  });
  assert.deepEqual(transform("gpt-future-luna-max"), { model: "gpt-future-luna", effort: "max" });
  assert.deepEqual(transform("gpt-future-luna", { reasoning_effort: "ultra" }), {
    model: "gpt-future-luna",
    effort: "max",
  });
  // Explicit native Max remains valid for future models.
  assert.deepEqual(transform("gpt-7-nova", { reasoning_effort: "max" }), {
    model: "gpt-7-nova",
    effort: "max",
  });
  assert.deepEqual(transform("gpt-5.5", { reasoning_effort: "max" }), {
    model: "gpt-5.5",
    effort: "max",
  });
});

test("Responses Lite keeps parallel tool calls only at a discovered model's delegation tier", async () => {
  registerGpt6Levels();

  const solUltra = await runResponsesLiteRequest("gpt-future-sol-ultra");
  assert.equal(solUltra.model, "gpt-future-sol");
  assert.equal(solUltra.parallel_tool_calls, true);
  assert.equal((await runResponsesLiteRequest("gpt-future-luna-max")).parallel_tool_calls, true);
  assert.equal((await runResponsesLiteRequest("gpt-future-sol-max")).parallel_tool_calls, false);
  assert.equal((await runResponsesLiteRequest("gpt-future-sol")).parallel_tool_calls, false);

  // Statically known models are unchanged (#7821).
  assert.equal((await runResponsesLiteRequest("gpt-5.6-sol-ultra")).parallel_tool_calls, true);
  assert.equal((await runResponsesLiteRequest("gpt-5.6-luna-max")).parallel_tool_calls, true);
  assert.equal((await runResponsesLiteRequest("gpt-5.6-sol-max")).parallel_tool_calls, false);
  assert.equal((await runResponsesLiteRequest("gpt-5.5")).parallel_tool_calls, false);
});

test("Responses translation keeps native max once a Codex model declares it", () => {
  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-future-sol"), "xhigh");

  registerGpt6Levels();
  registerCodexReasoningLevels([
    { id: "gpt-5.5", supportedThinkingEfforts: ["low", "medium", "high", "xhigh"] },
  ]);

  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-future-sol"), "max");
  assert.equal(normalizeResponsesReasoningEffort("max", "codex/gpt-future-luna-high"), "max");
  assert.equal(normalizeResponsesReasoningEffort("max", "gpt-future-sol-ultra"), "max");
  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-5.5"), "xhigh");
  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-7-nova"), "xhigh");
  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-5.6-terra"), "max");
  assert.equal(normalizeResponsesReasoningEffort("high", "cx/gpt-future-sol"), "high");
});

test("derived -high/-xhigh Codex ids get the #6354 reasoning-heavy timeout", () => {
  assert.equal(getModelTimeoutMs("codex", "gpt-future-sol-xhigh"), undefined);

  registerGpt6Levels();

  assert.equal(getModelTimeoutMs("codex", "gpt-future-sol-xhigh"), 1200000);
  assert.equal(getModelTimeoutMs("codex", "gpt-future-sol-high"), 1200000);
  assert.equal(getModelTimeoutMs("cx", "gpt-future-luna-xhigh"), 1200000);
  assert.equal(getModelTimeoutMs("codex", "cx/gpt-future-luna-high"), 1200000);
  for (const model of [
    "gpt-future-sol-medium",
    "gpt-future-sol",
    "gpt-future-sol-max",
    "gpt-future-sol-ultra",
  ]) {
    assert.equal(getModelTimeoutMs("codex", model), undefined, model);
  }
  assert.equal(getModelTimeoutMs("codex", "gpt-7-nova-xhigh"), undefined);
  assert.equal(getModelTimeoutMs("openai", "gpt-future-sol-xhigh"), undefined);
  // Registry-backed values are unchanged.
  assert.equal(getModelTimeoutMs("codex", "gpt-5.5-xhigh"), 1200000);
  assert.equal(getModelTimeoutMs("codex", "gpt-5.5-medium"), undefined);
});

test("buildCodexDiscoveryCatalog synthesizes declared effort variants right after their base", () => {
  const localCatalog = [
    { id: "gpt-6-astra", name: "GPT 6 Astra" },
    { id: "gpt-6-astra-ultra", name: "GPT 6 Astra (Ultra)" },
    { id: "gpt-6-astra-low", name: "GPT 6 Astra (Low)" },
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.5-xhigh", name: "GPT 5.5 (xHigh)" },
  ];
  const remoteModels = [
    discoveredModel("gpt-future-sol", "GPT-6 Sol", SOL_LEVELS, {
      description: "Frontier Sol",
      inputTokenLimit: 872000,
      outputTokenLimit: 128000,
      supportsVision: true,
    }),
    discoveredModel("gpt-future-luna", "GPT-6 Luna", LUNA_LEVELS),
    discoveredModel("gpt-6-astra", "GPT-6 Astra Live", ["low", "medium", "ultra"]),
    discoveredModel("gpt-5.4", "GPT 5.4", ["low", "high"]),
    discoveredModel("gpt-5.5", "GPT 5.5 Live", ["low", "medium", "high", "xhigh"]),
    discoveredModel("codex-auto-review", "Codex Auto Review", []),
  ];

  const catalog = codexDiscovery.buildCodexDiscoveryCatalog(remoteModels, localCatalog);
  const ids = catalog.map((model) => model.id);

  assert.deepEqual(ids, [
    "gpt-future-sol",
    "gpt-future-sol-ultra",
    "gpt-future-sol-max",
    "gpt-future-sol-xhigh",
    "gpt-future-sol-high",
    "gpt-future-sol-medium",
    "gpt-future-sol-low",
    "gpt-future-luna",
    "gpt-future-luna-max",
    "gpt-future-luna-xhigh",
    "gpt-future-luna-high",
    "gpt-future-luna-medium",
    "gpt-future-luna-low",
    "gpt-6-astra",
    "gpt-6-astra-ultra",
    "gpt-6-astra-medium",
    "gpt-6-astra-low",
    "gpt-5.5",
    "gpt-5.5-xhigh",
    "gpt-5.5-high",
    "gpt-5.5-medium",
    "gpt-5.5-low",
    "codex-auto-review",
  ]);

  const byId = new Map(catalog.map((model) => [model.id, model]));
  assert.deepEqual(byId.get("gpt-future-sol-xhigh"), {
    id: "gpt-future-sol-xhigh",
    name: "GPT-6 Sol (xHigh)",
    owned_by: "codex",
    apiFormat: "responses",
    supportedEndpoints: ["responses"],
    supportsThinking: true,
    description: "Frontier Sol",
    inputTokenLimit: 872000,
    outputTokenLimit: 128000,
    supportsVision: true,
  });
  assert.equal(byId.get("gpt-future-luna-max")?.name, "GPT-6 Luna (Max)");
  assert.equal(byId.get("gpt-future-sol-ultra")?.name, "GPT-6 Sol (Ultra)");
  assert.deepEqual(byId.get("gpt-future-sol")?.supportedThinkingEfforts, SOL_LEVELS);
  for (const variantId of ids.filter((id) => /-(?:ultra|max|xhigh|high|medium|low)$/.test(id))) {
    const variant = byId.get(variantId) ?? {};
    assert.equal("supportedThinkingEfforts" in variant, false, `${variantId} has no nested tiers`);
  }
  // Live inventories synthesize variants from current upstream metadata.
  assert.equal(byId.get("gpt-6-astra-ultra")?.name, "GPT-6 Astra Live (Ultra)");
  assert.equal(byId.get("gpt-5.5-xhigh")?.name, "GPT 5.5 Live (xHigh)");

  // Stable: the served catalog fed back in (the cached path) yields the same ids.
  const recycled = codexDiscovery.buildCodexDiscoveryCatalog(catalog, localCatalog);
  assert.deepEqual(
    recycled.map((model) => model.id),
    ids
  );

  // The executor's runtime table learned the served models' declared levels.
  assert.deepEqual(getCodexReasoningLevels("gpt-future-sol"), SOL_LEVELS);
  assert.deepEqual(getCodexReasoningLevels("gpt-future-luna"), LUNA_LEVELS);
  assert.equal(getCodexReasoningLevels("gpt-5.4"), null);
  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-luna-max"), {
    baseModel: "gpt-future-luna",
    effort: "max",
  });

  // Filters apply to bases and to synthesized variants alike.
  const filteredIds = codexDiscovery
    .buildCodexDiscoveryCatalog(remoteModels, localCatalog, [
      (model) => model.id !== "gpt-future-luna" && model.id !== "gpt-future-sol-max",
    ])
    .map((model) => model.id);
  assert.equal(
    filteredIds.some((id) => id.startsWith("gpt-future-luna")),
    false
  );
  assert.equal(filteredIds.includes("gpt-future-sol-max"), false);
  assert.ok(filteredIds.includes("gpt-future-sol-ultra"));
});

test("GitHub enrichment and the live/local merge keep discovered reasoning levels", () => {
  const liveWithoutLevels: CodexDiscoveryModel = {
    id: "gpt-future-sol",
    name: "Live Sol",
    owned_by: "codex",
    apiFormat: "responses",
    supportedEndpoints: ["responses"],
  };
  const githubSol = discoveredModel("gpt-future-sol", "GitHub Sol", SOL_LEVELS);

  const [enriched] = codexDiscovery.enrichCodexModelsFromGithubCatalog(
    [liveWithoutLevels],
    [githubSol]
  );
  assert.equal(enriched?.name, "Live Sol");
  assert.deepEqual(enriched?.supportedThinkingEfforts, SOL_LEVELS);

  const [liveWins] = codexDiscovery.enrichCodexModelsFromGithubCatalog(
    [discoveredModel("gpt-future-sol", "Live Sol", LUNA_LEVELS)],
    [githubSol]
  );
  assert.deepEqual(liveWins?.supportedThinkingEfforts, LUNA_LEVELS);

  const [merged] = codexDiscovery.mergeCodexLiveModelsWithLocalCatalog(
    [discoveredModel("gpt-5.5", "GPT 5.5 Live", ["low", "xhigh"])],
    [{ id: "gpt-5.5", name: "GPT 5.5", maxInputTokens: 272000 }]
  );
  assert.deepEqual(merged?.supportedThinkingEfforts, ["low", "xhigh"]);
  assert.equal(merged?.inputTokenLimit, 272000);
});

test("normalizeCodexModelsResponse maps supported_reasoning_levels onto supportedThinkingEfforts", () => {
  const parsed = codexDiscovery.normalizeCodexModelsResponse({
    models: [
      {
        slug: "gpt-future-sol",
        display_name: "GPT-6 Sol",
        visibility: "list",
        supported_in_api: true,
        default_reasoning_level: "medium",
        supported_reasoning_levels: [
          { effort: "ultra", description: "Delegates to sub-agents" },
          { effort: "LOW", description: "Fast" },
          "max",
          { effort: "turbo" },
          { level: "high" },
          { effort: 7 },
          42,
          null,
          "medium",
          { effort: "low" },
        ],
      },
      {
        slug: "gpt-future-luna",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: ["bogus"],
      },
      { slug: "gpt-5.5", visibility: "list", supported_in_api: true },
    ],
  });
  const byId = new Map(parsed.map((model) => [model.id, model]));

  assert.deepEqual(byId.get("gpt-future-sol")?.supportedThinkingEfforts, [
    "ultra",
    "max",
    "turbo",
    "medium",
    "low",
  ]);
  assert.equal(byId.get("gpt-future-sol")?.supportsThinking, true);
  assert.equal(byId.get("gpt-future-sol")?.defaultThinkingEffort, "medium");
  assert.deepEqual(byId.get("gpt-future-luna")?.supportedThinkingEfforts, ["bogus"]);
  assert.equal("supportedThinkingEfforts" in (byId.get("gpt-5.5") ?? {}), false);
});

test("hydration re-registers levels from the synced Codex catalog once and never throws", async () => {
  let reads = 0;
  const deps = {
    readSyncedModels: async () => {
      reads += 1;
      return [
        {
          id: "gpt-future-sol",
          name: "GPT-6 Sol",
          source: "imported",
          supportedThinkingEfforts: SOL_LEVELS,
        },
        { id: "gpt-future-sol-ultra", name: "GPT-6 Sol (Ultra)", source: "imported" },
        { id: "gpt-5.5", name: "GPT 5.5", source: "imported" },
      ];
    },
  };

  await reasoningLevelsHydration.hydrateCodexReasoningLevelsFromSyncedModels(deps);
  await reasoningLevelsHydration.hydrateCodexReasoningLevelsFromSyncedModels(deps);

  assert.equal(reads, 1, "hydration runs once per process");
  assert.deepEqual(getCodexReasoningLevels("gpt-future-sol"), SOL_LEVELS);
  assert.equal(getCodexReasoningLevels("gpt-5.5"), null);
  assert.deepEqual(splitCodexReasoningSuffix("gpt-future-sol-ultra"), {
    baseModel: "gpt-future-sol",
    effort: "ultra",
  });

  for (const readSyncedModels of [
    async () => {
      throw new Error("db unavailable");
    },
    async () => "not-a-list",
  ]) {
    reasoningLevelsHydration.__resetCodexReasoningLevelsHydrationForTests();
    await assert.doesNotReject(
      reasoningLevelsHydration.hydrateCodexReasoningLevelsFromSyncedModels({ readSyncedModels })
    );
  }
  assert.deepEqual(getCodexReasoningLevels("gpt-future-sol"), SOL_LEVELS);
});
