import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  ChatGptWebCompanionExecutor,
  extractPromptFromInput,
} from "@/../open-sse/executors/chatgpt-web-companion.ts";
import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer.ts";

describe("ChatGptWebCompanionExecutor", () => {
  let executor: ChatGptWebCompanionExecutor;

  beforeEach(() => {
    executor = new ChatGptWebCompanionExecutor();
    // Reset process-wide bridge instance for clean test isolation
    globalThis.__omnirouteChatGptWebBridge = undefined;
  });

  test("removes OpenCode's generated runtime envelope before sending a browser prompt", () => {
    const runtimeEnvelope = [
      "You are OpenCode, You and the user share the same workspace.",
      "You are powered by the model named chatgpt-web-companion/companion.",
      "The exact model ID is omniroute-codex/chatgpt-web-companion/companion.",
      "Here is some useful information about the environment.",
      "x".repeat(9_000),
    ].join("\n\n");

    assert.deepEqual(
      extractPromptFromInput({
        messages: [
          { role: "system", content: runtimeEnvelope },
          { role: "user", content: "Reply with OPENCODE_RUN_AGENT_OK" },
        ],
      }),
      { prompt: "Reply with OPENCODE_RUN_AGENT_OK" }
    );
  });

  test("retains a custom OpenCode agent preamble while removing its generated tail", () => {
    const runtimeEnvelope = [
      "Answer concisely and do not call tools.",
      "You are powered by the model named chatgpt-web-companion/companion.",
      "The exact model ID is omniroute-codex/chatgpt-web-companion/companion.",
      "Here is some useful information about the environment.",
      "x".repeat(9_000),
    ].join("\n\n");

    assert.deepEqual(
      extractPromptFromInput({
        messages: [
          { role: "system", content: runtimeEnvelope },
          { role: "user", content: "Say hello" },
        ],
      }),
      { prompt: "[System: Answer concisely and do not call tools.]\n\nSay hello" }
    );
  });

  test("returns 503 error response when no browser extension is active", async () => {
    const result = await executor.execute({
      body: {
        messages: [{ role: "user", content: "Hello ChatGPT" }],
      },
      model: "chatgpt-web",
      stream: false,
    });

    assert.equal(result.response.status, 503);
    const body = (await result.response.json()) as { error: { message: string; code: string } };
    assert.ok(body.error.message.includes("Companion extension is not connected"));
    assert.equal(body.error.code, "service_unavailable");
  });

  test("rejects an unsupported model before it can occupy the Companion queue", async () => {
    const bridge = getChatGptWebBridge();
    const { code } = bridge.createPairingCode();
    bridge.pairBrowser(code, { availableModels: ["gpt-4o"] });

    const result = await executor.execute({
      body: { messages: [{ role: "user", content: "Hello" }] },
      model: "o3-mini",
      stream: true,
    });

    assert.equal(result.response.status, 503);
    const body = (await result.response.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "model_not_supported");
    assert.match(body.error.message, /No connected ChatGPT Web Companion browser supports/);
    assert.equal(bridge.getStatus().queuedTurnCount, 0);
  });

  test("streams SSE completion chunks when browser processes turn", async () => {
    const bridge = getChatGptWebBridge();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code, { availableModels: ["chatgpt-web"] });

    // Execute in background
    const executePromise = executor.execute({
      body: {
        messages: [
          { role: "system", content: "Be concise" },
          { role: "user", content: "Say hi" },
        ],
      },
      model: "chatgpt-web",
      stream: true,
    });

    // Simulate extension claiming turn and streaming deltas
    await new Promise((r) => setTimeout(r, 10));
    const claimed = bridge.claimNextTurn(session.sessionToken);
    assert.ok(claimed !== null);
    assert.ok(claimed.turn.prompt.includes("Say hi"));

    bridge.appendTurnEvent(session.sessionToken, claimed.turn.id, claimed.leaseToken, {
      type: "text_delta",
      delta: "Hello ",
    });
    bridge.appendTurnEvent(session.sessionToken, claimed.turn.id, claimed.leaseToken, {
      type: "text_delta",
      delta: "from ChatGPT Web!",
    });
    bridge.appendTurnEvent(session.sessionToken, claimed.turn.id, claimed.leaseToken, {
      type: "completed",
      finishReason: "stop",
    });

    const result = await executePromise;
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get("Content-Type"), "text/event-stream; charset=utf-8");

    // Read full stream
    const reader = result.response.body?.getReader();
    assert.ok(reader !== undefined);
    const decoder = new TextDecoder();
    let streamText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    assert.ok(streamText.includes("Hello "));
    assert.ok(streamText.includes("from ChatGPT Web!"));
    assert.ok(streamText.includes("data: [DONE]"));
  });

  test("returns complete JSON response for non-streaming execution", async () => {
    const bridge = getChatGptWebBridge();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);

    const executePromise = executor.execute({
      body: {
        messages: [{ role: "user", content: "Test JSON response" }],
      },
      model: "chatgpt-web",
      stream: false,
    });

    await new Promise((r) => setTimeout(r, 10));
    const claimed = bridge.claimNextTurn(session.sessionToken);
    assert.ok(claimed !== null);

    bridge.appendTurnEvent(session.sessionToken, claimed.turn.id, claimed.leaseToken, {
      type: "text_delta",
      delta: "Full text content",
    });
    bridge.appendTurnEvent(session.sessionToken, claimed.turn.id, claimed.leaseToken, {
      type: "completed",
      finishReason: "stop",
    });

    const result = await executePromise;
    assert.equal(result.response.status, 200);

    const body = (await result.response.json()) as {
      choices: Array<{ message: { content: string; role: string } }>;
      object: string;
    };
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.role, "assistant");
    assert.equal(body.choices[0].message.content, "Full text content");
  });

  test("cancels bridge turn when execution signal aborts", async () => {
    const bridge = getChatGptWebBridge();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);

    const abortController = new AbortController();

    const executePromise = executor.execute({
      body: {
        messages: [{ role: "user", content: "Abort me" }],
      },
      model: "chatgpt-web",
      stream: true,
      signal: abortController.signal,
    });

    await new Promise((r) => setTimeout(r, 10));
    const claimed = bridge.claimNextTurn(session.sessionToken);
    assert.ok(claimed !== null);

    // Abort from client side
    abortController.abort();

    const result = await executePromise;
    const reader = result.response.body?.getReader();
    assert.ok(reader !== undefined);
    const decoder = new TextDecoder();
    let streamText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamText += decoder.decode(value, { stream: true });
    }

    assert.ok(streamText.includes("Turn cancelled") || streamText.includes("[DONE]"));

    const snapshot = bridge.getTurnSnapshot(claimed.turn.id);
    assert.equal(snapshot?.status, "cancelled");
  });
});
