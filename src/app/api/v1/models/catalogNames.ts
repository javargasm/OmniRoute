import { getProviderModels } from "@omniroute/open-sse/config/providerModels";
import { formatKiroModelName } from "@omniroute/open-sse/utils/kiroModelName";
import { getManagedModelAliasNames, getModelAliases } from "@/lib/db/models/aliases";
import { DEFAULT_MODEL_ALIAS_SEED } from "@/lib/modelAliasSeed";

type Entry = Record<string, unknown>;

export async function applyCatalogModelNames(
  models: Entry[],
  aliasToProviderId: Record<string, string>,
  providerNodeIdsByPrefix: Record<string, string> = {},
  aliases?: Record<string, unknown>
): Promise<Entry[]> {
  const storedAliases = aliases ?? (await getModelAliases());
  const managedAliases = await getManagedModelAliasNames();
  const canonical = (provider: string) =>
    providerNodeIdsByPrefix[provider] || aliasToProviderId[provider] || provider;
  const manualNames = new Map<string, string>();
  for (const [name, target] of Object.entries(storedAliases)) {
    if (typeof target !== "string" || managedAliases.has(name) || !name.trim()) continue;
    const slash = target.indexOf("/");
    if (slash < 1) continue;
    const modelId = target.slice(slash + 1);
    const aliasModelId = name.slice(name.lastIndexOf("/") + 1);
    if (
      aliasModelId === modelId ||
      aliasModelId === modelId.split("/").pop() ||
      (DEFAULT_MODEL_ALIAS_SEED as Record<string, string>)[name] === target
    )
      continue;
    manualNames.set(`${canonical(target.slice(0, slash))}/${modelId}`, name.trim());
  }
  const registryNames = new Map<string, Map<string, string>>();
  return models.map((entry) => {
    if (entry.owned_by === "combo") {
      const name = typeof entry.display_name === "string" ? entry.display_name : entry.id;
      return typeof name === "string" ? { ...entry, name } : entry;
    }
    if (typeof entry.id !== "string" || typeof entry.owned_by !== "string") return entry;
    const provider = canonical(entry.owned_by);
    const publicModelId = entry.id.slice(entry.id.indexOf("/") + 1);
    const modelId = typeof entry.root === "string" ? entry.root : publicModelId;
    if (!registryNames.has(provider)) {
      registryNames.set(provider, new Map(getProviderModels(provider).map((m) => [m.id, m.name])));
    }
    const registeredName =
      registryNames.get(provider)?.get(modelId) || registryNames.get(provider)?.get(publicModelId);
    const existingName = typeof entry.name === "string" ? entry.name.trim() : "";
    let name =
      (existingName !== modelId && existingName !== publicModelId && existingName) ||
      registeredName ||
      modelId;
    if (provider === "kiro") name = formatKiroModelName(name, modelId, undefined, registeredName);
    name =
      manualNames.get(`${provider}/${modelId}`) ||
      manualNames.get(`${provider}/${publicModelId}`) ||
      name;
    return { ...entry, name };
  });
}
