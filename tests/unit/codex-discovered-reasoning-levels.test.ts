import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { CodexDiscoveryModel } from "../../src/app/api/providers/[id]/models/discovery/codex.ts";

// Codex discovery declares per-model reasoning levels (`supported_reasoning_levels`).
// New models (gpt-6-sol, gpt-6-luna) have no hand-written registry variants, so the
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
    { id: "gpt-6-sol", supportedThinkingEfforts: SOL_LEVELS },
    { id: "gpt-6-luna", supportedThinkingEfforts: LUNA_LEVELS },
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
  for (const id of ["gpt-6-sol-max", "gpt-6-sol-ultra", "gpt-6-luna-max", "gpt-6-sol(max)"]) {
    assert.deepEqual(splitCodexReasoningSuffix(id), { baseModel: id, effort: null }, id);
  }

  registerGpt6Levels();

  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-sol-max"), {
    baseModel: "gpt-6-sol",
    effort: "max",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-sol-ultra"), {
    baseModel: "gpt-6-sol",
    effort: "ultra",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-luna-max"), {
    baseModel: "gpt-6-luna",
    effort: "max",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-luna-ultra"), {
    baseModel: "gpt-6-luna-ultra",
    effort: null,
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-sol(max)"), {
    baseModel: "gpt-6-sol",
    effort: "max",
  });
  // Parenthesized overrides mirror the static rule: any model reaching Max accepts both,
  // and the executor clamps Ultra down to the model's top tier.
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-luna(ultra)"), {
    baseModel: "gpt-6-luna",
    effort: "ultra",
  });
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-sol-xhigh"), {
    baseModel: "gpt-6-sol",
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
    { id: "gpt-6-sol-max", supportedThinkingEfforts: ["low"] },
    {
      id: "gpt-6-sol",
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

  assert.deepEqual(getCodexReasoningLevels("gpt-6-sol"), ["low", "xhigh", "max", "ultra"]);
  assert.equal(getCodexMaxEffort("gpt-6-sol"), "ultra");
  for (const id of ["gpt-6-sol-max", "gpt-5.5-xhigh", "no-levels", "only-unknown-levels"]) {
    assert.equal(getCodexReasoningLevels(id), null, id);
    assert.equal(getCodexMaxEffort(id), null, id);
  }

  registerCodexReasoningLevels([{ id: "gpt-6-luna", supportedThinkingEfforts: LUNA_LEVELS }]);
  assert.deepEqual(getCodexReasoningLevels("gpt-6-luna"), LUNA_LEVELS);
  assert.deepEqual(
    getCodexReasoningLevels("gpt-6-sol"),
    ["low", "xhigh", "max", "ultra"],
    "registering one model never clears another"
  );

  registerCodexReasoningLevels([{ id: "gpt-6-sol", supportedThinkingEfforts: ["high", "low"] }]);
  assert.deepEqual(getCodexReasoningLevels("gpt-6-sol"), ["low", "high"], "a redeclaration wins");

  for (const malformed of [undefined, null, "gpt-6-sol", { id: "gpt-6-sol" }, [{ id: 7 }]]) {
    assert.doesNotThrow(() => registerCodexReasoningLevels(malformed));
  }
  const throwingItem = Object.defineProperty({}, "id", {
    get() {
      throw new Error("boom");
    },
  });
  assert.doesNotThrow(() => registerCodexReasoningLevels([throwingItem]));
  assert.deepEqual(getCodexReasoningLevels("gpt-6-sol"), ["low", "high"]);
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
  assert.equal(isCodexDelegationEffort("gpt-6-sol", "ultra"), false);

  registerGpt6Levels();

  assert.equal(isCodexDelegationEffort("gpt-6-sol", "ultra"), true);
  assert.equal(isCodexDelegationEffort("gpt-6-sol", "max"), false);
  assert.equal(isCodexDelegationEffort("gpt-6-luna", "max"), true);
  assert.equal(isCodexDelegationEffort("gpt-6-luna", "ultra"), false);
  assert.equal(isCodexDelegationEffort("gpt-6-sol", "xhigh"), false);
  assert.equal(isCodexDelegationEffort("gpt-6-sol", null), false);
});

