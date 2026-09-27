import assert from "node:assert/strict";
import test from "node:test";

const { KiroExecutor, readKiroMeteringCredits } = await import("../../open-sse/executors/kiro.ts");
const { isKiroContextTooLong, kiroRetryDelayMs, trimKiroConversationForRetry, KIRO_RETRY_CONFIG } =
  await import("../../open-sse/executors/kiro/requestRecovery.ts");
const {
  parseKiroModelCapabilities,
  recordKiroModelCapabilities,
  clearKiroModelCapabilities,
  clampKiroEffort,
} = await import("../../open-sse/services/kiroModelCapabilities.ts");
const { fetchKiroAvailableModels, clearKiroModelCache } =
  await import("../../open-sse/services/kiroModels.ts");
const { buildKiroPayload } = await import("../../open-sse/translator/request/openai-to-kiro.ts");
const { resolveKiroSessionKey } = await import("../../open-sse/utils/kiroSessionKey.ts");

// ── helpers ────────────────────────────────────────────────────────────────

type TestToolResult = { toolUseId: string; status?: string; content: Array<{ text: string }> };
type TestUserMessage = {
  content?: string;
  userInputMessageContext?: { toolResults?: TestToolResult[] };
};
type TestEntry = {
  userInputMessage?: TestUserMessage;
  assistantResponseMessage?: { content: string; toolUses?: Array<{ toolUseId: string }> };
};
type TestBody = {
  conversationState: {
    currentMessage: { userInputMessage: TestUserMessage };
    history: TestEntry[];
  };
};
type ExecuteArgs = Parameters<InstanceType<typeof KiroExecutor>["execute"]>[0];

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildEventFrame(eventType: string, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const header = (name: string, value: string) => {
    const n = enc.encode(name);
    const v = enc.encode(value);
    const out = new Uint8Array(1 + n.length + 1 + 2 + v.length);
    out[0] = n.length;
    out.set(n, 1);
    out[1 + n.length] = 7;
    new DataView(out.buffer).setUint16(2 + n.length, v.length, false);
    out.set(v, 4 + n.length);
    return out;
  };
  const headers = [header(":event-type", eventType), header(":message-type", "event")];
  const headerLen = headers.reduce((sum, h) => sum + h.length, 0);
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + headerLen + body.length + 4;
  const frame = new Uint8Array(total);
  const view = new DataView(frame.buffer);
  view.setUint32(0, total, false);
  view.setUint32(4, headerLen, false);
  view.setUint32(8, crc32(frame.slice(0, 8)), false);
  let offset = 12;
  for (const h of headers) {
    frame.set(h, offset);
    offset += h.length;
  }
  frame.set(body, offset);
  view.setUint32(total - 4, crc32(frame.slice(0, total - 4)), false);
  return frame;
}

function eventStreamResponse(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(f);
        controller.close();
      },
    }),
    { status: 200 }
  );
}

