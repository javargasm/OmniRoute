/**
 * OmniRoute Content Script (Isolated World)
 * Bridges background service worker commands with DOM injection and Fiber events.
 */
(() => {
  'use strict';

  // Bump the page-message protocol when changing content/Fiber coordination.
  // A listener from an invalidated pre-reload extension context may still be
  // attached to window; it ignores this namespace instead of trying to call
  // its now-invalid chrome.runtime object.
  const CONTENT_EVENT_SOURCE = 'OMNI_CONTENT_V2';
  const FIBER_EVENT_SOURCE = 'OMNI_FIBER_V2';
  const CHATGPT_CONVERSATION_REQUIRED_ERROR =
    'Open a ChatGPT conversation tab (not settings, billing, or admin) before using OmniRoute Companion';
  let currentTurnId = null;
  let currentObserverId = null;

  function isCompanionChatPage() {
    try {
      const url = new URL(window.location.href);
      if (!['chatgpt.com', 'chat.openai.com'].includes(url.hostname.toLowerCase())) return false;
      if (/^#settings(?:\/|$)/i.test(url.hash)) return false;
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      return pathname === '/' || pathname.startsWith('/c/') || pathname.startsWith('/g/');
    } catch (_err) {
      return false;
    }
  }

  function createObserverId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID();
    }
    return `observer_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  }

  function forwardBridgeEvent(event) {
    try {
      const result = chrome.runtime.sendMessage({
        type: 'BRIDGE_EVENT',
        event: { ...event, timestamp: Date.now() },
      });
      if (result && typeof result.catch === 'function') {
        void result.catch(() => {});
      }
    } catch (_err) {
      // Chrome can retain a window listener briefly after an unpacked
      // extension reload while invalidating its extension context. There is
      // no live worker to receive this event, so silently drop it.
    }
  }

  // Listen for streaming deltas and finish events from fiber.js (MAIN world)
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.source !== FIBER_EVENT_SOURCE) return;

    const { type, turnId, observerId, text, thinking, finishReason, error } = event.data;
    // A legacy MAIN-world observer can survive an unpacked extension reload.
    // Only forward events from the observer that received this turn's ID, so
    // it cannot duplicate the turn or leak its old cursor behavior.
    if (
      !currentTurnId ||
      turnId !== currentTurnId ||
      !currentObserverId ||
      observerId !== currentObserverId
    ) {
      return;
    }

    // Forward to background service worker
    forwardBridgeEvent({ turnId, type, text, thinking, finishReason, error });

    if (type === 'finish' || type === 'error') {
      currentTurnId = null;
      currentObserverId = null;
    }
  });

  // Listen for instructions from background.js
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'PING') {
      sendResponse({
        ok: true,
        url: window.location.href,
        title: document.title,
        isCompanionTarget: isCompanionChatPage(),
      });
      return true;
    }

    if (message.type === 'CANCEL_TURN') {
      if (currentTurnId && (!message.turnId || message.turnId === currentTurnId)) {
        window.__OMNI_DOM.clickStop();
        window.postMessage({ source: CONTENT_EVENT_SOURCE, action: 'STOP_TURN' }, '*');
        currentTurnId = null;
        currentObserverId = null;
      }
      sendResponse({ ok: true });
      return true;
    }

    if (message.type === 'EXECUTE_TURN') {
      const { turn } = message;
      if (!turn || !turn.id || !turn.prompt) {
        sendResponse({ ok: false, error: 'Invalid turn payload' });
        return true;
      }
      if (!isCompanionChatPage()) {
        sendResponse({ ok: false, error: CHATGPT_CONVERSATION_REQUIRED_ERROR });
        return true;
      }

      currentTurnId = turn.id;
      const observerId = createObserverId();
      currentObserverId = observerId;
      let startedObserving = false;

      // A manual response may still be streaming when this turn is claimed.
      // Start Fiber immediately before the actual click (not before the idle
      // wait), so it cannot attach that earlier response to this bridge turn.
      const startObservingForSubmission = () => {
        if (currentTurnId !== turn.id || currentObserverId !== observerId) {
          throw new Error('Turn was cancelled before ChatGPT became ready');
        }
        const turns = document.querySelectorAll(
          'article[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"]'
        );
        window.postMessage(
          {
            source: CONTENT_EVENT_SOURCE,
            action: 'START_TURN',
            turnId: turn.id,
            initialTurnCount: turns.length,
            observerId,
          },
          '*'
        );
        startedObserving = true;
      };

      // Perform DOM injection and click Send
      window.__OMNI_DOM.submitPrompt(turn.prompt, { onBeforeSubmit: startObservingForSubmission })
        .then(() => {
          if (!startedObserving) {
            throw new Error('ChatGPT prompt submission did not start observation');
          }
          sendResponse({ ok: true });
        })
        .catch((err) => {
          console.error('[OmniRoute Companion] Prompt submission failed:', err);
          if (startedObserving) {
            window.postMessage({ source: CONTENT_EVENT_SOURCE, action: 'STOP_TURN' }, '*');
          }
          if (currentTurnId === turn.id && currentObserverId === observerId) {
            currentTurnId = null;
            currentObserverId = null;
          }
          forwardBridgeEvent({
            turnId: turn.id,
            type: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
          sendResponse({ ok: false, error: err.message });
        });

      return true; // async sendResponse
    }

    return false;
  });

  console.log('[OmniRoute Companion] Content script ready on ChatGPT');
})();
