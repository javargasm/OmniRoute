import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const fiberSource = readFileSync(
  fileURLToPath(new URL("../../extensions/chatgpt-companion/fiber.js", import.meta.url)),
  "utf8"
);

type FiberEvent = {
  source?: string;
  type: string;
  text?: string;
  finishReason?: string;
  observerId?: string | null;
};

function createFiberHarness() {
  let now = 0;
  let generating = true;
  let markdownText = "";
  let nextIntervalId = 1;
  const intervals = new Map<number, () => void>();
  const messageListeners = new Set<(event: { source: unknown; data: unknown }) => void>();
  const emitted: FiberEvent[] = [];

  const markdown = {
    get innerText() {
      return markdownText;
    },
    get textContent() {
      return markdownText;
    },
  };
  const assistantTurn = {
    querySelector(selector: string) {
      return selector === ".markdown" ? markdown : null;
    },
    querySelectorAll(selector: string) {
      return selector === ".markdown" ? [markdown] : [];
    },
  };
  const stopButton = { isConnected: true, offsetParent: {} };
  const window = {
    addEventListener(type: string, listener: (event: { source: unknown; data: unknown }) => void) {
      if (type === "message") messageListeners.add(listener);
    },
    removeEventListener(type: string, listener: (event: { source: unknown; data: unknown }) => void) {
      if (type === "message") messageListeners.delete(listener);
    },
    postMessage(event: FiberEvent) {
      emitted.push(event);
    },
  };
  const document = {
    querySelectorAll(selector: string) {
      return selector.includes("conversation-turn") ? [assistantTurn] : [];
    },
    querySelector(selector: string) {
      return selector.includes("stop-button") ? (generating ? stopButton : null) : null;
    },
  };

  const runtime = {
    window,
    document,
    console,
    Date: { now: () => now },
    setInterval(callback: () => void) {
      const id = nextIntervalId++;
      intervals.set(id, callback);
      return id;
    },
    clearInterval(id: number) {
      intervals.delete(id);
    },
  };

  function install() {
    vm.runInNewContext(fiberSource, runtime);
  }

  install();

  function tick(ms: number) {
    now += ms;
    for (const callback of [...intervals.values()]) callback();
  }

  function start(observerId = "observer_test") {
    for (const listener of [...messageListeners]) {
      listener({
        source: window,
        data: {
          source: "OMNI_CONTENT_V2",
          action: "START_TURN",
          turnId: "turn_test",
          initialTurnCount: 0,
          observerId,
        },
      });
    }
  }

  start();

  return {
    emitted,
    activeIntervalCount() {
      return intervals.size;
    },
    messageListenerCount() {
      return messageListeners.size;
    },
    reinject() {
      install();
    },
    setGenerating(value: boolean) {
      generating = value;
    },
    setMarkdown(value: string) {
      markdownText = value;
    },
    start,
    tick,
  };
}

describe("ChatGPT Companion fiber observer", () => {
  test("waits for the final DOM commit and excludes a transient trailing cursor", () => {
    const harness = createFiberHarness();

    harness.setMarkdown("COMPANION_OK_");
    harness.tick(100); // first observation is intentionally not emitted yet

    harness.setGenerating(false);
    harness.setMarkdown("COMPANION_OK");
    harness.tick(100); // stable prefix emits without the cursor underscore
    harness.tick(500); // final render settle window

    assert.deepEqual(
      harness.emitted.map((event) => ({ type: event.type, text: event.text, finishReason: event.finishReason })),
      [
        { type: "delta", text: "COMPANION_OK", finishReason: undefined },
        { type: "finish", text: undefined, finishReason: "stop" },
      ]
    );
    assert.equal(harness.emitted[0]?.source, "OMNI_FIBER_V2");
  });

  test("flushes text committed after ChatGPT hides its Stop button", () => {
    const harness = createFiberHarness();

    harness.setMarkdown("First fragment");
    harness.tick(100);
    harness.setGenerating(false);
    harness.tick(100); // the first snapshot becomes stable

    harness.setMarkdown("First fragment with final DOM text");
    harness.tick(100); // observes the late DOM commit but keeps its edge buffered
    harness.tick(500); // flushes the settled final snapshot before finish

    assert.equal(
      harness.emitted.filter((event) => event.type === "delta").map((event) => event.text).join(""),
      "First fragment with final DOM text"
    );
    assert.equal(harness.emitted.at(-1)?.type, "finish");
  });

  test("replaces a prior current observer when the MAIN-world script is reinjected", () => {
    const harness = createFiberHarness();

    harness.reinject();
    assert.equal(harness.messageListenerCount(), 1);

    harness.start("observer_after_reload");
    harness.setMarkdown("RELOAD_SAFE_");
    harness.tick(100);
    harness.setGenerating(false);
    harness.setMarkdown("RELOAD_SAFE");
    harness.tick(100);
    harness.tick(500);

    assert.equal(harness.activeIntervalCount(), 0);
    assert.deepEqual(
      harness.emitted.map((event) => ({
        type: event.type,
        text: event.text,
        finishReason: event.finishReason,
        observerId: event.observerId,
      })),
      [
        {
          type: "delta",
          text: "RELOAD_SAFE",
          finishReason: undefined,
          observerId: "observer_after_reload",
        },
        {
          type: "finish",
          text: undefined,
          finishReason: "stop",
          observerId: "observer_after_reload",
        },
      ]
    );
  });
});
