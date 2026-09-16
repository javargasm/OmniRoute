import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const domSource = readFileSync(
  fileURLToPath(new URL("../../extensions/chatgpt-companion/chatgpt-dom.js", import.meta.url)),
  "utf8"
);

type Timer = { callback: () => void };
type SubmitOptions = { idleTimeoutMs?: number; submitTimeoutMs?: number; onBeforeSubmit?: () => void };

function createDomHarness() {
  let now = 0;
  let generating = true;
  let nextTimerId = 1;
  let sendClicks = 0;
  const timers = new Map<number, Timer>();
  const events: Array<{ type: string }> = [];

  const composer = {
    tagName: "TEXTAREA",
    value: "",
    focus() {},
    dispatchEvent(event: { type: string }) {
      events.push({ type: event.type });
      return true;
    },
  };
  const sendButton = {
    isConnected: true,
    disabled: false,
    getAttribute() {
      return null;
    },
    click() {
      sendClicks += 1;
    },
  };
  const stopButton = { isConnected: true, offsetParent: {} };
  const window = {
    HTMLTextAreaElement: function HTMLTextAreaElement() {},
  };
  const document = {
    querySelector(selector: string) {
      if (selector === "#prompt-textarea") return composer;
      if (selector.includes("send-button")) return sendButton;
      if (selector.includes("stop-button")) return generating ? stopButton : null;
      return null;
    },
    execCommand() {
      return false;
    },
    createElement() {
      return { textContent: "" };
    },
  };
  class BasicEvent {
    type: string;
    constructor(type: string) {
      this.type = type;
    }
  }

  vm.runInNewContext(domSource, {
    window,
    document,
    console,
    Date: { now: () => now },
    Event: BasicEvent,
    InputEvent: BasicEvent,
    KeyboardEvent: BasicEvent,
    setInterval(callback: () => void) {
      const id = nextTimerId++;
      timers.set(id, { callback });
      return id;
    },
    clearInterval(id: number) {
      timers.delete(id);
    },
  });

  return {
    api: (window as typeof window & {
      __OMNI_DOM: { submitPrompt: (text: string, options?: SubmitOptions) => Promise<boolean> };
    }).__OMNI_DOM,
    composer,
    events,
    sendClicks: () => sendClicks,
    setGenerating(value: boolean) {
      generating = value;
    },
    async tick(ms: number) {
      now += ms;
      for (const timer of [...timers.values()]) timer.callback();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

describe("ChatGPT Companion DOM submission", () => {
  test("waits for an existing ChatGPT response before submitting and observing a new turn", async () => {
    const harness = createDomHarness();
    let observedSubmissions = 0;
    const pending = harness.api.submitPrompt("queued prompt", {
      idleTimeoutMs: 1_000,
      onBeforeSubmit() {
        observedSubmissions += 1;
      },
    });

    await Promise.resolve();
    assert.equal(harness.composer.value, "");
    assert.equal(observedSubmissions, 0);

    await harness.tick(150);
    assert.equal(harness.sendClicks(), 0);

    harness.setGenerating(false);
    await harness.tick(150);
    assert.equal(harness.composer.value, "queued prompt");
    assert.equal(observedSubmissions, 0);

    await harness.tick(150);
    assert.equal(await pending, true);
    assert.equal(observedSubmissions, 1);
    assert.equal(harness.sendClicks(), 1);
    assert.deepEqual(harness.events.map((event) => event.type), ["beforeinput", "input", "change"]);
  });

  test("fails clearly after the bounded idle wait instead of rejecting immediately", async () => {
    const harness = createDomHarness();
    const pending = harness.api.submitPrompt("queued prompt", { idleTimeoutMs: 300 });

    await harness.tick(150);
    await harness.tick(150);

    await assert.rejects(pending, /Timed out waiting for the current ChatGPT response to finish/);
    assert.equal(harness.composer.value, "");
    assert.equal(harness.sendClicks(), 0);
  });
});