test("CodexExecutor.transformRequest honors discovered Max/Ultra tiers for new models", () => {
  registerGpt6Levels();

  // Ultra is a Codex-client tier; its upstream wire effort is Max.
  assert.deepEqual(transform("gpt-6-sol-ultra"), { model: "gpt-6-sol", effort: "max" });
  assert.deepEqual(transform("gpt-6-sol-max"), { model: "gpt-6-sol", effort: "max" });
  assert.deepEqual(transform("gpt-6-sol", { reasoning_effort: "max" }), {
    model: "gpt-6-sol",
    effort: "max",
  });
  assert.deepEqual(transform("gpt-6-luna-max"), { model: "gpt-6-luna", effort: "max" });
  assert.deepEqual(transform("gpt-6-luna", { reasoning_effort: "ultra" }), {
    model: "gpt-6-luna",
    effort: "max",
  });
  // Models without discovered levels keep the xhigh cap.
  assert.deepEqual(transform("gpt-7-nova", { reasoning_effort: "max" }), {
    model: "gpt-7-nova",
    effort: "xhigh",
  });
  assert.deepEqual(transform("gpt-5.5", { reasoning_effort: "max" }), {
    model: "gpt-5.5",
    effort: "xhigh",
  });
});

test("Responses Lite keeps parallel tool calls only at a discovered model's delegation tier", async () => {
  registerGpt6Levels();

  const solUltra = await runResponsesLiteRequest("gpt-6-sol-ultra");
  assert.equal(solUltra.model, "gpt-6-sol");
  assert.equal(solUltra.parallel_tool_calls, true);
  assert.equal((await runResponsesLiteRequest("gpt-6-luna-max")).parallel_tool_calls, true);
  assert.equal((await runResponsesLiteRequest("gpt-6-sol-max")).parallel_tool_calls, false);
  assert.equal((await runResponsesLiteRequest("gpt-6-sol")).parallel_tool_calls, false);

  // Statically known models are unchanged (#7821).
  assert.equal((await runResponsesLiteRequest("gpt-5.6-sol-ultra")).parallel_tool_calls, true);
  assert.equal((await runResponsesLiteRequest("gpt-5.6-luna-max")).parallel_tool_calls, true);
  assert.equal((await runResponsesLiteRequest("gpt-5.6-sol-max")).parallel_tool_calls, false);
  assert.equal((await runResponsesLiteRequest("gpt-5.5")).parallel_tool_calls, false);
});

test("Responses translation keeps native max once a Codex model declares it", () => {
  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-6-sol"), "xhigh");

  registerGpt6Levels();
  registerCodexReasoningLevels([
    { id: "gpt-5.5", supportedThinkingEfforts: ["low", "medium", "high", "xhigh"] },
  ]);

  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-6-sol"), "max");
  assert.equal(normalizeResponsesReasoningEffort("max", "codex/gpt-6-luna-high"), "max");
  assert.equal(normalizeResponsesReasoningEffort("max", "gpt-6-sol-ultra"), "max");
  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-5.5"), "xhigh");
  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-7-nova"), "xhigh");
  assert.equal(normalizeResponsesReasoningEffort("max", "cx/gpt-5.6-terra"), "max");
  assert.equal(normalizeResponsesReasoningEffort("high", "cx/gpt-6-sol"), "high");
});

