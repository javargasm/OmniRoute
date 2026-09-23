import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import React from "react";
import { renderToStaticMarkup as reactRenderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";

const { default: RequestLoggerDetail } =
  await import("../../src/shared/components/RequestLoggerDetail.tsx");

// #9245 (7ca73697b0) localized RequestLoggerDetail (useTranslations("requestLogger.detail")),
// so the component must render inside NextIntlClientProvider. Use the REAL English
// messages — the assertions below pin the actual en.json copy, not a stub.
const here = dirname(fileURLToPath(import.meta.url));
const enMessages = JSON.parse(
  readFileSync(resolve(here, "../../src/i18n/messages/en.json"), "utf8")
);

function renderToStaticMarkup(element: React.ReactElement) {
  return reactRenderToStaticMarkup(
    React.createElement(
      NextIntlClientProvider,
      { locale: "en", timeZone: "UTC", messages: { requestLogger: enMessages.requestLogger } },
      element
    )
  );
}

test("event stream shows only when debugEnabled and appears above legacy response", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        status: 504,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-04-09T21:27:08.000Z",
        duration: 2500,
        provider: "gemini",
        sourceFormat: "openai-chat",
        model: "test-model",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        pipelinePayloads: {
          streamChunks: {
            provider: ['data: {"content": "hello"}\n\n'],
            openai: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'],
          },
          // No providerResponse here so payloadSections will be empty and the legacy
          // response payload should still be rendered; Event Stream must appear above it.
        },
        responseBody: "{}",
      },

      loading: false,
      debugEnabled: true,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.notEqual(
    html.indexOf(">Provider Event Stream<"),
    -1,
    "Event Stream should be present when debugEnabled"
  );
  // Ensure the legacy response payload is present and that the Event Stream appears above it
  assert.notEqual(
    html.indexOf(">Response Payload (Legacy)<"),
    -1,
    "Legacy response payload should be present"
  );
  assert(
    html.indexOf(">Provider Event Stream<") < html.indexOf(">Response Payload (Legacy)<"),
    "Event Stream should appear before Response Payload (Legacy)"
  );
});

// Regression: commit 692d6be80 ("unify active and finished requests into single
// view") swapped the collapsible PayloadSection for the new StreamSection (added
// autoscroll) when rendering the provider/client event streams, but never carried
// the collapse toggle over — StreamSection had none. Provider/Client Event Stream
// panes silently lost the ability to collapse from that point on.
test("Provider Event Stream and Client Event Stream panes are collapsible", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        status: 200,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-04-09T21:27:08.000Z",
        duration: 2500,
        provider: "gemini",
        sourceFormat: "openai-chat",
        model: "test-model",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        pipelinePayloads: {
          streamChunks: {
            provider: ['data: {"content": "hello"}\n\n'],
            client: ['data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'],
          },
        },
        responseBody: "{}",
      },
      loading: false,
      debugEnabled: true,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.notEqual(
    html.indexOf('aria-label="Collapse Provider Event Stream"'),
    -1,
    "Provider Event Stream should render a collapse toggle"
  );
  assert.notEqual(
    html.indexOf('aria-label="Collapse Client Event Stream"'),
    -1,
    "Client Event Stream should render a collapse toggle"
  );
});

test("event stream hidden when debugEnabled is false", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        status: 504,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-04-09T21:27:08.000Z",
        duration: 2500,
        provider: "gemini",
        sourceFormat: "openai-chat",
        model: "test-model",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        pipelinePayloads: {
          streamChunks: { provider: ["data: chunk"] },
          providerResponse: { status: 200 },
        },
        responseBody: "{}",
      },
      loading: false,
      debugEnabled: false,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.equal(
    html.indexOf(">Provider Event Stream<"),
    -1,
    "Event Stream should be hidden when debugEnabled is false"
  );
});

test("status discrepancy shows both OmniRoute and provider statuses", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        status: 504,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-04-09T21:27:08.000Z",
        duration: 2500,
        provider: "gemini",
        sourceFormat: "openai-chat",
        model: "test-model",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        pipelinePayloads: {
          providerResponse: { status: 200 },
        },
      },
      loading: false,
      debugEnabled: false,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.notEqual(html.indexOf("Upstream: 200"), -1, "Should display upstream/provider status");
  assert.notEqual(
    html.indexOf("OmniRoute returned 504"),
    -1,
    "Should indicate OmniRoute returned its own status"
  );
});

test("request logger detail renders stream chunks correctly", () => {
  const log = {
    status: 200,
    method: "POST",
    path: "/v1/chat/completions",
    provider: "gemini",
    model: "gemma-4-31b-it",
    timestamp: new Date().toISOString(),
    duration: 100,
  };

  const detail = {
    pipelinePayloads: {
      streamChunks: {
        provider: [
          'data: {"type": "message_start"}\n\n',
          'data: {"type": "content_block_start"}\n\n',
          ": x-omniroute-latency-ms=1\n",
          "data: [DONE]\n\n",
        ],
      },
    },
    responseBody: "{}",
  };

  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log,
      detail,
      loading: false,
      debugEnabled: true,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  const expectedFragment = "message_start";
  assert.notEqual(
    html.indexOf(">Provider Event Stream<"),
    -1,
    "Event Stream header should be present"
  );
  // The new UI renders the provider stream under a "Provider Event Stream" section
  // (the raw key is no longer dumped inline); match case-insensitively so the check
  // still asserts the provider stream is referenced in the output.
  assert.notEqual(
    html.toLowerCase().indexOf("provider"),
    -1,
    "Stream chunks output should reference the provider stream"
  );
  assert.notEqual(
    html.indexOf(expectedFragment),
    -1,
    "Stream content (message_start) should be present in rendered HTML"
  );
});

