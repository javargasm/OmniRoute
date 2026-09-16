import assert from "node:assert/strict";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const contentSource = readFileSync(
  fileURLToPath(new URL("../../extensions/chatgpt-companion/content.js", import.meta.url)),
  "utf8"
);

type WindowMessage = { source: unknown; data: unknown };
type RuntimeListener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => boolean | void;
type SubmitOptions = { onBeforeSubmit?: () => void };

function createContentHarness(
  {
    sendMessageThrows = false,
    url = "https://chatgpt.com/c/conversation-id",
  }: { sendMessageThrows?: boolean; url?: string } = {}
) {
  const windowListeners = new Set<(event: WindowMessage) => void>();
  const postedToMain: Array<Record<string, unknown>> = [];
  const bridgeMessages: Array<Record<string, unknown>> = [];
  const submittedPrompts: string[] = [];
  let runtimeListener: RuntimeListener | null = null;

  const window = {
    location: { href: url },
    __OMNI_DOM: {
      submitPrompt: async (prompt: string, options: SubmitOptions = {}) => {
        submittedPrompts.push(prompt);
        options.onBeforeSubmit?.();
      },
      clickStop() {},
    },
    addEventListener(type: string, listener: (event: WindowMessage) => void) {
      if (type === "message") windowListeners.add(listener);
    },
    postMessage(message: Record<string, unknown>) {
      postedToMain.push(JSON.parse(JSON.stringify(message)) as Record<string, unknown>);
    },
  };
  const chrome = {
    runtime: {
      sendMessage(message: Record<string, unknown>) {
        if (sendMessageThrows) throw new Error("Extension context invalidated.");
        bridgeMessages.push(message);
        return Promise.resolve();
      },
      onMessage: {
        addListener(listener: RuntimeListener) {
          runtimeListener = listener;
        },
      },
    },
  };
  const document = {
    querySelectorAll() {
      return [];
    },
  };

  vm.runInNewContext(contentSource, {
    chrome,
    console,
    crypto: { randomUUID: () => "observer_current" },
    document,
    URL,
    window,
  });

  return {
    bridgeMessages,
    async executeTurn() {
      const responses: unknown[] = [];
      const handled = runtimeListener?.(
        { type: "EXECUTE_TURN", turn: { id: "turn_current", prompt: "hello" } },
        {},
        (response) => responses.push(response)
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      return { handled, responses };
    },
    emitFiber(data: Record<string, unknown>, source = "OMNI_FIBER_V2") {
      for (const listener of [...windowListeners]) {
        listener({ source: window, data: { source, ...data } });
      }
    },
    postedToMain,
    submittedPrompts,
  };
}

describe("ChatGPT Companion content bridge", () => {
  test("forwards only events from the observer assigned to the current turn", async () => {
    const harness = createContentHarness();

    const execution = await harness.executeTurn();
    assert.equal(execution.handled, true);
    assert.equal((execution.responses[0] as { ok?: boolean }).ok, true);
    assert.deepEqual(harness.postedToMain, [
      {
        source: "OMNI_CONTENT_V2",
        action: "START_TURN",
        turnId: "turn_current",
        initialTurnCount: 0,
        observerId: "observer_current",
      },
    ]);

    harness.emitFiber(
      {
        type: "delta",
        turnId: "turn_current",
        observerId: "observer_current",
        text: "LEGACY_PROTOCOL",
      },
      "OMNI_FIBER"
    );
    harness.emitFiber({ type: "delta", turnId: "turn_current", text: "STALE_CURSOR_" });
    harness.emitFiber({
      type: "delta",
      turnId: "turn_current",
      observerId: "observer_old",
      text: "STALE_DUPLICATE",
    });
    harness.emitFiber({
      type: "delta",
      turnId: "turn_other",
      observerId: "observer_current",
      text: "WRONG_TURN",
    });
    assert.equal(harness.bridgeMessages.length, 0);

    harness.emitFiber({
      type: "delta",
      turnId: "turn_current",
      observerId: "observer_current",
      text: "CURRENT_TEXT",
    });
    assert.equal(harness.bridgeMessages.length, 1);
    const forwarded = harness.bridgeMessages[0];
    const event = forwarded.event as Record<string, unknown>;
    assert.equal(forwarded.type, "BRIDGE_EVENT");
    assert.equal(event.turnId, "turn_current");
    assert.equal(event.type, "delta");
    assert.equal(event.text, "CURRENT_TEXT");
    assert.equal(event.thinking, undefined);
    assert.equal(event.finishReason, undefined);
    assert.equal(event.error, undefined);
    assert.equal(typeof event.timestamp, "number");
  });

  test("swallows a synchronous runtime invalidation from a current observer event", async () => {
    const harness = createContentHarness({ sendMessageThrows: true });

    await harness.executeTurn();
    assert.doesNotThrow(() => {
      harness.emitFiber({
        type: "delta",
        turnId: "turn_current",
        observerId: "observer_current",
        text: "CURRENT_TEXT",
      });
    });
    assert.equal(harness.bridgeMessages.length, 0);
  });

  test("rejects an admin or billing page before changing the ChatGPT composer", async () => {
    const harness = createContentHarness({ url: "https://chatgpt.com/admin/billing" });

    const execution = await harness.executeTurn();
    assert.equal(execution.handled, true);
    assert.deepEqual(JSON.parse(JSON.stringify(execution.responses)), [
      {
        ok: false,
        error: "Open a ChatGPT conversation tab (not settings, billing, or admin) before using OmniRoute Companion",
      },
    ]);
    assert.deepEqual(harness.postedToMain, []);
    assert.deepEqual(harness.submittedPrompts, []);
    assert.deepEqual(harness.bridgeMessages, []);
  });
});