test("derived -high/-xhigh Codex ids get the #6354 reasoning-heavy timeout", () => {
  assert.equal(getModelTimeoutMs("codex", "gpt-6-sol-xhigh"), undefined);

  registerGpt6Levels();

  assert.equal(getModelTimeoutMs("codex", "gpt-6-sol-xhigh"), 1200000);
  assert.equal(getModelTimeoutMs("codex", "gpt-6-sol-high"), 1200000);
  assert.equal(getModelTimeoutMs("cx", "gpt-6-luna-xhigh"), 1200000);
  assert.equal(getModelTimeoutMs("codex", "cx/gpt-6-luna-high"), 1200000);
  for (const model of ["gpt-6-sol-medium", "gpt-6-sol", "gpt-6-sol-max", "gpt-6-sol-ultra"]) {
    assert.equal(getModelTimeoutMs("codex", model), undefined, model);
  }
  assert.equal(getModelTimeoutMs("codex", "gpt-7-nova-xhigh"), undefined);
  assert.equal(getModelTimeoutMs("openai", "gpt-6-sol-xhigh"), undefined);
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
    discoveredModel("gpt-6-sol", "GPT-6 Sol", SOL_LEVELS, {
      description: "Frontier Sol",
      inputTokenLimit: 872000,
      outputTokenLimit: 128000,
      supportsVision: true,
    }),
    discoveredModel("gpt-6-luna", "GPT-6 Luna", LUNA_LEVELS),
    discoveredModel("gpt-6-astra", "GPT-6 Astra Live", ["low", "medium", "ultra"]),
    discoveredModel("gpt-5.4", "GPT 5.4", ["low", "high"]),
    discoveredModel("gpt-5.5", "GPT 5.5 Live", ["low", "medium", "high", "xhigh"]),
    discoveredModel("codex-auto-review", "Codex Auto Review", []),
  ];

  const catalog = codexDiscovery.buildCodexDiscoveryCatalog(remoteModels, localCatalog);
  const ids = catalog.map((model) => model.id);

  assert.deepEqual(ids, [
    "gpt-6-sol",
    "gpt-6-sol-ultra",
    "gpt-6-sol-max",
    "gpt-6-sol-xhigh",
    "gpt-6-sol-high",
    "gpt-6-sol-medium",
    "gpt-6-sol-low",
    "gpt-6-luna",
    "gpt-6-luna-max",
    "gpt-6-luna-xhigh",
    "gpt-6-luna-high",
    "gpt-6-luna-medium",
    "gpt-6-luna-low",
    "gpt-6-astra",
    "gpt-6-astra-medium",
    "gpt-5.5",
    "gpt-5.5-high",
    "gpt-5.5-medium",
    "gpt-5.5-low",
    "codex-auto-review",
    "gpt-6-astra-ultra",
    "gpt-6-astra-low",
    "gpt-5.5-xhigh",
  ]);

  const byId = new Map(catalog.map((model) => [model.id, model]));
  assert.deepEqual(byId.get("gpt-6-sol-xhigh"), {
    id: "gpt-6-sol-xhigh",
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
  assert.equal(byId.get("gpt-6-luna-max")?.name, "GPT-6 Luna (Max)");
  assert.equal(byId.get("gpt-6-sol-ultra")?.name, "GPT-6 Sol (Ultra)");
  assert.deepEqual(byId.get("gpt-6-sol")?.supportedThinkingEfforts, SOL_LEVELS);
  for (const variantId of ids.filter((id) => /-(?:ultra|max|xhigh|high|medium|low)$/.test(id))) {
    const variant = byId.get(variantId) ?? {};
    assert.equal("supportedThinkingEfforts" in variant, false, `${variantId} has no nested tiers`);
  }
  // Hand-written registry variants always win over synthesized ones.
  assert.equal(byId.get("gpt-6-astra-ultra")?.name, "GPT 6 Astra (Ultra)");
  assert.equal(byId.get("gpt-5.5-xhigh")?.name, "GPT 5.5 (xHigh)");

  // Stable: the served catalog fed back in (the cached path) yields the same ids.
  const recycled = codexDiscovery.buildCodexDiscoveryCatalog(catalog, localCatalog);
  assert.deepEqual(
    recycled.map((model) => model.id),
    ids
  );

  // The executor's runtime table learned the served models' declared levels.
  assert.deepEqual(getCodexReasoningLevels("gpt-6-sol"), SOL_LEVELS);
  assert.deepEqual(getCodexReasoningLevels("gpt-6-luna"), LUNA_LEVELS);
  assert.equal(getCodexReasoningLevels("gpt-5.4"), null);
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-luna-max"), {
    baseModel: "gpt-6-luna",
    effort: "max",
  });

  // Filters apply to bases and to synthesized variants alike.
  const filteredIds = codexDiscovery
    .buildCodexDiscoveryCatalog(remoteModels, localCatalog, [
      (model) => model.id !== "gpt-6-luna" && model.id !== "gpt-6-sol-max",
    ])
    .map((model) => model.id);
  assert.equal(
    filteredIds.some((id) => id.startsWith("gpt-6-luna")),
    false
  );
  assert.equal(filteredIds.includes("gpt-6-sol-max"), false);
  assert.ok(filteredIds.includes("gpt-6-sol-ultra"));
});