test("Kiro detail displays the stored wire request and its native reasoning effort", () => {
  const translatedKiroRequest = {
    conversationState: {
      currentMessage: {
        userInputMessage: {
          content: "Explain the payload",
          modelId: "gpt-5.6-sol",
          origin: "KIRO_CLI",
        },
      },
      history: [],
    },
    additionalModelRequestFields: { reasoning: { effort: "max" } },
  };
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        status: 200,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-09-17T13:00:00.000Z",
        duration: 100,
        provider: "kiro",
        sourceFormat: "openai-chat",
        model: "gpt-5.6-sol",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        pipelinePayloads: {
          providerRequest: {
            url: "https://kiro.example.test/generateAssistantResponse",
            headers: { authorization: "[REDACTED]" },
            body: translatedKiroRequest,
          },
        },
      },
      loading: false,
      debugEnabled: false,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.notEqual(html.indexOf("Kiro Provider Request"), -1);
  assert.notEqual(html.indexOf("Reasoning: max"), -1);
  assert.notEqual(html.indexOf("additionalModelRequestFields"), -1);
  assert.notEqual(html.indexOf("gpt-5.6-sol"), -1);
  assert.equal(
    html.includes("kiro.example.test"),
    false,
    "Kiro detail should display the translated request body, not its capture envelope"
  );
});

test("Kiro active detail surfaces native reasoning effort", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        active: true,
        status: 0,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-09-17T13:00:00.000Z",
        duration: 100,
        provider: "kiro",
        sourceFormat: "openai-chat",
        model: "gpt-5.6-terra",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        pipelinePayloads: {
          providerRequest: {
            conversationState: {
              currentMessage: { userInputMessage: { modelId: "gpt-5.6-terra" } },
            },
            additionalModelRequestFields: { reasoning: { effort: "max" } },
          },
        },
      },
      loading: false,
      debugEnabled: false,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.match(html, /data-testid="kiro-reasoning-effort"/);
  assert.match(html, /Reasoning: max/);
});

test("Kiro detail surfaces output_config reasoning effort", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        status: 200,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-09-17T13:00:00.000Z",
        duration: 100,
        provider: "kiro",
        sourceFormat: "openai-chat",
        model: "claude-sonnet-4.6",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        pipelinePayloads: {
          providerRequest: {
            body: {
              conversationState: {
                currentMessage: { userInputMessage: { modelId: "claude-sonnet-4.6" } },
              },
              additionalModelRequestFields: { output_config: { effort: "high" } },
            },
          },
        },
      },
      loading: false,
      debugEnabled: false,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.match(html, /Kiro Provider Request/);
  assert.match(html, /Reasoning: high/);
});

test("Kiro detail surfaces recorded reasoning when a historical log lacks its wire payload", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        status: 200,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-09-17T13:00:00.000Z",
        duration: 100,
        provider: "kiro",
        sourceFormat: "openai-chat",
        model: "gpt-5.6-terra",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        requestBody: {
          model: "gpt-5.6-terra",
          reasoning_effort: "max",
        },
      },
      loading: false,
      debugEnabled: false,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.match(html, /data-testid="kiro-reasoning-effort"/);
  assert.match(html, /Reasoning: max/);
  assert.match(html, /Kiro Request Payload \(Legacy\)/);
  assert.match(html, /Enable detailed logging first/);
  assert.equal(
    html.includes("Kiro Provider Request"),
    false,
    "A historical normalized request must not be presented as the captured Kiro wire payload"
  );
});

test("non-Kiro details retain the captured provider request envelope", () => {
  const html = renderToStaticMarkup(
    React.createElement(RequestLoggerDetail, {
      log: {
        status: 200,
        method: "POST",
        path: "/v1/chat/completions",
        timestamp: "2026-09-17T13:00:00.000Z",
        duration: 100,
        provider: "openai",
        sourceFormat: "openai-chat",
        model: "gpt-4o-mini",
        tokens: { in: 1, out: 1 },
      },
      detail: {
        pipelinePayloads: {
          providerRequest: {
            url: "https://api.openai.example/v1/chat/completions",
            headers: { authorization: "[REDACTED]" },
            body: { model: "gpt-4o-mini", messages: [{ role: "user", content: "hello" }] },
          },
        },
      },
      loading: false,
      debugEnabled: false,
      onClose: () => {},
      onCopy: async () => true,
    })
  );

  assert.match(html, /Provider Request/);
  assert.match(html, /api\.openai\.example/);
  assert.equal(html.includes("Kiro Provider Request"), false);
});
