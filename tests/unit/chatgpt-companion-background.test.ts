import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const backgroundSource = readFileSync(
  fileURLToPath(new URL("../../extensions/chatgpt-companion/background.js", import.meta.url)),
  "utf8"
);

type ScriptInjection = { files: string[]; world?: string };
type FetchCall = {
  url: string;
  init: { method?: string; headers?: Record<string, string>; body?: string };
};
type BrowserTab = { id?: number; url?: string; active?: boolean };
type PendingClaim = { turn: { id: string }; leaseToken: string };
type RuntimeMessage = {
  type?: string;
  event?: {
    turnId: string;
    type: string;
    text?: string;
    delta?: string;
    thinking?: string;
    finishReason?: string;
    error?: string;
  };
};
type RuntimeMessageListener = (
  message: RuntimeMessage,
  sender: unknown,
  sendResponse: (response: unknown) => void
) => unknown;

function normalize<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

type BackgroundHarnessOptions = {
  missingReceiver?: boolean;
  leaseRenewalStatus?: number;
  onSessionSet?: () => void;
  pendingClaims?: PendingClaim[];
  sessionSetDeferred?: Promise<void>;
  sessionStorage?: Record<string, unknown>;
  tabs?: BrowserTab[];
  trace?: string[];
};

function createBackgroundHarness(options: BackgroundHarnessOptions = {}) {
  const injections: ScriptInjection[] = [];
  const messages: Array<{ tabId: number; message: { type?: string } }> = [];
  const fetchCalls: FetchCall[] = [];
  const initialPollBlocked = createDeferred();
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  const runtimeListeners: RuntimeMessageListener[] = [];
  const sessionStorage = options.sessionStorage ?? {};
  const pendingClaims = [...(options.pendingClaims ?? [])];
  let nextIntervalId = 1;
  let pingCount = 0;
  let tabs = [...(options.tabs ?? [])];

  const chrome = {
    storage: {
      local: {
        async get() {
          // Keeps the production polling loop dormant in this harness.
          return { serverUrl: "http://127.0.0.1:20128", sessionToken: "test-session" };
        },
        async set() {},
        async remove() {},
      },
      session: {
        async get(keys: string[]) {
          return Object.fromEntries(
            keys.flatMap((key) => (key in sessionStorage ? [[key, sessionStorage[key]]] : []))
          );
        },
        async set(values: Record<string, unknown>) {
          options.trace?.push("session.set");
          options.onSessionSet?.();
          if (options.sessionSetDeferred) await options.sessionSetDeferred;
          Object.assign(sessionStorage, normalize(values));
        },
      },
    },
    tabs: {
      async query() {
        return tabs;
      },
      async sendMessage(tabId: number, message: { type?: string }) {
        messages.push({ tabId, message });
        if (message.type === "EXECUTE_TURN") options.trace?.push("tabs.sendMessage:EXECUTE_TURN");
        if (message.type === "PING") {
          pingCount += 1;
          if (options.missingReceiver && pingCount === 1) {
            throw new Error("Receiving end does not exist.");
          }
          return { ok: true };
        }
        return { ok: true };
      },
    },
    scripting: {
      async executeScript(injection: { files?: string[]; world?: string }) {
        injections.push({ files: injection.files ?? [], world: injection.world });
      },
    },
    runtime: {
      onMessage: {
        addListener(listener: RuntimeMessageListener) {
          runtimeListeners.push(listener);
        },
      },
    },
  };

  const context = {
    chrome,
    console: { info() {}, log() {}, warn() {}, error() {} },
    fetch: async (url: string, init: FetchCall["init"] = {}) => {
      fetchCalls.push({ url, init: normalize(init) });
      if (url.endsWith("/api/chatgpt-bridge/lease")) {
        const status = options.leaseRenewalStatus ?? 200;
        return {
          ok: status >= 200 && status < 300,
          status,
          json: async () =>
            status >= 200 && status < 300
              ? { ok: true, leaseExpiresAt: Date.now() + 30_000 }
              : { ok: false, error: "turn lease is no longer valid", code: "lease_lost" },
        };
      }
      if (url.includes("/api/chatgpt-bridge/pending?")) {
        const claimed = pendingClaims.shift();
        return { ok: true, status: 200, json: async () => ({ claimed }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    },
    AbortController,
    URL,
    setInterval(callback: () => void, delay: number) {
      const id = nextIntervalId++;
      intervals.set(id, { callback, delay });
      return id;
    },
    clearInterval(id: number) {
      intervals.delete(id);
    },
    // The background loop reaches this delay after discovering no ChatGPT
    // tab, which deliberately keeps it idle while the test invokes hooks.
    setTimeout() {
      return 1;
    },
  };

  vm.runInNewContext(
    `${backgroundSource}\nglobalThis.__testHooks = {
      ensureChatGptContentScript,
      startTurnLeaseRenewal,
      renewTurnLease,
      clearActiveLease,
      getLeaseToken: (turnId) => activeLeases.get(turnId),
      findActiveChatGptTab,
      pollPendingTurn
    };`,
    context
  );

  const hooks = (
    context as typeof context & {
      __testHooks: {
        ensureChatGptContentScript: (tabId: number) => Promise<void>;
        startTurnLeaseRenewal: (turnId: string, leaseToken: string) => Promise<void>;
        renewTurnLease: (turnId: string) => Promise<void>;
        clearActiveLease: (turnId: string) => Promise<void>;
        getLeaseToken: (turnId: string) => string | undefined;
        findActiveChatGptTab: () => Promise<BrowserTab | null>;
        pollPendingTurn: () => Promise<void>;
      };
    }
  ).__testHooks;

  return {
    ensure: hooks.ensureChatGptContentScript,
    startLeaseRenewal: hooks.startTurnLeaseRenewal,
    renewLease: hooks.renewTurnLease,
    clearLease: hooks.clearActiveLease,
    getLeaseToken: hooks.getLeaseToken,
    findActiveTab: hooks.findActiveChatGptTab,
    pollPendingTurn: hooks.pollPendingTurn,
    releaseInitialPoll: initialPollBlocked.resolve,
    renewalTimerCount: () =>
      [...intervals.values()].filter((timer) => timer.delay === 10_000).length,
    dispatchRuntimeMessage(message: RuntimeMessage) {
      return new Promise<unknown>((resolve) => {
        assert.equal(runtimeListeners.length, 1);
        assert.equal(runtimeListeners[0](message, {}, resolve), true);
      });
    },
    fetchCalls,
    injections,
    messages,
    setTabs(nextTabs: BrowserTab[]) {
      tabs = nextTabs;
    },
  };
}

describe("ChatGPT Companion background content-script recovery", () => {
  test("does not inject again when the existing ChatGPT content script responds", async () => {
    const harness = createBackgroundHarness();

    await harness.ensure(42);

    assert.deepEqual(normalize(harness.injections), []);
    assert.deepEqual(normalize(harness.messages), [{ tabId: 42, message: { type: "PING" } }]);
  });

  test("reinjects isolated and main-world scripts after an unpacked extension reload", async () => {
    const harness = createBackgroundHarness({ missingReceiver: true });

    await harness.ensure(42);

    assert.deepEqual(normalize(harness.injections), [
      { files: ["chatgpt-dom.js"] },
      { files: ["fiber.js"], world: "MAIN" },
      { files: ["content.js"] },
    ]);
    assert.deepEqual(normalize(harness.messages), [
      { tabId: 42, message: { type: "PING" } },
      { tabId: 42, message: { type: "PING" } },
    ]);
  });

  test("ignores active admin and settings pages when selecting a ChatGPT conversation tab", async () => {
    const harness = createBackgroundHarness({
      tabs: [
        { id: 1, url: "https://chatgpt.com/admin/billing", active: true },
        { id: 2, url: "https://chatgpt.com/#settings", active: false },
        { id: 3, url: "https://chatgpt.com/c/conversation-id", active: false },
      ],
    });

    assert.deepEqual(normalize(await harness.findActiveTab()), {
      id: 3,
      url: "https://chatgpt.com/c/conversation-id",
      active: false,
    });
  });

  test("returns no target when only non-conversation ChatGPT routes are open", async () => {
    const harness = createBackgroundHarness({
      tabs: [
        { id: 1, url: "https://chatgpt.com/admin/billing", active: true },
        { id: 2, url: "https://chatgpt.com/#settings", active: false },
      ],
    });

    assert.equal(await harness.findActiveTab(), null);
  });

  test("renews an active claimed turn and drops the timer after lease loss", async () => {
    const harness = createBackgroundHarness();

    await harness.startLeaseRenewal("turn_live", "lease_live");
    assert.equal(harness.renewalTimerCount(), 1);
    await harness.renewLease("turn_live");

    const renewal = harness.fetchCalls.find((call) =>
      call.url.endsWith("/api/chatgpt-bridge/lease")
    );
    assert.ok(renewal);
    assert.deepEqual(JSON.parse(renewal.init.body || "{}"), {
      turnId: "turn_live",
      leaseToken: "lease_live",
    });
    assert.equal(renewal.init.headers?.["x-bridge-token"], "test-session");

    await harness.clearLease("turn_live");
    assert.equal(harness.getLeaseToken("turn_live"), undefined);
    assert.equal(harness.renewalTimerCount(), 0);
  });

  test("stops renewal when the bridge reports a lost lease", async () => {
    const harness = createBackgroundHarness({ leaseRenewalStatus: 409 });

    await harness.startLeaseRenewal("turn_lost", "lease_lost");
    await harness.renewLease("turn_lost");

    assert.equal(harness.getLeaseToken("turn_lost"), undefined);
    assert.equal(harness.renewalTimerCount(), 0);
  });

  test("restores a persisted lease after an MV3 worker restart before forwarding an event", async () => {
    const sessionStorage: Record<string, unknown> = {};
    const workerBeforeRestart = createBackgroundHarness({ sessionStorage });
    await workerBeforeRestart.startLeaseRenewal("turn_restart", "lease_restart");

    const workerAfterRestart = createBackgroundHarness({ sessionStorage });
    const result = await workerAfterRestart.dispatchRuntimeMessage({
      type: "BRIDGE_EVENT",
      event: { turnId: "turn_restart", type: "text_delta", text: "Recovered text" },
    });

    assert.deepEqual(normalize(result), { ok: true });
    const eventRequest = workerAfterRestart.fetchCalls.find((call) =>
      call.url.endsWith("/api/chatgpt-bridge/events")
    );
    assert.ok(eventRequest);
    assert.deepEqual(JSON.parse(eventRequest.init.body || "{}"), {
      turnId: "turn_restart",
      leaseToken: "lease_restart",
      type: "text_delta",
      delta: "Recovered text",
    });
    assert.equal(workerAfterRestart.getLeaseToken("turn_restart"), "lease_restart");
    assert.equal(workerAfterRestart.renewalTimerCount(), 1);
  });

  test("does not send an event with an empty lease token after an MV3 worker restart", async () => {
    const workerAfterRestart = createBackgroundHarness({ sessionStorage: {} });
    const result = await workerAfterRestart.dispatchRuntimeMessage({
      type: "BRIDGE_EVENT",
      event: { turnId: "turn_missing", type: "completed" },
    });

    assert.deepEqual(normalize(result), {
      ok: false,
      error: "Turn lease was lost after extension restart",
    });
    assert.equal(
      workerAfterRestart.fetchCalls.some((call) => call.url.endsWith("/api/chatgpt-bridge/events")),
      false
    );
  });

  test("persists a claimed lease before dispatching it to the ChatGPT content script", async () => {
    const deferredStorageWrite = createDeferred();
    const trace: string[] = [];
    const harness = createBackgroundHarness({
      sessionSetDeferred: deferredStorageWrite.promise,
      pendingClaims: [{ turn: { id: "turn_commit" }, leaseToken: "lease_commit" }],
      tabs: [{ id: 42, url: "https://chatgpt.com/c/conversation", active: true }],
      trace,
    });

    const poll = harness.pollPendingTurn();
    harness.releaseInitialPoll();
    while (!trace.includes("session.set")) await Promise.resolve();
    assert.deepEqual(normalize(trace), ["session.set"]);

    deferredStorageWrite.resolve();
    await poll;
    while (!trace.includes("tabs.sendMessage:EXECUTE_TURN")) await Promise.resolve();

    assert.deepEqual(normalize(trace), ["session.set", "tabs.sendMessage:EXECUTE_TURN"]);
  });
});
