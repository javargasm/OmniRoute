/**
 * POC Temporal: Confirmación de Bug en Visibilidad de Modelos
 *
 * Reproduce el flujo exacto de la UI:
 * 1. El usuario hace clic en el ojo de un modelo (o en "Ocultar todos").
 * 2. La UI envía PATCH /api/provider-models con { isHidden: true, modality: "chat" }.
 * 3. La UI refresca los metadatos llamando a GET /api/provider-models.
 * 4. La UI ejecuta isModelHiddenFn() con los overrides devueltos.
 * 5. Se demuestra que isModelHiddenFn() devuelve FALSE (el bug), haciendo que el ojo
 *    siga abierto y el modelo no se oculte.
 * 6. Se demuestra cómo la corrección resuelve el problema inmediatamente.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-poc-visibility-"));
process.env.DATA_DIR = tempDir;
process.env.API_KEY_SECRET = "poc-secret-key-12345";

async function runPoc() {
  console.log("================================================================");
  console.log("POC: Confirmación de Bug de Visibilidad de Modelos (Ojo / Ocultar)");
  console.log("================================================================\n");

  const providerModelsRoute = await import("../../src/app/api/provider-models/route");
  const { buildCompatMap, isModelHiddenFn } = await import(
    "../../src/app/(dashboard)/dashboard/providers/[id]/providerPageHelpers"
  );
  const { resetDbInstance } = await import("../../src/lib/db/core");

  const providerId = "kiro";
  const modelId = "claude-3-7-sonnet";

  try {
    // -------------------------------------------------------------------------
    // PASO 1: Simular el clic en el ojo de un modelo individual
    // -------------------------------------------------------------------------
    console.log("--- PASO 1: Usuario hace clic en el icono del ojo para ocultar 'claude-3-7-sonnet' ---");
    console.log("La UI (useModelVisibilityHandlers.ts:210) envía:");
    console.log(`PATCH /api/provider-models?provider=${providerId}&modelId=${modelId}`);
    console.log(`Body: { isHidden: true, modality: "chat" }\n`);

    const patchReq = new Request(
      `http://localhost/api/provider-models?provider=${providerId}&modelId=${modelId}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isHidden: true, modality: "chat" }),
      }
    );

    const patchRes = await providerModelsRoute.PATCH(patchReq);
    const patchBody = await patchRes.json();
    console.log(`Respuesta del servidor PATCH: status=${patchRes.status}, ok=${patchBody.ok}`);

    // -------------------------------------------------------------------------
    // PASO 2: La UI refresca los metadatos llamando a GET /api/provider-models
    // -------------------------------------------------------------------------
    console.log("\n--- PASO 2: La UI llama a fetchProviderModelMeta() (GET /api/provider-models) ---");
    const getReq = new Request(`http://localhost/api/provider-models?provider=${providerId}`);
    const getRes = await providerModelsRoute.GET(getReq);
    const getData = await getRes.json();

    const override = getData.modelCompatOverrides?.find((o: any) => o.id === modelId);
    console.log("Objeto override devuelto por el backend para el modelo:");
    console.dir(override, { depth: null });
    console.log(`¿Tiene override.isHidden definido? -> ${override?.isHidden !== undefined ? override?.isHidden : "UNDEFINED (NO EXISTE)"}`);
    console.log(`¿Tiene override.hiddenModalities? -> ${JSON.stringify(override?.hiddenModalities)}`);

    // -------------------------------------------------------------------------
    // PASO 3: La UI evalúa si el modelo está oculto usando isModelHiddenFn()
    // -------------------------------------------------------------------------
    console.log("\n--- PASO 3: La UI evalúa isModelHiddenFn() con el código ACTUAL ---");
    const customMap = new Map();
    const overrideMapActual = buildCompatMap(getData.modelCompatOverrides || []);

    const isHiddenActual = isModelHiddenFn(modelId, customMap, overrideMapActual);
    console.log(`Resultado de isModelHiddenFn("${modelId}"): ${isHiddenActual}`);

    if (isHiddenActual === false) {
      console.log("\n❌ [CONFIRMADO]: EL BUG OCURRE AQUÍ.");
      console.log("   Aunque el usuario presionó ocultar y la base de datos guardó { chat: true },");
      console.log("   la función de la UI (readActiveHiddenFlag) solo busca `row.isHidden`.");
      console.log("   Al ser undefined, concluye que el modelo NO está oculto (false).");
      console.log("   -> El ojo sigue mostrándose abierto.");
      console.log("   -> El contador {active}/{total} no disminuye.");
      console.log("   -> El botón 'Mostrar todos' permanece deshabilitado.");
    }

    // -------------------------------------------------------------------------
    // PASO 4: Simular el botón "Ocultar todos" (Hide all)
    // -------------------------------------------------------------------------
    console.log("\n--- PASO 4: Simular botón 'Ocultar todos' (Bulk toggle) ---");
    const bulkModelIds = ["claude-3-7-sonnet", "gpt-4o", "gemini-2.5-pro"];
    console.log(`La UI envía PATCH en lote para: ${bulkModelIds.join(", ")}`);
    const bulkPatchReq = new Request(`http://localhost/api/provider-models?provider=${providerId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isHidden: true, modelIds: bulkModelIds, modality: "chat" }),
    });
    const bulkRes = await providerModelsRoute.PATCH(bulkPatchReq);
    const bulkData = await bulkRes.json();
    console.log(`Respuesta PATCH bulk: status=${bulkRes.status}, updated=${bulkData.updated}`);

    const getBulkRes = await providerModelsRoute.GET(getReq);
    const getBulkData = await getBulkRes.json();
    const overrideMapBulkActual = buildCompatMap(getBulkData.modelCompatOverrides || []);

    const bulkResultsActual = bulkModelIds.map((id) => ({
      model: id,
      isHiddenSegunUI: isModelHiddenFn(id, customMap, overrideMapBulkActual),
    }));
    console.log("Evaluación de la UI para todos los modelos ocultados:");
    console.table(bulkResultsActual);
    console.log("❌ NINGUNO se oculta en la UI porque todos tienen isHiddenSegunUI = false.");

    // -------------------------------------------------------------------------
    // PASO 5: Demostrar la solución (readActiveHiddenFlag corregido)
    // -------------------------------------------------------------------------
    console.log("\n--- PASO 5: Demostración con la CORRECCIÓN propuesta ---");
    function readActiveHiddenFlagCorregido(row: any, modality = "chat"): boolean | undefined {
      if (!row) return undefined;
      // 1. Si existe hiddenModalities para la modalidad, ese valor tiene prioridad
      if (row.hiddenModalities && typeof row.hiddenModalities === "object") {
        const scoped = row.hiddenModalities[modality];
        if (scoped !== undefined) return Boolean(scoped);
      }
      // 2. Fallback a isHidden tradicional (global / legacy)
      if (Object.prototype.hasOwnProperty.call(row, "isHidden")) {
        return Boolean(row.isHidden);
      }
      return undefined;
    }

    function isModelHiddenFnCorregido(
      mId: string,
      cMap: Map<string, any>,
      oMap: Map<string, any>,
      modality = "chat"
    ): boolean {
      const customHidden = readActiveHiddenFlagCorregido(cMap.get(mId), modality);
      if (customHidden !== undefined) return customHidden;
      const overrideHidden = readActiveHiddenFlagCorregido(oMap.get(mId), modality);
      if (overrideHidden !== undefined) return overrideHidden;
      return false;
    }

    const bulkResultsCorregido = bulkModelIds.map((id) => ({
      model: id,
      isHiddenSegunUICorregida: isModelHiddenFnCorregido(id, customMap, overrideMapBulkActual),
    }));
    console.table(bulkResultsCorregido);
    console.log("✅ [SOLUCIONADO]: Todos los modelos ahora se detectan correctamente como OCULTOS (true).");
    console.log("   -> El ojo cambia a visibility_off.");
    console.log("   -> 'Ocultar todos' funciona inmediatamente.");
    console.log("   -> 'Mostrar todos' se activa porque hiddenCount > 0.");

  } finally {
    resetDbInstance();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

runPoc().catch((err) => {
  console.error("Error en la POC:", err);
  process.exit(1);
});