function kiroBody(historyTurns: number) {
  const history: unknown[] = [];
  for (let i = 0; i < historyTurns; i++) {
    history.push({ userInputMessage: { content: `user ${i}`, modelId: "m", origin: "KIRO_CLI" } });
    history.push({ assistantResponseMessage: { content: `assistant ${i}` } });
  }
  return {
    conversationState: {
      chatTriggerType: "MANUAL",
      conversationId: "c",
      currentMessage: { userInputMessage: { content: "now", modelId: "m", origin: "KIRO_CLI" } },
      history,
    },
  };
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

// ── 1. context-too-long trim + retry ──────────────────────────────────────

test("isKiroContextTooLong recognizes 413 and the 400 body markers only", () => {
  assert.equal(isKiroContextTooLong(413, ""), true);
  assert.equal(isKiroContextTooLong(400, "CONTENT_LENGTH_EXCEEDS_THRESHOLD"), true);
  assert.equal(isKiroContextTooLong(400, "ValidationException: Input is too long"), true);
  assert.equal(isKiroContextTooLong(400, "Improperly formed request"), false);
  assert.equal(isKiroContextTooLong(500, "Input is too long"), false);
});

test("trimKiroConversationForRetry drops oldest turns, keeps user-first history", () => {
  const body = kiroBody(5); // 10 entries
  const trimmed = trimKiroConversationForRetry(body) as unknown as TestBody;
  assert.ok(trimmed);
  const history = trimmed.conversationState.history;
  assert.ok(history.length < 10 && history.length >= 2);
  assert.ok(history[0].userInputMessage, "kept history must start with a user turn");
  assert.equal(history.at(-1).assistantResponseMessage.content, "assistant 4");
  assert.equal(body.conversationState.history.length, 10, "input body is not mutated");
});

test("trimKiroConversationForRetry halves current tool results and drops orphans", () => {
  const big = "x".repeat(4000);
  const body = kiroBody(0) as unknown as TestBody;
  body.conversationState.history = [
    { userInputMessage: { content: "u" } },
    { assistantResponseMessage: { content: "a", toolUses: [{ toolUseId: "t1" }] } },
  ];
  body.conversationState.currentMessage.userInputMessage.userInputMessageContext = {
    toolResults: [
      { toolUseId: "t1", status: "success", content: [{ text: big }] },
      { toolUseId: "gone", status: "success", content: [{ text: "orphan" }] },
    ],
  };
  const trimmed = trimKiroConversationForRetry(body) as unknown as TestBody;
  const results =
    trimmed.conversationState.currentMessage.userInputMessage.userInputMessageContext.toolResults;
  assert.equal(results.length, 1);
  assert.equal(results[0].toolUseId, "t1");
  assert.ok(results[0].content[0].text.length < big.length);
  assert.match(results[0].content[0].text, /truncated/);
});

test("trimKiroConversationForRetry returns null when nothing can shrink", () => {
  assert.equal(trimKiroConversationForRetry(kiroBody(1)), null);
});

test("KiroExecutor retries a 413 with a trimmed conversation", async () => {
  const executor = new KiroExecutor();
  executor.transformEventStreamToSSE = (response: Response) => response;
  const sentHistoryLengths: number[] = [];
  const result = await withFetch(
    (async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      sentHistoryLengths.push(body.conversationState.history.length);
      return sentHistoryLengths.length === 1
        ? new Response("Request Entity Too Large", { status: 413 })
        : new Response("ok", { status: 200 });
    }) as typeof fetch,
    () =>
      executor.execute({
        model: "claude-sonnet-4.5",
        body: kiroBody(5),
        stream: true,
        credentials: { accessToken: "t", providerSpecificData: { authMethod: "idc" } },
      } as unknown as ExecuteArgs)
  );
  assert.equal(result.response.status, 200);
  assert.equal(sentHistoryLengths.length, 2);
  assert.ok(sentHistoryLengths[1] < sentHistoryLengths[0]);
});

// ── 4. capacity / 429 / 5xx retry ─────────────────────────────────────────

test("kiroRetryDelayMs: capacity uses 5s base, transient 2s + jitter, others never", () => {
  const noJitter = () => 0;
  assert.equal(
    kiroRetryDelayMs(500, "INSUFFICIENT_MODEL_CAPACITY", 0, null, KIRO_RETRY_CONFIG, noJitter),
    5000
  );
  assert.equal(
    kiroRetryDelayMs(400, "MODEL_TEMPORARILY_UNAVAILABLE", 2, null, KIRO_RETRY_CONFIG, noJitter),
    20000
  );
  assert.equal(kiroRetryDelayMs(429, "Rate exceeded", 1, null, KIRO_RETRY_CONFIG, noJitter), 4000);
  assert.equal(
    kiroRetryDelayMs(503, "ServiceUnavailable", 0, "3", KIRO_RETRY_CONFIG, noJitter),
    3000
  );
  assert.equal(kiroRetryDelayMs(429, "MONTHLY_REQUEST_COUNT exceeded", 0, null), null);
  assert.equal(kiroRetryDelayMs(400, "Improperly formed request", 0, null), null);
  assert.equal(kiroRetryDelayMs(403, "AccessDenied", 0, null), null);
  assert.equal(kiroRetryDelayMs(429, "Rate exceeded", 3, null), null, "bounded to maxAttempts");
});

test("KiroExecutor retries a transient 503 and honors skipUpstreamRetry", async () => {
  const executor = new KiroExecutor();
  executor.transformEventStreamToSSE = (response: Response) => response;
  const credentials = { accessToken: "t", providerSpecificData: { authMethod: "idc" } };

  let calls = 0;
  const ok = await withFetch(
    (async () => {
      calls++;
      return calls === 1
        ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
        : new Response("ok", { status: 200 });
    }) as typeof fetch,
    () =>
      executor.execute({
        model: "m",
        body: kiroBody(1),
        stream: true,
        credentials,
      } as unknown as ExecuteArgs)
  );
  assert.equal(ok.response.status, 200);
  assert.equal(calls, 2);

  calls = 0;
  const skipped = await withFetch(
    (async () => {
      calls++;
      return new Response("busy", { status: 503 });
    }) as typeof fetch,
    () =>
      executor.execute({
        model: "m",
        body: kiroBody(1),
        stream: true,
        credentials,
        skipUpstreamRetry: true,
      } as unknown as ExecuteArgs)
  );
  assert.equal(skipped.response.status, 503);
  assert.equal(await skipped.response.text(), "busy", "error body survives the internal read");
  assert.equal(calls, 1);
});

