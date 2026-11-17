import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-custom-effort-"));
process.env.DATA_DIR = dataDir;
const core = await import("../../src/lib/db/core.ts");
const { handleChatCore } = await import("../../open-sse/handlers/chatCore.ts");
const { closeCallLogSaves } = await import("../../src/lib/usage/callLogs.ts");
const originalFetch = globalThis.fetch;

test.after(async () => {
  globalThis.fetch = originalFetch;
  await closeCallLogSaves();
  core.resetDbInstance();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

for (const model of ["claude-sonnet-5-5-high", "claude-opus-5-5-high"]) {
  test(`custom OpenAI endpoint receives literal ${model} without suffix-derived effort`, async () => {
    const captured: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body === "string") {
        captured.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      return new Response(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          model,
          choices: [
            { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        }),
        { headers: { "content-type": "application/json" } }
      );
    }) as typeof fetch;
    const body = {
      model: `tx/${model}`,
      stream: false,
      messages: [{ role: "user", content: "Reply pong" }],
    };
    await handleChatCore({
      body: structuredClone(body),
      modelInfo: { provider: "openai-compatible-tx", model, extendedContext: false },
      credentials: {
        apiKey: "test-key",
        providerSpecificData: { baseUrl: "https://custom.example.test/v1", prefix: "tx" },
      },
      clientRawRequest: {
        endpoint: "/v1/chat/completions",
        body: structuredClone(body),
        headers: new Headers({ accept: "application/json" }),
      },
      userAgent: "unit-test",
      log: { debug() {}, info() {}, warn() {}, error() {} },
    } as never);
    assert.ok(captured.length > 0, "expected a mocked upstream request");
    for (const payload of captured) {
      assert.equal(payload.model, model);
      assert.notEqual(payload.reasoning_effort, "high", "literal tier must not become effort");
    }
  });
}
