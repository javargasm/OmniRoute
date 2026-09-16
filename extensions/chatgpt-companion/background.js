/**
 * OmniRoute Companion Service Worker (Manifest V3)
 * Long-polls OmniRoute for pending turns, routes them to the active ChatGPT tab,
 * and streams events back to OmniRoute.
 */

const DEFAULT_SERVER_URL = "http://127.0.0.1:20128";
let isPolling = false;
let pollingAbortController = null;
let pairingPromise = null;
const activeLeases = new Map(); // turnId -> leaseToken
const leaseRenewalTimers = new Map(); // turnId -> timer id
const renewingLeaseTurnIds = new Set();
const ACTIVE_LEASES_STORAGE_KEY = "activeLeases";
let activeLeasesReady = null;
// The bridge lease is short to prevent replaying an abandoned browser turn.
// Renew well before it expires while ChatGPT is still rendering a response.
const TURN_LEASE_RENEWAL_MS = 10_000;
const CHATGPT_CONVERSATION_REQUIRED_ERROR =
  "Open a ChatGPT conversation tab (not settings, billing, or admin) before using OmniRoute Companion";

async function getConfig() {
  const data = await chrome.storage.local.get(["serverUrl", "sessionToken"]);
  return {
    serverUrl: data.serverUrl || DEFAULT_SERVER_URL,
    sessionToken: data.sessionToken || null,
  };
}