// ── 3. metering credits ───────────────────────────────────────────────────

test("readKiroMeteringCredits handles flat, nested and non-credit shapes", () => {
  assert.equal(readKiroMeteringCredits({ unit: "credit", usage: 0.022 }), 0.022);
  assert.equal(readKiroMeteringCredits({ metering: { unit: "credit", usage: 1.5 } }), 1.5);
  assert.equal(readKiroMeteringCredits({ unit: "token", usage: 5 }), undefined);
  assert.equal(readKiroMeteringCredits({}), undefined);
});

test("KiroExecutor reports metered credits on the final usage chunk", async () => {
  const executor = new KiroExecutor();
  const response = eventStreamResponse([
    buildEventFrame("assistantResponseEvent", { content: "hello" }),
    buildEventFrame("metadataEvent", { stopReason: "END_TURN" }),
    buildEventFrame("contextUsageEvent", { contextUsagePercentage: 2 }),
    buildEventFrame("meteringEvent", { unit: "credit", unitPlural: "credits", usage: 0.022 }),
  ]);
  const text = await executor.transformEventStreamToSSE(response, "kiro-model").text();
  const finish = text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
    .find((c) => c.choices?.[0]?.finish_reason);
  assert.equal(finish.usage.kiro_credits, 0.022);
});

// ── 2. catalog capabilities ───────────────────────────────────────────────

const catalogItem = {
  modelId: "gpt-5.6-sol",
  modelName: "GPT 5.6 Sol",
  tokenLimits: { maxInputTokens: 272000, maxOutputTokens: 128000 },
  supportedInputTypes: ["TEXT", "IMAGE"],
  additionalModelRequestFieldsSchema: {
    properties: {
      reasoning: { properties: { effort: { enum: ["low", "medium", "high"] } } },
      max_tokens: { type: "integer" },
    },
  },
};

test("parseKiroModelCapabilities reads the effort field, enum and max_tokens", () => {
  assert.deepEqual(parseKiroModelCapabilities(catalogItem), {
    supportsMaxTokens: true,
    effortField: "reasoning",
    efforts: ["low", "medium", "high"],
  });
  assert.deepEqual(
    parseKiroModelCapabilities({
      additionalModelRequestFieldsSchema: {
        properties: { output_config: { properties: { effort: { enum: ["max", "HIGH"] } } } },
      },
    }),
    { supportsMaxTokens: false, effortField: "output_config", efforts: ["high", "max"] }
  );
  assert.equal(parseKiroModelCapabilities({ modelId: "x" }), undefined);
});

test("clampKiroEffort picks the highest supported tier at or below the request", () => {
  clearKiroModelCapabilities();
  recordKiroModelCapabilities("m", { efforts: ["low", "high"] });
  assert.equal(clampKiroEffort("m", "high"), "high");
  assert.equal(clampKiroEffort("m", "max"), "high");
  assert.equal(clampKiroEffort("m", "medium"), "low");
  assert.equal(clampKiroEffort("m", "none"), undefined);
  assert.equal(clampKiroEffort("unknown", "max"), "max");
  clearKiroModelCapabilities();
});

test("fetchKiroAvailableModels maps maxOutputTokens, vision and catalog efforts", async () => {
  clearKiroModelCache();
  clearKiroModelCapabilities();
  const result = await fetchKiroAvailableModels({
    accessToken: "tok",
    providerSpecificData: { profileArn: "arn:aws:codewhisperer:us-east-1:1:profile/X" },
    fetchImpl: (async () =>
      new Response(JSON.stringify({ models: [catalogItem] }), { status: 200 })) as typeof fetch,
  });
  assert.equal(result.source, "api");
  const model = result.models.find((m) => m.id === "gpt-5.6-sol")!;
  assert.equal(model.maxOutputTokens, 128000);
  assert.equal(model.supportsVision, true);
  assert.deepEqual(model.supportedThinkingEfforts, ["low", "medium", "high"]);
  clearKiroModelCache();
  clearKiroModelCapabilities();
});

