/**
 * OmniRoute React Fiber Inspector (Runs in MAIN World)
 * Hooks into React's internal fiber tree (__reactFiber$) on chatgpt.com
 * to observe real-time message streaming, thinking tokens, and turn completion signals.
 */
(() => {
  'use strict';

  const CONTENT_EVENT_SOURCE = 'OMNI_CONTENT_V2';
  const FIBER_EVENT_SOURCE = 'OMNI_FIBER_V2';
  // ChatGPT can hide its Stop button before React commits the final rendered
  // markdown. Wait briefly after both events settle before closing a turn.
  const FINAL_RENDER_SETTLE_MS = 500;
  // Keep the growing edge out of incremental deltas until the next snapshot
  // proves it is content rather than ChatGPT's transient typing cursor.
  const TRAILING_TEXT_BUFFER_CHARS = 1;
  // Scripts injected into MAIN world outlive an unpacked extension reload.
  // Current versions replace the prior observer instead of reporting each
  // turn twice when they are reinjected into the same ChatGPT page.
  const RUNTIME_KEY = '__OMNI_COMPANION_FIBER_RUNTIME__';
  const previousRuntime = window[RUNTIME_KEY];
  if (previousRuntime && typeof previousRuntime.dispose === 'function') {
    previousRuntime.dispose();
  }

  let lastEmittedText = '';
  let lastEmittedThinking = '';
  let lastObservedText = null;
  let lastObservedThinking = null;
  let isObservingTurn = false;
  let activeTurnId = null;
  let baselineTurnCount = 0;
  let pollInterval = null;
  let seenGenerating = false;
  let generationStoppedAt = null;
  let lastContentChangeAt = 0;
  let activeObserverId = null;

  function findFiberNode(element) {
    if (!element) return null;
    const key = Object.keys(element).find((k) => k.startsWith('__reactFiber$'));
    return key ? element[key] : null;
  }

  function getConversationTurns() {
    return document.querySelectorAll(
      'article[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"]'
    );
  }

  function getActiveAssistantTurnElement() {
    const turns = getConversationTurns();
    if (turns.length === 0) return null;

    // Only inspect turns that were created after observation started
    const startIndex = Math.max(0, baselineTurnCount);
    for (let i = turns.length - 1; i >= startIndex; i--) {
      const turn = turns[i];
      // Assistant turns contain .markdown, thought container, or copy button
      if (
        turn.querySelector('.markdown') ||
        turn.querySelector('[data-testid*="thought"]') ||
        turn.querySelector('[data-testid*="reasoning"]') ||
        turn.querySelector('button[data-testid*="copy"]')
      ) {
        return turn;
      }
    }

    // If turns grew but markdown not yet rendered, inspect the latest turn
    if (turns.length > baselineTurnCount) {
      return turns[turns.length - 1];
    }

    return null;
  }

  function renderedText(element) {
    if (!element) return '';
    // innerText follows the rendered tree and usually excludes hidden cursor
    // nodes. textContent remains a compatibility fallback for unusual pages.
    return typeof element.innerText === 'string' ? element.innerText : element.textContent || '';
  }

  function longestRenderedText(turnEl, selector) {
    if (!turnEl) return '';
    const candidates = turnEl.querySelectorAll(selector);
    let longest = '';
    for (const candidate of candidates) {
      const text = renderedText(candidate);
      if (text.length > longest.length) longest = text;
    }
    return longest;
  }

  function extractAssistantText(turnEl) {
    // Streaming/final React subtrees can overlap briefly. Selecting the
    // longest rendered markdown avoids sticking to a stale partial subtree.
    return longestRenderedText(turnEl, '.markdown');
  }

  function extractThinkingText(turnEl) {
    return longestRenderedText(
      turnEl,
      '[data-testid="thought-content"], [data-testid="reasoning-content"], div[class*="thought"]'
    );
  }

  function longestCommonPrefix(left, right) {
    const length = Math.min(left.length, right.length);
    let index = 0;
    while (index < length && left[index] === right[index]) index += 1;
    return left.slice(0, index);
  }

  function emitTextDelta(nextText, trailingBufferChars = 0) {
    if (!nextText.startsWith(lastEmittedText)) return;
    const safeEnd = Math.max(
      lastEmittedText.length,
      nextText.length - Math.max(0, trailingBufferChars)
    );
    const safeText = nextText.slice(0, safeEnd);
    const delta = safeText.slice(lastEmittedText.length);
    if (!delta) return;
    // Track precisely the prefix delivered to the bridge. The optional
    // trailing buffer has intentionally not been emitted yet.
    lastEmittedText = safeText;
    window.postMessage(
      {
        source: FIBER_EVENT_SOURCE,
        type: 'delta',
        turnId: activeTurnId,
        observerId: activeObserverId,
        text: delta,
      },
      '*'
    );
  }

  function emitThinkingDelta(nextText) {
    if (!nextText.startsWith(lastEmittedThinking)) return;
    const delta = nextText.slice(lastEmittedThinking.length);
    if (!delta) return;
    lastEmittedThinking = nextText;
    window.postMessage(
      {
        source: FIBER_EVENT_SOURCE,
        type: 'thinking',
        turnId: activeTurnId,
        observerId: activeObserverId,
        thinking: delta,
      },
      '*'
    );
  }

  function observeText(currentText) {
    if (lastObservedText === null) {
      lastObservedText = currentText;
      return;
    }
    if (currentText !== lastObservedText) {
      lastContentChangeAt = Date.now();
      // Emit only the text stable across two snapshots. This delays a small
      // trailing edge by one poll and prevents a transient typing cursor (for
      // example a trailing underscore) from leaking into OpenAI deltas.
      emitTextDelta(longestCommonPrefix(lastObservedText, currentText));
      lastObservedText = currentText;
    } else {
      emitTextDelta(currentText, TRAILING_TEXT_BUFFER_CHARS);
    }
  }

  function observeThinking(currentText) {
    if (lastObservedThinking === null) {
      lastObservedThinking = currentText;
      return;
    }
    if (currentText !== lastObservedThinking) {
      lastContentChangeAt = Date.now();
      emitThinkingDelta(longestCommonPrefix(lastObservedThinking, currentText));
      lastObservedThinking = currentText;
    } else {
      emitThinkingDelta(currentText);
    }
  }

  function checkErrorBanner(turnEl) {
    if (!turnEl) return null;
    const errorEl = turnEl.querySelector(
      'div[role="alert"], [class*="text-error"], [class*="text-red"]'
    );
    if (errorEl && errorEl.textContent) {
      return errorEl.textContent.trim();
    }
    return null;
  }

  function isStopButtonVisible() {
    const stop = document.querySelector(
      'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label*="Stop" i]'
    );
    return Boolean(stop && stop.isConnected && stop.offsetParent !== null);
  }

  function checkStreamingProgress() {
    if (!isObservingTurn) return;

    const now = Date.now();
    const generating = isStopButtonVisible();
    if (generating) {
      seenGenerating = true;
      generationStoppedAt = null;
    }

    const turnEl = getActiveAssistantTurnElement();
    if (!turnEl) return;

    // 1. Check for error banner
    const errorMsg = checkErrorBanner(turnEl);
    if (errorMsg && !generating) {
      window.postMessage(
        {
          source: FIBER_EVENT_SOURCE,
          type: 'error',
          turnId: activeTurnId,
          observerId: activeObserverId,
          error: errorMsg,
        },
        '*'
      );
      stopObserving();
      return;
    }

    // 2. Stream thinking/reasoning deltas
    const currentThinking = extractThinkingText(turnEl);
    observeThinking(currentThinking);

    // 3. Stream text deltas
    const currentText = extractAssistantText(turnEl);
    observeText(currentText);

    // 4. Check completion only after the final React render has been quiet.
    if (
      seenGenerating &&
      !generating &&
      (currentText.length > 0 || currentThinking.length > 0 || lastEmittedText.length > 0 || lastEmittedThinking.length > 0)
    ) {
      if (generationStoppedAt === null) generationStoppedAt = now;
      if (
        now - generationStoppedAt < FINAL_RENDER_SETTLE_MS ||
        now - lastContentChangeAt < FINAL_RENDER_SETTLE_MS
      ) {
        return;
      }

      // Flush the final stable snapshot. This captures text that arrived
      // after ChatGPT hid Stop but before its markdown commit completed.
      emitThinkingDelta(currentThinking);
      emitTextDelta(currentText);
      window.postMessage(
        {
          source: FIBER_EVENT_SOURCE,
          type: 'finish',
          turnId: activeTurnId,
          observerId: activeObserverId,
          finishReason: 'stop',
          fullText: lastEmittedText,
        },
        '*'
      );
      stopObserving();
    }
  }

  function startObserving(turnId, initialTurnCount = 0, observerId = null) {
    isObservingTurn = true;
    activeTurnId = turnId;
    activeObserverId = observerId;
    baselineTurnCount = typeof initialTurnCount === 'number' ? initialTurnCount : 0;
    lastEmittedText = '';
    lastEmittedThinking = '';
    lastObservedText = null;
    lastObservedThinking = null;
    seenGenerating = false;
    generationStoppedAt = null;
    lastContentChangeAt = Date.now();

    if (pollInterval) clearInterval(pollInterval);
    pollInterval = setInterval(checkStreamingProgress, 100);
  }

  function stopObserving() {
    isObservingTurn = false;
    activeTurnId = null;
    activeObserverId = null;
    seenGenerating = false;
    generationStoppedAt = null;
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  }

  // Listen for instructions from the isolated world content.js
  function onContentMessage(event) {
    if (event.source !== window || !event.data || event.data.source !== CONTENT_EVENT_SOURCE) return;
    if (event.data.action === 'START_TURN') {
      startObserving(event.data.turnId, event.data.initialTurnCount, event.data.observerId);
    } else if (event.data.action === 'STOP_TURN') {
      stopObserving();
    }
  }

  window.addEventListener('message', onContentMessage);
  window[RUNTIME_KEY] = {
    dispose() {
      stopObserving();
      window.removeEventListener('message', onContentMessage);
    },
  };

  console.log('[OmniRoute Companion] Fiber monitor initialized in MAIN world');
})();