async function getOrInitSessionToken(serverUrl, forceNew = false) {
  if (!forceNew) {
    const { sessionToken } = await chrome.storage.local.get(["sessionToken"]);
    if (sessionToken) return sessionToken;
  }

  // The startup heartbeat and long-poll can race in a MV3 worker. Coalesce
  // pairing so they cannot create redundant browser sessions.
  if (!pairingPromise) {
    pairingPromise = (async () => {
      try {
        const res = await fetch(`${serverUrl}/api/chatgpt-bridge/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: "OmniRoute Chrome Companion" }),
        });

        if (res.ok) {
          const data = await res.json();
          if (data.ok && data.session?.sessionToken) {
            await chrome.storage.local.set({ sessionToken: data.session.sessionToken });
            console.log(
              "[OmniRoute Companion] Paired successfully with OmniRoute:",
              data.session.id
            );
            return data.session.sessionToken;
          }
        }
      } catch (err) {
        console.warn("[OmniRoute Companion] Pairing attempt failed:", err.message);
      }
      return null;
    })().finally(() => {
      pairingPromise = null;
    });
  }

  return pairingPromise;
}

function isExpiredSessionResponse(response, body) {
  if (response.status === 401) return true;
  // Older local OmniRoute builds surfaced extension_not_paired as 400. Keep
  // the extension forward and backward compatible so a bridge restart heals
  // itself even before the server has been upgraded.
  return (
    response.status === 400 &&
    (body?.code === "extension_not_paired" ||
      body?.error === "browser session is not paired or has expired")
  );
}

async function recoverExpiredSession(serverUrl) {
  console.warn("[OmniRoute Companion] Session rejected by bridge, re-pairing...");
  await chrome.storage.local.remove("sessionToken");
  await clearAllActiveLeases();
  return getOrInitSessionToken(serverUrl, true);
}

async function readBridgeResponse(response) {
  return response.json().catch(() => null);
}

function isChatGptConversationUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    if (!["chatgpt.com", "chat.openai.com"].includes(url.hostname.toLowerCase())) return false;
    // Settings stays mounted as a hash route on the ChatGPT root URL.
    if (/^#settings(?:\/|$)/i.test(url.hash)) return false;
    const pathname = url.pathname.replace(/\/+$/, "") || "/";
    // `/` includes a new or temporary chat. `/c/` is a normal conversation
    // and `/g/` covers a custom GPT conversation. Do not treat dashboard,
    // admin, billing, project-list, or settings routes as a chat target.
    return pathname === "/" || pathname.startsWith("/c/") || pathname.startsWith("/g/");
  } catch (_err) {
    return false;
  }
}

function snapshotActiveLeases() {
  return Object.fromEntries(activeLeases.entries());
}

async function persistActiveLeases() {
  await chrome.storage.session.set({ [ACTIVE_LEASES_STORAGE_KEY]: snapshotActiveLeases() });
}

async function ensureActiveLeasesReady() {
  if (!activeLeasesReady) {
    activeLeasesReady = (async () => {
      const stored = await chrome.storage.session.get([ACTIVE_LEASES_STORAGE_KEY]);
      const leases = stored?.[ACTIVE_LEASES_STORAGE_KEY];
      if (!leases || typeof leases !== "object" || Array.isArray(leases)) return;
      for (const [turnId, leaseToken] of Object.entries(leases)) {
        if (typeof leaseToken === "string" && leaseToken) activeLeases.set(turnId, leaseToken);
      }
    })().catch((err) => {
      console.warn("[OmniRoute Companion] Could not restore active turn leases:", err.message);
    });
  }
  await activeLeasesReady;
}

function restoreLeaseRenewalTimer(turnId) {
  if (!activeLeases.has(turnId) || leaseRenewalTimers.has(turnId)) return;
  const timer = setInterval(() => {
    void renewTurnLease(turnId);
  }, TURN_LEASE_RENEWAL_MS);
  leaseRenewalTimers.set(turnId, timer);
}

async function restoreActiveLeaseRenewals() {
  await ensureActiveLeasesReady();
  for (const turnId of activeLeases.keys()) restoreLeaseRenewalTimer(turnId);
}

async function clearActiveLease(turnId) {
  await ensureActiveLeasesReady();
  const timer = leaseRenewalTimers.get(turnId);
  if (timer) clearInterval(timer);
  leaseRenewalTimers.delete(turnId);
  activeLeases.delete(turnId);
  await persistActiveLeases();
}

async function clearAllActiveLeases() {
  await ensureActiveLeasesReady();
  for (const turnId of [...activeLeases.keys()]) {
    const timer = leaseRenewalTimers.get(turnId);
    if (timer) clearInterval(timer);
  }
  leaseRenewalTimers.clear();
  activeLeases.clear();
  await persistActiveLeases();
}

async function renewTurnLease(turnId) {
  await ensureActiveLeasesReady();
  const leaseToken = activeLeases.get(turnId);
  if (!leaseToken || renewingLeaseTurnIds.has(turnId)) return;

  renewingLeaseTurnIds.add(turnId);
  try {
    const { serverUrl } = await getConfig();
    const sessionToken = await getOrInitSessionToken(serverUrl);
    if (!sessionToken || activeLeases.get(turnId) !== leaseToken) return;

    const res = await fetch(`${serverUrl}/api/chatgpt-bridge/lease`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": sessionToken,
      },
      body: JSON.stringify({ turnId, leaseToken }),
    });
    const data = await readBridgeResponse(res);

    if (res.ok) return;
    if (isExpiredSessionResponse(res, data)) {
      await recoverExpiredSession(serverUrl);
      return;
    }
    if (res.status === 404 || res.status === 409) {
      await clearActiveLease(turnId);
      return;
    }
    console.warn("[OmniRoute Companion] Turn lease renewal failed:", data?.error || res.status);
  } catch (err) {
    // Keep the lease timer alive for a later retry while the bridge is
    // temporarily unavailable. A terminal event will clear it immediately.
    console.warn("[OmniRoute Companion] Turn lease renewal error:", err.message);
  } finally {
    renewingLeaseTurnIds.delete(turnId);
  }
}

async function startTurnLeaseRenewal(turnId, leaseToken) {
  await ensureActiveLeasesReady();
  const existingTimer = leaseRenewalTimers.get(turnId);
  if (existingTimer) clearInterval(existingTimer);
  leaseRenewalTimers.delete(turnId);
  activeLeases.set(turnId, leaseToken);
  await persistActiveLeases();
  restoreLeaseRenewalTimer(turnId);
}

async function findActiveChatGptTab() {
  const tabs = await chrome.tabs.query({
    url: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  });
  const conversationTabs = (tabs || []).filter((tab) => isChatGptConversationUrl(tab.url));
  if (conversationTabs.length === 0) return null;
  const activeTab = conversationTabs.find((t) => t.active) || conversationTabs[0];
  return activeTab;
}

/**
 * Chrome removes old content-script contexts when an unpacked extension is
 * reloaded, but it does not automatically inject the new contexts into an
 * already-open ChatGPT tab. Probe first to avoid duplicate observers; if the
 * receiver is missing, restore the same isolated/main-world injection order
 * declared by manifest.json before dispatching a claimed turn.
 */
async function ensureChatGptContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
    if (response?.ok) {
      if (response.isCompanionTarget === false)
        throw new Error(CHATGPT_CONVERSATION_REQUIRED_ERROR);
      return;
    }
  } catch (_err) {
    if (_err?.message === CHATGPT_CONVERSATION_REQUIRED_ERROR) throw _err;
    // Expected after extension reload; inject the current extension contexts.
  }

  console.info("[OmniRoute Companion] Re-injecting content scripts into existing ChatGPT tab");
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["chatgpt-dom.js"],
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["fiber.js"],
    world: "MAIN",
  });
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content.js"],
  });

  const response = await chrome.tabs.sendMessage(tabId, { type: "PING" });
  if (response?.isCompanionTarget === false) throw new Error(CHATGPT_CONVERSATION_REQUIRED_ERROR);
  if (!response?.ok) {
    throw new Error("ChatGPT content script did not respond after injection");
  }
}

async function sendHeartbeat() {
  try {
    const { serverUrl } = await getConfig();
    const sessionToken = await getOrInitSessionToken(serverUrl);
    if (!sessionToken) return;

    const tab = await findActiveChatGptTab();
    const res = await fetch(`${serverUrl}/api/chatgpt-bridge/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-bridge-token": sessionToken,
      },
      body: JSON.stringify({
        label: "OmniRoute Chrome Companion",
        tabId: tab?.id,
      }),
    });

    if (!res.ok && isExpiredSessionResponse(res, await readBridgeResponse(res))) {
      await recoverExpiredSession(serverUrl);
    }
  } catch (_err) {
    // Non-critical heartbeat failure
  }
}

async function pollPendingTurn() {
  if (isPolling) return;
  isPolling = true;

  try {
    const { serverUrl } = await getConfig();
    const sessionToken = await getOrInitSessionToken(serverUrl);
    if (!sessionToken) {
      await new Promise((r) => setTimeout(r, 2000));
      return;
    }

    const tab = await findActiveChatGptTab();
    if (!tab || !tab.id) {
      // No active ChatGPT tab, wait before polling again
      await new Promise((r) => setTimeout(r, 3000));
      return;
    }

    pollingAbortController = new AbortController();
    const res = await fetch(`${serverUrl}/api/chatgpt-bridge/pending?wait=true&timeout=15000`, {
      headers: {
        "x-bridge-token": sessionToken,
      },
      signal: pollingAbortController.signal,
    });

    if (res.ok) {
      const data = await res.json();
      const claimed = data.claimed;

      if (claimed && claimed.turn && claimed.leaseToken) {
        const { turn, leaseToken } = claimed;
        console.log("[OmniRoute Companion] Claimed pending turn:", turn.id);
        await startTurnLeaseRenewal(turn.id, leaseToken);

        // Forward turn to content script in the ChatGPT tab
        try {
          await ensureChatGptContentScript(tab.id);
          const response = await chrome.tabs.sendMessage(tab.id, {
            type: "EXECUTE_TURN",
            turn,
          });

          if (!response?.ok) {
            throw new Error(response?.error || "Content script did not acknowledge the turn");
          }
        } catch (tabErr) {
          console.error("[OmniRoute Companion] Failed to message ChatGPT tab:", tabErr);
          // Report error back to bridge
          await fetch(`${serverUrl}/api/chatgpt-bridge/events`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-bridge-token": sessionToken,
            },
            body: JSON.stringify({
              turnId: turn.id,
              leaseToken,
              type: "error",
              error: "Failed to communicate with ChatGPT tab: " + tabErr.message,
            }),
          });
          await clearActiveLease(turn.id);
        }
      }
    } else if (isExpiredSessionResponse(res, await readBridgeResponse(res))) {
      await recoverExpiredSession(serverUrl);
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      console.warn("[OmniRoute Companion] Poll error:", err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  } finally {
    isPolling = false;
  }
}

// Continuous polling loop
async function startPollingLoop() {
  while (true) {
    await pollPendingTurn();
    await new Promise((r) => setTimeout(r, 250));
  }
}

// Message listener from content script and popup
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "BRIDGE_EVENT" && message.event) {
    (async () => {
      const { serverUrl } = await getConfig();
      const sessionToken = await getOrInitSessionToken(serverUrl);
      if (!sessionToken) {
        sendResponse({ ok: false, error: "Extension not paired" });
        return;
      }

      await ensureActiveLeasesReady();
      const turnId = message.event.turnId;
      const leaseToken = activeLeases.get(turnId);
      if (!leaseToken) {
        sendResponse({ ok: false, error: "Turn lease was lost after extension restart" });
        return;
      }

      try {
        const res = await fetch(`${serverUrl}/api/chatgpt-bridge/events`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-bridge-token": sessionToken,
          },
          body: JSON.stringify({
            turnId,
            leaseToken,
            type: message.event.type,
            delta: message.event.text || message.event.delta,
            thinking: message.event.thinking,
            finishReason: message.event.finishReason,
            error: message.event.error,
          }),
        });

        const data = await readBridgeResponse(res);
        if (isExpiredSessionResponse(res, data)) {
          await clearActiveLease(turnId);
          await recoverExpiredSession(serverUrl);
          sendResponse({ ok: false, error: "Bridge session was renewed after a restart" });
          return;
        }

        if (
          res.ok &&
          (message.event.type === "finish" ||
            message.event.type === "completed" ||
            message.event.type === "error")
        ) {
          await clearActiveLease(turnId);
        }

        // If turn was cancelled upstream, notify content script
        if (res.status === 409 || data?.error?.includes("cancelled")) {
          const tab = await findActiveChatGptTab();
          if (tab?.id) {
            chrome.tabs.sendMessage(tab.id, { type: "CANCEL_TURN", turnId }).catch(() => {});
          }
          await clearActiveLease(turnId);
        }

        sendResponse({ ok: data?.ok });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true; // async sendResponse
  }

  if (message.type === "PAIR_WITH_CODE") {
    (async () => {
      const { serverUrl } = await getConfig();
      const code = String(message.code || "").trim();
      try {
        const res = await fetch(`${serverUrl}/api/chatgpt-bridge/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code, label: "OmniRoute Chrome Companion" }),
        });
        const data = await res.json();
        if (data.ok && data.session?.sessionToken) {
          await chrome.storage.local.set({ sessionToken: data.session.sessionToken });
          sendResponse({ ok: true, session: data.session });
        } else {
          sendResponse({ ok: false, error: data.error || "Pairing failed" });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }

  if (message.type === "RESET_SESSION") {
    (async () => {
      await chrome.storage.local.remove("sessionToken");
      await clearAllActiveLeases();
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (message.type === "GET_STATUS") {
    (async () => {
      const { serverUrl } = await getConfig();
      const sessionToken = await getOrInitSessionToken(serverUrl);
      const tab = await findActiveChatGptTab();
      sendResponse({
        connected: Boolean(sessionToken),
        sessionToken: sessionToken ? sessionToken.slice(0, 8) + "..." : null,
        hasChatGptTab: Boolean(tab),
        tabUrl: tab?.url || null,
        serverUrl,
      });
    })();
    return true;
  }

  return false;
});

void restoreActiveLeaseRenewals();

// Periodic heartbeat every 20 seconds
setInterval(sendHeartbeat, 20000);
sendHeartbeat();

// Start loop
startPollingLoop();
console.log("[OmniRoute Companion] Background service worker initialized");
