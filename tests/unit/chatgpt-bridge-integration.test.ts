import assert from "node:assert/strict";
import { describe, test, beforeEach } from "node:test";
import { POST as pairHandler } from "@/app/api/chatgpt-bridge/pair/route.ts";
import { GET as pendingHandler } from "@/app/api/chatgpt-bridge/pending/route.ts";
import { POST as eventsHandler } from "@/app/api/chatgpt-bridge/events/route.ts";
import { POST as heartbeatHandler } from "@/app/api/chatgpt-bridge/heartbeat/route.ts";
import { ChatGptWebCompanionExecutor } from "@/../open-sse/executors/chatgpt-web-companion.ts";
import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer.ts";
import { AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR } from "@/server/authz/headers.ts";

describe("ChatGPT Bridge Full Integration Flow", () => {
  beforeEach(() => {
    globalThis.__omnirouteChatGptWebBridge = undefined;
  });

  test("end-to-end: pair -> heartbeat -> execute -> claim -> stream events -> complete", async () => {
    // 1. Extension pairs with the bridge via /api/chatgpt-bridge/pair
    const pairReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pair", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR]: "1",
      },
      body: JSON.stringify({
        label: "OmniRoute Companion Integration Test",
        availableModels: ["chatgpt-web", "companion"],
      }),
    });
    const pairRes = await pairHandler(pairReq);
    assert.equal(pairRes.status, 200);
    const pairData = (await pairRes.json()) as {
      ok: boolean;
      session: { sessionToken: string; label: string };
    };
    assert.equal(pairData.ok, true);
    const sessionToken = pairData.session.sessionToken;

    // 2. Extension sends heartbeat
    const hbReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": sessionToken,
      },
      body: JSON.stringify({ tabId: 42 }),
    });
    const hbRes = await heartbeatHandler(hbReq);
    assert.equal(hbRes.status, 200);

    // 3. Client executes request via ChatGptWebCompanionExecutor with streaming
    const executor = new ChatGptWebCompanionExecutor();
    const executePromise = executor.execute({
      body: {
        messages: [{ role: "user", content: "Write a short poem about code" }],
      },
      model: "chatgpt-web",
      stream: true,
    });

    // Small delay to allow executor to enqueue turn
    await new Promise((r) => setTimeout(r, 20));

    // 4. Extension claims pending turn via /api/chatgpt-bridge/pending
    const pendingReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pending?wait=false", {
      headers: { "x-bridge-token": sessionToken },
    });
    const pendingRes = await pendingHandler(pendingReq);
    assert.equal(pendingRes.status, 200);
    const pendingData = (await pendingRes.json()) as {
      ok: boolean;
      claimed: { turn: { id: string; prompt: string }; leaseToken: string };
    };
    assert.equal(pendingData.ok, true);
    assert.ok(pendingData.claimed !== null);
    assert.ok(pendingData.claimed.turn.prompt.includes("Write a short poem about code"));

    const turnId = pendingData.claimed.turn.id;
    const leaseToken = pendingData.claimed.leaseToken;

    // 5. Extension streams thinking delta via /api/chatgpt-bridge/events
    const thinkingReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": sessionToken,
      },
      body: JSON.stringify({
        turnId,
        leaseToken,
        type: "reasoning_delta",
        delta: "Thinking about rhymes...",
      }),
    });
    const thinkingRes = await eventsHandler(thinkingReq);
    assert.equal(thinkingRes.status, 200);

    // 6. Extension streams text deltas via /api/chatgpt-bridge/events
    const textDeltaReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": sessionToken,
      },
      body: JSON.stringify({
        turnId,
        leaseToken,
        type: "text_delta",
        delta: "Lines of code in the dark,\n",
      }),
    });
    const textDeltaRes = await eventsHandler(textDeltaReq);
    assert.equal(textDeltaRes.status, 200);

    // 7. Extension finishes turn via /api/chatgpt-bridge/events
    const finishReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": sessionToken,
      },
      body: JSON.stringify({
        turnId,
        leaseToken,
        type: "completed",
        finishReason: "stop",
      }),
    });
    const finishRes = await eventsHandler(finishReq);
    assert.equal(finishRes.status, 200);

    // 8. Client receives full SSE response
    const result = await executePromise;
    assert.equal(result.response.status, 200);
    const text = await result.response.text();
    assert.ok(text.includes("data: "));
    assert.ok(text.includes("Lines of code in the dark"));
    assert.ok(text.includes("[DONE]"));
  });

  test("cancellation flow: aborted client request marks turn cancelled in bridge", async () => {
    const bridge = getChatGptWebBridge();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code, { availableModels: ["companion"] });

    const abortController = new AbortController();
    const executor = new ChatGptWebCompanionExecutor();

    const executePromise = executor.execute({
      body: {
        messages: [{ role: "user", content: "Long calculation" }],
      },
      model: "companion",
      stream: true,
      signal: abortController.signal,
    });

    await new Promise((r) => setTimeout(r, 20));

    const claimed = bridge.claimNextTurn(session.sessionToken);
    assert.ok(claimed !== null);

    // Abort client request
    abortController.abort();

    const result = await executePromise;
    const text = await result.response.text();
    assert.ok(text.includes("cancelled") || text.includes("[DONE]"));

    const snapshot = bridge.getTurnSnapshot(claimed.turn.id);
    assert.equal(snapshot?.status, "cancelled");
  });
});
