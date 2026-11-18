import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const tempDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-stream-stall-"));
process.env.DATA_DIR = tempDataDir;

const { resetDbInstance } = await import("../../src/lib/db/core.ts");
const { createSSEStream } = await import("../../open-sse/utils/stream.ts");
const { FORMATS } = await import("../../open-sse/translator/formats.ts");
const { estimateInputTokens } = await import("../../open-sse/utils/usageEstimation.ts");

test.after(() => {
  resetDbInstance();
  fs.rmSync(tempDataDir, { recursive: true, force: true });
});

const encoder = new TextEncoder();

function encodeResponsesEvent(payload: Record<string, unknown>): string {
  return `event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function makeTrackedResponsesBody(wordRepeats = 10_000) {
  let serializations = 0;
  const body = {
    model: "gpt-6-astra",
    input: [
      { type: "message", role: "user", content: "token ".repeat(wordRepeats) },
      { type: "custom_tool_call", id: "ctc_1", call_id: "call_1", name: "exec", input: "ls" },
      { type: "custom_tool_call_output", call_id: "call_1", output: "ok" },
    ],
    metadata: {
      toJSON() {
        serializations += 1;
        return {};
      },
    },
  };
  return {
    body,
    getSerializations: () => serializations,
  };
}

test("Responses passthrough stream with reported usage does not serialize request body per delta", async () => {
  const { body, getSerializations } = makeTrackedResponsesBody();
  const deltaCount = 200;
  const frames: string[] = [
    encodeResponsesEvent({
      type: "response.created",
      sequence_number: 1,
      response: { id: "resp_1", object: "response", status: "in_progress", output: [] },
    }),
  ];
  for (let i = 0; i < deltaCount; i++) {
    frames.push(
      encodeResponsesEvent({
        type: "response.reasoning_summary_text.delta",
        sequence_number: i + 2,
        item_id: "rs_1",
        output_index: 0,
        summary_index: 0,
        delta: "s",
      })
    );
  }
  frames.push(
    encodeResponsesEvent({
      type: "response.completed",
      sequence_number: deltaCount + 2,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        output: [],
        usage: { input_tokens: 15_000, output_tokens: 80, total_tokens: 15_080 },
      },
    })
  );

  let completedUsage: Record<string, unknown> | null = null;
  const stream = createSSEStream({
    mode: "passthrough",
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    clientResponseFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: "gpt-6-astra",
    body,
    onComplete(payload) {
      completedUsage = (payload.usage as Record<string, unknown>) ?? null;
    },
  });

  const wire = await new Response(
    new Response(encoder.encode(frames.join(""))).body!.pipeThrough(stream)
  ).text();

  assert.ok(wire.includes('"type":"response.completed"'));
  assert.equal(completedUsage?.prompt_tokens, 15_000);
  assert.equal(completedUsage?.completion_tokens, 80);
  assert.ok(
    getSerializations() <= 5,
    `expected O(1) body serializations across ${deltaCount} deltas, got ${getSerializations()}`
  );
});

test("Responses passthrough stream without reported usage estimates body tokens only once", async () => {
  const { body, getSerializations } = makeTrackedResponsesBody();
  const deltaCount = 120;
  const frames: string[] = [
    encodeResponsesEvent({
      type: "response.created",
      sequence_number: 1,
      response: { id: "resp_2", object: "response", status: "in_progress", output: [] },
    }),
  ];
  for (let i = 0; i < deltaCount; i++) {
    frames.push(
      encodeResponsesEvent({
        type: "response.output_text.delta",
        sequence_number: i + 2,
        item_id: "msg_1",
        output_index: 0,
        content_index: 0,
        delta: "x",
      })
    );
  }
  frames.push(
    encodeResponsesEvent({
      type: "response.completed",
      sequence_number: deltaCount + 2,
      response: {
        id: "resp_2",
        object: "response",
        status: "completed",
        output: [
          {
            id: "msg_1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "x".repeat(deltaCount) }],
          },
        ],
      },
    })
  );

  let completedUsage: Record<string, unknown> | null = null;
  const stream = createSSEStream({
    mode: "passthrough",
    sourceFormat: FORMATS.OPENAI_RESPONSES,
    targetFormat: FORMATS.OPENAI_RESPONSES,
    clientResponseFormat: FORMATS.OPENAI_RESPONSES,
    provider: "codex",
    model: "gpt-6-astra",
    body,
    onComplete(payload) {
      completedUsage = (payload.usage as Record<string, unknown>) ?? null;
    },
  });

  await new Response(
    new Response(encoder.encode(frames.join(""))).body!.pipeThrough(stream)
  ).text();

  const promptOrInput = Number(completedUsage?.input_tokens ?? completedUsage?.prompt_tokens ?? 0);
  assert.ok(promptOrInput > 0, `expected positive estimated input tokens, got ${promptOrInput}`);
  assert.equal(completedUsage?.estimated, true);
  assert.ok(
    getSerializations() <= 5,
    `expected O(1) body serializations across ${deltaCount} deltas, got ${getSerializations()}`
  );
});

test("Claude passthrough stream still repairs zero message_delta output_tokens without per-delta body scans", async () => {
  let serializations = 0;
  const body = {
    messages: [{ role: "user", content: "hello ".repeat(8_000) }],
    metadata: {
      toJSON() {
        serializations += 1;
        return {};
      },
    },
  };
  const events = [
    {
      type: "message_start",
      message: {
        id: "msg_claude_1",
        role: "assistant",
        content: [],
        usage: { input_tokens: 9_600, output_tokens: 0 },
      },
    },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    ...Array.from({ length: 80 }, () => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "chunk " },
    })),
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
    { type: "message_stop" },
  ];
  const rawSse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");

  let completedUsage: Record<string, unknown> | null = null;
  const stream = createSSEStream({
    mode: "passthrough",
    sourceFormat: FORMATS.CLAUDE,
    targetFormat: FORMATS.CLAUDE,
    clientResponseFormat: FORMATS.CLAUDE,
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    body,
    onComplete(payload) {
      completedUsage = (payload.usage as Record<string, unknown>) ?? null;
    },
  });

  const wire = await new Response(
    new Response(encoder.encode(rawSse)).body!.pipeThrough(stream)
  ).text();

  assert.equal(completedUsage?.prompt_tokens, 9_600);
  assert.ok(Number(completedUsage?.completion_tokens) > 0);
  assert.match(wire, /"type":"message_delta".*"output_tokens":[1-9]/);
  assert.ok(
    serializations <= 5,
    `expected O(1) body serializations across 80 Claude deltas, got ${serializations}`
  );
});

test("estimateInputTokens memoizes per body object and uses linear scan above 32 KB with CJK support", () => {
  let serializations = 0;
  const largeCode = "const result = transformPayload(alpha, beta);\n".repeat(20_000);
  const body = {
    messages: [{ role: "user", content: largeCode }],
    metadata: {
      toJSON() {
        serializations += 1;
        return {};
      },
    },
  };

  const originalSplit = String.prototype.split;
  let largeSplits = 0;
  String.prototype.split = function (this: string, ...args: unknown[]) {
    if (this.length > 32 * 1024) largeSplits += 1;
    return (originalSplit as (...splitArgs: unknown[]) => string[]).apply(this, args);
  } as unknown as typeof originalSplit;

  let first = 0;
  try {
    first = estimateInputTokens(body);
    assert.equal(estimateInputTokens(body), first);
    assert.equal(estimateInputTokens(body), first);
  } finally {
    String.prototype.split = originalSplit;
  }

  assert.ok(first > 150_000, `expected >150k tokens, got ${first}`);
  assert.equal(serializations, 1, "same body object must only be serialized once");
  assert.equal(largeSplits, 0, "strings above 32 KB must not invoke regex split");

  const cjkContent = "\u6f22\u5b57".repeat(18_000) + "\u{20000}".repeat(2_000);
  const cjkTokens = estimateInputTokens({ messages: [{ role: "user", content: cjkContent }] });
  assert.ok(cjkTokens >= 38_000, `expected >=38k tokens for 38k CJK ideographs, got ${cjkTokens}`);
});