test("GitHub enrichment and the live/local merge keep discovered reasoning levels", () => {
  const liveWithoutLevels: CodexDiscoveryModel = {
    id: "gpt-6-sol",
    name: "Live Sol",
    owned_by: "codex",
    apiFormat: "responses",
    supportedEndpoints: ["responses"],
  };
  const githubSol = discoveredModel("gpt-6-sol", "GitHub Sol", SOL_LEVELS);

  const [enriched] = codexDiscovery.enrichCodexModelsFromGithubCatalog(
    [liveWithoutLevels],
    [githubSol]
  );
  assert.equal(enriched?.name, "Live Sol");
  assert.deepEqual(enriched?.supportedThinkingEfforts, SOL_LEVELS);

  const [liveWins] = codexDiscovery.enrichCodexModelsFromGithubCatalog(
    [discoveredModel("gpt-6-sol", "Live Sol", LUNA_LEVELS)],
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
        slug: "gpt-6-sol",
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
        slug: "gpt-6-luna",
        visibility: "list",
        supported_in_api: true,
        supported_reasoning_levels: ["bogus"],
      },
      { slug: "gpt-5.5", visibility: "list", supported_in_api: true },
    ],
  });
  const byId = new Map(parsed.map((model) => [model.id, model]));

  assert.deepEqual(byId.get("gpt-6-sol")?.supportedThinkingEfforts, [
    "low",
    "medium",
    "max",
    "ultra",
  ]);
  assert.equal(byId.get("gpt-6-sol")?.supportsThinking, true);
  // The upstream default is deliberately not captured (it would inject request defaults).
  assert.equal("defaultThinkingEffort" in (byId.get("gpt-6-sol") ?? {}), false);
  assert.equal("supportedThinkingEfforts" in (byId.get("gpt-6-luna") ?? {}), false);
  assert.equal("supportedThinkingEfforts" in (byId.get("gpt-5.5") ?? {}), false);
});

test("hydration re-registers levels from the synced Codex catalog once and never throws", async () => {
  let reads = 0;
  const deps = {
    readSyncedModels: async () => {
      reads += 1;
      return [
        {
          id: "gpt-6-sol",
          name: "GPT-6 Sol",
          source: "imported",
          supportedThinkingEfforts: SOL_LEVELS,
        },
        { id: "gpt-6-sol-ultra", name: "GPT-6 Sol (Ultra)", source: "imported" },
        { id: "gpt-5.5", name: "GPT 5.5", source: "imported" },
      ];
    },
  };

  await reasoningLevelsHydration.hydrateCodexReasoningLevelsFromSyncedModels(deps);
  await reasoningLevelsHydration.hydrateCodexReasoningLevelsFromSyncedModels(deps);

  assert.equal(reads, 1, "hydration runs once per process");
  assert.deepEqual(getCodexReasoningLevels("gpt-6-sol"), SOL_LEVELS);
  assert.equal(getCodexReasoningLevels("gpt-5.5"), null);
  assert.deepEqual(splitCodexReasoningSuffix("gpt-6-sol-ultra"), {
    baseModel: "gpt-6-sol",
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
  assert.deepEqual(getCodexReasoningLevels("gpt-6-sol"), SOL_LEVELS);
});
