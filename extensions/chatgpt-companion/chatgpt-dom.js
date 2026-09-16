/**
 * OmniRoute ChatGPT DOM Helpers
 * Locates the composer, handles text injection with synthetic events,
 * and controls the Send/Stop button state.
 */
window.__OMNI_DOM = (() => {
  const DEFAULT_IDLE_WAIT_MS = 60_000;
  const POLL_INTERVAL_MS = 150;
  const SELECTORS = {
    textarea: '#prompt-textarea',
    sendButton: 'button[data-testid="send-button"], form button[aria-label^="Send" i]',
    stopButton: 'button[data-testid="stop-button"], button[data-testid="composer-stop-button"], button[aria-label*="Stop" i]',
    conversationTurns: 'article[data-testid^="conversation-turn"], section[data-testid^="conversation-turn"]',
    assistantMarkdown: '.markdown',
    errorAlert: 'div[role="alert"], [data-testid="conversation-turn"] [class*="text-error"], [data-testid="conversation-turn"] [class*="text-red"]',
    thinkingContainer: '[data-testid="thought-content"], [data-testid="reasoning-content"], div[class*="thought"]',
  };

  function getComposer() {
    return document.querySelector(SELECTORS.textarea);
  }

  function getSendButton() {
    return document.querySelector(SELECTORS.sendButton);
  }

  function getStopButton() {
    return document.querySelector(SELECTORS.stopButton);
  }

  function isGenerating() {
    const stop = getStopButton();
    return Boolean(stop && stop.isConnected && stop.offsetParent !== null);
  }

  function isSendEnabled(button) {
    if (!button || !button.isConnected) return false;
    if (button.disabled) return false;
    if (button.getAttribute('aria-disabled') === 'true') return false;
    return true;
  }

  function clickStop() {
    const stop = getStopButton();
    if (stop && stop.isConnected) {
      stop.click();
      return true;
    }
    return false;
  }

  function getErrorText() {
    const el = document.querySelector(SELECTORS.errorAlert);
    if (el && el.textContent) {
      return el.textContent.trim();
    }
    return null;
  }

  function positiveTimeout(value, fallback) {
    return Number.isFinite(value) && value > 0 ? value : fallback;
  }

  /**
   * A manually-started ChatGPT response and a Companion turn share one
   * composer. Wait for the existing response rather than rejecting a valid
   * queued turn immediately. The worker renews its bridge lease while this
   * bounded wait is in progress.
   */
  function waitForIdle(timeoutMs = DEFAULT_IDLE_WAIT_MS) {
    if (!isGenerating()) return Promise.resolve();

    const limit = positiveTimeout(timeoutMs, DEFAULT_IDLE_WAIT_MS);
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        if (!isGenerating()) {
          clearInterval(interval);
          resolve();
          return;
        }
        if (Date.now() - startTime >= limit) {
          clearInterval(interval);
          reject(new Error('Timed out waiting for the current ChatGPT response to finish'));
        }
      }, POLL_INTERVAL_MS);
    });
  }

  function normalizeSubmitOptions(timeoutOrOptions) {
    if (typeof timeoutOrOptions === 'number') {
      return {
        submitTimeoutMs: positiveTimeout(timeoutOrOptions, 20_000),
        idleTimeoutMs: DEFAULT_IDLE_WAIT_MS,
        onBeforeSubmit: null,
      };
    }

    const options = timeoutOrOptions && typeof timeoutOrOptions === 'object' ? timeoutOrOptions : {};
    return {
      submitTimeoutMs: positiveTimeout(options.submitTimeoutMs ?? options.timeoutMs, 20_000),
      idleTimeoutMs: positiveTimeout(options.idleTimeoutMs, DEFAULT_IDLE_WAIT_MS),
      onBeforeSubmit: typeof options.onBeforeSubmit === 'function' ? options.onBeforeSubmit : null,
    };
  }

  /**
   * Injects text into ChatGPT's contenteditable/textarea composer
   * and dispatches proper React synthetic input events.
   */
  function setComposerText(text) {
    const box = getComposer();
    if (!box) return false;
    box.focus();

    if (box.tagName.toLowerCase() === 'textarea') {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value'
      )?.set;
      if (nativeSetter) {
        nativeSetter.call(box, text);
      } else {
        box.value = text;
      }
      box.dispatchEvent(new Event('beforeinput', { bubbles: true, cancelable: true }));
      box.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
      box.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    } else {
      // Contenteditable (Lexical / ProseMirror)
      document.execCommand('selectAll', false, null);
      const inserted = document.execCommand('insertText', false, text);
      if (!inserted || box.textContent !== text) {
        box.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = text;
        box.appendChild(p);
      }
      box.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      box.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true, inputType: 'insertText', data: text }));
      box.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    }
    return true;
  }

  /**
   * Submits the prompt: injects the text, waits for Send to be enabled, and clicks.
   */
  async function submitPrompt(text, timeoutOrOptions = 20000) {
    const { submitTimeoutMs, idleTimeoutMs, onBeforeSubmit } = normalizeSubmitOptions(timeoutOrOptions);
    await waitForIdle(idleTimeoutMs);

    const box = getComposer();
    if (!box) {
      throw new Error('Could not find ChatGPT composer textarea (#prompt-textarea)');
    }
    setComposerText(text);

    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      let enterDispatched = false;
      let submissionNotified = false;

      function notifyBeforeSubmit() {
        if (submissionNotified) return;
        if (onBeforeSubmit) onBeforeSubmit();
        submissionNotified = true;
      }

      const interval = setInterval(() => {
        const btn = getSendButton();
        if (btn && isSendEnabled(btn)) {
          clearInterval(interval);
          try {
            notifyBeforeSubmit();
            btn.click();
            resolve(true);
          } catch (err) {
            reject(err);
          }
          return;
        }

        // If after 1.5s button isn't enabled, attempt Enter keypress fallback
        if (!enterDispatched && Date.now() - startTime > 1500) {
          enterDispatched = true;
          try {
            notifyBeforeSubmit();
            box.dispatchEvent(new KeyboardEvent('keydown', {
              key: 'Enter',
              code: 'Enter',
              keyCode: 13,
              which: 13,
              bubbles: true,
              cancelable: true,
            }));
          } catch (err) {
            clearInterval(interval);
            reject(err);
            return;
          }
        }

        if (isGenerating()) {
          clearInterval(interval);
          if (submissionNotified) {
            resolve(true);
          } else {
            reject(new Error('ChatGPT started generating before the prompt could be submitted'));
          }
          return;
        }

        if (Date.now() - startTime > submitTimeoutMs) {
          clearInterval(interval);
          reject(new Error('Timed out waiting for Send button to become enabled'));
        }
      }, 150);
    });
  }

  return {
    getComposer,
    getSendButton,
    getStopButton,
    isGenerating,
    isSendEnabled,
    clickStop,
    getErrorText,
    waitForIdle,
    setComposerText,
    submitPrompt,
  };
})();
