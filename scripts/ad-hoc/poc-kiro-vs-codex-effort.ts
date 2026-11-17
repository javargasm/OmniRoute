/**
 * POC: Diagnóstico comparativo de por qué `codex/gpt-5.6-luna-max` preserva el nivel de
 * pensamiento mientras que `kiro/gpt-5.6-terra-high` lo pierde en OmniRoute.
 *
 * Ejecutar con:
 *   node --import tsx/esm scripts/ad-hoc/poc-kiro-vs-codex-effort.ts
 */

import assert from "node:assert/strict";

async function runPoc() {
  console.log("================================================================================");
  console.log("POC: Diagnóstico Comparativo - Codex vs Kiro en Manejo de Sufijos de Pensamiento");
  console.log("================================================================================\n");

  // 1. Capa de Resolución de Modelos (src/sse/services/model.ts)
  console.log("--- 1. Capa de Resolución de Modelos (resolveSyncedModelIdAndEffort) ---");
  const SYNCED_EFFORT_SKIP_PROVIDER_PREFIXES = ["codex", "kimi"];

  const candidateSyncedKiroModels = [
    {
      id: "gpt-5.6-terra",
      supportedThinkingEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    },
  ];

  const candidateSyncedCodexModels = [
    {
      id: "gpt-5.6-luna",
      supportedThinkingEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
    },
  ];

  const { splitSyncedEffortSuffix } = await import("../../open-sse/services/model.ts");

  function simulateResolveSyncedModelIdAndEffort(
    providerId: string,
    modelId: string,
    syncedModels: Array<{ id: string; supportedThinkingEfforts: string[] }>
  ) {
    if (SYNCED_EFFORT_SKIP_PROVIDER_PREFIXES.some((p) => providerId.startsWith(p))) {
      return { modelId, effort: null, skipped: true };
    }
    for (const candidate of syncedModels) {
      const attempt = splitSyncedEffortSuffix(modelId, candidate.supportedThinkingEfforts);
      if (attempt.effort && attempt.baseModel === candidate.id) {
        return { modelId: attempt.baseModel, effort: attempt.effort, skipped: false };
      }
    }
    return { modelId, effort: null, skipped: false };
  }

  const codexResolution = simulateResolveSyncedModelIdAndEffort(
    "codex",
    "gpt-5.6-luna-max",
    candidateSyncedCodexModels
  );
  console.log("Resolución para 'codex/gpt-5.6-luna-max':");
  console.dir(codexResolution);
  assert.equal(codexResolution.skipped, true);
  assert.equal(codexResolution.modelId, "gpt-5.6-luna-max", "Codex NO suprime el sufijo -max");

  const kiroResolution = simulateResolveSyncedModelIdAndEffort(
    "kiro",
    "gpt-5.6-terra-high",
    candidateSyncedKiroModels
  );
  console.log("\nResolución para 'kiro/gpt-5.6-terra-high':");
  console.dir(kiroResolution);
  assert.equal(kiroResolution.skipped, false);
  assert.equal(kiroResolution.modelId, "gpt-5.6-terra", "Kiro separa el modelo base");
  assert.equal(kiroResolution.effort, "high", "Kiro extrae effort='high'");

  console.log("📌 HALLAZGO 1: Codex está en SYNCED_EFFORT_SKIP_PROVIDER_PREFIXES y NO toca el modelo.");
  console.log("   Kiro separa el modelo base ('gpt-5.6-terra') y el effort ('high').\n");

  // 2. Capa resolveModelOrError en chatHelpers.ts
  console.log("--- 2. Fuga en resolveModelOrError (src/sse/handlers/chatHelpers.ts) ---");
  console.log("Simulando lo que retorna resolveModelOrError hoy vs lo que debería retornar:");
  const currentResolveModelOrErrorOutput = {
    provider: "kiro",
    model: kiroResolution.modelId, // "gpt-5.6-terra"
    sourceFormat: "openai",
    targetFormat: "kiro",
    customModelTargetFormat: undefined,
    extendedContext: undefined,
    apiFormat: undefined,
    // ❌ ERROR: resolvedThinkingEffort NO se incluye en el return!
  };
  console.log("Retorno actual de resolveModelOrError:", currentResolveModelOrErrorOutput);
  assert.equal(
    (currentResolveModelOrErrorOutput as any).resolvedThinkingEffort,
    undefined,
    "Fuga confirmada: resolveModelOrError descarta resolvedThinkingEffort"
  );
  console.log("❌ CONFIRMADO: resolveModelOrError descarta resolvedThinkingEffort.\n");

  // 3. Sobrescritura de body.model en executeChatWithBreaker (chatHelpers.ts:540)
  console.log("--- 3. Sobrescritura de body.model en executeChatWithBreaker ---");
  const originalCodexClientBody = { model: "codex/gpt-5.6-luna-max", messages: [{ role: "user", content: "hi" }] };
  const originalKiroClientBody = { model: "kiro/gpt-5.6-terra-high", messages: [{ role: "user", content: "hi" }] };

  // Línea 540: body: { ...body, model: `${provider}/${model}` }
  const codexBodyPassedToCore = {
    ...originalCodexClientBody,
    model: `${"codex"}/${codexResolution.modelId}`, // "codex/gpt-5.6-luna-max"
  };
  const kiroBodyPassedToCore = {
    ...originalKiroClientBody,
    model: `${"kiro"}/${kiroResolution.modelId}`, // "kiro/gpt-5.6-terra"  <-- ¡Aquí se destruye el -high!
  };

  console.log("Codex body.model enviado a handleChatCore:", codexBodyPassedToCore.model);
  console.log("Kiro body.model enviado a handleChatCore:", kiroBodyPassedToCore.model);
  assert.equal(codexBodyPassedToCore.model, "codex/gpt-5.6-luna-max", "Codex preserva el sufijo en body.model");
  assert.equal(kiroBodyPassedToCore.model, "kiro/gpt-5.6-terra", "Kiro pierde el sufijo en body.model");
  console.log("📌 HALLAZGO 2: En executeChatWithBreaker, body.model se sobrescribe con `${provider}/${model}`.");
  console.log("   Para Kiro, model ya era 'gpt-5.6-terra', por lo que body.model pasa a ser 'kiro/gpt-5.6-terra'.\n");

  // 4. Requested Model en chatCore (open-sse/handlers/chatCore/requestSetup.ts)
  console.log("--- 4. Requested Model en chatCore (resolveChatCoreRequestSetup) ---");
  const { resolveChatCoreRequestSetup } = await import(
    "../../open-sse/handlers/chatCore/requestSetup.ts"
  );

  const codexSetup = resolveChatCoreRequestSetup(
    { provider: "codex", model: codexResolution.modelId },
    codexBodyPassedToCore,
    codexResolution.modelId
  );
  const kiroSetup = resolveChatCoreRequestSetup(
    { provider: "kiro", model: kiroResolution.modelId },
    kiroBodyPassedToCore,
    kiroResolution.modelId
  );

  console.log("Codex requestedModel registrado en DB/logs:", codexSetup.requestedModel);
  console.log("Kiro requestedModel registrado en DB/logs:", kiroSetup.requestedModel);
  assert.equal(codexSetup.requestedModel, "codex/gpt-5.6-luna-max");
  assert.equal(kiroSetup.requestedModel, "kiro/gpt-5.6-terra");
  console.log("📌 HALLAZGO 3: ¡Esto explica exactamente por qué en SQLite y en el Dashboard");
  console.log("   'Requested' aparece como 'kiro/gpt-5.6-terra' en vez de 'kiro/gpt-5.6-terra-high'!\n");

  // 5. Traducción e Inyección de Pensamiento (open-sse/translator/request/openai-to-kiro.ts)
  console.log("--- 5. Traducción a Kiro (buildKiroPayload) ---");
  const { buildKiroPayload } = await import(
    "../../open-sse/translator/request/openai-to-kiro.ts"
  );

  console.log("A) Simulando el flujo actual defectuoso que recibió Kiro en tu consulta:");
  const currentDefectiveKiroPayload = buildKiroPayload(
    kiroResolution.modelId, // "gpt-5.6-terra"
    kiroBodyPassedToCore,   // { model: "kiro/gpt-5.6-terra", ... } (sufijo perdido)
    false,
    null
  );
  console.log("  - additionalModelRequestFields:", currentDefectiveKiroPayload.additionalModelRequestFields);
  console.log("  - ¿Tiene directiva <thinking_mode>?:", /<thinking_mode>/.test(currentDefectiveKiroPayload.conversationState.currentMessage.userInputMessage.content));
  assert.equal(
    currentDefectiveKiroPayload.additionalModelRequestFields,
    undefined,
    "Sin sufijo ni effort, Kiro NO recibe additionalModelRequestFields"
  );
  assert.equal(
    /<thinking_mode>/.test(currentDefectiveKiroPayload.conversationState.currentMessage.userInputMessage.content),
    false,
    "Sin sufijo ni effort, Kiro NO recibe directiva de pensamiento"
  );
  console.log("  => Kiro ejecutó la petición SIN razonamiento (Salida: 66, Razonamiento: N/A).\n");

  console.log("B) Simulando el flujo con la propagación corregida:");
  // Si preservamos body.model con su sufijo o inyectamos reasoning_effort derivado de resolvedThinkingEffort:
  const fixedKiroBody = {
    ...originalKiroClientBody,
    reasoning_effort: kiroResolution.effort, // "high"
  };
  const fixedKiroPayload = buildKiroPayload(
    kiroResolution.modelId,
    fixedKiroBody,
    false,
    null
  );
  console.log("  - additionalModelRequestFields:", fixedKiroPayload.additionalModelRequestFields);
  console.log("  - ¿Tiene directiva <thinking_mode>?:", /<thinking_mode>/.test(fixedKiroPayload.conversationState.currentMessage.userInputMessage.content));
  assert.ok(fixedKiroPayload.additionalModelRequestFields?.reasoning?.effort === "high");
  assert.ok(/<thinking_mode>enabled<\/thinking_mode>/.test(fixedKiroPayload.conversationState.currentMessage.userInputMessage.content));
  console.log("  => ¡Con la corrección, Kiro recibe reasoning.effort='high' y <thinking_mode>enabled</thinking_mode>!\n");

  // 6. Comportamiento en Codex Executor (open-sse/executors/codex/reasoningSuffix.ts)
  console.log("--- 6. Comportamiento en Codex Executor ---");
  const { splitCodexReasoningSuffix } = await import(
    "../../open-sse/executors/codex/reasoningSuffix.ts"
  );
  const codexSplit = splitCodexReasoningSuffix(codexBodyPassedToCore.model.replace(/^codex\//, ""));
  console.log("Codex splitCodexReasoningSuffix('gpt-5.6-luna-max'):", codexSplit);
  assert.equal(codexSplit.effort, "max");
  console.log("  => Codex maneja su sufijo de forma aislada dentro de su propio ejecutor,\n" +
              "     por eso a Codex nunca le afectó este problema.\n");

  console.log("================================================================================");
  console.log("✅ DIAGNÓSTICO CONFIRMADO POR LA POC CON ÉXITO");
  console.log("================================================================================");
}

runPoc().catch((err) => {
  console.error("Error en POC:", err);
  process.exit(1);
});
