import test from "node:test";
import assert from "node:assert/strict";

import { getCodexFastCostMultiplier } from "../../src/lib/usage/costCalculator.ts";

// https://developers.openai.com/codex/pricing: "Fast mode uses 2.5x the Standard credit
// rate for GPT-6 Astra, Sol, and Luna where available."
const GPT_6_MODELS = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const;

test("Codex Fast mode bills every GPT-6 model at 2.5x Standard, effort variants included", () => {
  for (const model of GPT_6_MODELS) {
    for (const id of [model, `${model}-high`, `${model}-max`]) {
      assert.equal(getCodexFastCostMultiplier("codex", id, "priority"), 2.5, `${id} priority`);
      assert.equal(getCodexFastCostMultiplier("cx", id, "fast"), 2.5, `${id} fast`);
      assert.equal(getCodexFastCostMultiplier("codex", id, "default"), 1, `${id} default`);
      assert.equal(getCodexFastCostMultiplier("codex", id, "flex"), 0.5, `${id} flex`);
    }
  }
});

test("Codex Fast multiplier stays scoped to Codex and leaves other models unchanged", () => {
  assert.equal(getCodexFastCostMultiplier("openai", "gpt-6-sol", "priority"), 1);
  assert.equal(getCodexFastCostMultiplier("codex", "gpt-5.6-luna", "priority"), 1.5);
  assert.equal(getCodexFastCostMultiplier("codex", "gpt-5.5", "priority"), 2.5);
  assert.equal(getCodexFastCostMultiplier("codex", "gpt-6-solar", "priority"), 1);
});
