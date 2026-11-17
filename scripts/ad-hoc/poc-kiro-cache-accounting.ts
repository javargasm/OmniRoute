import assert from "node:assert/strict";

process.env.NEXT_PHASE = "phase-production-build";

import type { KiroExecutor } from "../../open-sse/executors/kiro.ts";

const textEncoder = new TextEncoder();

type JsonRecord = Record<string, unknown>;
type Usage = {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

type Scenario = {
  name: string;
  frames: Uint8Array[];
  expected: Usage;
};

function crc32(buf: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[i] = crc >>> 0;
  }

  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodeHeader(name: string, value: string): Uint8Array {
  const nameBytes = textEncoder.encode(name);
  const valueBytes = textEncoder.encode(value);
  const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
  let offset = 0;
  header[offset++] = nameBytes.length;
  header.set(nameBytes, offset);
  offset += nameBytes.length;
  header[offset++] = 7;
  header[offset++] = (valueBytes.length >> 8) & 0xff;
  header[offset++] = valueBytes.length & 0xff;
  header.set(valueBytes, offset);
  return header;
}

function buildEventFrame(eventType: string, payload: JsonRecord): Uint8Array {
  const headers = encodeHeader(":event-type", eventType);
  const payloadBytes = textEncoder.encode(JSON.stringify(payload));
  const totalLength = 12 + headers.length + payloadBytes.length + 4;
  const frame = new Uint8Array(totalLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, totalLength, false);
  view.setUint32(4, headers.length, false);
  view.setUint32(8, crc32(frame.slice(0, 8)), false);
  frame.set(headers, 12);
  frame.set(payloadBytes, 12 + headers.length);
  view.setUint32(totalLength - 4, crc32(frame.slice(0, totalLength - 4)), false);
  return frame;
}

function buildEventStreamResponse(frames: Uint8Array[]): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of frames) controller.enqueue(frame);
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/vnd.amazon.eventstream" },
    }
  );
}

function getFinishUsage(text: string): Usage {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    const chunk = JSON.parse(payload) as {
      choices?: Array<{ finish_reason?: string | null }>;
      usage?: Usage;
    };
    if (chunk.choices?.[0]?.finish_reason && chunk.usage) return chunk.usage;
  }
  throw new Error("Kiro EventStream emitted no terminal usage block");
}

function sanitizedUsage(usage: Usage): Usage {
  return {
    prompt_tokens: usage.prompt_tokens,
    completion_tokens: usage.completion_tokens,
    total_tokens: usage.total_tokens,
    ...(usage.cache_read_input_tokens !== undefined && {
      cache_read_input_tokens: usage.cache_read_input_tokens,
    }),
    ...(usage.cache_creation_input_tokens !== undefined && {
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
    }),
  };
}

async function runScenario(executor: KiroExecutor, scenario: Scenario): Promise<void> {
  const response = executor.transformEventStreamToSSE(
    buildEventStreamResponse(scenario.frames),
    "kiro-model"
  );
  const usage = getFinishUsage(await response.text());
  assert.deepEqual(usage, scenario.expected, scenario.name);
  console.log(`${scenario.name}: ${JSON.stringify(sanitizedUsage(usage))}`);
}

async function runPoc(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  globalThis.fetch = async () => {
    throw new Error("Offline Kiro cache-accounting PoC blocked fetch");
  };
  Object.defineProperty(globalThis, "caches", { configurable: true, value: {} });

  try {
    const { KiroExecutor } = await import("../../open-sse/executors/kiro.ts");
    const executor = new KiroExecutor();
    const scenarios: Scenario[] = [
      {
        name: "explicit cache zeros are preserved",
        frames: [
          buildEventFrame("metadataEvent", {
            usage: {
              inputTokens: 12,
              outputTokens: 3,
              cacheReadInputTokens: 0,
              cacheWriteInputTokens: 0,
            },
          }),
        ],
        expected: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      {
        name: "cache-only metadata survives later totals",
        frames: [
          buildEventFrame("metadataEvent", { usage: { cacheReadInputTokens: 900 } }),
          buildEventFrame("metricsEvent", { inputTokens: 12, outputTokens: 3 }),
        ],
        expected: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          cache_read_input_tokens: 900,
        },
      },
      {
        name: "partial cache fields merge in reverse order",
        frames: [
          buildEventFrame("metricsEvent", { inputTokens: 12, outputTokens: 3 }),
          buildEventFrame("metadataEvent", { usage: { cacheReadInputTokens: 900 } }),
          buildEventFrame("metricsEvent", { cacheWriteInputTokens: 24 }),
        ],
        expected: {
          prompt_tokens: 12,
          completion_tokens: 3,
          total_tokens: 15,
          cache_read_input_tokens: 900,
          cache_creation_input_tokens: 24,
        },
      },
      {
        name: "partial totals preserve their previous counterpart",
        frames: [
          buildEventFrame("metricsEvent", { inputTokens: 12, outputTokens: 3 }),
          buildEventFrame("metadataEvent", { usage: { outputTokens: 4 } }),
        ],
        expected: {
          prompt_tokens: 12,
          completion_tokens: 4,
          total_tokens: 16,
        },
      },
      {
        name: "explicit zero totals suppress estimates",
        frames: [
          buildEventFrame("assistantResponseEvent", { content: "not an estimate" }),
          buildEventFrame("contextUsageEvent", { contextUsagePercentage: 10 }),
          buildEventFrame("metricsEvent", { inputTokens: 0, outputTokens: 0 }),
        ],
        expected: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
      },
    ];

    for (const scenario of scenarios) await runScenario(executor, scenario);
    console.log("Offline Kiro cache-accounting PoC passed.");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete (globalThis as { caches?: unknown }).caches;
    else Object.defineProperty(globalThis, "caches", { configurable: true, value: originalCaches });
  }
}

runPoc().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Offline Kiro cache-accounting PoC failed: ${message}`);
  process.exitCode = 1;
});
