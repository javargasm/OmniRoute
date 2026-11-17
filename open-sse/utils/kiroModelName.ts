const BRAND_NAMES: Record<string, string> = {
  claude: "Claude",
  gpt: "GPT",
  deepseek: "DeepSeek",
  minimax: "MiniMax",
  glm: "GLM",
  qwen3: "Qwen3",
};

/** Normalize both live discovery labels and persisted legacy credit labels. */
export function formatKiroModelName(
  name: string,
  modelId: string,
  rateMultiplier?: unknown,
  registeredName?: string
): string {
  let base = (name || modelId).trim().replace(/^Kiro\s+/i, "");
  const credit = base.match(
    /\s*\((?:([0-9]{1,4}(?:\.[0-9]{1,4})?)x credit|x([0-9]{1,4}(?:\.[0-9]{1,4})?))\)$/i
  );
  if (credit) base = base.slice(0, credit.index).trim();
  const rate = Number(rateMultiplier ?? credit?.[1] ?? credit?.[2]);
  if (base === modelId && registeredName) base = registeredName;
  else if (base === modelId && BRAND_NAMES[modelId.split("-")[0]]) {
    base = modelId
      .split("-")
      .map((part) => BRAND_NAMES[part] || part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return Number.isFinite(rate) && rate > 0 && Math.abs(rate - 1) > 1e-9
    ? `${base} (x${rate.toFixed(1)})`
    : base;
}
