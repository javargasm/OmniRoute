import test from "node:test";
import assert from "node:assert/strict";
import { createChatPipelineHarness } from "../integration/_chatPipelineHarness.ts";

const harness = await createChatPipelineHarness("kiro-synced-effort-wire");
const { BaseExecutor, buildRequest, cleanup, resetStorage, seedConnection } = harness;
const chatRoute = await import("../../src/app/api/v1/chat/completions/route.ts");

function readReasoning(body: Record<string, unknown>): { effort?: string } | undefined {
  return (body.additionalModelRequestFields as { reasoning?: { effort?: string } } | undefined)
    ?.reasoning;
}

function readContent(body: Record<string, unknown>): string {
  const state = body.conversationState as Record<string, unknown> | undefined;
  const current = state?.currentMessage as Record<string, unknown> | undefined;
  const input = current?.userInputMessage as Record<string, unknown> | undefined;
  return String(input?.content ?? "");
}

test("Kiro GPT-5.6 effort aliases reach the wire payload after model resolution", async () => {
  const originalFetch = globalThis.fetch;
  const observations: Array<{ effort: string; reasoning?: { effort?: string }; content: string }> =
    [];

  try {
    BaseExecutor.RETRY_CONFIG.delayMs = 0;
    for (const effort of ["none", "low", "medium", "high", "xhigh", "max"]) {
      await resetStorage();
      await seedConnection("kiro", {
        apiKey: `kiro-effort-${effort}`,
        providerSpecificData: { authMethod: "api_key" },
      });
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        assert.ok(init?.body);
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        observations.push({ effort, reasoning: readReasoning(body), content: readContent(body) });
        return new Response("wire capture", { status: 400 });
      }) as typeof fetch;

      const response = await chatRoute.POST(
        buildRequest({
          body: {
            model: `kr/gpt-5.6-sol-${effort}`,
            stream: false,
            messages: [{ role: "user", content: "wire capture" }],
          },
        })
      );
      assert.ok(response.status >= 400);
    }

    assert.equal(observations.length, 6);
    for (const observation of observations) {
      assert.deepEqual(observation.reasoning, { effort: observation.effort });
      assert.equal(
        /<thinking_mode>enabled<\/thinking_mode>/.test(observation.content),
        observation.effort !== "none"
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});
