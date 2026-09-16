import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { POST as pairHandler } from "@/app/api/chatgpt-bridge/pair/route.ts";
import { GET as pendingHandler } from "@/app/api/chatgpt-bridge/pending/route.ts";
import { POST as eventsHandler } from "@/app/api/chatgpt-bridge/events/route.ts";
import { POST as heartbeatHandler } from "@/app/api/chatgpt-bridge/heartbeat/route.ts";
import { POST as leaseHandler } from "@/app/api/chatgpt-bridge/lease/route.ts";
import { getChatGptWebBridge } from "@/lib/chatgptWebBridge/bridgeServer.ts";
import { createChatGptWebBridgeManagementHandlers } from "@/lib/chatgptWebBridge/managementApi.ts";
import { AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR } from "@/server/authz/headers.ts";

describe("ChatGPT Bridge Route Handlers", () => {
  beforeEach(() => {
    globalThis.__omnirouteChatGptWebBridge = undefined;
  });

  test("pair route rejects untrusted automatic pairing without creating a browser session", async () => {
    const res = await pairHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: "Untrusted Extension" }),
      })
    );

    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), {
      ok: false,
      error: "A pairing code is required outside loopback access",
    });
    const status = getChatGptWebBridge().getStatus();
    assert.equal(status.pairedBrowserCount, 0);
    assert.equal(status.activeBrowserCount, 0);
  });

  test("pair route accepts the trusted local auto-pair header", async () => {
    const res = await pairHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR]: "1",
        },
        body: JSON.stringify({ label: "Local Extension" }),
      })
    );

    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      ok: boolean;
      session: { sessionToken: string; label: string };
    };
    assert.equal(data.ok, true);
    assert.ok(data.session.sessionToken.length > 0);
    assert.equal(data.session.label, "Local Extension");
    assert.equal(getChatGptWebBridge().getStatus().pairedBrowserCount, 1);
  });

  test("pair route accepts a valid management-created pairing code", async () => {
    const management = createChatGptWebBridgeManagementHandlers({
      authorize: async () => null,
    });
    const pairing = await management.createPairing(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pairing", { method: "POST" })
    );
    assert.equal(pairing.status, 200);
    const { code } = (await pairing.json()) as { code: string };

    const res = await pairHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, label: "Approved Extension" }),
      })
    );

    assert.equal(res.status, 200);
    const data = (await res.json()) as {
      ok: boolean;
      session: { sessionToken: string; label: string };
    };
    assert.equal(data.ok, true);
    assert.ok(data.session.sessionToken.length > 0);
    assert.equal(data.session.label, "Approved Extension");
    assert.equal(getChatGptWebBridge().getStatus().pairedBrowserCount, 1);
  });

  test("heartbeat route updates browser lease", async () => {
    const bridge = getChatGptWebBridge();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);

    const req = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": session.sessionToken,
      },
      body: JSON.stringify({ label: "Updated Label" }),
    });

    const res = await heartbeatHandler(req);
    assert.equal(res.status, 200);

    const data = (await res.json()) as { ok: boolean; session: { label: string } };
    assert.equal(data.ok, true);
    assert.equal(data.session.label, "Updated Label");
  });

  test("bridge route errors sanitize unexpected error details", async () => {
    const res = await pairHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pair", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [AUTHZ_HEADER_CHATGPT_BRIDGE_AUTO_PAIR]: "1",
        },
        body: JSON.stringify({ label: "x".repeat(257) }),
      })
    );

    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: string; code?: string };
    assert.equal(body.code, "invalid_bridge_payload");
    assert.equal(body.error.includes("at /"), false);
  });

  test("client endpoints reject an expired extension session with 401", async () => {
    const headers = {
      "Content-Type": "application/json",
      "x-bridge-token": "stale-extension-session-token",
    };

    const heartbeatRes = await heartbeatHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/heartbeat", {
        method: "POST",
        headers,
        body: JSON.stringify({ label: "Stale Extension" }),
      })
    );
    assert.equal(heartbeatRes.status, 401);
    assert.equal((await heartbeatRes.json()).code, "extension_not_paired");

    const pendingRes = await pendingHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pending?wait=false", {
        headers,
      })
    );
    assert.equal(pendingRes.status, 401);
    assert.equal((await pendingRes.json()).code, "extension_not_paired");

    const eventRes = await eventsHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/events", {
        method: "POST",
        headers,
        body: JSON.stringify({
          turnId: "turn_stale",
          leaseToken: "lease_stale",
          type: "text_delta",
          delta: "ignored",
        }),
      })
    );
    assert.equal(eventRes.status, 401);
    assert.equal((await eventRes.json()).code, "extension_not_paired");
  });

  test("an aborted waiting poll leaves a later turn for the reconnecting browser", async () => {
    const bridge = getChatGptWebBridge();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);
    const abortController = new AbortController();

    const waitingPoll = pendingHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pending?wait=true&timeout=1000", {
        headers: { "x-bridge-token": session.sessionToken },
        signal: abortController.signal,
      })
    );

    abortController.abort();
    const turn = bridge.enqueueTurn({
      requestId: "route-aborted-wait",
      model: "chatgpt-web",
      prompt: "Claim me after reconnecting",
    });

    const abortedResponse = await waitingPoll;
    assert.equal(abortedResponse.status, 499);
    assert.deepEqual(await abortedResponse.json(), {
      ok: false,
      error: "Bridge pending request was cancelled",
      code: "client_disconnected",
    });
    assert.equal(bridge.getTurnSnapshot(turn.id)?.status, "queued");
    assert.equal(bridge.getStatus().claimedTurnCount, 0);

    const reconnectResponse = await pendingHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pending?wait=false", {
        headers: { "x-bridge-token": session.sessionToken },
      })
    );
    assert.equal(reconnectResponse.status, 200);
    const reconnectData = (await reconnectResponse.json()) as {
      ok: boolean;
      claimed: { turn: { id: string }; leaseToken: string };
    };
    assert.equal(reconnectData.ok, true);
    assert.equal(reconnectData.claimed.turn.id, turn.id);
    assert.ok(reconnectData.claimed.leaseToken.length > 0);
  });

  test("pending and events route handle turn claim and streaming deltas", async () => {
    const bridge = getChatGptWebBridge();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);

    // Enqueue turn
    const turn = bridge.enqueueTurn({
      requestId: "route-test",
      model: "chatgpt-web",
      prompt: "Hello route",
    });

    // Claim turn via pending GET
    const pendingReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/pending?wait=false", {
      headers: { "x-bridge-token": session.sessionToken },
    });

    const pendingRes = await pendingHandler(pendingReq);
    assert.equal(pendingRes.status, 200);

    const pendingData = (await pendingRes.json()) as {
      ok: boolean;
      claimed: { turn: { id: string }; leaseToken: string };
    };
    assert.equal(pendingData.ok, true);
    assert.equal(pendingData.claimed.turn.id, turn.id);
    const leaseToken = pendingData.claimed.leaseToken;

    const renewalRes = await leaseHandler(
      new Request("http://127.0.0.1:20128/api/chatgpt-bridge/lease", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-bridge-token": session.sessionToken,
        },
        body: JSON.stringify({ turnId: turn.id, leaseToken }),
      })
    );
    assert.equal(renewalRes.status, 200);
    const renewalData = (await renewalRes.json()) as { ok: boolean; leaseExpiresAt: number };
    assert.equal(renewalData.ok, true);
    assert.ok(renewalData.leaseExpiresAt > Date.now());

    // Send streaming text_delta event
    const eventReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": session.sessionToken,
      },
      body: JSON.stringify({
        turnId: turn.id,
        leaseToken,
        type: "text_delta",
        delta: "Chunk from route",
      }),
    });

    const eventRes = await eventsHandler(eventReq);
    assert.equal(eventRes.status, 200);
    const eventData = (await eventRes.json()) as { ok: boolean; sequence: number };
    assert.equal(eventData.ok, true);
    assert.equal(eventData.sequence, 1);

    // Send completed event
    const completeReq = new Request("http://127.0.0.1:20128/api/chatgpt-bridge/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": session.sessionToken,
      },
      body: JSON.stringify({
        turnId: turn.id,
        leaseToken,
        type: "completed",
        finishReason: "stop",
      }),
    });

    const completeRes = await eventsHandler(completeReq);
    assert.equal(completeRes.status, 200);

    const snapshot = bridge.getTurnSnapshot(turn.id);
    assert.equal(snapshot?.status, "completed");
  });
});
