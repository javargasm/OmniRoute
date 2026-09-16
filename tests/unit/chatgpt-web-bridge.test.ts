import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ChatGptWebBridgeServer } from "@/lib/chatgptWebBridge/bridgeServer.ts";
import type { BridgeTurnEvent } from "@/lib/chatgptWebBridge/types.ts";

describe("ChatGptWebBridgeServer", () => {
  test("pairing code lifecycle: create and pair browser", () => {
    const bridge = new ChatGptWebBridgeServer();
    const { code, expiresAt } = bridge.createPairingCode();

    assert.ok(typeof code === "string" && code.length > 0);
    assert.ok(expiresAt > Date.now());

    const session = bridge.pairBrowser(code, {
      label: "Chrome Extension Test",
      availableModels: ["gpt-5.6", "chatgpt-web"],
    });

    assert.ok(session.id.startsWith("browser_"));
    assert.ok(typeof session.sessionToken === "string" && session.sessionToken.length > 0);
    assert.equal(session.label, "Chrome Extension Test");
    assert.deepEqual(session.availableModels, ["gpt-5.6", "chatgpt-web"]);

    // Attempting to reuse the one-time pairing code must fail
    assert.throws(
      () => bridge.pairBrowser(code),
      /pairing code is invalid or expired/
    );
  });

  test("tracks browser heartbeat and model compatibility", () => {
    const bridge = new ChatGptWebBridgeServer();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code, {
      availableModels: ["gpt-5.6"],
    });

    assert.equal(bridge.hasCompatibleBrowserForModel("gpt-5.6"), true);
    assert.equal(bridge.hasCompatibleBrowserForModel("claude-3"), false);

    const initialStatus = bridge.getStatus();
    assert.equal(initialStatus.pairedBrowserCount, 1);
    assert.equal(initialStatus.activeBrowserCount, 1);
    assert.deepEqual(initialStatus.availableModels, ["gpt-5.6"]);

    // Heartbeat updates registration and timestamp
    const updated = bridge.heartbeat(session.sessionToken, {
      availableModels: ["gpt-5.6", "o3-mini"],
    });
    assert.deepEqual(updated.availableModels, ["gpt-5.6", "o3-mini"]);
    assert.equal(bridge.hasCompatibleBrowserForModel("o3-mini"), true);
  });

  test("enqueues turn, claims it with lease, and streams events", () => {
    const bridge = new ChatGptWebBridgeServer();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);

    const snapshot = bridge.enqueueTurn({
      requestId: "req-123",
      model: "gpt-5.6",
      prompt: "Hello world prompt",
      temporaryChat: true,
    });

    assert.ok(snapshot.id.startsWith("turn_"));
    assert.equal(snapshot.status, "queued");
    assert.equal(bridge.getStatus().queuedTurnCount, 1);

    // Extension claims the next turn
    const claimed = bridge.claimNextTurn(session.sessionToken);
    assert.ok(claimed !== null);
    assert.equal(claimed.turn.id, snapshot.id);
    assert.equal(claimed.turn.prompt, "Hello world prompt");
    assert.ok(typeof claimed.leaseToken === "string" && claimed.leaseToken.length > 0);

    // Queue count is now 0, claimed turn count is 1
    assert.equal(bridge.getStatus().queuedTurnCount, 0);
    assert.equal(bridge.getStatus().claimedTurnCount, 1);

    // Subscribe to turn events
    const receivedEvents: BridgeTurnEvent[] = [];
    const unsubscribe = bridge.subscribeToTurn(snapshot.id, (evt) => {
      receivedEvents.push(evt);
    });

    // Extension posts streaming deltas
    bridge.appendTurnEvent(session.sessionToken, snapshot.id, claimed.leaseToken, {
      type: "text_delta",
      delta: "Hello ",
    });
    bridge.appendTurnEvent(session.sessionToken, snapshot.id, claimed.leaseToken, {
      type: "text_delta",
      delta: "there!",
    });
    bridge.appendTurnEvent(session.sessionToken, snapshot.id, claimed.leaseToken, {
      type: "completed",
      finishReason: "stop",
    });

    assert.equal(receivedEvents.length, 3);
    assert.equal(receivedEvents[0].type, "text_delta");
    if (receivedEvents[0].type === "text_delta") {
      assert.equal(receivedEvents[0].delta, "Hello ");
    }
    if (receivedEvents[1].type === "text_delta") {
      assert.equal(receivedEvents[1].delta, "there!");
    }
    assert.equal(receivedEvents[2].type, "completed");

    const finalSnapshot = bridge.getTurnSnapshot(snapshot.id);
    assert.equal(finalSnapshot?.status, "completed");

    unsubscribe();
  });

  test("handles client turn cancellation", () => {
    const bridge = new ChatGptWebBridgeServer();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);

    const snapshot = bridge.enqueueTurn({
      requestId: "req-abort",
      model: "gpt-5.6",
      prompt: "Abort me",
    });

    const claimed = bridge.claimNextTurn(session.sessionToken);
    assert.ok(claimed !== null);

    const events: BridgeTurnEvent[] = [];
    bridge.subscribeToTurn(snapshot.id, (evt) => {
      events.push(evt);
    });

    const cancelled = bridge.cancelTurn(snapshot.id, "client_abort");
    assert.equal(cancelled, true);

    const finalSnapshot = bridge.getTurnSnapshot(snapshot.id);
    assert.equal(finalSnapshot?.status, "cancelled");

    assert.equal(events.length, 1);
    assert.equal(events[0].type, "cancelled");
    if (events[0].type === "cancelled") {
      assert.equal(events[0].reason, "client_abort");
    }
  });

  test("rejects event appending with invalid lease token", () => {
    const bridge = new ChatGptWebBridgeServer();
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);

    const snapshot = bridge.enqueueTurn({
      requestId: "req-lease",
      model: "gpt-5.6",
      prompt: "Lease test",
    });

    bridge.claimNextTurn(session.sessionToken);

    assert.throws(
      () =>
        bridge.appendTurnEvent(session.sessionToken, snapshot.id, "bogus_lease_token", {
          type: "text_delta",
          delta: "invalid",
        }),
      /turn lease is no longer valid/
    );
  });

  test("renews a claimed turn lease before it expires", () => {
    let now = 1_000;
    const bridge = new ChatGptWebBridgeServer({
      now: () => now,
      turnLeaseMs: 1_000,
    });
    const { code } = bridge.createPairingCode();
    const session = bridge.pairBrowser(code);
    const turn = bridge.enqueueTurn({
      requestId: "req-renew",
      model: "gpt-5.6",
      prompt: "Keep the lease alive",
    });
    const claimed = bridge.claimNextTurn(session.sessionToken);
    assert.ok(claimed !== null);
    assert.equal(claimed.leaseExpiresAt, 2_000);

    now = 1_900;
    const renewed = bridge.renewTurnLease(session.sessionToken, turn.id, claimed.leaseToken);
    assert.equal(renewed.leaseExpiresAt, 2_900);

    now = 2_100;
    assert.doesNotThrow(() => {
      bridge.appendTurnEvent(session.sessionToken, turn.id, claimed.leaseToken, {
        type: "completed",
        finishReason: "stop",
      });
    });
  });
});
