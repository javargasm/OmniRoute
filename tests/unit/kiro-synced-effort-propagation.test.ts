import test from "node:test";
import assert from "node:assert/strict";

const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.ts");
const { resolveKiroModelAlias } = await import(
  "../../open-sse/translator/request/openai-to-kiro/adaptiveThinking.ts"
);
const { resolveChatCoreRequestSetup } = await import(
  "../../open-sse/handlers/chatCore/requestSetup.ts"
);
const { splitSyncedEffortSuffix } = await import("../../open-sse/services/model.ts");
const { applyDefaultReasoningEffort } = await import(
  "../../open-sse/services/defaultReasoningEffort.ts"
);
const { splitCodexReasoningSuffix } = await import(
  "../../open-sse/executors/codex/reasoningSuffix.ts"
);

test("Kiro vs Codex theory: Codex bypasses synced suffix resolution while Kiro splits it", () => {
  const SYNCED_EFFORT_SKIP_PROVIDER_PREFIXES = ["codex", "kimi"];
  const isCodexSkipped = SYNCED_EFFORT_SKIP_PROVIDER_PREFIXES.some((p) => "codex".startsWith(p));
  const isKiroSkipped = SYNCED_EFFORT_SKIP_PROVIDER_PREFIXES.some((p) => "kiro".startsWith(p));

  assert.equal(isCodexSkipped, true, "Codex must be skipped from generic synced suffix stripping");
  assert.equal(isKiroSkipped, false, "Kiro must NOT be skipped from synced suffix resolution");

  // Codex splits its own suffix inside executor
  const codexSplit = splitCodexReasoningSuffix("gpt-5.6-luna-max");
  assert.equal(codexSplit.baseModel, "gpt-5.6-luna");
  assert.equal(codexSplit.effort, "max");

  // Kiro splits via splitSyncedEffortSuffix against supportedThinkingEfforts
  const kiroSplit = splitSyncedEffortSuffix("gpt-5.6-terra-high", [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.equal(kiroSplit.baseModel, "gpt-5.6-terra");
  assert.equal(kiroSplit.effort, "high");
});

test("Kiro alias resolution: resolveKiroModelAlias extracts effort tier from -high suffix", () => {
  const aliasRes = resolveKiroModelAlias("kiro/gpt-5.6-terra-high");
  assert.equal(aliasRes.upstream, "gpt-5.6-terra");
  assert.equal(aliasRes.effort, "high");

  const solRes = resolveKiroModelAlias("kr/gpt-5.6-sol-max");
  assert.equal(solRes.upstream, "gpt-5.6-sol");
  assert.equal(solRes.effort, "max");
});

test("Requested Model in chatCore: preserves full model string when body.model is not clobbered", () => {
  const unstrippedBody = {
    model: "kiro/gpt-5.6-terra-high",
    messages: [{ role: "user", content: "hello" }],
  };
  const setupUnstripped = resolveChatCoreRequestSetup(
    { provider: "kiro", model: "gpt-5.6-terra" },
    unstrippedBody,
    "gpt-5.6-terra"
  );
  assert.equal(
    setupUnstripped.requestedModel,
    "kiro/gpt-5.6-terra-high",
    "When body.model preserves suffix, requestedModel records full model name"
  );

  const clobberedBody = {
    model: "kiro/gpt-5.6-terra",
    messages: [{ role: "user", content: "hello" }],
  };
  const setupClobbered = resolveChatCoreRequestSetup(
    { provider: "kiro", model: "gpt-5.6-terra" },
    clobberedBody,
    "gpt-5.6-terra"
  );
  assert.equal(
    setupClobbered.requestedModel,
    "kiro/gpt-5.6-terra",
    "When body.model is clobbered to ${provider}/${model}, suffix is lost in requestedModel"
  );
});

test("Kiro payload translation: demonstrates thinking enabled when effort is propagated vs lost", () => {
  // Scenario A: Suffix lost, no reasoning_effort (Current bug behavior)
  const defectiveBody = {
    model: "kiro/gpt-5.6-terra",
    messages: [{ role: "user", content: "Hello" }],
  };
  const defectivePayload = buildKiroPayload("gpt-5.6-terra", defectiveBody, false, null);
  assert.equal(
    defectivePayload.additionalModelRequestFields,
    undefined,
    "Defective flow sends no additionalModelRequestFields"
  );
  assert.equal(
    /<thinking_mode>/.test(
      defectivePayload.conversationState.currentMessage.userInputMessage.content
    ),
    false,
    "Defective flow does not inject <thinking_mode>"
  );

  // Scenario B: Preserved suffix in body.model
  const preservedBody = {
    model: "kiro/gpt-5.6-terra-high",
    messages: [{ role: "user", content: "Hello" }],
  };
  const preservedPayload = buildKiroPayload("gpt-5.6-terra", preservedBody, false, null);
  assert.ok(preservedPayload.additionalModelRequestFields?.reasoning?.effort === "high");
  assert.match(
    preservedPayload.conversationState.currentMessage.userInputMessage.content,
    /<thinking_mode>enabled<\/thinking_mode>/
  );

  // Scenario C: Propagated reasoning_effort via applyDefaultReasoningEffort
  const appliedBody = applyDefaultReasoningEffort(
    { model: "gpt-5.6-terra", messages: [{ role: "user", content: "Hello" }] },
    "gpt-5.6-terra",
    "high"
  );
  assert.equal(appliedBody.reasoning_effort, "high");
  const appliedPayload = buildKiroPayload("gpt-5.6-terra", appliedBody, false, null);
  assert.ok(appliedPayload.additionalModelRequestFields?.reasoning?.effort === "high");
  assert.match(
    appliedPayload.conversationState.currentMessage.userInputMessage.content,
    /<thinking_mode>enabled<\/thinking_mode>/
  );
});