test("buildKiroPayload clamps effort to the discovered catalog enum", () => {
  clearKiroModelCapabilities();
  recordKiroModelCapabilities("gpt-5.6-sol", {
    effortField: "reasoning",
    efforts: ["low", "medium", "high"],
    supportsMaxTokens: true,
  });
  const payload = buildKiroPayload(
    "gpt-5.6-sol",
    { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
    true,
    { providerSpecificData: {} }
  );
  assert.deepEqual(payload.additionalModelRequestFields, { reasoning: { effort: "high" } });
  clearKiroModelCapabilities();
});

test("buildKiroPayload keeps static behavior when the catalog is unknown", () => {
  clearKiroModelCapabilities();
  const payload = buildKiroPayload(
    "gpt-5.6-sol",
    { messages: [{ role: "user", content: "hi" }], reasoning_effort: "max" },
    true,
    { providerSpecificData: {} }
  );
  assert.deepEqual(payload.additionalModelRequestFields, { reasoning: { effort: "max" } });
});

// ── 5. stable conversationId ──────────────────────────────────────────────

test("resolveKiroSessionKey prefers Kiro/Anthropic headers, then generic identity", () => {
  assert.equal(resolveKiroSessionKey({ "X-Kiro-Session-Id": "k1" }), "k1");
  assert.equal(resolveKiroSessionKey({ "anthropic-session-id": "a1" }), "a1");
  assert.equal(resolveKiroSessionKey({ "x-session-id": "s1" }), "s1");
  assert.equal(resolveKiroSessionKey({}, { metadata: { session_id: "m1" } }), "m1");
  assert.equal(resolveKiroSessionKey({}, { messages: [] }), undefined);
  assert.equal(resolveKiroSessionKey({ "x-kiro-session-id": "bad\u0000id" }), undefined);
});

test("buildKiroPayload derives conversationId from the session key when provided", () => {
  const first = { messages: [{ role: "user", content: "first" }] };
  const edited = { messages: [{ role: "user", content: "edited first" }] };
  const a = buildKiroPayload("claude-sonnet-4.5", first, true, { _sessionKey: "sess-1" });
  const b = buildKiroPayload("claude-sonnet-4.5", edited, true, { _sessionKey: "sess-1" });
  const c = buildKiroPayload("claude-sonnet-4.5", first, true, { _sessionKey: "sess-2" });
  const d = buildKiroPayload("claude-sonnet-4.5", first, true, {});
  assert.equal(a.conversationState.conversationId, b.conversationState.conversationId);
  assert.notEqual(a.conversationState.conversationId, c.conversationState.conversationId);
  assert.notEqual(a.conversationState.conversationId, d.conversationState.conversationId);
});

// ── A. single Kiro CLI client version ─────────────────────────────────────

test("chat and model-discovery headers advertise the same Kiro CLI version", async () => {
  const { KIRO_CLI_VERSION, getKiroUserAgent } =
    await import("../../open-sse/config/providerHeaderProfiles.ts");
  const { KIRO_CLI_USER_AGENT } = await import("../../open-sse/services/kiroModels.ts");
  assert.equal(KIRO_CLI_VERSION, "2.24.0");
  if (!process.env.KIRO_CUSTOM_USER_AGENT) {
    assert.match(getKiroUserAgent(), /md\/appVersion-2\.24\.0 app\/AmazonQ-For-CLI$/);
    assert.match(KIRO_CLI_USER_AGENT, /md\/appVersion-2\.24\.0 app\/AmazonQ-For-CLI$/);
  }
});

// ── B. context-pressure signal ────────────────────────────────────────────

async function finishUsage(percent: number) {
  const executor = new KiroExecutor();
  const response = eventStreamResponse([
    buildEventFrame("assistantResponseEvent", { content: "reply text" }),
    buildEventFrame("metadataEvent", { stopReason: "END_TURN" }),
    buildEventFrame("contextUsageEvent", { contextUsagePercentage: percent }),
  ]);
  const text = await executor.transformEventStreamToSSE(response, "claude-sonnet-4.5").text();
  return text
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
    .find((c) => c.choices?.[0]?.finish_reason).usage;
}

test("context usage >= 95% reports prompt tokens past the model window", async () => {
  const { KIRO_CONTEXT_PRESSURE_PERCENT } = await import("../../open-sse/executors/kiro.ts");
  assert.equal(KIRO_CONTEXT_PRESSURE_PERCENT, 95);
  const window = 200000; // claude-sonnet-4.5 registry contextLength
  const high = await finishUsage(96);
  assert.ok(high.total_tokens > window, `total ${high.total_tokens} must exceed ${window}`);
  const low = await finishUsage(50);
  assert.ok(low.total_tokens <= window * 0.5 + 1);
});
